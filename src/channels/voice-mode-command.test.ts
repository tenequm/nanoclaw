/**
 * `/voice` against the real core: core's router hands it to the command (registered through the
 * real channel barrel) before any agent sees it, who may run it is decided by core's owner and
 * admin roles on a real test DB, and a run mints a call link whose token only the skill's table
 * knows by hash.
 */
import fs from 'fs';
import { Bot } from 'grammy';
import { Effect } from 'effect';
import { buildCommandGroup } from './telegram-grammy/commands/command-group.js';
import type { AdapterRuntime } from './telegram-grammy/runtime.js';
import type { CommandMenus } from './telegram-grammy/commands/menus.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-voice-command' };
});

const TEST_DIR = '/tmp/nanoclaw-test-voice-command';

/** Runs once right after the next lookup of an agent's line: what another /voice did in between. */
const lineLookups = vi.hoisted(() => ({ after: null as null | (() => Promise<void>) }));
vi.mock('../db/voice-mode-lines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/voice-mode-lines.js')>();
  return {
    ...actual,
    getVoiceModeLineForAgent: async (agentGroupId: string) => {
      const found = await actual.getVoiceModeLineForAgent(agentGroupId);
      const after = lineLookups.after;
      lineLookups.after = null;
      await after?.();
      return found;
    },
  };
});

import type { ChannelAdapter, InboundEvent, OutboundMessage } from './adapter.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channel-registry.js';
import './index.js'; // the real channel barrel: the voice channel brings the /voice command with it
import { createAgentGroup } from '../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../db/connection.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../db/messaging-groups.js';
import { runMigrations } from '../db/migrations/index.js';
import { findVoiceModeLineByToken, hashLinkToken, type VoiceModeLine } from '../db/voice-mode-lines.js';
import { addMember } from '../modules/permissions/db/agent-group-members.js';
import { grantRole } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { getSessionsByAgentGroup } from '../db/sessions.js';
import { getVoiceLine } from '../db/voice-lines.js';
import { resolveVoiceModeLine } from './voice-mode-line.js';
import { routeInbound } from '../router.js';
import type { MessagingGroup } from '../types.js';
import {
  handleVoiceCommand,
  parseVoiceCommand,
  runVoiceCommand,
  senderUserId,
  voiceCommandReply,
  voiceLinkLines,
} from './voice-mode-command.js';

const OWNER = 'chat:1';
const MEMBER = 'chat:2';
const SCOPED_ADMIN = 'chat:3';

const now = () => new Date().toISOString();
const callUrl = (token: string) => `https://voice.example.com/voice?t=${token}`;
const tokenOf = (link: string) => new URL(link).searchParams.get('t')!;

