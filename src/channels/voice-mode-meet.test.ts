/**
 * `/meet` against core's roles on a real test DB, with the voice channel's meetings faked.
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
import {
  meetCommandReply,
  meetingUrl,
  parseMeetCommand,
  runMeetCommand,
  type MeetingControl,
  type MeetingStart,
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
    expect(parseMeetCommand(`/meet ${MEET} please`, 'telegram')).toEqual({ action: 'usage' });
    expect(parseMeetCommand(`/meet ${MEET} desk`, 'telegram')).toEqual({ action: 'usage' });
    expect(parseMeetCommand(`!meet ${MEET}`, 'telegram')).toBeNull();
    expect(parseMeetCommand('/meeting', 'telegram')).toBeNull();
    expect(parseMeetCommand('lets meet', 'telegram')).toBeNull();
  });

  it('takes pause on either side of the link, once', () => {
    const pause = { action: 'join', url: MEET, pauseSends: true };
    expect(parseMeetCommand(`/meet ${MEET} pause`, 'telegram')).toEqual(pause);
    expect(parseMeetCommand(`/meet PAUSE ${MEET}`, 'telegram')).toEqual(pause);
    expect(parseMeetCommand(`!meet <${MEET}> pause`, 'slack')).toEqual(pause);
    expect(parseMeetCommand(`/meet ${MEET} pause pause`, 'telegram')).toEqual({ action: 'usage' });
    expect(parseMeetCommand('/meet pause', 'telegram')).toEqual({ action: 'usage' });
    expect(parseMeetCommand(`/meet ${MEET} pause please`, 'telegram')).toEqual({ action: 'usage' });
  });

  it('takes jev in any order with the link and pause, once', () => {
    const jev = { action: 'join', url: MEET, jev: true };
    expect(parseMeetCommand(`/meet ${MEET} jev`, 'telegram')).toEqual(jev);
    expect(parseMeetCommand(`/meet JEV ${MEET}`, 'telegram')).toEqual(jev);
    expect(parseMeetCommand(`!meet <${MEET}> jev`, 'slack')).toEqual(jev);
    expect(parseMeetCommand(`/meet ${MEET} jev pause`, 'telegram')).toEqual({ ...jev, pauseSends: true });
    expect(parseMeetCommand(`/meet pause jev ${MEET}`, 'telegram')).toEqual({ ...jev, pauseSends: true });
    expect(parseMeetCommand(`/meet ${MEET} jev jev`, 'telegram')).toEqual({ action: 'usage' });
    expect(parseMeetCommand('/meet jev', 'telegram')).toEqual({ action: 'usage' });
  });

  it('accepts only https Google Meet links', () => {
    expect(meetingUrl(MEET)).toBe(MEET);
    expect(meetingUrl('http://meet.google.com/abc')).toBeNull();
    expect(meetingUrl('https://meet.google.com/')).toBeNull();
    expect(meetingUrl('https://meet.google.com.evil.example/abc')).toBeNull();
    expect(meetingUrl('not a url')).toBeNull();
  });

  it('refuses credentials and ports, and passes on only the origin and meeting code path', () => {
    expect(meetingUrl('https://user@meet.google.com/abc-defg-hij')).toBeNull();
    expect(meetingUrl('https://user:pw@meet.google.com/abc-defg-hij')).toBeNull();
    expect(meetingUrl('https://meet.google.com:8443/abc-defg-hij')).toBeNull();
    expect(meetingUrl('https://meet.google.com:443/abc-defg-hij')).toBe('https://meet.google.com/abc-defg-hij');
    expect(meetingUrl('https://meet.google.com/abc-defg-hij?authuser=1&x=<y>#frag')).toBe(
      'https://meet.google.com/abc-defg-hij',
    );
    expect(meetingUrl('<https://meet.google.com/abc-defg-hij?pli=1|Meet>')).toBe(
      'https://meet.google.com/abc-defg-hij',
    );
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

  function fakeMeetings(start: MeetingStart = { ok: true }) {
    const started: Array<{ platformId: string; url: string; pauseSends: boolean; jev: boolean }> = [];
    const left: string[] = [];
    const control: MeetingControl = {
      meetings: {
        // The core binds the chat only once it admitted the call.
        start: async (platformId, url, { pauseSends, jev }, bindChat) => {
          started.push({ platformId, url, pauseSends, jev });
          if (start.ok && bindChat && !(await bindChat())) return { ok: false, error: 'no-line' };
          return start;
        },
        leave: (platformId) => {
          left.push(platformId);
          return true;
        },
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
    expect(m.started).toEqual([
      { platformId: linePlatformId(line!.line_id), url: MEET, pauseSends: false, jev: false },
    ]);
    expect(meetCommandReply(outcome)).toContain('Andy is asking to join https://meet.google.com/abc-defg-hij');
    expect(meetCommandReply(outcome)).toContain('a turn ends on a send word.');
    expect(meetCommandReply({ kind: 'usage' }, '!meet')).toContain('!meet <Google Meet link>');
    expect(meetCommandReply({ kind: 'usage' }, '!meet')).toContain('!meet <link> pause');

    const paused = await runMeetCommand(
      mg('mg-dm'),
      null,
      OWNER,
      { ...join, pauseSends: true },
      { meetings: m.control },
    );
    expect(paused).toEqual({ kind: 'started', agentName: 'Andy', url: MEET, pauseSends: true });
    expect(m.started.at(-1)?.pauseSends).toBe(true);
    expect(meetCommandReply(paused)).toContain('a turn ends on a send word or a pause.');
    expect(meetCommandReply(paused)).not.toContain('unaddressed');

    const withJev = await runMeetCommand(
      mg('mg-dm'),
      null,
      OWNER,
      { ...join, jev: true },
      { meetings: m.control, jevAvailable: true },
    );
    expect(withJev).toEqual({ kind: 'started', agentName: 'Andy', url: MEET, jev: true });
    expect(m.started.at(-1)).toMatchObject({ pauseSends: false, jev: true });
    expect(meetCommandReply(withJev)).toContain('It may also join in unaddressed when the conversation invites it.');
    expect(meetCommandReply({ kind: 'usage' })).toContain('/meet <link> jev');
  });

  it('refuses jev without the Jev key, before any line is made or call started', async () => {
    const m = fakeMeetings();
    const outcome = await runMeetCommand(
      mg('mg-dm'),
      null,
      OWNER,
      { ...join, jev: true },
      { meetings: m.control, key: randomBytes(32), jevAvailable: false },
    );
    expect(outcome).toEqual({ kind: 'no-jev', agentName: 'Andy' });
    expect(meetCommandReply(outcome)).toContain('JEV_API_KEY');
    expect(m.started).toEqual([]);
    expect(await getVoiceModeLineForAgent('ag-1')).toBeUndefined();
  });

  it('moves an existing line to this chat only once the meeting call is admitted', async () => {
    await chat('mg-other', 'chat:other');
    await wire('mg-other', 'ag-1');
    await runMeetCommand(mg('mg-other'), null, OWNER, join, { meetings: fakeMeetings().control, key: randomBytes(32) });
    expect(await getVoiceModeLineForAgent('ag-1')).toMatchObject({ messaging_group_id: 'mg-other' });
    const refused = fakeMeetings({ ok: false, error: 'limit', body: 'No calls left this hour.', retryAfter: '60' });
    await runMeetCommand(mg('mg-dm'), null, OWNER, join, { meetings: refused.control });
    expect(await getVoiceModeLineForAgent('ag-1')).toMatchObject({ messaging_group_id: 'mg-other' });
    await runMeetCommand(mg('mg-dm'), null, OWNER, join, { meetings: fakeMeetings().control });
    expect(await getVoiceModeLineForAgent('ag-1')).toMatchObject({ messaging_group_id: 'mg-dm' });
  });

  it('needs the host key only to make a first line', async () => {
    const m = fakeMeetings();
    expect(await runMeetCommand(mg('mg-dm'), null, OWNER, join, { meetings: m.control, key: null })).toEqual({
      kind: 'no-key',
      agentName: 'Andy',
    });
    await runMeetCommand(mg('mg-dm'), null, OWNER, join, { meetings: m.control, key: randomBytes(32) });
    expect(await runMeetCommand(mg('mg-dm'), null, OWNER, join, { meetings: m.control, key: null })).toEqual({
      kind: 'started',
      agentName: 'Andy',
      url: MEET,
    });
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

  it('says when meetings or voice are off, or the bot failed, and refuses a chat with several agents', async () => {
    expect(await runMeetCommand(mg('mg-dm'), null, OWNER, join, { meetings: { meetings: null } })).toEqual({
      kind: 'not-configured',
      agentName: 'Andy',
    });
    expect(meetCommandReply({ kind: 'not-configured', agentName: 'Andy' })).toContain('RECALL_API_KEY');
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
    const limited = await runMeetCommand(mg('mg-dm'), null, OWNER, join, {
      meetings: fakeMeetings({ ok: false, error: 'limit', body: 'No minutes left.', retryAfter: '60' }).control,
    });
    expect(meetCommandReply(limited)).toBe('Andy could not join the meeting: No minutes left.');
    expect(meetCommandReply({ kind: 'failed', agentName: 'Andy', start: { ok: false, error: 'no-line' } })).toBe(
      'Andy could not join the meeting: its voice line is gone, or its caller no longer owns or administers the agent.',
    );
    await createAgentGroup({ id: 'ag-2', name: 'Dan', folder: 'ag-2', agent_provider: null, created_at: now() });
    await wire('mg-dm', 'ag-2');
    expect(await runMeetCommand(mg('mg-dm'), null, OWNER, join, { meetings: fakeMeetings().control })).toEqual({
      kind: 'several-agents',
    });
  });
});
