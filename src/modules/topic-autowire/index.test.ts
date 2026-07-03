/**
 * Topic auto-wire behavior against the real central-DB layer: an unknown
 * `telegram:<chatId>:<topicId>` platform id whose base chat is wired gets a
 * cloned messaging group + wiring(s); everything else is left alone.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import type { InboundEvent } from '../../channels/adapter.js';

import { autowireTopic } from './index.js';

const BASE = 'telegram:-1003927289090';
const TOPIC = 'telegram:-1003927289090:9';

function event(platformId: string, channelType = 'telegram'): InboundEvent {
  return {
    channelType,
    platformId,
    threadId: null,
    message: { id: 'm1', kind: 'chat-sdk', content: '{"text":"hi"}', timestamp: new Date().toISOString() },
  };
}

function seedBase(withWiring = true): void {
  createAgentGroup({ id: 'ag-1', name: 'Dan', folder: 'dan', agent_provider: null, created_at: 't' });
  createMessagingGroup({
    id: 'mg-base',
    channel_type: 'telegram',
    platform_id: BASE,
    name: 'HQ',
    is_group: 1,
    unknown_sender_policy: 'request_approval',
    created_at: 't',
  });
  if (withWiring) {
    createMessagingGroupAgent({
      id: 'w-base',
      messaging_group_id: 'mg-base',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: 't',
    });
  }
}

beforeEach(() => {
  closeDb();
  const db = initTestDb();
  runMigrations(db);
});

describe('autowireTopic', () => {
  it('clones the base wiring onto an unknown topic and never claims the message', async () => {
    seedBase();
    const claimed = await autowireTopic(event(TOPIC));
    expect(claimed).toBe(false);

    const mg = getMessagingGroupByPlatform('telegram', TOPIC, 'telegram');
    expect(mg).toBeDefined();
    expect(mg!.unknown_sender_policy).toBe('request_approval');
    expect(mg!.is_group).toBe(1);

    const wirings = getMessagingGroupAgents(mg!.id);
    expect(wirings).toHaveLength(1);
    expect(wirings[0].agent_group_id).toBe('ag-1');
    expect(wirings[0].engage_mode).toBe('pattern');
    expect(wirings[0].engage_pattern).toBe('.');
    expect(wirings[0].session_mode).toBe('shared');
  });

  it('is idempotent: an existing topic row is left untouched', async () => {
    seedBase();
    await autowireTopic(event(TOPIC));
    const first = getMessagingGroupByPlatform('telegram', TOPIC, 'telegram')!;
    await autowireTopic(event(TOPIC));
    const second = getMessagingGroupByPlatform('telegram', TOPIC, 'telegram')!;
    expect(second.id).toBe(first.id);
    expect(getMessagingGroupAgents(first.id)).toHaveLength(1);
  });

  it('does nothing when the base chat is unwired or unknown', async () => {
    seedBase(false);
    await autowireTopic(event(TOPIC));
    expect(getMessagingGroupByPlatform('telegram', TOPIC, 'telegram')).toBeUndefined();

    await autowireTopic(event('telegram:-100999:7'));
    expect(getMessagingGroupByPlatform('telegram', 'telegram:-100999:7', 'telegram')).toBeUndefined();
  });

  it('ignores non-telegram channels and non-topic platform ids', async () => {
    seedBase();
    await autowireTopic(event(TOPIC, 'discord'));
    expect(getMessagingGroupByPlatform('discord', TOPIC, 'discord')).toBeUndefined();

    await autowireTopic(event(BASE));
    await autowireTopic(event('telegram:-100123:abc'));
    expect(getMessagingGroupByPlatform('telegram', 'telegram:-100123:abc', 'telegram')).toBeUndefined();
  });
});