async function chatGroup(id: string, platformId: string, isGroup: 0 | 1 = 0) {
  await createMessagingGroup({
    id,
    channel_type: 'chat',
    platform_id: platformId,
    name: null,
    is_group: isGroup,
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

const lines = () => getDb().all<VoiceModeLine>('SELECT * FROM voice_mode_lines ORDER BY agent_group_id');
const mg = (id: string, isGroup = 0) =>
  ({ id, instance: null, channel_type: 'chat', is_group: isGroup }) as unknown as MessagingGroup;
const linkFrom = async (who: string, chat = 'mg-dm', threadId: string | null = null) => {
  const outcome = await runVoiceCommand(mg(chat), threadId, who, callUrl);
  return voiceLinkLines(outcome)[0]?.split(': ').slice(1).join(': ');
};

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  for (const id of [OWNER, MEMBER, SCOPED_ADMIN]) {
    await upsertUser({ id, kind: 'chat', display_name: null, created_at: now() });
  }
  await createAgentGroup({ id: 'ag-1', name: 'Andy', folder: 'ag-1', agent_provider: null, created_at: now() });
  await grantRole({ user_id: OWNER, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  await grantRole({
    user_id: SCOPED_ADMIN,
    role: 'admin',
    agent_group_id: 'ag-1',
    granted_by: null,
    granted_at: now(),
  });
  await addMember({ user_id: MEMBER, agent_group_id: 'ag-1', added_by: null, added_at: now() });
  await chatGroup('mg-dm', 'chat:1');
  await chatGroup('mg-other', 'chat:-100');
  await wire('mg-dm', 'ag-1');
  await wire('mg-other', 'ag-1');
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('parseVoiceCommand / senderUserId', () => {
  it('takes /voice, /voice@bot and, on Slack only, !voice, with `new` as the only argument', () => {
    expect(parseVoiceCommand('/voice', 'telegram')).toEqual({ renew: false });
    expect(parseVoiceCommand('/VOICE please', 'telegram')).toEqual({ renew: false });
    expect(parseVoiceCommand('/voice@some_bot', 'telegram')).toEqual({ renew: false });
    expect(parseVoiceCommand('/voice new', 'telegram')).toEqual({ renew: true });
    expect(parseVoiceCommand('/voice@some_bot  NEW', 'telegram')).toEqual({ renew: true });
    expect(parseVoiceCommand('!voice new', 'slack')).toEqual({ renew: true });
    expect(parseVoiceCommand('/voice newer', 'telegram')).toEqual({ renew: false });
    expect(parseVoiceCommand('!voice', 'slack')).toEqual({ renew: false });
    expect(parseVoiceCommand('!voice', 'telegram')).toBeNull();
    expect(parseVoiceCommand('/voices', 'telegram')).toBeNull();
    expect(parseVoiceCommand('my /voice', 'telegram')).toBeNull();
    expect(parseVoiceCommand('  /voice\tnew', 'telegram')).toEqual({ renew: true });
    expect(parseVoiceCommand('/voice@', 'telegram')).toEqual({ renew: false });
    expect(parseVoiceCommand('/voice-mode', 'telegram')).toBeNull();
    expect(parseVoiceCommand('', 'telegram')).toBeNull();
  });

  it('reads the sender the way the permissions module does, namespacing a bare handle', () => {
    const ev = (content: unknown) =>
      ({ channelType: 'slack', message: { content: JSON.stringify(content) } }) as unknown as InboundEvent;
    expect(senderUserId(ev({ senderId: 'U1' }))).toBe('slack:U1');
    expect(senderUserId(ev({ author: { userId: 'U2' } }))).toBe('slack:U2');
    expect(senderUserId(ev({ sender: 'telegram:5' }))).toBe('telegram:5');
    expect(senderUserId(ev({ text: '/voice' }))).toBeNull();
  });
});

describe('runVoiceCommand', () => {
  it('creates the line on first use, storing only the token hash, bound to this chat', async () => {
    const link = await linkFrom(OWNER);
    const token = tokenOf(link!);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    const [line] = await lines();
    expect(line).toMatchObject({
      agent_group_id: 'ag-1',
      owner_user_id: OWNER,
      messaging_group_id: 'mg-dm',
      thread_id: null,
      token_hash: hashLinkToken(token),
    });
    expect(line.line_id).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(line)).not.toContain(token);
    expect((await findVoiceModeLineByToken(token))?.line_id).toBe(line.line_id);
  });

  it("never replaces the link another admin's /voice created after this run looked for a line", async () => {
    let ownerLink: string | undefined;
    lineLookups.after = async () => {
      ownerLink = await linkFrom(OWNER);
    };
    expect(await runVoiceCommand(mg('mg-other'), null, SCOPED_ADMIN, callUrl)).toEqual({
      kind: 'done',
      results: [{ ok: false, agentName: 'Andy', reason: 'other-caller' }],
    });
    expect(await lines()).toEqual([
      expect.objectContaining({ owner_user_id: OWNER, token_hash: hashLinkToken(tokenOf(ownerLink!)) }),
    ]);
  });

  it('on later runs only moves the call chat: no new link, the old one and its caller stay', async () => {
    const first = tokenOf((await linkFrom(OWNER))!);
    const [before] = await lines();
    const outcome = await runVoiceCommand(mg('mg-other'), null, OWNER, callUrl);
    expect(outcome).toEqual({ kind: 'done', results: [{ ok: true, agentName: 'Andy', rebound: true }] });
    expect(voiceLinkLines(outcome)).toEqual([]);
    expect(voiceCommandReply(outcome)).toBe(
      'Calls with Andy now talk in this chat. Lost the link? Send /voice new for a fresh one (the old one stops working).',
    );
    const after = await lines();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      line_id: before.line_id,
      owner_user_id: OWNER,
      messaging_group_id: 'mg-other',
      token_hash: before.token_hash,
    });
    expect((await findVoiceModeLineByToken(first))?.line_id).toBe(before.line_id);
  });

  it("never moves another admin's line: it stays put, and the sender is told /voice new takes it over", async () => {
    await linkFrom(OWNER);
    const [before] = await lines();
    const outcome = await runVoiceCommand(mg('mg-other'), null, SCOPED_ADMIN, callUrl);
    expect(outcome).toEqual({ kind: 'done', results: [{ ok: false, agentName: 'Andy', reason: 'other-caller' }] });
    expect(voiceCommandReply(outcome, '!voice')).toBe(
      "Calls with Andy are on another admin's link, so they stay where they talk. Send !voice new to take the line over (that link stops working).",
    );
    expect(await lines()).toEqual([before]);
  });

  it('with `new` re-mints: the old link stops working, the line and its id stay', async () => {
    const first = tokenOf((await linkFrom(OWNER))!);
    const [before] = await lines();
    const outcome = await runVoiceCommand(mg('mg-other'), null, SCOPED_ADMIN, callUrl, true);
    const second = tokenOf(voiceLinkLines(outcome)[0].split(': ').slice(1).join(': '));
    expect(voiceCommandReply(outcome)).toContain('Any earlier link no longer works.');
    const after = await lines();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      line_id: before.line_id,
      owner_user_id: SCOPED_ADMIN,
      messaging_group_id: 'mg-other',
    });
    expect(await findVoiceModeLineByToken(first)).toBeUndefined();
    expect((await findVoiceModeLineByToken(second))?.line_id).toBe(before.line_id);
  });

  it('decides by core roles: unknown senders dropped, members refused, owners and scoped admins served', async () => {
    expect(await runVoiceCommand(mg('mg-dm'), null, null, callUrl)).toEqual({ kind: 'drop' });
    expect(await runVoiceCommand(mg('mg-dm'), null, 'chat:999', callUrl)).toEqual({ kind: 'drop' });
    const refused = await runVoiceCommand(mg('mg-dm'), null, MEMBER, callUrl);
    expect(refused).toEqual({ kind: 'refused' });
    expect(voiceCommandReply(refused)).toBe('Only an owner or admin of this agent can use /voice.');
    expect(await lines()).toEqual([]);
    expect(await linkFrom(SCOPED_ADMIN)).toMatch(/^https:\/\/voice\.example\.com\/voice\?t=/);
  });

  it('treats each channel account as its own user, as core does: a role must be granted to each', async () => {
    const SLACK_ACCOUNT = 'slack:U1';
    await upsertUser({ id: SLACK_ACCOUNT, kind: 'slack', display_name: null, created_at: now() });
    expect(await runVoiceCommand(mg('mg-dm'), null, SLACK_ACCOUNT, callUrl)).toEqual({ kind: 'refused' });
    await grantRole({
      user_id: SLACK_ACCOUNT,
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: null,
      granted_at: now(),
    });
    expect(await linkFrom(SLACK_ACCOUNT)).toBeDefined();
  });

  it('rotates nothing when the voice-mode channel is not running here', async () => {
    await linkFrom(OWNER);
    const [before] = await lines();
    expect(voiceCommandReply(await runVoiceCommand(mg('mg-dm'), null, OWNER, null, true))).toBe(
      'Voice calls are off on this host (the voice-mode channel is not configured).',
    );
    expect((await lines())[0].token_hash).toBe(before.token_hash);
  });

  it('renders one link per agent and says calls now talk here', async () => {
    const reply = voiceCommandReply(await runVoiceCommand(mg('mg-dm'), null, OWNER, callUrl))!;
    expect(reply).toMatch(/^🎙 Talk to Andy: https:\/\/voice\.example\.com\/voice\?t=[0-9a-f]{32}\n\n/);
    expect(reply).toContain('Calls now talk in this chat, until /voice is run in another one.');
    expect(reply).not.toContain('earlier link');
  });
});

