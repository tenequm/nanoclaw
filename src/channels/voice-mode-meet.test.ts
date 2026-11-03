/**
 * `/meet` against core's roles on a real test DB, with the voice channel's meeting control faked, and
 * the Attendee bridge's requests against a faked fetch.
 */
import fs from 'fs';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const TEST_DIR = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  return mkdtempSync(`${tmpdir()}/nanoclaw-test-meet-`);
});
vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

import { createAgentGroup } from '../db/agent-groups.js';
import { closeDb, initTestDb } from '../db/connection.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../db/messaging-groups.js';
import { runMigrations } from '../db/migrations/index.js';
import { getVoiceModeLineForAgent } from '../db/voice-mode-lines.js';
import { addMember } from '../modules/permissions/db/agent-group-members.js';
import { grantRole } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import type { MessagingGroup } from '../types.js';
import { linePlatformId } from './voice-mode-line.js';
import type { MeetingStart } from './voice-mode-livekit.js';
import {
  createAttendeeBridge,
  meetBridgeFromEnv,
  meetCommandReply,
  meetingUrl,
  parseMeetCommand,
  runMeetCommand,
  type MeetingControl,
} from './voice-mode-meet.js';

const OWNER = 'chat:1';
const MEMBER = 'chat:2';
const OTHER_ADMIN = 'chat:3';
const MEET = 'https://meet.google.com/abc-defg-hij';
const now = () => new Date().toISOString();

describe('parseMeetCommand', () => {
  it('takes /meet <link>, /meet leave, /meet@bot and, on Slack only, !meet', () => {
    expect(parseMeetCommand(`/meet ${MEET}`, 'telegram')).toEqual({ action: 'join', url: MEET });
    expect(parseMeetCommand(`/meet@some_bot ${MEET}`, 'telegram')).toEqual({ action: 'join', url: MEET });
    expect(parseMeetCommand(`!meet <${MEET}>`, 'slack')).toEqual({ action: 'join', url: MEET });
    expect(parseMeetCommand(`!meet <${MEET}|meet.google.com/abc-defg-hij>`, 'slack')).toEqual({
      action: 'join',
      url: MEET,
    });
    expect(parseMeetCommand('/meet LEAVE', 'telegram')).toEqual({ action: 'leave' });
    expect(parseMeetCommand('/meet', 'telegram')).toEqual({ action: 'usage' });
    expect(parseMeetCommand('/meet https://zoom.us/j/1', 'telegram')).toEqual({ action: 'usage' });
    expect(parseMeetCommand(`!meet ${MEET}`, 'telegram')).toBeNull();
    expect(parseMeetCommand('/meeting', 'telegram')).toBeNull();
    expect(parseMeetCommand('lets meet', 'telegram')).toBeNull();
  });

  it('accepts only https Google Meet links', () => {
    expect(meetingUrl(MEET)).toBe(MEET);
    expect(meetingUrl('http://meet.google.com/abc')).toBeNull();
    expect(meetingUrl('https://meet.google.com/')).toBeNull();
    expect(meetingUrl('https://meet.google.com.evil.example/abc')).toBeNull();
    expect(meetingUrl('not a url')).toBeNull();
  });
});

describe('Attendee bridge', () => {
  it('creates a non-recording bot synced to the room with the worker as its source, and leaves by id', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/leave')
        ? new Response('{}', { status: 200 })
        : new Response(JSON.stringify({ id: 'bot_abc', state: 'joining' }), { status: 201 }),
    );
    const bridge = createAttendeeBridge({ url: 'http://127.0.0.1:8010/', apiKey: 'k-1' }, fetchImpl as typeof fetch);
    expect(
      await bridge.join({ meetingUrl: MEET, botName: 'Dan', roomName: 'meet-x-1', sourceIdentity: 'agent-meet-1' }),
    ).toEqual({ botId: 'bot_abc' });
    await bridge.leave('bot_abc');
    const [[createUrl, create], [leaveUrl, leave]] = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(createUrl).toBe('http://127.0.0.1:8010/api/v1/bots');
    expect(create.method).toBe('POST');
    expect(create.headers).toEqual({ Authorization: 'Token k-1', 'Content-Type': 'application/json' });
    expect(JSON.parse(String(create.body))).toEqual({
      meeting_url: MEET,
      bot_name: 'Dan',
      recording_settings: { format: 'none' },
      room_sync_settings: { livekit: { room_name: 'meet-x-1', source_participant: { identity: 'agent-meet-1' } } },
    });
    expect(leaveUrl).toBe('http://127.0.0.1:8010/api/v1/bots/bot_abc/leave');
    expect(leave.method).toBe('POST');
  });

  it('fails on an error answer or a bot without an id', async () => {
    const answers = [new Response('bad meeting', { status: 400 }), new Response('{}', { status: 201 })];
    const bridge = createAttendeeBridge(
      { url: 'http://a', apiKey: 'k' },
      (async () => answers.shift()!) as typeof fetch,
    );
    const join = () => bridge.join({ meetingUrl: MEET, botName: 'Dan', roomName: 'r', sourceIdentity: 's' });
    await expect(join()).rejects.toThrow('HTTP 400 bad meeting');
    await expect(join()).rejects.toThrow('without an id');
  });

  it('is picked by MEET_PROVIDER (attendee by default), only with its settings', () => {
    const env = (values: Record<string, string>) => (keys: string[]) =>
      Object.fromEntries(keys.filter((k) => k in values).map((k) => [k, values[k]]));
    expect(meetBridgeFromEnv(env({ ATTENDEE_URL: 'http://a', ATTENDEE_API_KEY: 'k' }))).toBeDefined();
    expect(meetBridgeFromEnv(env({ ATTENDEE_URL: 'http://a' }))).toBeUndefined();
    expect(
      meetBridgeFromEnv(env({ MEET_PROVIDER: 'nope', ATTENDEE_URL: 'http://a', ATTENDEE_API_KEY: 'k' })),
    ).toBeUndefined();
  });
});

