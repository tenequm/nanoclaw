/**
 * The Jev wake-gate seen from the router, through the REAL routeInbound path.
 *
 * Two wirings share one group chat: one has a gate entry, one does not. The
 * fan-out loop reuses a single `event` across both, so the load-bearing
 * assertion here is that the gated wiring's annotation lands ONLY in its own
 * session — the ungated wiring must see the message exactly as it arrived.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-router-jev',
    TIMEZONE: 'UTC',
    JEV_API_KEY: 'test-key',
  };
});

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import { wakeContainer } from './container-runner.js';
import { resetGateConfigCache } from './modules/jev-gate/index.js';
import { withExistingMailboxSession } from './session-manager.js';
import { routeInbound } from './router.js';
import type { ChannelAdapter, ChannelDefaults } from './channels/adapter.js';

const TEST_DIR = '/tmp/nanoclaw-test-router-jev';
const GATED = 'ag-gated';
const PLAIN = 'ag-plain';

function now(): string {
  return new Date().toISOString();
}

const channelDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  mentions: 'platform',
};

function makeAdapter(): ChannelAdapter {
  return {
    name: 'testchat',
    channelType: 'testchat',
    supportsThreads: false,
    defaults: channelDefaults,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
  };
}

async function activate(): Promise<void> {
  registerChannelAdapter('testchat', { factory: () => makeAdapter(), defaults: channelDefaults });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
}

async function seed(): Promise<void> {
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'testchat',
    platform_id: 'testchat:C1',
    instance: 'testchat',
    name: 'Pondarium',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  let n = 0;
  for (const agentGroupId of [GATED, PLAIN]) {
    await createAgentGroup({
      id: agentGroupId,
      name: agentGroupId,
      folder: agentGroupId,
      agent_provider: null,
      created_at: now(),
    });
    await createMessagingGroupAgent({
      id: `mga-${++n}`,
      messaging_group_id: 'mg-1',
      agent_group_id: agentGroupId,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'accumulate',
      session_mode: 'shared',
      priority: 0,
      threads: 0,
      created_at: now(),
    });
  }
}

function writeGateConfig(entry: Record<string, unknown>): void {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, 'jev-gate.json'), JSON.stringify({ [GATED]: entry }));
  resetGateConfigCache();
}

function stubJev(direct_invitation: number): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        answers: {
          direct_invitation: { type: 'noul', noul: direct_invitation },
          unresolved: { type: 'noul', noul: 0 },
          already_answered: { type: 'noul', noul: 0 },
          human_pingpong: { type: 'noul', noul: 0 },
        },
      }),
    }),
  );
}

async function inbound(id: string, text: string): Promise<void> {
  await routeInbound({
    channelType: 'testchat',
    platformId: 'testchat:C1',
    threadId: null,
    message: {
      id,
      kind: 'chat',
      content: JSON.stringify({
        text,
        sender: 'Alex',
        senderId: 'testchat:U1',
        senderName: 'Alex',
        author: { userId: 'testchat:U1', fullName: 'Alex', userName: 'alex', isBot: false },
        attachments: [],
      }),
      timestamp: now(),
      isMention: false,
      isGroup: true,
    },
  });
}

/** The stored inbound texts for one agent group's only session. */
async function storedTexts(agentGroupId: string): Promise<string[]> {
  const sessions = await getSessionsByAgentGroup(agentGroupId);
  const texts: string[] = [];
  for (const session of sessions) {
    const rows = await withExistingMailboxSession(agentGroupId, session.id, (mailbox) => mailbox.getInboundHistory(50));
    for (const row of rows ?? []) {
      texts.push((JSON.parse(row.content) as { text?: string }).text ?? '');
    }
  }
  return texts;
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  resetGateConfigCache();
  await runMigrations(await initTestDb());
  vi.clearAllMocks();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('routeInbound with the Jev wake-gate', () => {
  it('silences the gated wiring and leaves the other wiring untouched', async () => {
    writeGateConfig({ enabled: true, mode: 'live', daily_cap: 0, cooldown_minutes: 0, max_consecutive_bot: 0 });
    stubJev(0.1);
    await activate();
    await seed();

    await inbound('m1', 'two humans chatting about lunch');

    const gated = await storedTexts(GATED);
    expect(gated).toHaveLength(1);
    expect(gated[0]).toContain('[jev: silent');

    // The fan-out loop shares one event object: the annotation must not have
    // reached the other wiring's copy.
    const plain = await storedTexts(PLAIN);
    expect(plain).toEqual(['two humans chatting about lunch']);

    // Only the ungated wiring woke a container.
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('wakes the gated wiring when Jev says reply, annotating only its own copy', async () => {
    writeGateConfig({ enabled: true, mode: 'live', daily_cap: 0, cooldown_minutes: 0, max_consecutive_bot: 0 });
    stubJev(0.95);
    await activate();
    await seed();

    await inbound('m1', 'can someone check the deploy?');

    expect((await storedTexts(GATED))[0]).toContain('[jev: reply');
    expect(await storedTexts(PLAIN)).toEqual(['can someone check the deploy?']);
    expect(wakeContainer).toHaveBeenCalledTimes(2);
  });

  it('shadow mode annotates but suppresses the wake (pre-gate baseline)', async () => {
    writeGateConfig({ enabled: true, mode: 'shadow', daily_cap: 0, cooldown_minutes: 0, max_consecutive_bot: 0 });
    stubJev(0.95);
    await activate();
    await seed();

    await inbound('m1', 'can someone check the deploy?');

    expect((await storedTexts(GATED))[0]).toContain('[jev: shadow-reply');
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('behaves exactly as upstream when no gate config exists', async () => {
    stubJev(0.05);
    await activate();
    await seed();

    await inbound('m1', 'two humans chatting about lunch');

    expect(await storedTexts(GATED)).toEqual(['two humans chatting about lunch']);
    expect(await storedTexts(PLAIN)).toEqual(['two humans chatting about lunch']);
    expect(fetch).not.toHaveBeenCalled();
    expect(wakeContainer).toHaveBeenCalledTimes(2);
  });

  it('does not judge an @mention — those wake on the platform signal alone', async () => {
    writeGateConfig({ enabled: true, mode: 'live', daily_cap: 0, cooldown_minutes: 0, max_consecutive_bot: 0 });
    stubJev(0.05);
    await activate();
    await seed();

    await routeInbound({
      channelType: 'testchat',
      platformId: 'testchat:C1',
      threadId: null,
      message: {
        id: 'm1',
        kind: 'chat',
        content: JSON.stringify({ text: '@bot hello', sender: 'Alex', senderId: 'testchat:U1' }),
        timestamp: now(),
        isMention: true,
        isGroup: true,
      },
    });

    expect(fetch).not.toHaveBeenCalled();
    expect((await storedTexts(GATED))[0]).toBe('@bot hello');
    expect(wakeContainer).toHaveBeenCalledTimes(2);
  });
});
