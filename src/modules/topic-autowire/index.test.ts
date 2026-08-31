/**
 * Topic auto-wire behavior against the real central-DB layer: an unknown
 * `telegram:<chatId>:<topicId>` platform id whose base chat is wired gets a
 * cloned messaging group + wiring(s); everything else is left alone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import type { InboundEvent } from '../../channels/adapter.js';

import { autowireTopic } from './index.js';

const BASE = 'telegram:-1000000000001';
const TOPIC = 'telegram:-1000000000001:9';

function event(platformId: string, channelType = 'telegram'): InboundEvent {
  return {
    channelType,
    platformId,
    threadId: null,
    message: { id: 'm1', kind: 'chat-sdk', content: '{"text":"hi"}', timestamp: new Date().toISOString() },
  };
}

async function seedBase(withWiring = true): Promise<void> {
  await createAgentGroup({ id: 'ag-1', name: 'Agent One', folder: 'agent-one', agent_provider: null, created_at: 't' });
  await createMessagingGroup({
    id: 'mg-base',
    channel_type: 'telegram',
    platform_id: BASE,
    name: 'Base chat',
    is_group: 1,
    unknown_sender_policy: 'request_approval',
    created_at: 't',
  });
  if (withWiring) {
    await createMessagingGroupAgent({
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

beforeEach(async () => {
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
});

describe('autowireTopic', () => {
  it('clones the base wiring onto an unknown topic and never claims the message', async () => {
    await seedBase();
    const claimed = await autowireTopic(event(TOPIC));
    expect(claimed).toBe(false);

    const mg = await getMessagingGroupByPlatform('telegram', TOPIC, 'telegram');
    expect(mg).toBeDefined();
    expect(mg!.unknown_sender_policy).toBe('request_approval');
    expect(mg!.is_group).toBe(1);

    const wirings = await getMessagingGroupAgents(mg!.id);
    expect(wirings).toHaveLength(1);
    expect(wirings[0].agent_group_id).toBe('ag-1');
    expect(wirings[0].engage_mode).toBe('pattern');
    expect(wirings[0].engage_pattern).toBe('.');
    expect(wirings[0].session_mode).toBe('shared');
  });

  it('is idempotent: an existing topic row is left untouched', async () => {
    await seedBase();
    await autowireTopic(event(TOPIC));
    const first = (await getMessagingGroupByPlatform('telegram', TOPIC, 'telegram'))!;
    await autowireTopic(event(TOPIC));
    const second = (await getMessagingGroupByPlatform('telegram', TOPIC, 'telegram'))!;
    expect(second.id).toBe(first.id);
    expect(await getMessagingGroupAgents(first.id)).toHaveLength(1);
  });

  it('does nothing when the base chat is unwired or unknown', async () => {
    await seedBase(false);
    await autowireTopic(event(TOPIC));
    expect(await getMessagingGroupByPlatform('telegram', TOPIC, 'telegram')).toBeUndefined();

    await autowireTopic(event('telegram:-1000000000002:7'));
    expect(await getMessagingGroupByPlatform('telegram', 'telegram:-1000000000002:7', 'telegram')).toBeUndefined();
  });

  it('ignores non-telegram channels and non-topic platform ids', async () => {
    await seedBase();
    await autowireTopic(event(TOPIC, 'discord'));
    expect(await getMessagingGroupByPlatform('discord', TOPIC, 'discord')).toBeUndefined();

    await autowireTopic(event(BASE));
    await autowireTopic(event('telegram:-1000000000003:abc'));
    expect(await getMessagingGroupByPlatform('telegram', 'telegram:-1000000000003:abc', 'telegram')).toBeUndefined();
  });

  it('rolls back a partial clone and allows a later retry', async () => {
    await seedBase();
    const db = (await import('../../db/index.js')).getDb();
    await db.exec('PRAGMA foreign_keys = OFF');
    await db.run(
      `INSERT INTO messaging_group_agents (
         id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
         sender_scope, ignored_message_policy, session_mode, priority, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'w-invalid',
      'mg-base',
      'ag-missing',
      'pattern',
      '.',
      'all',
      'drop',
      'shared',
      -1,
      't',
    );
    await db.exec('PRAGMA foreign_keys = ON');

    await expect(autowireTopic(event(TOPIC))).rejects.toThrow();
    expect(await getMessagingGroupByPlatform('telegram', TOPIC, 'telegram')).toBeUndefined();

    await db.run('DELETE FROM messaging_group_agents WHERE id = ?', 'w-invalid');
    await expect(autowireTopic(event(TOPIC))).resolves.toBe(false);
    expect(await getMessagingGroupByPlatform('telegram', TOPIC, 'telegram')).toBeDefined();
  });
});