describe('findVoiceModeLineByToken', () => {
  it('opens a line only for its exact current token', async () => {
    const token = tokenOf((await linkFrom(OWNER))!);
    expect(await findVoiceModeLineByToken(token)).toBeDefined();
    expect(await findVoiceModeLineByToken(token.replace(/.$/, (c) => (c === '0' ? '1' : '0')))).toBeUndefined();
    expect(await findVoiceModeLineByToken(token.toUpperCase())).toBeUndefined();
    expect(await findVoiceModeLineByToken('')).toBeUndefined();
    expect(await findVoiceModeLineByToken(hashLinkToken(token))).toBeUndefined();
  });
});

describe('handleVoiceCommand (the interceptor)', () => {
  const delivered: Array<{ platformId: string; threadId: string | null; message: OutboundMessage }> = [];

  async function startChat(supportsThreads: boolean, voiceRunning = false, failLinks = false) {
    delivered.length = 0;
    const defaults = {
      dm: {
        engageMode: 'pattern' as const,
        engagePattern: '.',
        threads: false,
        unknownSenderPolicy: 'strict' as const,
      },
      group: { engageMode: 'mention' as const, threads: true, unknownSenderPolicy: 'strict' as const },
      mentions: 'platform' as const,
    };
    registerChannelAdapter('chat', {
      factory: (): ChannelAdapter => ({
        name: 'chat',
        channelType: 'chat',
        supportsThreads,
        defaults,
        setup: async () => {},
        teardown: async () => {},
        isConnected: () => true,
        deliver: async (platformId, threadId, message) => {
          if (failLinks && JSON.stringify(message).includes('?t=')) throw new Error('send failed');
          delivered.push({ platformId, threadId, message });
          return undefined;
        },
      }),
      defaults,
    });
    if (voiceRunning) {
      // Stands in for a running voice channel: only its call-link builder is used.
      registerChannelAdapter('voice-mode', {
        factory: () =>
          ({
            name: 'voice-mode',
            channelType: 'voice-mode',
            supportsThreads: false,
            defaults,
            setup: async () => {},
            teardown: async () => {},
            isConnected: () => true,
            deliver: async () => undefined,
            callUrl,
          }) as ChannelAdapter,
        defaults,
      });
    }
    await initChannelAdapters(() => ({
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));
  }

  const event = (
    text: string,
    sender: string,
    platformId = 'chat:1',
    threadId: string | null = null,
  ): InboundEvent => ({
    channelType: 'chat',
    instance: 'chat',
    platformId,
    threadId,
    message: { id: '171', kind: 'chat', content: JSON.stringify({ text, senderId: sender }), timestamp: now() },
  });

  it('answers the owner in their direct chat with the link, straight through the adapter', async () => {
    await startChat(false);
    expect(await handleVoiceCommand(event('/voice', OWNER), callUrl)).toBe(true);
    expect(delivered).toEqual([
      {
        platformId: 'chat:1',
        threadId: null,
        message: { kind: 'chat', content: { text: expect.stringMatching(/voice\?t=[0-9a-f]{32}/) } },
      },
    ]);
  });

  it('tells the sender, without the link, when a minted link could not be delivered', async () => {
    await startChat(false, false, true);
    expect(await handleVoiceCommand(event('/voice', OWNER), callUrl)).toBe(true);
    expect(await lines()).toHaveLength(1);
    expect(delivered).toEqual([
      {
        platformId: 'chat:1',
        threadId: null,
        message: { kind: 'chat', content: { text: 'I could not deliver your call link; run /voice new again.' } },
      },
    ]);
  });

  it("is claimed from core's routeInbound before any agent session sees it", async () => {
    await startChat(false, true);
    await routeInbound(event('/voice', OWNER));
    expect(delivered).toEqual([
      {
        platformId: 'chat:1',
        threadId: null,
        message: { kind: 'chat', content: { text: expect.stringMatching(/voice\?t=[0-9a-f]{32}/) } },
      },
    ]);
    expect(await getSessionsByAgentGroup('ag-1')).toEqual([]);
    expect(await lines()).toHaveLength(1);
  });

  it('claims the command silently for an unknown sender or an unwired chat, and leaves other messages alone', async () => {
    await startChat(false);
    expect(await handleVoiceCommand(event('/voice', 'chat:999'), callUrl)).toBe(true);
    expect(await handleVoiceCommand(event('/voice', OWNER, 'chat:unwired'), callUrl)).toBe(true);
    expect(delivered).toEqual([]);
    expect(await lines()).toEqual([]);
    expect(await handleVoiceCommand(event('hello', OWNER), callUrl)).toBe(false);
  });

  it('in a group chat sends the link to the sender directly and tells the group only where calls talk', async () => {
    await startChat(false);
    await chatGroup('mg-group', 'chat:G1', 1);
    await wire('mg-group', 'ag-1');
    await handleVoiceCommand(event('/voice', OWNER, 'chat:G1'), callUrl);
    const inGroup = delivered.filter((d) => d.platformId === 'chat:G1');
    const direct = delivered.filter((d) => d.platformId !== 'chat:G1');
    expect(inGroup).toHaveLength(1);
    expect(JSON.stringify(inGroup[0].message)).not.toContain('?t=');
    expect(JSON.stringify(inGroup[0].message)).toContain('Your call link is in our direct chat.');
    expect(direct).toHaveLength(1);
    expect(JSON.stringify(direct[0].message)).toMatch(/voice\?t=[0-9a-f]{32}/);
    expect((await lines())[0]).toMatchObject({ messaging_group_id: 'mg-group' });
  });

  it('in a group chat a later /voice only confirms the move there, and /voice new sends a fresh link directly', async () => {
    await startChat(false);
    await chatGroup('mg-group', 'chat:G1', 1);
    await wire('mg-group', 'ag-1');
    await linkFrom(OWNER);
    const [before] = await lines();
    await handleVoiceCommand(event('/voice', OWNER, 'chat:G1'), callUrl);
    expect(delivered).toEqual([
      {
        platformId: 'chat:G1',
        threadId: null,
        message: { kind: 'chat', content: { text: expect.stringContaining('Calls with Andy now talk in this chat.') } },
      },
    ]);
    expect((await lines())[0]).toMatchObject({ messaging_group_id: 'mg-group', token_hash: before.token_hash });
    delivered.length = 0;
    await handleVoiceCommand(event('/voice new', OWNER, 'chat:G1'), callUrl);
    const direct = delivered.filter((d) => d.platformId !== 'chat:G1');
    expect(direct).toHaveLength(1);
    expect(JSON.stringify(direct[0].message)).toMatch(/voice\?t=[0-9a-f]{32}/);
    expect(JSON.stringify(delivered.filter((d) => d.platformId === 'chat:G1'))).not.toContain('?t=');
    expect((await lines())[0].token_hash).not.toBe(before.token_hash);
  });

  it('opens no direct chat for a group member without the role', async () => {
    await startChat(false);
    await chatGroup('mg-group', 'chat:G1', 1);
    await wire('mg-group', 'ag-1');
    await handleVoiceCommand(event('/voice', MEMBER, 'chat:G1'), callUrl);
    expect(delivered).toEqual([
      {
        platformId: 'chat:G1',
        threadId: null,
        message: { kind: 'chat', content: { text: 'Only an owner or admin of this agent can use /voice.' } },
      },
    ]);
    expect(await getDb().all("SELECT id FROM messaging_groups WHERE platform_id = 'chat:2'")).toEqual([]);
  });

  it('binds a thread where the wiring keeps threads, and a top-level command to the chat itself', async () => {
    await startChat(true);
    await chatGroup('mg-chan', 'chat:C1', 1);
    await wire('mg-chan', 'ag-1');
    await handleVoiceCommand(event('/voice', OWNER, 'chat:C1', 'chat:C1:99'), callUrl);
    expect((await lines())[0]).toMatchObject({ messaging_group_id: 'mg-chan', thread_id: 'chat:C1:99' });
    expect(delivered.at(-1)?.threadId).toBe('chat:C1:99');
    // Top level: the platform's thread id is the command's own id.
    await handleVoiceCommand(event('/voice', OWNER, 'chat:C1', 'chat:C1:171'), callUrl);
    expect((await lines())[0]).toMatchObject({ thread_id: null });
    await getDb().run("UPDATE messaging_group_agents SET threads = 0 WHERE messaging_group_id = 'mg-chan'");
    await handleVoiceCommand(event('/voice', OWNER, 'chat:C1', 'chat:C1:99'), callUrl);
    expect((await lines())[0]).toMatchObject({ messaging_group_id: 'mg-chan', thread_id: null });
  });
});

/** A line from before the rename, as main left it: its voice user, chat, wiring and OWNER as its owner. */
const SAVED_LINE = 'voice:legacy';
async function seedSavedLine(): Promise<void> {
  await upsertUser({ id: SAVED_LINE, kind: 'voice', display_name: 'Caller', created_at: now() });
  await addMember({ user_id: SAVED_LINE, agent_group_id: 'ag-1', added_by: null, added_at: now() });
  await createMessagingGroup({
    id: 'legacy-mg',
    channel_type: 'voice',
    platform_id: SAVED_LINE,
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await wire('legacy-mg', 'ag-1');
  await getDb().run(
    "UPDATE messaging_group_agents SET sender_scope = 'known' WHERE messaging_group_id = ?",
    'legacy-mg',
  );
  await getDb().run('INSERT INTO voice_lines (line_messaging_group_id, updated_at) VALUES (?, ?)', 'legacy-mg', now());
  await getDb().run(
    'INSERT INTO voice_line_owners (line_messaging_group_id, owner_user_id) VALUES (?, ?)',
    'legacy-mg',
    OWNER,
  );
}
const SAVED_LINK = 'https://voice.example.com/voice?t=saved';
const savedLink = (platformId: string) => (platformId === SAVED_LINE ? SAVED_LINK : null);

it('moves a saved main line without minting, and only /voice new retires its link', async () => {
  const id = SAVED_LINE;
  await seedSavedLine();
  expect(await resolveVoiceModeLine(id)).not.toBeNull();
  expect(await runVoiceCommand(mg('mg-other'), null, OWNER, callUrl)).toMatchObject({ results: [{ rebound: true }] });
  expect(await lines()).toEqual([]);
  expect((await getVoiceLine('legacy-mg'))?.target_messaging_group_id).toBe('mg-other');
  expect(await runVoiceCommand(mg('mg-dm'), null, SCOPED_ADMIN, callUrl)).toMatchObject({
    results: [{ reason: 'other-caller' }],
  });
  expect(await resolveVoiceModeLine(id)).not.toBeNull();
  expect(await runVoiceCommand(mg('mg-dm'), null, OWNER, callUrl, true)).toMatchObject({
    results: [{ replaced: true }],
  });
  expect(await resolveVoiceModeLine(id)).toBeNull();
});

it("gives a saved main line's owner its saved link when /voice moves it, privately in a group", async () => {
  await seedSavedLine();
  expect(await runVoiceCommand(mg('mg-other'), null, OWNER, callUrl, false, savedLink)).toEqual({
    kind: 'done',
    results: [{ ok: true, agentName: 'Andy', link: SAVED_LINK, replaced: false }],
  });
  expect(await lines()).toEqual([]);

  const delivered: Array<{ platformId: string; text: string }> = [];
  registerChannelAdapter('chat', {
    factory: (): ChannelAdapter => ({
      name: 'chat',
      channelType: 'chat',
      supportsThreads: false,
      setup: async () => {},
      teardown: async () => {},
      isConnected: () => true,
      deliver: async (platformId, _threadId, message) => {
        delivered.push({ platformId, text: (message.content as { text: string }).text });
        return undefined;
      },
    }),
  });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  await chatGroup('mg-group', 'chat:G1', 1);
  await wire('mg-group', 'ag-1');
  const event: InboundEvent = {
    channelType: 'chat',
    instance: 'chat',
    platformId: 'chat:G1',
    threadId: null,
    message: { id: '9', kind: 'chat', content: JSON.stringify({ text: '/voice', senderId: OWNER }), timestamp: now() },
  };
  await handleVoiceCommand(event, callUrl, savedLink);
  expect(delivered.filter((d) => d.platformId === 'chat:G1').map((d) => d.text)).toEqual([
    'Calls now talk in this chat, until /voice is run in another one. Your call link is in our direct chat.',
  ]);
  expect(delivered.filter((d) => d.platformId !== 'chat:G1').map((d) => d.text)).toEqual([
    `🎙 Talk to Andy: ${SAVED_LINK}`,
  ]);
  expect((await getVoiceLine('legacy-mg'))?.target_messaging_group_id).toBe('mg-group');
});

it('native Telegram /voice and /voice new use the same line handler as the router', async () => {
  const actor = 'telegram:1';
  await upsertUser({ id: actor, kind: 'telegram', display_name: 'Caller', created_at: now() });
  await grantRole({ user_id: actor, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  await createMessagingGroup({
    id: 'native-mg',
    channel_type: 'telegram',
    platform_id: actor,
    is_group: 0,
    name: null,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await wire('native-mg', 'ag-1');
  const delivered: OutboundMessage[] = [];
  const adapter = (name: string): ChannelAdapter => ({
    name,
    channelType: name,
    supportsThreads: false,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async (_id, _thread, message) => {
      delivered.push(message);
      return undefined;
    },
  });
  registerChannelAdapter('telegram', { factory: () => adapter('telegram') });
  registerChannelAdapter('voice-mode', {
    factory: () => ({
      ...adapter('voice-mode'),
      handleVoiceCommand: (event: InboundEvent) => handleVoiceCommand(event, callUrl),
    }),
  });
  await initChannelAdapters(() => ({
    onInboundEvent: () => {},
    onInbound: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  const bot = new Bot('1:fixture');
  bot.botInfo = {
    id: 9,
    is_bot: true,
    first_name: 'Fixture',
    username: 'fixture_bot',
    can_join_groups: true,
    can_read_all_group_messages: true,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  bot.use(buildCommandGroup({ runPromise: Effect.runPromise } as unknown as AdapterRuntime, {} as CommandMenus));
  const send = (text: string, id: number) =>
    bot.handleUpdate({
      update_id: id,
      message: {
        message_id: id,
        date: 1,
        chat: { id: 1, type: 'private', first_name: 'Caller' },
        from: { id: 1, is_bot: false, first_name: 'Caller' },
        text,
        entities: [{ type: 'bot_command', offset: 0, length: 6 }],
      },
    });
  await send('/voice', 1);
  expect(delivered).toHaveLength(1);
  expect(JSON.stringify(delivered[0])).toContain('/voice?t=');
  const [first] = await lines();
  await send('/voice', 2);
  expect((await lines())[0].token_hash).toBe(first.token_hash);
  await send('/voice new', 3);
  expect((await lines())[0].token_hash).not.toBe(first.token_hash);
  expect(await getSessionsByAgentGroup('ag-1')).toEqual([]);
});
