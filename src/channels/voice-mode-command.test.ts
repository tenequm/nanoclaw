/**
 * `/voice`: hands a line owner their own line's call link and makes the chat the line's call chat.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-voice-command' };
});

const TEST_DIR = '/tmp/nanoclaw-test-voice-command';

import type { ChannelAdapter, InboundEvent, OutboundMessage } from './adapter.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channel-registry.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../db/connection.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../db/messaging-groups.js';
import { runMigrations } from '../db/migrations/index.js';
import { getVoiceLine } from '../db/voice-mode-lines.js';
import { addMember } from '../modules/permissions/db/agent-group-members.js';
import { grantRole } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import type { MessagingGroup } from '../types.js';
import {
  handleVoiceCommand,
  isVoiceCommand,
  runVoiceCommand,
  senderUserId,
  voiceCommandReply,
} from './voice-mode-command.js';

const OWNER = 'chat:1';
const MEMBER = 'chat:2';
const SCOPED_ADMIN = 'chat:3';

const now = () => new Date().toISOString();
const link = (line: MessagingGroup) => `https://voice.example.com/voice?t=tok-${line.platform_id}`;

async function chatGroup(id: string, platformId: string, channelType = 'chat', isGroup: 0 | 1 = 0) {
  await createMessagingGroup({
    id,
    channel_type: channelType,
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

/** What `ncl voice-lines set|add-owner` leaves behind. */
async function own(lineMessagingGroupId: string, ownerUserId: string) {
  await getDb().run(
    'INSERT INTO voice_lines (line_messaging_group_id, updated_at) VALUES (?, ?) ON CONFLICT DO NOTHING',
    lineMessagingGroupId,
    now(),
  );
  await getDb().run(
    'INSERT INTO voice_line_owners (line_messaging_group_id, owner_user_id) VALUES (?, ?)',
    lineMessagingGroupId,
    ownerUserId,
  );
}

