/**
 * `/voice` against the real core: core's router hands it to the command (registered through the
 * real channel barrel) before any agent sees it, who may run it is decided by core's owner and
 * admin roles on a real test DB, and a run mints a call link the skill's table knows by hash and
 * keeps sealed for its caller.
 */
import fs from 'fs';
import { randomBytes } from 'node:crypto';
import { Bot } from 'grammy';
import { Effect } from 'effect';
import { buildCommandGroup } from './telegram-grammy/commands/command-group.js';
import { commandList } from './telegram-grammy/commands/scope-sync.js';
import type { AdapterRuntime } from './telegram-grammy/runtime.js';
import type { CommandMenus } from './telegram-grammy/commands/menus.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** The host key `encryptionKey()` returns; null as on a host without one. */
const hostKey = vi.hoisted(() => ({ value: null as Buffer | null }));
vi.mock('../secret-seal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../secret-seal.js')>();
  return { ...actual, encryptionKey: () => hostKey.value };
});

const TEST_DIR = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  return mkdtempSync(`${tmpdir()}/nanoclaw-test-voice-command-`);
});
vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

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
import {
  findVoiceModeLineByToken,
  hashLinkToken,
  mintVoiceModeLine,
  sealVoiceModeLink,
  type VoiceModeLineRow,
} from '../db/voice-mode-lines.js';
import { log } from '../log.js';
import { addMember } from '../modules/permissions/db/agent-group-members.js';
import { grantRole, revokeRole } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { getSessionsByAgentGroup } from '../db/sessions.js';
import { routeInbound } from '../router.js';
import type { MessagingGroup } from '../types.js';
import {
  handleVoiceCommand,
  parseVoiceCommand,
  type PrivateReply,
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

const lines = () => getDb().all<VoiceModeLineRow>('SELECT * FROM voice_mode_lines ORDER BY agent_group_id');
const mg = (id: string, isGroup = 0) =>
  ({ id, instance: null, channel_type: 'chat', is_group: isGroup }) as unknown as MessagingGroup;
const run = (who: string | null, chat = 'mg-dm', renew = false) =>
  runVoiceCommand(mg(chat), null, who, { callUrl, renew });
const linkOf = (outcome: Awaited<ReturnType<typeof runVoiceCommand>>) =>
  voiceLinkLines(outcome)[0]?.split(': ').slice(1).join(': ');
const linkFrom = async (who: string, chat = 'mg-dm', renew = false) => linkOf(await run(who, chat, renew));
/** Nothing logged anywhere may carry a call link. */
const loggedLinks = () =>
  [log.info, log.warn, log.error, log.debug].flatMap((fn) =>
    vi.mocked(fn).mock.calls.filter((call) => /[0-9a-f]{32}/.test(JSON.stringify(call))),
  );

beforeEach(async () => {
  hostKey.value = randomBytes(32);
  for (const fn of [log.info, log.warn, log.error, log.debug]) vi.mocked(fn).mockClear();
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
  expect(loggedLinks()).toEqual([]);
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
  it('creates the line on first use, bound to this chat, with the token hashed and sealed', async () => {
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
    expect(line.link_sealed).toMatch(/^v1:/);
    expect(JSON.stringify(line)).not.toContain(token);
    expect((await findVoiceModeLineByToken(token))?.line_id).toBe(line.line_id);
  });

  it('shows the caller the same link again on later runs, moving only the call chat', async () => {
    const first = await linkFrom(OWNER);
    const [before] = await lines();
    const outcome = await run(OWNER, 'mg-other');
    expect(linkOf(outcome)).toBe(first);
    expect(voiceCommandReply(outcome)).toBe(
      `🎙 Talk to Andy: ${first}\n\nCalls talk in this chat, until /voice is run in another one.`,
    );
    const after = await lines();
    expect(after).toEqual([{ ...before, messaging_group_id: 'mg-other', updated_at: after[0].updated_at }]);
  });

  it("never shows or moves another caller's line, and names whose it is", async () => {
    await getDb().run("UPDATE users SET display_name = 'Olga' WHERE id = ?", OWNER);
    await linkFrom(OWNER);
    const [before] = await lines();
    for (const renew of [false, true]) {
      const outcome = await run(SCOPED_ADMIN, 'mg-other', renew);
      expect(outcome).toEqual({
        kind: 'done',
        results: [{ ok: false, agentGroupId: 'ag-1', agentName: 'Andy', reason: 'other-caller', caller: 'Olga' }],
      });
      expect(voiceCommandReply(outcome, '!voice')).toBe(
        "Andy: this line is Olga's; only they can get its link or move its calls.",
      );
    }
    expect(await lines()).toEqual([before]);
  });

  it("never takes the line another admin's /voice created after this run looked for one", async () => {
    let ownerLink: string | undefined;
    lineLookups.after = async () => {
      ownerLink = await linkFrom(OWNER);
    };
    expect(await run(SCOPED_ADMIN, 'mg-other')).toMatchObject({
      kind: 'done',
      results: [{ ok: false, reason: 'other-caller' }],
    });
    expect(await lines()).toEqual([
      expect.objectContaining({ owner_user_id: OWNER, token_hash: hashLinkToken(tokenOf(ownerLink!)) }),
    ]);
  });

  it("shows the winner's link to the same caller's concurrent first run", async () => {
    let racing: string | undefined;
    lineLookups.after = async () => {
      racing = await linkFrom(OWNER);
    };
    expect(await linkFrom(OWNER)).toBe(racing);
  });

  it("with `new` re-mints only the caller's own link: the old one stops working, the line and its id stay", async () => {
    const first = tokenOf((await linkFrom(OWNER))!);
    const [before] = await lines();
    const outcome = await run(OWNER, 'mg-other', true);
    const second = tokenOf(linkOf(outcome)!);
    expect(second).not.toBe(first);
    expect(voiceCommandReply(outcome)).toContain('Any earlier link no longer works.');
    const after = await lines();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ line_id: before.line_id, owner_user_id: OWNER, messaging_group_id: 'mg-other' });
    expect(await findVoiceModeLineByToken(first)).toBeUndefined();
    expect((await findVoiceModeLineByToken(second))?.line_id).toBe(before.line_id);
    expect(await linkFrom(OWNER)).toBe(linkOf(outcome));
  });

  it('decides by core roles: unknown senders dropped, members refused, owners and scoped admins served', async () => {
    expect(await run(null)).toEqual({ kind: 'drop' });
    expect(await run('chat:999')).toEqual({ kind: 'drop' });
    const refused = await run(MEMBER);
    expect(refused).toEqual({ kind: 'refused' });
    expect(voiceCommandReply(refused)).toBe('Only an owner or admin of this agent can use /voice.');
    expect(await lines()).toEqual([]);
    expect(await linkFrom(SCOPED_ADMIN)).toMatch(/^https:\/\/voice\.example\.com\/voice\?t=/);
  });

  it('treats each channel account as its own user, as core does: a role must be granted to each', async () => {
    const SLACK_ACCOUNT = 'slack:U1';
    await upsertUser({ id: SLACK_ACCOUNT, kind: 'slack', display_name: null, created_at: now() });
    expect(await run(SLACK_ACCOUNT)).toEqual({ kind: 'refused' });
    await grantRole({
      user_id: SLACK_ACCOUNT,
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: null,
      granted_at: now(),
    });
    expect(await linkFrom(SLACK_ACCOUNT)).toBeDefined();
  });

  it('mints, rotates and moves nothing when the voice-mode channel is not running here', async () => {
    await linkFrom(OWNER);
    const before = await lines();
    const outcome = await runVoiceCommand(mg('mg-other'), null, OWNER, { callUrl: null, renew: true });
    expect(voiceCommandReply(outcome)).toBe(
      'Andy: voice calls are off on this host (the voice-mode channel is not configured).',
    );
    expect(await lines()).toEqual(before);
  });

  it('mints, rotates, shows and moves nothing without the host key; calls still open by hash', async () => {
    const token = tokenOf((await linkFrom(OWNER))!);
    const before = await lines();
    hostKey.value = null;
    for (const renew of [false, true]) {
      const outcome = await run(OWNER, 'mg-other', renew);
      expect(voiceCommandReply(outcome)).toBe(
        'Andy: call link storage is not set up on this host, so no link can be shown or made.',
      );
    }
    expect(await lines()).toEqual(before);
    expect(await findVoiceModeLineByToken(token)).toBeDefined();
    await getDb().run('DELETE FROM voice_mode_lines');
    expect(voiceLinkLines(await run(OWNER))).toEqual([]);
    expect(await lines()).toEqual([]);
  });

  it('a sealed link that does not open with this key is reported, never replaced unasked, and sealed again by its next call', async () => {
    const token = tokenOf(await linkFrom(OWNER));
    const [before] = await lines();
    hostKey.value = randomBytes(32);
    const outcome = await run(OWNER);
    expect(voiceLinkLines(outcome)).toEqual([]);
    expect(voiceCommandReply(outcome)).toBe(
      'Andy: calls now talk in this chat, but its stored link cannot be read on this host: it shows here after its next call, or send /voice new for a fresh one (calls on the old link end).',
    );
    expect((await lines())[0]).toMatchObject({ token_hash: before.token_hash, link_sealed: null });
    const line = (await findVoiceModeLineByToken(token))!;
    await sealVoiceModeLink(line, token, hostKey.value!);
    expect(tokenOf(await linkFrom(OWNER))).toBe(token);
  });

  it('a sealed link from another row does not open: the row id is authenticated', async () => {
    await linkFrom(OWNER);
    await createAgentGroup({ id: 'ag-2', name: 'Bea', folder: 'ag-2', agent_provider: null, created_at: now() });
    await wire('mg-dm', 'ag-2');
    await run(OWNER);
    const [a, b] = await lines();
    await getDb().run(
      'UPDATE voice_mode_lines SET link_sealed = ?, token_hash = ? WHERE line_id = ?',
      a.link_sealed,
      a.token_hash + 'x',
      b.line_id,
    );
    const outcome = await run(OWNER);
    expect(outcome).toMatchObject({ results: [{ ok: true }, { ok: false, reason: 'unreadable' }] });
  });

  it('a line minted before sealing, or re-minted by an older host, shows after its next call, never re-minted', async () => {
    await linkFrom(OWNER);
    const [sealed] = await lines();
    // An older host's /voice new: a fresh hash, and the sealed link it does not know about left in place.
    const target = { agentGroupId: 'ag-1', ownerUserId: OWNER, messagingGroupId: 'mg-dm', threadId: null };
    const { token } = await mintVoiceModeLine(target);
    await getDb().run('UPDATE voice_mode_lines SET link_sealed = ?', sealed.link_sealed);
    for (let i = 0; i < 2; i++) {
      const outcome = await run(OWNER);
      expect(voiceLinkLines(outcome)).toEqual([]);
      expect(voiceCommandReply(outcome)).toBe(
        'Andy: calls now talk in this chat. Its link predates stored links: it shows here after its next call, or send /voice new for a fresh one (calls on the old link end).',
      );
    }
    const [unsealed] = await lines();
    expect(unsealed).toMatchObject({ token_hash: hashLinkToken(token), link_sealed: null });
    // The next call opens the line by its token and seals it.
    await sealVoiceModeLink(unsealed, token, hostKey.value!);
    expect(await linkFrom(OWNER)).toBe(callUrl(token));
  });

  it('seals a link only once, and only the current one', async () => {
    const target = { agentGroupId: 'ag-1', ownerUserId: OWNER, messagingGroupId: 'mg-dm', threadId: null };
    const old = await mintVoiceModeLine(target);
    const current = await mintVoiceModeLine(target);
    await sealVoiceModeLink(old.line, old.token, hostKey.value!);
    expect((await lines())[0].link_sealed).toBeNull();
    await sealVoiceModeLink(current.line, current.token, hostKey.value!);
    const [sealed] = await lines();
    expect(sealed.link_sealed).toMatch(/^v1:/);
    await sealVoiceModeLink({ ...current.line, link_sealed: null }, current.token, hostKey.value!);
    expect((await lines())[0].link_sealed).toBe(sealed.link_sealed);
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

  it('keeps the link when the reply could not be delivered: the next /voice shows it, nothing is logged with it', async () => {
    await startChat(false, false, true);
    expect(await handleVoiceCommand(event('/voice', OWNER), callUrl)).toBe(true);
    expect(delivered).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith('/voice reply could not be delivered', { channelType: 'chat', err: 'Error' });
    const [line] = await lines();
    await startChat(false);
    await handleVoiceCommand(event('/voice', OWNER), callUrl);
    expect((await lines())[0].token_hash).toBe(line.token_hash);
    expect(JSON.stringify(delivered)).toMatch(/voice\?t=[0-9a-f]{32}/);
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

  async function groupChat() {
    await chatGroup('mg-group', 'chat:G1', 1);
    await wire('mg-group', 'ag-1');
  }
  const inGroup = () => delivered.filter((d) => d.platformId === 'chat:G1');
  const direct = () => delivered.filter((d) => d.platformId !== 'chat:G1');
  const textOf = (d: { message: OutboundMessage }) => (d.message.content as { text: string }).text;

  it('in a group chat without a private reply sends the link to the direct chat, and only a pointer to the group', async () => {
    await startChat(false);
    await groupChat();
    for (let i = 0; i < 2; i++) {
      delivered.length = 0;
      await handleVoiceCommand(event('/voice', OWNER, 'chat:G1'), callUrl);
      expect(inGroup().map(textOf)).toEqual(['Your call link is in our direct chat.']);
      expect(direct()).toHaveLength(1);
      expect(textOf(direct()[0])).toMatch(/voice\?t=[0-9a-f]{32}/);
    }
    expect((await lines())[0]).toMatchObject({ messaging_group_id: 'mg-group' });
  });

  it('in a group chat with a private reply, the link goes there and nowhere else', async () => {
    await startChat(false);
    await groupChat();
    const privately: string[] = [];
    await handleVoiceCommand(event('/voice', OWNER, 'chat:G1'), callUrl, async (text) => {
      privately.push(text);
      return 'sent';
    });
    expect(delivered).toEqual([]);
    expect(privately).toHaveLength(1);
    expect(privately[0]).toMatch(/^🎙 Talk to Andy: https:\/\/voice\.example\.com\/voice\?t=[0-9a-f]{32}\n\n/);
    // A refusal is private too.
    await handleVoiceCommand(event('/voice', MEMBER, 'chat:G1'), callUrl, async (text) => {
      privately.push(text);
      return 'sent';
    });
    expect(privately[1]).toBe('Only an owner or admin of this agent can use /voice.');
    expect(delivered).toEqual([]);
  });

  it('falls back to the direct chat when the private reply is unavailable, and never posts the link in the group', async () => {
    await startChat(false);
    await groupChat();
    await handleVoiceCommand(event('/voice', OWNER, 'chat:G1'), callUrl, async () => 'unavailable');
    expect(inGroup().map(textOf)).toEqual(['Your call link is in our direct chat.']);
    expect(textOf(direct()[0])).toMatch(/voice\?t=[0-9a-f]{32}/);
  });

  it('answers without the link when neither the private reply nor the direct chat works', async () => {
    await startChat(false);
    await groupChat();
    const chat = (await import('./channel-registry.js')).getChannelAdapterExact('chat')!;
    const deliver = chat.deliver.bind(chat);
    chat.deliver = async (platformId, threadId, message) => {
      if (platformId !== 'chat:G1')
        throw Object.assign(new Error('Forbidden: bot was blocked by the user'), { payload: message });
      return deliver(platformId, threadId, message);
    };
    await handleVoiceCommand(event('/voice', OWNER, 'chat:G1'), callUrl, async () => 'unavailable');
    expect(delivered.map(textOf)).toEqual([
      'I cannot message you privately here: start a direct chat with me, then run /voice again.',
    ]);
    expect(await lines()).toHaveLength(1);
  });

  it('replaces a link whose private reply went public, and sends the new one privately', async () => {
    await startChat(false);
    await groupChat();
    let exposed = '';
    await handleVoiceCommand(event('/voice', OWNER, 'chat:G1'), callUrl, async (text) => {
      exposed = text;
      return 'public';
    });
    const old = tokenOf(exposed.match(/https:\S+/)![0]);
    expect(await findVoiceModeLineByToken(old)).toBeUndefined();
    expect(inGroup().map(textOf)).toEqual(['Your call link is in our direct chat.']);
    const fresh = textOf(direct()[0]);
    expect(fresh).toContain('The link I sent was visible to the whole chat, so it was replaced');
    expect(await findVoiceModeLineByToken(tokenOf(fresh.match(/https:\S+/)![0]))).toBeDefined();
  });

  it('does not claim a public link was replaced when its replacement was refused', async () => {
    await startChat(false);
    await groupChat();
    let exposed = '';
    await handleVoiceCommand(event('/voice', OWNER, 'chat:G1'), callUrl, async (text) => {
      exposed = text;
      await revokeRole(OWNER, 'owner', null);
      return 'public';
    });
    expect(await findVoiceModeLineByToken(tokenOf(exposed.match(/https:\S+/)![0]))).toBeDefined();
    expect(inGroup().map(textOf).join('\n')).toContain(
      'The link I sent was visible to the whole chat and could not be replaced: send /voice new to replace it.',
    );
    expect(JSON.stringify(delivered)).not.toContain('so it was replaced');
    expect(log.error).toHaveBeenCalledWith('/voice links posted publicly were not replaced', {
      channelType: 'chat',
      agentGroupIds: ['ag-1'],
    });
  });

  it('in a group without a private reply, /voice new ends no call when the direct chat is out of reach', async () => {
    await startChat(false);
    await groupChat();
    await handleVoiceCommand(event('/voice', OWNER, 'chat:G1'), callUrl, async () => 'sent');
    const [line] = await lines();
    const chat = (await import('./channel-registry.js')).getChannelAdapterExact('chat')!;
    chat.openDM = async () => {
      throw new Error('Forbidden: bot was blocked by the user');
    };
    await getDb().run('DELETE FROM user_dms');
    delivered.length = 0;
    await handleVoiceCommand(event('/voice new', OWNER, 'chat:G1'), callUrl);
    expect((await lines())[0].token_hash).toBe(line.token_hash);
    expect(delivered.map(textOf)).toEqual([
      'I cannot message you privately here: start a direct chat with me, then run /voice again.',
    ]);
  });

  it('says the earlier link is gone when /voice new replaced it but neither private route works', async () => {
    await startChat(false);
    await groupChat();
    await handleVoiceCommand(event('/voice', OWNER, 'chat:G1'), callUrl, async () => 'sent');
    const chat = (await import('./channel-registry.js')).getChannelAdapterExact('chat')!;
    const deliver = chat.deliver.bind(chat);
    chat.deliver = async (platformId, threadId, message) => {
      if (platformId !== 'chat:G1') throw new Error('Forbidden: bot was blocked by the user');
      return deliver(platformId, threadId, message);
    };
    delivered.length = 0;
    await handleVoiceCommand(event('/voice new', OWNER, 'chat:G1'), callUrl, async () => 'unavailable');
    expect(delivered.map(textOf)).toEqual([
      'Any earlier link no longer works. I cannot message you privately here: start a direct chat with me, then run /voice again.',
    ]);
  });

  it('a refusal whose private reply is unavailable or went public is answered in the group, opening no direct chat', async () => {
    await startChat(false);
    await groupChat();
    for (const result of ['unavailable', 'public'] as const) {
      delivered.length = 0;
      await handleVoiceCommand(event('/voice', MEMBER, 'chat:G1'), callUrl, async () => result);
      expect(delivered).toEqual([
        {
          platformId: 'chat:G1',
          threadId: null,
          message: { kind: 'chat', content: { text: 'Only an owner or admin of this agent can use /voice.' } },
        },
      ]);
    }
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

describe('native Telegram /voice', () => {
  const actor = 'telegram:1';
  const delivered: OutboundMessage[] = [];
  /** Bot API calls the command made, and what each answers. */
  const api: Array<{ method: string; payload: Record<string, unknown> }> = [];
  let answer: (method: string, payload: Record<string, unknown>) => unknown;

  async function nativeBot(voiceRunning = true) {
    delivered.length = 0;
    api.length = 0;
    answer = () => true;
    await upsertUser({ id: actor, kind: 'telegram', display_name: 'Caller', created_at: now() });
    await grantRole({ user_id: actor, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
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
    // An unconfigured voice-mode channel starts no adapter.
    registerChannelAdapter('voice-mode', {
      factory: () =>
        voiceRunning
          ? {
              ...adapter('voice-mode'),
              handleVoiceCommand: (event: InboundEvent, privateReply?: PrivateReply) =>
                handleVoiceCommand(event, callUrl, privateReply),
            }
          : null,
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
    bot.api.config.use(async (_prev, method, payload) => {
      api.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true, result: answer(method, payload as Record<string, unknown>) } as never;
    });
    bot.use(buildCommandGroup({ runPromise: Effect.runPromise } as unknown as AdapterRuntime, {} as CommandMenus));
    return bot;
  }

  async function chat(id: string, platformId: string, isGroup: 0 | 1) {
    await createMessagingGroup({
      id,
      channel_type: 'telegram',
      platform_id: platformId,
      is_group: isGroup,
      name: null,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await wire(id, 'ag-1');
  }

  it('in a direct chat, /voice and /voice new use the same line handler as the router', async () => {
    const bot = await nativeBot();
    await chat('native-mg', actor, 0);
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
    expect(delivered[1]).toEqual(delivered[0]);
    await send('/voice new', 3);
    expect((await lines())[0].token_hash).not.toBe(first.token_hash);
    expect(await getSessionsByAgentGroup('ag-1')).toEqual([]);
    expect(api).toEqual([]);
  });

  const topicCommand = (text = '/voice') => ({
    update_id: 1,
    message: {
      message_id: 0,
      ephemeral_message_id: 55,
      date: 1,
      chat: { id: -1001, type: 'supergroup' as const, title: 'HQ', is_forum: true as const },
      from: { id: 1, is_bot: false, first_name: 'Caller' },
      is_topic_message: true as const,
      message_thread_id: 7,
      text,
      entities: [{ type: 'bot_command' as const, offset: 0, length: 6 }],
    },
  });

  it('in a forum topic, answers the ephemeral command with one ephemeral message to the sender only', async () => {
    const bot = await nativeBot();
    await chat('native-topic', 'telegram:-1001:7', 1);
    answer = (_method, payload) => ({
      message_id: 0,
      ephemeral_message_id: 56,
      receiver_user: { id: 1, is_bot: false, first_name: 'Caller' },
      date: 1,
      chat: { id: -1001, type: 'supergroup', title: 'HQ' },
      text: payload.text,
    });
    await bot.handleUpdate(topicCommand());
    expect(api).toEqual([
      {
        method: 'sendMessage',
        payload: {
          chat_id: -1001,
          text: expect.stringMatching(/^🎙 Talk to Andy: https:\/\/voice\.example\.com\/voice\?t=[0-9a-f]{32}/),
          ephemeral_message_parameters: { receiver_user_id: 1 },
          reply_parameters: { ephemeral_message_id: 55 },
          message_thread_id: 7,
          link_preview_options: { is_disabled: true },
        },
      },
    ]);
    expect(delivered).toEqual([]);
    expect((await lines())[0]).toMatchObject({ messaging_group_id: 'native-topic', owner_user_id: actor });
  });

  it('deletes a reply that came back public, replaces the link and sends the new one to the direct chat', async () => {
    const bot = await nativeBot();
    await chat('native-topic', 'telegram:-1001:7', 1);
    await chat('native-dm', actor, 0);
    answer = (method, payload) =>
      method === 'sendMessage'
        ? { message_id: 812, date: 1, chat: { id: -1001, type: 'supergroup', title: 'HQ' }, text: payload.text }
        : true;
    await bot.handleUpdate(topicCommand());
    expect(api.map((c) => c.method)).toEqual(['sendMessage', 'deleteMessage']);
    expect(api[1].payload).toEqual({ chat_id: -1001, message_id: 812 });
    const leaked = tokenOf(String(api[0].payload.text).match(/https:\S+/)![0]);
    expect(await findVoiceModeLineByToken(leaked)).toBeUndefined();
    const texts = delivered.map((m) => (m.content as { text: string }).text);
    expect(texts[0]).toContain('The link I sent was visible to the whole chat, so it was replaced');
    expect(await findVoiceModeLineByToken(tokenOf(texts[0].match(/https:\S+/)![0]))).toBeDefined();
    expect(texts[1]).toBe('Your call link is in our direct chat.');
  });

  it('falls back to the direct chat when Telegram refuses the ephemeral reply, logging no link', async () => {
    const bot = await nativeBot();
    await chat('native-topic', 'telegram:-1001:7', 1);
    await chat('native-dm', actor, 0);
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (method !== 'sendMessage') return prev(method, payload, signal);
      api.push({ method, payload: payload as Record<string, unknown> });
      return { ok: false, error_code: 400, description: 'Bad Request: ephemeral reply expired' } as never;
    });
    await bot.handleUpdate(topicCommand());
    expect(api.map((c) => c.method)).toEqual(['sendMessage']);
    expect(log.warn).toHaveBeenCalledWith('telegram-grammy: ephemeral reply not sent', {
      error: 'GrammyApiError',
      description: 'Bad Request: ephemeral reply expired',
    });
    expect(JSON.stringify(delivered[0])).toMatch(/voice\?t=[0-9a-f]{32}/);
  });

  it('without the voice-mode channel running, answers privately that voice calls are off', async () => {
    const bot = await nativeBot(false);
    await chat('native-topic', 'telegram:-1001:7', 1);
    answer = (_method, payload) => ({
      message_id: 0,
      ephemeral_message_id: 56,
      receiver_user: { id: 1, is_bot: false, first_name: 'Caller' },
      date: 1,
      chat: { id: -1001, type: 'supergroup', title: 'HQ' },
      text: payload.text,
    });
    await bot.handleUpdate(topicCommand('/voice new'));
    expect(api).toHaveLength(1);
    expect(api[0].payload.text).toBe(
      'Andy: voice calls are off on this host (the voice-mode channel is not configured).',
    );
    expect(await lines()).toEqual([]);
  });
});

describe('Telegram command menus', () => {
  it('register /voice as an ephemeral command and nothing else', () => {
    expect(commandList(['voice', 'status'])).toEqual([
      { command: 'voice', description: expect.any(String), is_ephemeral: true },
      { command: 'status', description: expect.any(String) },
    ]);
  });
});
