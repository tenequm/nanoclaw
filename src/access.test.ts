import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { canAccessAgentGroup, pickApprovalDelivery, pickApprover } from './access.js';
import type { ChannelAdapter, OutboundMessage } from './channels/adapter.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import {
  addMember,
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createUser,
  getUserDm,
  grantRole,
  hasAnyOwner,
  initTestDb,
  isMember,
  isOwner,
  runMigrations,
} from './db/index.js';
import { ensureUserDm } from './user-dm.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(async () => {
  await teardownChannelAdapters();
  closeDb();
});

/**
 * Register and activate a mock adapter for tests. `openDM` optional — omit
 * to simulate direct-addressable channels (Telegram/WhatsApp), provide to
 * simulate resolution-required channels (Discord/Slack).
 */
async function mountMockAdapter(
  channelType: string,
  openDM?: (handle: string) => Promise<string>,
): Promise<{ delivered: OutboundMessage[]; openDMCalls: string[] }> {
  const delivered: OutboundMessage[] = [];
  const openDMCalls: string[] = [];
  const adapter: ChannelAdapter = {
    name: channelType,
    channelType,
    supportsThreads: false,
    async setup() {},
    async teardown() {},
    isConnected() {
      return true;
    },
    async deliver(_platformId, _threadId, message) {
      delivered.push(message);
      return undefined;
    },
    async setTyping() {},
  };
  if (openDM) {
    adapter.openDM = async (handle: string) => {
      openDMCalls.push(handle);
      return openDM(handle);
    };
  }
  registerChannelAdapter(channelType, { factory: () => adapter });
  await initChannelAdapters(() => ({
    conversations: [],
    onInbound: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  return { delivered, openDMCalls };
}

function seedAgentGroup(id: string): void {
  createAgentGroup({
    id,
    name: id.toUpperCase(),
    folder: id,
    agent_provider: null,
    created_at: now(),
  });
}

function seedUser(id: string, kind: string): void {
  createUser({ id, kind, display_name: null, created_at: now() });
}

describe('canAccessAgentGroup', () => {
  beforeEach(() => {
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
  });

  it('denies unknown users', () => {
    const d = canAccessAgentGroup('ghost', 'ag-1');
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toBe('unknown_user');
  });

  it('allows owners globally', () => {
    seedUser('u-owner', 'telegram');
    grantRole({ user_id: 'u-owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    expect(canAccessAgentGroup('u-owner', 'ag-1').allowed).toBe(true);
    expect(canAccessAgentGroup('u-owner', 'ag-2').allowed).toBe(true);
  });

  it('allows global admins', () => {
    seedUser('u-ga', 'telegram');
    grantRole({ user_id: 'u-ga', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });
    expect(canAccessAgentGroup('u-ga', 'ag-1').allowed).toBe(true);
    expect(canAccessAgentGroup('u-ga', 'ag-2').allowed).toBe(true);
  });

  it('scopes admins to their agent group', () => {
    seedUser('u-sa', 'telegram');
    grantRole({ user_id: 'u-sa', role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });
    expect(canAccessAgentGroup('u-sa', 'ag-1').allowed).toBe(true);
    const denied = canAccessAgentGroup('u-sa', 'ag-2');
    expect(denied.allowed).toBe(false);
    expect(denied.allowed === false && denied.reason).toBe('not_member');
  });

  it('admin @ group is implicitly a member', () => {
    seedUser('u-sa', 'telegram');
    grantRole({ user_id: 'u-sa', role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });
    expect(isMember('u-sa', 'ag-1')).toBe(true);
  });

  it('allows members of the group', () => {
    seedUser('u-m', 'telegram');
    addMember({ user_id: 'u-m', agent_group_id: 'ag-1', added_by: null, added_at: now() });
    expect(canAccessAgentGroup('u-m', 'ag-1').allowed).toBe(true);
    expect(canAccessAgentGroup('u-m', 'ag-2').allowed).toBe(false);
  });

  it('denies known-but-not-member users', () => {
    seedUser('u-known', 'telegram');
    const d = canAccessAgentGroup('u-known', 'ag-1');
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toBe('not_member');
  });
});

describe('role helpers', () => {
  it('rejects owner rows with a scope', () => {
    seedUser('u-1', 'telegram');
    expect(() =>
      grantRole({
        user_id: 'u-1',
        role: 'owner',
        agent_group_id: 'ag-1',
        granted_by: null,
        granted_at: now(),
      }),
    ).toThrow();
  });

  it('hasAnyOwner reflects owner grants', () => {
    seedUser('u-1', 'telegram');
    expect(hasAnyOwner()).toBe(false);
    grantRole({ user_id: 'u-1', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    expect(hasAnyOwner()).toBe(true);
    expect(isOwner('u-1')).toBe(true);
  });
});

describe('pickApprover', () => {
  beforeEach(() => {
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
  });

  it('prefers scoped admins, then globals, then owners — deduplicated', () => {
    seedUser('u-owner', 'telegram');
    seedUser('u-ga', 'telegram');
    seedUser('u-sa', 'telegram');
    grantRole({ user_id: 'u-owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    grantRole({ user_id: 'u-ga', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });
    grantRole({ user_id: 'u-sa', role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });

    expect(pickApprover('ag-1')).toEqual(['u-sa', 'u-ga', 'u-owner']);
    expect(pickApprover('ag-2')).toEqual(['u-ga', 'u-owner']);
    expect(pickApprover(null)).toEqual(['u-ga', 'u-owner']);
  });

  it('returns empty list when nobody is privileged', () => {
    expect(pickApprover('ag-1')).toEqual([]);
  });
});

describe('ensureUserDm', () => {
  it('adapter without openDM: falls through to using the bare handle as platform_id', async () => {
    await mountMockAdapter('nodm'); // no openDM → direct-addressable fallback
    seedUser('nodm:123', 'nodm');

    const mg = await ensureUserDm('nodm:123');
    expect(mg).toBeDefined();
    expect(mg!.channel_type).toBe('nodm');
    expect(mg!.platform_id).toBe('123');
    expect(mg!.is_group).toBe(0);

    // Cache row written
    const cached = getUserDm('nodm:123', 'nodm');
    expect(cached?.messaging_group_id).toBe(mg!.id);
  });

  it('Telegram via chat-sdk-bridge: adapter.openDM returns prefixed platform_id', async () => {
    // Post-fix bridge behavior: the bridged Telegram adapter exposes openDM
    // that delegates to the underlying @chat-adapter/telegram adapter, whose
    // channelIdFromThreadId returns "telegram:<chatId>". That's the same
    // encoding onInbound stores in messaging_groups, so cache hits on repeat.
    const mock = await mountMockAdapter('telegram', async (handle) => `telegram:${handle}`);
    seedUser('telegram:6037840640', 'telegram');

    const mg = await ensureUserDm('telegram:6037840640');
    expect(mg).toBeDefined();
    expect(mg!.platform_id).toBe('telegram:6037840640');
    expect(mock.openDMCalls).toEqual(['6037840640']);

    // Second call hits the user_dms cache, not openDM again.
    const mg2 = await ensureUserDm('telegram:6037840640');
    expect(mg2!.id).toBe(mg!.id);
    expect(mock.openDMCalls).toEqual(['6037840640']);
  });

  it('resolution-required channels: calls adapter.openDM, uses its result, caches', async () => {
    const mock = await mountMockAdapter('discord', async (handle) => `dm-channel-${handle}`);
    seedUser('discord:user-1', 'discord');

    const mg = await ensureUserDm('discord:user-1');
    expect(mg).toBeDefined();
    expect(mg!.platform_id).toBe('dm-channel-user-1');
    expect(mock.openDMCalls).toEqual(['user-1']);

    // Second call should hit the cache, not openDM.
    const mg2 = await ensureUserDm('discord:user-1');
    expect(mg2!.id).toBe(mg!.id);
    expect(mock.openDMCalls).toEqual(['user-1']); // unchanged
  });

  it('returns null when the adapter is not registered', async () => {
    seedUser('missing:42', 'missing');
    expect(await ensureUserDm('missing:42')).toBeNull();
  });

  it('returns null when adapter.openDM throws', async () => {
    await mountMockAdapter('slack', async () => {
      throw new Error('openDM boom');
    });
    seedUser('slack:u1', 'slack');
    expect(await ensureUserDm('slack:u1')).toBeNull();
    // No cache row should be written on failure
    expect(getUserDm('slack:u1', 'slack')).toBeUndefined();
  });

  it('reuses an existing messaging_group row if one already matches', async () => {
    await mountMockAdapter('telegram');
    seedUser('telegram:555', 'telegram');
    const existing = {
      id: 'mg-preexisting',
      channel_type: 'telegram',
      platform_id: '555',
      name: 'Pre-existing',
      is_group: 0 as const,
      unknown_sender_policy: 'strict' as const,
      created_at: now(),
    };
    createMessagingGroup(existing);

    const mg = await ensureUserDm('telegram:555');
    expect(mg?.id).toBe('mg-preexisting');
    expect(getUserDm('telegram:555', 'telegram')?.messaging_group_id).toBe('mg-preexisting');
  });
});

describe('pickApprovalDelivery', () => {
  beforeEach(() => {
    seedAgentGroup('ag-1');
  });

  it('returns the first reachable approver', async () => {
    await mountMockAdapter('telegram');
    seedUser('telegram:111', 'telegram');
    seedUser('telegram:222', 'telegram');

    // Both users are reachable (direct-addressable), so the first wins.
    const result = await pickApprovalDelivery(['telegram:111', 'telegram:222'], 'telegram');
    expect(result?.userId).toBe('telegram:111');
    expect(result?.messagingGroup.platform_id).toBe('111');
  });

  it('prefers same-channel-kind approver on tie-break', async () => {
    await mountMockAdapter('telegram');
    await mountMockAdapter('discord', async (h) => `dm-${h}`);
    seedUser('telegram:111', 'telegram');
    seedUser('discord:222', 'discord');

    // Origin is discord → discord approver wins even though telegram is first.
    const result = await pickApprovalDelivery(['telegram:111', 'discord:222'], 'discord');
    expect(result?.userId).toBe('discord:222');
  });

  it('falls through to any reachable approver when none match origin', async () => {
    await mountMockAdapter('telegram');
    seedUser('telegram:111', 'telegram');

    const result = await pickApprovalDelivery(['telegram:111'], 'discord');
    expect(result?.userId).toBe('telegram:111');
  });

  it('returns null when nobody is reachable', async () => {
    // No adapter registered → no user is reachable.
    seedUser('telegram:111', 'telegram');
    expect(await pickApprovalDelivery(['telegram:111'], 'telegram')).toBeNull();
  });
});