const mg = (id: string) => ({ id, instance: null, channel_type: 'chat', is_group: 0 }) as unknown as MessagingGroup;

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
  await chatGroup('mg-line', 'voice-mode:abc', 'voice-mode');
  await chatGroup('mg-line-2', 'voice-mode:def', 'voice-mode');
  for (const id of ['mg-dm', 'mg-other', 'mg-line', 'mg-line-2']) await wire(id, 'ag-1');
  await own('mg-line', OWNER);
  await own('mg-line-2', SCOPED_ADMIN);
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('isVoiceCommand / senderUserId', () => {
  it('takes /voice, /voice@bot and, on Slack only, !voice', () => {
    expect(isVoiceCommand('/voice', 'telegram')).toBe(true);
    expect(isVoiceCommand('/VOICE please', 'telegram')).toBe(true);
    expect(isVoiceCommand('/voice@some_bot', 'telegram')).toBe(true);
    expect(isVoiceCommand('!voice', 'slack')).toBe(true);
    expect(isVoiceCommand('!voice', 'telegram')).toBe(false);
    expect(isVoiceCommand('/voices', 'telegram')).toBe(false);
    expect(isVoiceCommand('my /voice', 'telegram')).toBe(false);
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
  it("binds and links only the sender's own line; the next chat replaces it", async () => {
    const done = await runVoiceCommand(mg('mg-dm'), null, OWNER, link);
    expect(done).toEqual({
      kind: 'done',
      results: [{ ok: true, agentName: 'Andy', links: ['https://voice.example.com/voice?t=tok-voice-mode:abc'] }],
    });
    expect(await getVoiceLine('mg-line')).toMatchObject({ target_messaging_group_id: 'mg-dm', thread_id: null });
    // Another admin's line is neither bound nor linked.
    expect(await getVoiceLine('mg-line-2')).toMatchObject({ target_messaging_group_id: null });

    await runVoiceCommand(mg('mg-other'), null, OWNER, link);
    expect(await getVoiceLine('mg-line')).toMatchObject({ target_messaging_group_id: 'mg-other' });
    await runVoiceCommand(mg('mg-dm'), null, SCOPED_ADMIN, link);
    expect(await getVoiceLine('mg-line')).toMatchObject({ target_messaging_group_id: 'mg-other' });
    expect(await getVoiceLine('mg-line-2')).toMatchObject({ target_messaging_group_id: 'mg-dm' });
  });

  it('drops unknown senders, refuses members, and says why nothing was linked', async () => {
    expect(await runVoiceCommand(mg('mg-dm'), null, null, link)).toEqual({ kind: 'drop' });
    expect(await runVoiceCommand(mg('mg-dm'), null, 'chat:999', link)).toEqual({ kind: 'drop' });
    const refused = await runVoiceCommand(mg('mg-dm'), null, MEMBER, link);
    expect(refused).toEqual({ kind: 'refused' });
    expect(voiceCommandReply(refused)).toBe('Only an admin of this agent can use /voice.');

    await getDb().run('DELETE FROM voice_line_owners WHERE line_messaging_group_id = ?', 'mg-line-2');
    expect(voiceCommandReply(await runVoiceCommand(mg('mg-dm'), null, SCOPED_ADMIN, link))).toBe(
      "You have no voice line for this agent. The operator names a line's owner accounts with `ncl voice-lines set` and `add-owner`.",
    );
    expect(voiceCommandReply(await runVoiceCommand(mg('mg-dm'), null, OWNER, () => null))).toBe(
      'Voice calls are off on this host (the voice channel is not configured).',
    );
    expect(await getVoiceLine('mg-line')).toMatchObject({ target_messaging_group_id: null });
  });

  it('renders one link per line and says the calls now talk here', async () => {
    expect(voiceCommandReply(await runVoiceCommand(mg('mg-dm'), null, OWNER, link))).toBe(
      '🎙 Talk to Andy: https://voice.example.com/voice?t=tok-voice-mode:abc\n\n' +
        'Calls now talk in this chat, until /voice is run in another one.',
    );
  });
});

describe('handleVoiceCommand (the interceptor)', () => {
  const delivered: Array<{ platformId: string; threadId: string | null; message: OutboundMessage }> = [];

  async function startChat(supportsThreads: boolean) {
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
          delivered.push({ platformId, threadId, message });
          return undefined;
        },
      }),
      defaults,
    });
    // The voice adapter as /voice sees it: the holder of each line's call link.
    registerChannelAdapter('voice-mode', {
      factory: () =>
        ({
          name: 'voice-mode',
          channelType: 'voice-mode',
          supportsThreads: false,
          setup: async () => {},
          teardown: async () => {},
          isConnected: () => true,
          deliver: async () => undefined,
          callLink: (platformId: string) => `https://voice.example.com/voice?t=real-${platformId}`,
        }) as ChannelAdapter,
    });
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

  it('answers the owner in the chat it was run in, straight through the adapter', async () => {
    await startChat(false);
    expect(await handleVoiceCommand(event('/voice', OWNER), link)).toBe(true);
    expect(delivered).toEqual([
      {
        platformId: 'chat:1',
        threadId: null,
        message: { kind: 'chat', content: { text: expect.stringContaining('voice?t=tok-voice-mode:abc') } },
      },
    ]);
  });

  it('asks the live voice adapter for the link when none is injected', async () => {
    await startChat(false);
    await handleVoiceCommand(event('/voice', OWNER));
    expect(delivered[0].message.content).toEqual({
      text: expect.stringContaining('https://voice.example.com/voice?t=real-voice-mode:abc'),
    });
  });

  it('claims the command silently for an unknown sender or an unwired chat, and leaves other messages alone', async () => {
    await startChat(false);
    expect(await handleVoiceCommand(event('/voice', 'chat:999'), link)).toBe(true);
    expect(await handleVoiceCommand(event('/voice', OWNER, 'chat:unwired'), link)).toBe(true);
    expect(delivered).toEqual([]);
    expect(await handleVoiceCommand(event('hello', OWNER), link)).toBe(false);
  });

  it('in a group chat sends the link to the sender directly and tells the group only where calls talk', async () => {
    await startChat(false);
    await chatGroup('mg-group', 'chat:G1', 'chat', 1);
    await wire('mg-group', 'ag-1');
    await handleVoiceCommand(event('/voice', OWNER, 'chat:G1'), link);
    const inGroup = delivered.filter((d) => d.platformId === 'chat:G1');
    const direct = delivered.filter((d) => d.platformId !== 'chat:G1');
    expect(inGroup).toHaveLength(1);
    expect(JSON.stringify(inGroup[0].message)).not.toContain('?t=');
    expect(JSON.stringify(inGroup[0].message)).toContain('Your call link is in our direct chat.');
    expect(direct).toHaveLength(1);
    expect(JSON.stringify(direct[0].message)).toContain('voice?t=tok-voice-mode:abc');
    expect(await getVoiceLine('mg-line')).toMatchObject({ target_messaging_group_id: 'mg-group' });
  });

  it('binds a thread where the wiring keeps threads, and a top-level command to the chat itself', async () => {
    await startChat(true);
    await chatGroup('mg-chan', 'chat:C1', 'chat', 1);
    await wire('mg-chan', 'ag-1');
    await handleVoiceCommand(event('/voice', OWNER, 'chat:C1', 'chat:C1:99'), link);
    expect(await getVoiceLine('mg-line')).toMatchObject({
      target_messaging_group_id: 'mg-chan',
      thread_id: 'chat:C1:99',
    });
    expect(delivered.at(-1)?.threadId).toBe('chat:C1:99');
    // Top level: the platform's thread id is the command's own id.
    await handleVoiceCommand(event('/voice', OWNER, 'chat:C1', 'chat:C1:171'), link);
    expect(await getVoiceLine('mg-line')).toMatchObject({ thread_id: null });
    await getDb().run("UPDATE messaging_group_agents SET threads = 0 WHERE messaging_group_id = 'mg-chan'");
    await handleVoiceCommand(event('/voice', OWNER, 'chat:C1', 'chat:C1:99'), link);
    expect(await getVoiceLine('mg-line')).toMatchObject({ target_messaging_group_id: 'mg-chan', thread_id: null });
  });
});
