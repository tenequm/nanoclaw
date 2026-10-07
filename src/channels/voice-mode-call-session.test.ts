/**
 * findCallSession must name the session the router itself stores a call's turn
 * in, without creating one. Checked against the REAL routeInbound (seeded
 * wiring, real central DB) for each way a wiring resolves its session.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceModeInboundEvent as InboundEvent } from './voice-mode-integration.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from '../db/index.js';
import { getActiveSessions } from '../db/sessions.js';
import { routeVoiceModeTurn } from './voice-mode-route.js';
import { getHostStartCallbacks } from '../host-lifecycle.js';
import type { MessagingGroupAgent, Session } from '../types.js';
import type { ChannelAdapter, ChannelDefaults } from './adapter.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channel-registry.js';
import { findCallSession } from './voice-mode.js';

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const TEST_DIR = '/tmp/nanoclaw-test-voice-call-session';
vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-voice-call-session' };
});

const now = () => new Date().toISOString();

const defaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'public' },
  mentions: 'platform',
};

async function activate(): Promise<void> {
  const adapter: ChannelAdapter = {
    name: 'testchat',
    channelType: 'testchat',
    supportsThreads: true,
    defaults,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
  };
  registerChannelAdapter('testchat', { factory: () => adapter, defaults });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
}

async function seed(isGroup: 0 | 1, wiring: Partial<MessagingGroupAgent>): Promise<void> {
  for (const id of ['ag-voice', 'ag-other']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
  }
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'testchat',
    platform_id: 'testchat:C1',
    instance: 'testchat',
    name: 'Chat',
    is_group: isGroup,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  for (const agent of ['ag-other', 'ag-voice']) {
    await createMessagingGroupAgent({
      id: `mga-${agent}`,
      messaging_group_id: 'mg-1',
      agent_group_id: agent,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      threads: null,
      created_at: now(),
      ...wiring,
    });
  }
}

/** A call turn as voice-livekit routes it: addressed to the line's agent. */
const route = (threadId: string | null): Omit<InboundEvent, 'message'> => ({
  channelType: 'testchat',
  instance: 'testchat',
  platformId: 'testchat:C1',
  threadId,
  agentGroupId: 'ag-voice',
});

async function routedSession(threadId: string | null): Promise<Session> {
  const stored: Session[] = [];
  const event: InboundEvent = {
    ...route(threadId),
    message: {
      id: `livekit:call-1:${Math.random()}`,
      kind: 'chat',
      content: JSON.stringify({ text: 'hello', sender: 'Ethan', senderId: 'voice-mode:test' }),
      timestamp: now(),
      isMention: true,
      isGroup: false,
    },
    onStored: (session) => void stored.push(session),
  };
  for (const start of getHostStartCallbacks()) await start({} as never);
  await routeVoiceModeTurn(event, { callerId: 'voice-mode:test', chat: null });
  expect(stored).toHaveLength(1);
  return stored[0];
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  await activate();
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('findCallSession', () => {
  it.each([
    ['a DM, shared', 0, {}, 'thread-1'],
    ['a group with threads, per-thread', 1, { session_mode: 'per-thread' as const }, 'thread-1'],
    ['a group, threads off', 1, { threads: 0 }, 'thread-1'],
    ['a group thread under a shared wiring', 1, {}, 'thread-1'],
    ['agent-shared', 1, { session_mode: 'agent-shared' as const }, 'thread-1'],
  ])('names the session the router stores the turn in: %s', async (_name, isGroup, wiring, threadId) => {
    await seed(isGroup as 0 | 1, wiring);
    expect(await findCallSession(route(threadId), 'ag-voice')).toBeUndefined();
    // Looking it up created nothing.
    expect(await getActiveSessions()).toEqual([]);
    const session = await routedSession(threadId);
    expect(session.agent_group_id).toBe('ag-voice');
    expect((await findCallSession(route(threadId), 'ag-voice'))?.id).toBe(session.id);
  });

  it('finds nothing for an unknown chat or an agent not wired to it', async () => {
    await seed(0, {});
    await routedSession(null);
    expect(await findCallSession({ ...route(null), platformId: 'testchat:C2' }, 'ag-voice')).toBeUndefined();
    expect(await findCallSession(route(null), 'ag-nobody')).toBeUndefined();
  });
});
