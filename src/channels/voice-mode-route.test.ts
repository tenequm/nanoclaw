/**
 * A caller's turn against the real core: the agent's session for the call chat gets the turn as a
 * waking message, and only the line's agent gets it, whoever else is wired to that chat. Core's
 * session-created hooks see a session a turn creates.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-voice-route' };
});

const TEST_DIR = '/tmp/nanoclaw-test-voice-route';

import { wakeContainer } from '../container-runner.js';
import { registerSessionCreatedHook, type SessionCreatedEvent } from '../router.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from '../db/index.js';
import { getSessionsByAgentGroup } from '../db/sessions.js';
import { inboundDbPath } from '../mailbox/sqlite/paths.js';
import type { InboundEvent } from './adapter.js';
import { getHostStartCallbacks } from '../host-lifecycle.js';
import './index.js'; // the real channel barrel: registers the voice channel
import { routeVoiceModeTurn } from './voice-mode-route.js';

const now = () => new Date().toISOString();

const sessionsCreated: SessionCreatedEvent[] = [];
registerSessionCreatedHook((event) => {
  sessionsCreated.push(event);
});

const turn = (platformId = 'chat:G1'): InboundEvent => ({
  channelType: 'chat',
  instance: 'chat',
  platformId,
  threadId: null,
  message: {
    id: 'livekit:call-1:1',
    kind: 'chat',
    content: JSON.stringify({ text: '<voice source="livekit">book a table</voice>', senderId: 'voice-mode:abc' }),
    timestamp: now(),
    isMention: true,
  },
});

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  for (const [id, name] of [
    ['ag-1', 'Andy'],
    ['ag-2', 'Other'],
  ]) {
    await createAgentGroup({ id, name, folder: id, agent_provider: null, created_at: now() });
  }
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'chat',
    platform_id: 'chat:G1',
    name: 'Family',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  for (const ag of ['ag-1', 'ag-2']) {
    await createMessagingGroupAgent({
      id: `mga-${ag}`,
      messaging_group_id: 'mg-1',
      agent_group_id: ag,
      // A trigger the spoken turn does not match: a turn engages its agent anyway.
      engage_mode: 'pattern',
      engage_pattern: '^@nobody',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  }
});

afterEach(async () => {
  sessionsCreated.length = 0;
  vi.mocked(wakeContainer).mockClear();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('routeVoiceModeTurn', () => {
  it('takes no turn before the host has started, as the router takes no inbound before then', async () => {
    await expect(routeVoiceModeTurn(turn(), 'ag-1')).rejects.toThrow('still starting');
    expect(vi.mocked(wakeContainer)).not.toHaveBeenCalled();
  });

  describe('once the host has started', () => {
    beforeEach(async () => {
      // What the host runs once inbound is released (src/index.ts startHostModules).
      for (const start of getHostStartCallbacks()) await start({} as never);
    });
    it("stores the turn as a waking message in the line agent's session only, and wakes it", async () => {
      expect(await routeVoiceModeTurn(turn(), 'ag-1')).toBe(true);
      const [session] = await getSessionsByAgentGroup('ag-1');
      expect(session).toMatchObject({ messaging_group_id: 'mg-1' });
      expect(await getSessionsByAgentGroup('ag-2')).toEqual([]);
      const db = new Database(inboundDbPath('ag-1', session.id), { readonly: true });
      const rows = db.prepare('SELECT id, trigger, platform_id FROM messages_in').all();
      db.close();
      expect(rows).toEqual([{ id: 'livekit:call-1:1:ag-1', trigger: 1, platform_id: 'chat:G1' }]);
      expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(1);
    });

    it('does not acknowledge a turn consumed by the core command gate', async () => {
      const event = turn();
      event.message.content = JSON.stringify({ text: '/status', senderId: 'voice-mode:abc' });
      event.onStored = vi.fn();
      expect(await routeVoiceModeTurn(event, 'ag-1')).toBe(false);
      expect(event.onStored).not.toHaveBeenCalled();
      expect(vi.mocked(wakeContainer)).not.toHaveBeenCalled();
    });

    it("tells core's session-created hooks about the session a first turn creates, once", async () => {
      await routeVoiceModeTurn(turn(), 'ag-1');
      const [session] = await getSessionsByAgentGroup('ag-1');
      expect(sessionsCreated).toHaveLength(1);
      expect(sessionsCreated[0]).toMatchObject({
        session: { id: session.id, agent_group_id: 'ag-1' },
        mg: { id: 'mg-1' },
        platformId: 'chat:G1',
        threadId: null,
        sessionMode: 'shared',
        message: { id: 'livekit:call-1:1' },
      });
      await routeVoiceModeTurn({ ...turn(), message: { ...turn().message, id: 'livekit:call-1:2' } }, 'ag-1');
      expect(sessionsCreated).toHaveLength(1);
    });

    it('stores nothing when the chat or its wiring to the agent is gone', async () => {
      expect(await routeVoiceModeTurn(turn('chat:unknown'), 'ag-1')).toBe(false);
      expect(await routeVoiceModeTurn(turn(), 'ag-unwired')).toBe(false);
      expect(await getSessionsByAgentGroup('ag-1')).toEqual([]);
      expect(vi.mocked(wakeContainer)).not.toHaveBeenCalled();
    });
  });
});