describe('runMeetCommand', () => {
  async function chat(id: string, platformId: string) {
    await createMessagingGroup({
      id,
      channel_type: 'chat',
      platform_id: platformId,
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
  }
  async function wire(mgId: string, agentGroupId: string) {
    await createMessagingGroupAgent({
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
    });
  }
  const mg = (id: string) => ({ id, instance: null, channel_type: 'chat', is_group: 0 }) as unknown as MessagingGroup;

  function fakeMeetings(start: MeetingStart = { ok: true, agentName: 'Andy' }) {
    const started: Array<{ platformId: string; url: string }> = [];
    const left: string[] = [];
    const control: MeetingControl = {
      meetingsEnabled: true,
      startMeeting: async (platformId, url) => {
        started.push({ platformId, url });
        return start;
      },
      leaveMeeting: (platformId) => {
        left.push(platformId);
        return true;
      },
    };
    return { control, started, left };
  }

  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await runMigrations(await initTestDb());
    for (const id of [OWNER, MEMBER, OTHER_ADMIN]) {
      await upsertUser({ id, kind: 'chat', display_name: id === OWNER ? 'Misha' : null, created_at: now() });
    }
    await createAgentGroup({ id: 'ag-1', name: 'Andy', folder: 'ag-1', agent_provider: null, created_at: now() });
    await grantRole({ user_id: OWNER, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    await grantRole({
      user_id: OTHER_ADMIN,
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: null,
      granted_at: now(),
    });
    await addMember({ user_id: MEMBER, agent_group_id: 'ag-1', added_by: null, added_at: now() });
    await chat('mg-dm', 'chat:1');
    await wire('mg-dm', 'ag-1');
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  const join = { action: 'join', url: MEET } as const;

  it('drops unknown senders and refuses members', async () => {
    const m = fakeMeetings();
    expect(await runMeetCommand(mg('mg-dm'), null, 'chat:404', join, { meetings: m.control })).toEqual({
      kind: 'drop',
    });
    expect(await runMeetCommand(mg('mg-dm'), null, MEMBER, join, { meetings: m.control })).toEqual({
      kind: 'refused',
    });
    expect(m.started).toEqual([]);
  });

  it("creates the admin's line bound to this chat and starts the meeting on it", async () => {
    const m = fakeMeetings();
    const outcome = await runMeetCommand(mg('mg-dm'), null, OWNER, join, {
      meetings: m.control,
      key: randomBytes(32),
    });
    expect(outcome).toEqual({ kind: 'started', agentName: 'Andy', url: MEET });
    const line = await getVoiceModeLineForAgent('ag-1');
    expect(line).toMatchObject({ owner_user_id: OWNER, messaging_group_id: 'mg-dm' });
    expect(m.started).toEqual([{ platformId: linePlatformId(line!.line_id), url: MEET }]);
    expect(meetCommandReply(outcome)).toContain('Andy is asking to join https://meet.google.com/abc-defg-hij');
  });

  it("leaves another admin's line alone, and leave works only for the line's caller", async () => {
    const m = fakeMeetings();
    await runMeetCommand(mg('mg-dm'), null, OWNER, join, { meetings: m.control, key: randomBytes(32) });
    const other = await runMeetCommand(mg('mg-dm'), null, OTHER_ADMIN, join, { meetings: m.control });
    expect(other).toEqual({ kind: 'other-caller', agentName: 'Andy', caller: 'Misha' });
    expect(await runMeetCommand(mg('mg-dm'), null, OTHER_ADMIN, { action: 'leave' }, { meetings: m.control })).toEqual({
      kind: 'other-caller',
      agentName: 'Andy',
      caller: 'Misha',
    });
    expect(await runMeetCommand(mg('mg-dm'), null, OWNER, { action: 'leave' }, { meetings: m.control })).toEqual({
      kind: 'left',
      agentName: 'Andy',
    });
    expect(m.started).toHaveLength(1);
    expect(m.left).toHaveLength(1);
  });

  it('says when meetings or voice are off, or the bridge failed, and refuses a chat with several agents', async () => {
    const off = { ...fakeMeetings().control, meetingsEnabled: false };
    expect(await runMeetCommand(mg('mg-dm'), null, OWNER, join, { meetings: off })).toEqual({
      kind: 'not-configured',
      agentName: 'Andy',
    });
    expect(await runMeetCommand(mg('mg-dm'), null, OWNER, join, { meetings: null })).toEqual({
      kind: 'voice-unavailable',
      agentName: 'Andy',
    });
    const failed = await runMeetCommand(mg('mg-dm'), null, OWNER, join, {
      meetings: fakeMeetings({ ok: false, error: 'bot' }).control,
      key: randomBytes(32),
    });
    expect(meetCommandReply(failed)).toBe(
      'Andy could not join the meeting: the meeting bot service refused or did not answer.',
    );
    await createAgentGroup({ id: 'ag-2', name: 'Dan', folder: 'ag-2', agent_provider: null, created_at: now() });
    await wire('mg-dm', 'ag-2');
    expect(await runMeetCommand(mg('mg-dm'), null, OWNER, join, { meetings: fakeMeetings().control })).toEqual({
      kind: 'several-agents',
    });
  });
});
