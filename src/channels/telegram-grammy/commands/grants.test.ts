import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { closeDb, initTestDb } from '../../../db/connection.js';
import { createAgentGroup } from '../../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../../db/messaging-groups.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { grantRole } from '../../../modules/permissions/db/user-roles.js';
import { upsertUser } from '../../../modules/permissions/db/users.js';
import type { MessagingGroup, MessagingGroupAgent } from '../../../types.js';
import { COMMAND_ORDER } from '../../../commands/index.js';
import { computeCommandGrants } from './grants.js';

const OWNER = 'telegram:1';
const SCOPED_ADMIN = 'telegram:9';
const NON_ADMIN_DM = 'telegram:555';

function now() {
  return new Date().toISOString();
}

function makeAgentGroup(id: string, name: string) {
  createAgentGroup({ id, name, folder: id, agent_provider: null, created_at: now() });
}

function makeMg(id: string, platformId: string, isGroup: 0 | 1, name: string | null = null) {
  const mg: MessagingGroup = {
    id,
    channel_type: 'telegram',
    platform_id: platformId,
    name,
    is_group: isGroup,
    unknown_sender_policy: 'strict',
    created_at: now(),
  };
  createMessagingGroup(mg);
}

function wire(mgId: string, agentGroupId: string) {
  const mga: MessagingGroupAgent = {
    id: `mga-${mgId}-${agentGroupId}`,
    messaging_group_id: mgId,
    agent_group_id: agentGroupId,
    engage_mode: 'mention-sticky',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  };
  createMessagingGroupAgent(mga);
}

function makeUser(id: string) {
  upsertUser({ id, kind: 'telegram', display_name: null, created_at: now() });
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  makeUser(OWNER);
  makeUser(SCOPED_ADMIN);
  makeUser(NON_ADMIN_DM);
  makeUser('telegram:8');
});

afterEach(() => {
  closeDb();
});

describe('computeCommandGrants', () => {
  it('returns no grants when nothing is wired', () => {
    grantRole({ user_id: OWNER, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    expect(computeCommandGrants()).toEqual([]);
  });

  it('collapses topics to one chat and unions admins across wired agents', () => {
    makeAgentGroup('ag-1', 'Emma');
    makeAgentGroup('ag-2', 'Stan');
    grantRole({ user_id: OWNER, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    grantRole({ user_id: SCOPED_ADMIN, role: 'admin', agent_group_id: 'ag-2', granted_by: OWNER, granted_at: now() });

    // One HQ group chat with two forum topics, each wired to a different agent.
    makeMg('mg-hq-a', 'telegram:-100:2', 1, 'HQ: Emma');
    makeMg('mg-hq-b', 'telegram:-100:3', 1, 'HQ: Stan');
    wire('mg-hq-a', 'ag-1');
    wire('mg-hq-b', 'ag-2');

    const grants = computeCommandGrants();
    // Both topics fold into telegram:-100; owner (global) + scoped admin of
    // ag-2 both get chat_member grants there.
    const hq = grants.filter((g) => g.chatPlatformId === 'telegram:-100');
    expect(hq).toHaveLength(2);
    expect(hq.every((g) => g.kind === 'chat_member')).toBe(true);
    expect(new Set(hq.map((g) => g.userId))).toEqual(new Set([OWNER, SCOPED_ADMIN]));
    expect(hq[0].commands).toEqual(COMMAND_ORDER);
  });

  it('emits a chat-scope grant for an admin-owned DM chat', () => {
    makeAgentGroup('ag-1', 'Emma');
    grantRole({ user_id: OWNER, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });

    // The owner's DM chat: platform_id equals the owner's user id.
    makeMg('mg-dm-owner', OWNER, 0);
    wire('mg-dm-owner', 'ag-1');

    const grants = computeCommandGrants();
    const dm = grants.filter((g) => g.chatPlatformId === OWNER);
    expect(dm).toHaveLength(1);
    expect(dm[0].kind).toBe('chat');
    expect(dm[0].userId).toBeUndefined();
    expect(dm[0].commands).toEqual(COMMAND_ORDER);
  });

  it('does not grant popups in a non-admin DM chat', () => {
    makeAgentGroup('ag-1', 'Emma');
    grantRole({ user_id: OWNER, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });

    makeMg('mg-dm-stranger', NON_ADMIN_DM, 0);
    wire('mg-dm-stranger', 'ag-1');

    const grants = computeCommandGrants();
    expect(grants.filter((g) => g.chatPlatformId === NON_ADMIN_DM)).toEqual([]);
  });

  it('ignores non-telegram messaging groups', () => {
    makeAgentGroup('ag-1', 'Emma');
    grantRole({ user_id: OWNER, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    const mg: MessagingGroup = {
      id: 'mg-slack',
      channel_type: 'slack',
      platform_id: 'slack:C123',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    };
    createMessagingGroup(mg);
    wire('mg-slack', 'ag-1');
    expect(computeCommandGrants()).toEqual([]);
  });

  it('produces a deterministic, stable ordering', () => {
    makeAgentGroup('ag-1', 'Emma');
    grantRole({ user_id: OWNER, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    grantRole({ user_id: 'telegram:8', role: 'admin', agent_group_id: null, granted_by: OWNER, granted_at: now() });

    makeMg('mg-b', 'telegram:-200', 1);
    makeMg('mg-a', 'telegram:-100', 1);
    wire('mg-b', 'ag-1');
    wire('mg-a', 'ag-1');

    const first = computeCommandGrants();
    const second = computeCommandGrants();
    expect(first).toEqual(second);
    // Chats sorted by platform id; -100 before -200.
    const chatIds = first.map((g) => g.chatPlatformId);
    expect(chatIds.indexOf('telegram:-100')).toBeLessThan(chatIds.indexOf('telegram:-200'));
  });
});
