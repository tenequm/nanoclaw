import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, createAgentGroup, initDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { createMessagingGroup, createMessagingGroupAgent, getMessagingGroup } from '../../db/messaging-groups.js';
import { composeGroupProjectDoc } from '../../project-doc-compose.js';
import type { AgentGroup, Session } from '../../types.js';
import { appAgentInstructions } from './agent-docs.js';

let directory: string;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'app-doc-'));
  await runMigrations(await initDb(join(directory, 'test.db'), { role: 'test' }));
});
afterEach(async () => {
  await closeDb();
  rmSync(directory, { recursive: true, force: true });
});

async function composeFor(channels: string[]): Promise<string> {
  const group: AgentGroup = {
    id: 'ag-doc',
    name: 'Test agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  };
  await createAgentGroup(group);
  await ensureContainerConfig(group.id);
  await updateContainerConfigJson(group.id, 'skills', []);
  for (const channel of channels) {
    await createMessagingGroup({
      id: channel,
      channel_type: channel,
      instance: channel,
      platform_id: `${channel}:test`,
      name: channel,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: group.created_at,
    });
    await createMessagingGroupAgent({
      id: `wire-${channel}`,
      messaging_group_id: channel,
      agent_group_id: group.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      threads: 0,
      created_at: group.created_at,
    });
  }
  const groupDirectory = join(directory, group.folder);
  await composeGroupProjectDoc(group, groupDirectory, { fileName: 'AGENTS.md' }, []);
  return readFileSync(join(groupDirectory, 'AGENTS.md'), 'utf8');
}

describe('app agent formatting', () => {
  it.each([['app'], ['app', 'telegram']])(
    'includes the section for wiring %j even without selected skills',
    async (...channels) => {
      const doc = await composeFor(channels);
      expect(doc).toContain('# Hey Dan app formatting\n');
      expect(doc).toContain(appAgentInstructions());
      expect(doc).toContain('shell variables (`$HOME`)');
      expect(doc).toContain('any line with two dollar signs in backticks');
    },
  );

  it.each([[], ['telegram']])('omits the section without app wiring %j', async (...channels) => {
    expect(await composeFor(channels)).not.toContain('# Hey Dan app formatting');
  });
});

import { createHash, randomUUID, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
const { signRequest } = (await import(new URL('../../../scripts/app-sign.ts', import.meta.url).href)) as {
  signRequest(input: {
    privateKey: string;
    deviceId: string;
    method: string;
    target: string;
    body?: Uint8Array;
    protocol?: number;
    ts?: number;
  }): string;
};
import { getDb } from '../../db/connection.js';
import { dispatchApp } from './routes.js';
import { ensureConversation } from './conversations.js';
import { deliver } from './deliver.js';
import { drainRoutingJobs } from './send.js';
import { configureFiles } from './files.js';
import fixtures from './app-contract.fixtures.json' with { type: 'json' };

vi.mock('../../env.js', async (original) => ({
  ...(await original<typeof import('../../env.js')>()),
  envValue: (key: string) => process.env[key],
}));
vi.mock('../../router.js', () => ({ routeInbound: vi.fn(), registerMessageInterceptor: vi.fn() }));
vi.mock('../../modules/interactive/index.js', () => ({ handleInteractiveResponse: async () => true }));
const hostWritten = vi.hoisted(() => new Set<string>());
const mailbox = vi.hoisted(() => ({ containerState: null as ContainerRecord | null }));
vi.mock('../../session-manager.js', async (original) => ({
  ...(await original<typeof import('../../session-manager.js')>()),
  isHostWrittenOutbound: (id: string) => hostWritten.has(id),
  // The agent container's turn, as its session mailbox reports it to the status service.
  withExistingMailboxSession: async (
    _agentGroupId: string,
    _sessionId: string,
    action: (session: { getContainerState(): ContainerRecord | null }) => unknown,
  ) => action({ getContainerState: () => mailbox.containerState }),
}));

import type { InboundEvent } from '../adapter.js';
import { parseIsoTimestamp, type ContainerRecord } from '../../mailbox/model.js';
import { createVoiceModeLine } from '../../db/voice-mode-lines.js';
import { dispatch } from '../../cli/dispatch.js';
import '../../cli/resources/devices.js';
import * as registry from '../channel-registry.js';
import { handlePairCommand, mintPairingLink } from '../../modules/device-auth/pairing.js';
import { createVoiceModeAdapter } from '../voice-mode.js';
import { CALLER_MARK, SPOKEN_MARK } from '../voice-mode-livekit.js';
import { createServer as createH2Server, type IncomingHttpHeaders } from 'node:http2';
import { createApnsClient } from './apns.js';
import { subscribePush } from './push.js';
import { onEventAppended, readEventsAfter, lastEventSeq } from './log.js';
import { configureStream } from './stream.js';
import { setTyping, stopStatus } from './status.js';
import type { Status } from './contract.js';
import { badgeFor, plainPreview } from './conversations.js';
import { readAppConfig, resetAppConfigCache } from './config.js';
const voiceState = vi.hoisted(() => ({ adapter: undefined as unknown }));
vi.mock('../voice-mode-chat.js', async (original) => ({
  ...(await original<typeof import('../voice-mode-chat.js')>()),
  liveVoiceAdapter: () => voiceState.adapter,
}));
vi.mock('../../webhook-server.js', () => ({
  registerRootHandler: vi.fn(),
  registerWebhookHandler: vi.fn(),
  registerUpgradeHandler: vi.fn(),
}));
const sealedStorage = vi.hoisted(() => ({ on: true }));
vi.mock('../../secret-seal.js', async (original) => ({
  ...(await original<typeof import('../../secret-seal.js')>()),
  encryptionKey: () => (sealedStorage.on ? Buffer.alloc(32, 7) : null),
}));

// Keep equality strict: only identity, ordering and clock values may vary.
function normalized(value: unknown): unknown {
  const ids = new Map<string, string>();
  const ranks = new Map<number, number>();
  const collect = (v: unknown, key = '') => {
    if (Array.isArray(v)) v.forEach((x) => collect(x));
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => collect(x, k));
    else if (typeof v === 'number' && ['seq', 'order', 'readOrder'].includes(key) && v > 0) ranks.set(v, 0);
  };
  collect(value);
  [...ranks.keys()].sort((a, b) => a - b).forEach((v, i) => ranks.set(v, i + 1));
  const walk = (v: unknown, key = ''): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, walk(x, k)]),
      );
    if (typeof v === 'number') {
      if (key === 'rev') return 1;
      if (['seq', 'order', 'readOrder'].includes(key)) return v === 0 ? 0 : ranks.get(v);
      if (['createdAt', 'editedAt', 'expiresAt', 'serverTime', 'at'].includes(key)) return 1;
    }
    if (typeof v === 'string') {
      if (['ticket', 'token'].includes(key)) return `<${key}>`;
      if (['id', 'deviceId', 'fileId', 'conversationId', 'replyTo', 'clientId', 'callId', 'attemptId'].includes(key)) {
        if (!ids.has(v)) ids.set(v, `id${ids.size + 1}`);
        return ids.get(v);
      }
      if (key === 'uploadPath') return '/app/files/<id>';
    }
    return v;
  };
  return walk(value);
}
function same(actual: unknown, expected: unknown) {
  expect(normalized(actual)).toEqual(normalized(expected));
}

describe('signed HTTP fixture producers', () => {
  let server: Server;
  let base: string;
  let conversation: string;
  const user = 'telegram:1000001';
  const agent = fixtures.pairResponse.agents[0];
  const device = fixtures.pairResponse.deviceId;
  beforeEach(async () => {
    const db = getDb();
    await db.run(
      'INSERT INTO users (id,kind,display_name,created_at) VALUES (?,?,?,?)',
      user,
      'telegram',
      fixtures.pairResponse.userName,
      '2026-11-17',
    );
    await createAgentGroup({
      id: agent.id,
      name: agent.name,
      folder: 'fixture-agent',
      agent_provider: null,
      created_at: '2026-11-17',
    });
    await db.run(
      'INSERT INTO device_auth_devices (id,user_id,name,public_key,app_json,created_at) VALUES (?,?,?,?,?,?)',
      device,
      user,
      'Fixture phone',
      fixtures.testKey.publicKeySpki,
      '{}',
      Date.now(),
    );
    await db.run('INSERT INTO device_auth_user_agents VALUES (?,?,?)', user, agent.id, Date.now());
    await db.run('INSERT INTO device_auth_device_agents VALUES (?,?)', device, agent.id);
    await db.run(
      "INSERT INTO user_roles (user_id,role,agent_group_id,granted_at) VALUES (?,'owner',NULL,?)",
      user,
      '2026-11-17',
    );
    conversation = (await ensureConversation(user, agent.id)).id;
    configureFiles({
      root: join(directory, 'files'),
      stagingRoot: join(directory, 'staging'),
      ticketKey: () => Buffer.alloc(32, 7),
    });
    server = createServer((req, res) => {
      void dispatchApp({ req, res, params: {} });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    configureFiles();
    configureStream();
    await stopStatus();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetAppConfigCache();
    sealedStorage.on = true;
    mailbox.containerState = null;
    voiceState.adapter = undefined;
  });
  async function request(method: string, target: string, body?: unknown, authorization?: string) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body === undefined ? '' : JSON.stringify(body));
    const auth =
      authorization ??
      signRequest({ privateKey: fixtures.testKey.privateKeyPkcs8Pem, deviceId: device, method, target, body: bytes });
    const response = await fetch(base + target, {
      method,
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : bytes,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  async function items() {
    const response = await request('GET', `/app/conversations/${conversation}/messages`);
    expect(response.status).toBe(200);
    return response.body.items as Array<Record<string, unknown>>;
  }
  async function agentSession(): Promise<Session> {
    await getDb().run(
      "INSERT INTO sessions (id,agent_group_id,messaging_group_id,created_at) VALUES ('fixture-session',?,?,'2026-11-17') ON CONFLICT (id) DO NOTHING",
      agent.id,
      conversation,
    );
    return (await getDb().get<Session>("SELECT * FROM sessions WHERE id = 'fixture-session'"))!;
  }
  // Plays the router: the turn is stored in the agent's session, then reported through onStored.
  async function storeInSession(event: InboundEvent): Promise<void> {
    event.onStored?.(await agentSession());
  }
  async function ask(expiresAt: number) {
    const q = fixtures.questions.open;
    const questionId = randomUUID();
    await getDb().run(
      "INSERT INTO pending_questions (question_id,session_id,message_out_id,platform_id,channel_type,title,options_json,created_at) VALUES (?,?,?,?,'app','Deploy','[]','2026-11-17')",
      questionId,
      (await agentSession()).id,
      questionId,
      conversation,
    );
    return deliver(conversation, null, {
      kind: 'chat-sdk',
      sourceId: randomUUID(),
      content: { type: 'ask_question', questionId, title: q.title, question: q.text, options: q.options, expiresAt },
    });
  }
  async function withStream<T>(
    after: number,
    deviceId: string,
    run: (readUntil: (pattern: RegExp) => Promise<string>) => Promise<T>,
  ): Promise<T> {
    const target = `/app/events?after=${after}`;
    const controller = new AbortController();
    const response = await fetch(base + target, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      headers: {
        authorization: signRequest({
          privateKey: fixtures.testKey.privateKeyPkcs8Pem,
          deviceId,
          method: 'GET',
          target,
        }),
      },
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let raw = '';
    try {
      const decoder = new TextDecoder();
      return await run(async (pattern) => {
        let match = pattern.exec(raw);
        while (!match) {
          const next = await reader.read();
          if (next.done) throw new Error('Stream closed before expected event');
          raw += decoder.decode(next.value, { stream: true });
          match = pattern.exec(raw);
        }
        const end = match.index + match[0].length;
        const result = raw.slice(0, end);
        raw = raw.slice(end);
        return result;
      });
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  }
  const synchronized = /event: synchronized\ndata: [^\n]+\n\n/;
  const replay = (after: number) => withStream(after, device, (read) => read(synchronized));
  async function wire(id: string, name: string | null, createdAt = '2026-11-17') {
    const group = randomUUID();
    const db = getDb();
    await db.run(
      "INSERT INTO messaging_groups (id,channel_type,platform_id,instance,name,created_at) VALUES (?,'telegram',?,'telegram',?,?)",
      group,
      group,
      name,
      createdAt,
    );
    await db.run(
      'INSERT INTO messaging_group_agents (id,messaging_group_id,agent_group_id,created_at) VALUES (?,?,?,?)',
      randomUUID(),
      group,
      id,
      createdAt,
    );
    return group;
  }
  it('lists wired or shown agents within the device and role scope, sorted by agent and oldest chat', async () => {
    const db = getDb();
    for (const id of ['unwired', 'also-taylor', 'unnamed-chat'])
      await createAgentGroup({ ...agent, id, folder: id, agent_provider: null, created_at: '2026-11-17' });
    await wire('also-taylor', 'beta');
    await wire('unnamed-chat', null);
    const list = async () => (await request('GET', '/app/agents')).body.agents;
    const expected = { ...agent, chat: null, shown: true };
    expect(await list()).toEqual([expected]);
    expect(await request('PUT', '/app/agents/also-taylor', { shown: true })).toEqual(fixtures.errors.notFound);
    await wire(agent.id, null, '2026-11-16');
    await wire(agent.id, 'Later', '2026-11-18');
    await wire(agent.id, 'Support');
    expect(await request('GET', '/app/agents')).toEqual({ status: 200, body: fixtures.agentsResponse });
    await db.run('DELETE FROM device_auth_device_agents WHERE device_id = ?', device);
    const global = [
      { ...agent, id: 'unnamed-chat', chat: null, shown: false },
      { ...agent, id: 'also-taylor', chat: 'beta', shown: false },
      { ...agent, chat: 'Support', shown: true },
    ];
    expect(await list()).toEqual(global);
    expect(await request('PUT', '/app/agents/unwired', { shown: true })).toEqual(fixtures.errors.notFound);
    await db.run("UPDATE user_roles SET role = 'admin' WHERE user_id = ?", user);
    expect(await list()).toEqual(global);
    await db.run("UPDATE user_roles SET agent_group_id = 'also-taylor' WHERE user_id = ?", user);
    expect(await list()).toEqual([global[1]]);
    expect(await request('PUT', `/app/agents/${agent.id}`, { shown: false })).toEqual(fixtures.errors.notFound);
    const update = await request('PUT', '/app/agents/also-taylor', { shown: true });
    expect(update).toEqual({ status: 200, body: { agent: { ...global[1], shown: true } } });
    expect((await request('GET', '/app/conversations')).body.conversations).toMatchObject([
      { agent: { id: 'also-taylor' } },
    ]);
  });
  it('sorts agent names without regard to case', async () => {
    const id = 'alpha';
    await createAgentGroup({ id, name: 'alpha', folder: id, agent_provider: null, created_at: '2026-11-17' });
    await wire(id, null);
    await getDb().run('INSERT INTO device_auth_device_agents VALUES (?,?)', device, id);
    const { body } = await request('GET', '/app/agents');
    expect(body.agents.map((candidate: { id: string }) => candidate.id)).toEqual([id, agent.id]);
  });
  it('hides an agent before its first conversation without creating app wiring or a stream event', async () => {
    const db = getDb();
    const id = 'unopened';
    await createAgentGroup({ ...agent, id, folder: id, agent_provider: null, created_at: '2026-11-17' });
    await db.run('INSERT INTO device_auth_user_agents VALUES (?,?,0)', user, id);
    await db.run('INSERT INTO device_auth_device_agents VALUES (?,?)', device, id);
    const cursor = await lastEventSeq();
    const badge = await badgeFor(user, [id]);
    expect(await request('PUT', `/app/agents/${id}`, { shown: false })).toEqual({
      status: 200,
      body: { agent: { id, name: agent.name, chat: null, shown: false } },
    });
    expect(await db.get('SELECT 1 FROM device_auth_user_agents WHERE agent_group_id = ?', id)).toBeUndefined();
    expect(await db.get('SELECT 1 FROM app_conversations WHERE agent_group_id = ?', id)).toBeUndefined();
    expect(await db.get('SELECT 1 FROM messaging_group_agents WHERE agent_group_id = ?', id)).toBeUndefined();
    expect(await lastEventSeq()).toBe(cursor);
    expect(await badgeFor(user, [id])).toEqual(badge);
  });
  it('updates an open sibling stream and its badge on hide and re-show, and suppresses hidden deliveries', async () => {
    const db = getDb();
    const sibling = 'fixture-sibling';
    await db.run(
      'INSERT INTO device_auth_devices (id,user_id,name,public_key,app_json,created_at) VALUES (?,?,?,?,?,?)',
      sibling,
      user,
      'Other phone',
      fixtures.testKey.publicKeySpki,
      '{}',
      Date.now(),
    );
    await wire(agent.id, 'Support');
    expect((await request('PUT', '/app/devices/me/push-token', fixtures.pushTokenRequest)).status).toBe(204);
    const send = vi.fn(async (_token: unknown, entityId: string) => ({ status: 200, clearToken: false, entityId }));
    const stop = subscribePush(
      { onEventAppended, badgeFor, plainPreview },
      {
        config: () => ({ ...readAppConfig(() => undefined), publicBase: 'https://app.example.com' }),
        send,
        concurrency: 1,
      },
    );
    const target = `/app/agents/${agent.id}`;
    const put = (shown: boolean) => request('PUT', target, { shown });
    const reply = () =>
      deliver(conversation, null, { kind: 'chat', sourceId: randomUUID(), content: { text: 'Reply' } });
    const badge = /event: badge\ndata: [^\n]+\n\n/;
    try {
      await reply();
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      await withStream(await lastEventSeq(), sibling, async (read) => {
        expect(await read(synchronized)).toContain('"unreadTotal":1');
        expect(await request('PUT', target, { shown: 0 })).toEqual(fixtures.errors.badRequest);
        expect(await request('PUT', target, fixtures.setAgentRequest)).toEqual({
          status: 200,
          body: fixtures.setAgentResponse,
        });
        const hidden = await read(badge);
        expect(hidden.match(/event: conversation/g)).toHaveLength(1);
        expect(hidden).toContain('"hidden":true');
        expect(hidden).toContain('"unreadTotal":0');
        const cursor = await lastEventSeq();
        expect((await put(false)).status).toBe(200);
        expect(await lastEventSeq()).toBe(cursor);
        expect(await request('GET', `/app/conversations/${conversation}/messages`)).toEqual(fixtures.errors.notFound);
        const otherId = 'ag_visible';
        await createAgentGroup({
          ...agent,
          id: otherId,
          folder: otherId,
          agent_provider: null,
          created_at: '2026-11-17',
        });
        await db.run('INSERT INTO device_auth_user_agents VALUES (?,?,0)', user, otherId);
        await db.run('INSERT INTO device_auth_device_agents VALUES (?,?)', device, otherId);
        const other = await ensureConversation(user, otherId);
        await reply();
        const visibleMessage = await deliver(other.id, null, {
          kind: 'chat',
          sourceId: randomUUID(),
          content: { text: 'Visible' },
        });
        const suppressed = await read(badge);
        expect(suppressed).not.toContain(conversation);
        expect(suppressed).toContain(other.id);
        expect(suppressed).toContain('"unreadTotal":1');
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
        expect(send.mock.calls[1][1]).toBe(visibleMessage);
        expect((await put(true)).status).toBe(200);
        const restored = await read(badge);
        expect(restored).toContain(conversation);
        expect(restored).toContain('"hidden":false');
        expect(restored).toContain('"unreadTotal":3');
        const shownCursor = await lastEventSeq();
        expect((await put(true)).status).toBe(200);
        expect(await lastEventSeq()).toBe(shownCursor);
        expect(await items()).toHaveLength(2);
        const latest = await reply();
        expect(await read(badge)).toContain(latest);
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
      });
    } finally {
      stop();
    }
  });
  it('replays a hide only within the current role and CLI device scope, even for a now-unwired agent', async () => {
    const cursor = await lastEventSeq();
    const db = getDb();
    expect((await request('PUT', `/app/agents/${agent.id}`, { shown: false })).status).toBe(200);
    const hidden = { ...agent, chat: null, shown: false };
    expect((await request('GET', '/app/agents')).body.agents).toEqual([hidden]);
    const afterHide = await lastEventSeq();
    expect(await request('PUT', `/app/agents/${agent.id}`, { shown: false })).toEqual({
      status: 200,
      body: { agent: hidden },
    });
    expect(await lastEventSeq()).toBe(afterHide);
    expect(await replay(cursor)).toContain('"hidden":true');
    expect((await request('PUT', `/app/agents/${agent.id}`, { shown: true })).status).toBe(200);
    expect((await request('GET', '/app/conversations')).body.conversations[0].id).toBe(conversation);
    await db.run('UPDATE device_auth_device_agents SET agent_group_id = ? WHERE device_id = ?', 'another', device);
    expect(await replay(cursor)).not.toContain(conversation);
    await db.run('DELETE FROM device_auth_device_agents WHERE device_id = ?', device);
    await db.run('DELETE FROM user_roles WHERE user_id = ?', user);
    expect(await replay(cursor)).not.toContain(conversation);
  });
  it.each(['/pair', 'ncl devices pair'])(
    '%s restores the conversation and badge on an open device',
    async (command) => {
      vi.stubEnv('APP_PUBLIC_BASE', fixtures.pairLink.host);
      resetAppConfigCache();
      const chat = await wire(agent.id, 'Support');
      vi.spyOn(registry, 'getChannelAdapterExact').mockReturnValue({
        name: 'telegram',
        channelType: 'telegram',
        supportsThreads: false,
        isConnected: () => true,
        setup: async () => {},
        teardown: async () => {},
        deliver: async () => undefined,
      });
      const pair = async () => {
        if (command === '/pair') {
          expect(
            await handlePairCommand({
              channelType: 'telegram',
              platformId: chat,
              threadId: null,
              message: {
                id: randomUUID(),
                kind: 'chat',
                content: JSON.stringify({ text: '/pair', senderId: user }),
                timestamp: new Date().toISOString(),
              },
            }),
          ).toBe(true);
        } else {
          const result = await dispatch(
            { id: 'pair', command: 'devices-pair', args: { user, agents: agent.id } },
            { caller: 'host' },
          );
          expect(result.ok).toBe(true);
        }
      };
      await deliver(conversation, null, { kind: 'chat', sourceId: randomUUID(), content: { text: 'Reply' } });
      expect((await request('PUT', `/app/agents/${agent.id}`, { shown: false })).status).toBe(200);
      await withStream(await lastEventSeq(), device, async (read) => {
        expect(await read(synchronized)).toContain('"unreadTotal":0');
        await pair();
        const restored = await read(/event: badge\ndata: [^\n]+\n\n/);
        expect(restored).toContain(conversation);
        expect(restored).toContain('"hidden":false');
        expect(restored).toContain('"unreadTotal":1');
        const cursor = await lastEventSeq();
        const badge = await badgeFor(user, [agent.id]);
        await pair();
        expect(await lastEventSeq()).toBe(cursor);
        expect(await badgeFor(user, [agent.id])).toEqual(badge);
      });
    },
  );
  it('preserves existing unread items and leaves a never-opened read cursor absent', async () => {
    const target = `/app/conversations/${conversation}`;
    for (let i = 0; i < 3; i++) {
      await deliver(conversation, null, { kind: 'chat', sourceId: randomUUID(), content: { text: 'Reply' } });
    }
    const list = async () => (await request('GET', '/app/conversations')).body;
    const checkUnchanged = async (count: number) => {
      const {
        conversations: [before],
        badge,
      } = await list();
      expect(before.unread).toBe(count);
      expect(await request('POST', target + '/unread')).toEqual({ status: 200, body: { conversation: before, badge } });
    };
    await checkUnchanged(3);
    expect(await getDb().get('SELECT 1 FROM app_read_state WHERE conversation_id = ?', conversation)).toBeUndefined();
    expect((await request('POST', target + '/read', { order: (await items())[0].order })).status).toBe(200);
    await checkUnchanged(2);
  });
  it('marks the newest agent message or question unread, ignoring newer user items', async () => {
    const target = `/app/conversations/${conversation}`;
    const unread = () => request('POST', target + '/unread');
    const send = () => request('POST', target + '/messages', { clientId: randomUUID(), text: 'Check', fileIds: [] });
    await send();
    expect(await unread()).toEqual(fixtures.errors.nothingUnread);
    const message = await deliver(conversation, null, {
      kind: 'chat',
      sourceId: randomUUID(),
      content: { text: 'Reply' },
    });
    for (const kind of ['message', 'question']) {
      const newest = kind === 'message' ? message : await ask(Date.now() + 300000);
      await send();
      const order = (await items()).find((item) => item.id === newest)!.order as number;
      expect((await request('POST', target + '/read', { order: Number.MAX_SAFE_INTEGER })).body.badge.unreadTotal).toBe(
        0,
      );
      const result = await unread();
      expect(result).toMatchObject({
        status: 200,
        body: { conversation: { id: conversation, readOrder: order - 1, unread: 1 }, badge: { unreadTotal: 1 } },
      });
      expect(await unread()).toEqual(result);
    }
  });
  it('replays seeded fixture frames through signed HTTP dispatch', async () => {
    const frames = fixtures.stream.raw
      .split('\n\n')
      .filter(Boolean)
      .map((frame) => ({
        raw: frame + '\n\n',
        id: Number(frame.match(/^id: (\d+)/m)?.[1]),
        kind: frame.match(/^event: (.+)/m)?.[1],
        data: JSON.parse(frame.match(/^data: (.+)/m)?.[1] ?? 'null'),
      }));
    const sync = frames.findIndex((frame) => frame.kind === 'synchronized');
    await getDb().run('DELETE FROM app_events');
    for (const frame of frames.slice(0, sync).filter((frame) => frame.id)) {
      // Exercise replay of message snapshots saved before the card column existed.
      if (frame.kind === 'message') delete frame.data.card;
      await getDb().run(
        'INSERT INTO app_events (seq,user_id,agent_group_id,conversation_id,entity_id,kind,entity_json,created_at) VALUES (?,?,?,?,?,?,?,?)',
        frame.id,
        user,
        agent.id,
        frame.data.conversationId ?? frame.data.id,
        frame.data.id,
        frame.kind,
        JSON.stringify(frame.data),
        Date.now(),
      );
    }
    // The fixture's status and badge are snapshots, not cursor-bearing log rows.
    configureStream({
      lastEventSeq,
      readEventsAfter,
      onEventAppended,
      onBadgeChanged: () => () => {},
      onStatusChanged: () => () => {},
      conversationsFor: async () => [
        {
          id: fixtures.statuses.working.conversationId,
          user_id: user,
          agent_group_id: agent.id,
          messaging_group_id: conversation,
          seq: 1,
          last_message_json: null,
          created_at: 1,
        },
      ],
      statuses: async () => [fixtures.statuses.working as Status],
      badgeFor: async () => fixtures.conversations.badge,
    });
    expect(await replay(118)).toBe(
      frames
        .slice(0, sync + 1)
        .map((frame) => frame.raw)
        .join(''),
    );
  });
  it('produces the call grant through signed dispatch and the real voice adapter', async () => {
    vi.stubEnv('APP_LIVEKIT_URL', fixtures.callGrant.url);
    resetAppConfigCache();
    const group = (await getMessagingGroup(conversation))!;
    const adapter = createVoiceModeAdapter({
      publicUrl: base,
      maxCallDurationMs: fixtures.callGrant.limit.ms,
      livekit: {
        url: 'ws://127.0.0.1:4902',
        speech: { silenceMs: fixtures.callGrant.silenceMs },
        apiKey: 'fixture',
        apiSecret: 'fixture-only',
        api: {
          createRoom: async () => ({}),
          deleteRoom: async () => {},
          createDispatch: async () => ({}),
          updateRoomMetadata: async () => {},
        },
        mirrorApi: {
          boundChat: async () => ({ group, threadId: null }),
          groupsFor: async () => [group],
          adapter: () => undefined,
        },
      },
    });
    voiceState.adapter = adapter;
    await adapter.setup({ onInbound: vi.fn(), onInboundEvent: vi.fn(), onMetadata: vi.fn(), onAction: vi.fn() });
    try {
      const call = await request('POST', '/app/calls', { ...fixtures.callRequest, conversationId: conversation });
      expect(call.status).toBe(200);
      same(call.body, fixtures.callGrant);
      expect((await request('POST', `/app/calls/${call.body.callId}/end`, fixtures.callEndRequest)).status).toBe(204);
      expect(
        (
          await request(
            'POST',
            `/app/calls/attempts/${fixtures.callRequest.attemptId}/cancel`,
            fixtures.callCancelRequest,
          )
        ).status,
      ).toBe(204);
    } finally {
      voiceState.adapter = undefined;
      await adapter.teardown();
    }
  });
  it('produces push payload and headers at a local h2c endpoint', async () => {
    vi.stubEnv('APP_PUBLIC_BASE', fixtures.pairLink.host);
    resetAppConfigCache();
    const keyPath = join(directory, 'apns.p8');
    writeFileSync(
      keyPath,
      generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600 },
    );
    const received: Array<{ headers: IncomingHttpHeaders; body: unknown }> = [];
    const h2 = createH2Server();
    h2.on('stream', (stream, headers) => {
      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', (part) => {
        body += part;
      });
      stream.on('end', () => {
        received.push({ headers, body: JSON.parse(body) });
        stream.respond({ ':status': 200 });
        stream.end();
      });
    });
    await new Promise<void>((resolve) => h2.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(h2.address() as AddressInfo).port}`;
    const client = createApnsClient({
      config: {
        teamId: 'fixture-team',
        topic: fixtures.pushPayload.headers['apns-topic'],
        sandbox: { keyId: 'fixture-key', keyPath },
        production: null,
      },
      origins: { sandbox: origin, production: origin },
    });
    const stop = subscribePush(
      { onEventAppended, badgeFor, plainPreview },
      { config: readAppConfig, send: client.sendPush },
    );
    try {
      expect((await request('PUT', '/app/devices/me/push-token', fixtures.pushTokenRequest)).status).toBe(204);
      // Three unread items reproduce the fixture badge using the actual badge query.
      await deliver(conversation, null, { kind: 'chat', sourceId: randomUUID(), content: { text: 'First' } });
      await vi.waitFor(() => expect(received).toHaveLength(1));
      await deliver(conversation, null, { kind: 'chat', sourceId: randomUUID(), content: { text: 'Second' } });
      await vi.waitFor(() => expect(received).toHaveLength(2));
      const id = await deliver(conversation, null, {
        kind: 'chat',
        sourceId: randomUUID(),
        content: { text: fixtures.messages.agentWithFiles.text },
      });
      await vi.waitFor(() => expect(received).toHaveLength(3));
      const push = received[2];
      expect(push.headers).toMatchObject({ ...fixtures.pushPayload.headers, 'apns-collapse-id': id });
      expect(push.body).toEqual({
        ...fixtures.pushPayload.body,
        aps: { ...fixtures.pushPayload.body.aps, 'thread-id': conversation },
        hd: { ...fixtures.pushPayload.body.hd, c: conversation, m: id },
      });
    } finally {
      stop();
      client.close();
      await new Promise<void>((resolve) => h2.close(() => resolve()));
    }
  });
  it('produces the fully configured hello fixture', async () => {
    const keyPath = join(directory, 'push.p8');
    writeFileSync(
      keyPath,
      generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600 },
    );
    vi.stubEnv('NANOCLAW_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    vi.stubEnv('APP_PUBLIC_BASE', fixtures.pairLink.host);
    vi.stubEnv('APP_LIVEKIT_URL', fixtures.callGrant.url);
    vi.stubEnv('APP_APNS_TEAM_ID', 'fixture-team');
    vi.stubEnv('APP_APNS_TOPIC', fixtures.pushPayload.headers['apns-topic']);
    vi.stubEnv('APP_APNS_SANDBOX_KEY_ID', 'fixture-key');
    vi.stubEnv('APP_APNS_SANDBOX_KEY_PATH', keyPath);
    resetAppConfigCache();
    vi.stubEnv('OPENAI_API_KEY', '');
    same((await request('GET', '/app/hello')).body, fixtures.hello);
    vi.stubEnv('OPENAI_API_KEY', 'fixture-only');
    resetAppConfigCache();
    same((await request('GET', '/app/hello')).body, {
      ...fixtures.hello,
      features: [...fixtures.hello.features, 'voice-messages'],
    });
  });
  it('pairs the fixture proof through the real gate and consumes the code once', async () => {
    await getDb().run(
      'INSERT INTO device_auth_pairing_codes (code_hash,user_id,agent_ids_json,created_at,expires_at) VALUES (?,?,?,?,?)',
      createHash('sha256').update(fixtures.pairLink.code).digest('hex'),
      user,
      JSON.stringify([agent.id]),
      Date.now(),
      Date.now() + 600000,
    );
    const paired = await request('POST', '/app/pair', fixtures.pairRequest);
    expect(paired.status).toBe(200);
    same(paired.body, fixtures.pairResponse);
    expect((await request('POST', '/app/pair', fixtures.pairRequest)).status).toBe(403);
  });
  it('mints pairing links in the fixture form for the public and local bases', async () => {
    const { code, host, link, localHost, localLink } = fixtures.pairLink;
    expect(code).toMatch(/^[A-Za-z0-9]{32}$/);
    for (const [base, expected] of [
      [host, link],
      [localHost, localLink],
    ]) {
      vi.stubEnv('APP_PUBLIC_BASE', base);
      resetAppConfigCache();
      const minted = await mintPairingLink(user, [agent.id]);
      const mintedCode = minted.slice(minted.indexOf('#') + 1);
      expect(mintedCode).toMatch(/^[A-Za-z0-9]{32}$/);
      expect(minted).toBe(expected.replace(code, mintedCode));
      expect(
        await getDb().get(
          'SELECT user_id FROM device_auth_pairing_codes WHERE code_hash = ?',
          createHash('sha256').update(mintedCode).digest('hex'),
        ),
      ).toEqual({ user_id: user });
    }
  });
  it('produces stored, routed and reached snapshots over signed history', async () => {
    const sent = await request('POST', `/app/conversations/${conversation}/messages`, fixtures.sendRequest);
    expect(sent.status).toBe(200);
    same(sent.body, fixtures.sendResponse);
    same((await items())[0], fixtures.messages.send.stored);
    let routed: unknown;
    await drainRoutingJobs(async (event) => {
      routed = (await items())[0];
      await storeInSession(event);
    });
    same(routed, fixtures.messages.send.routed);
    same((await items())[0], fixtures.messages.send.reached);
  });
  it.each(['agentMarkdown', 'host', 'voiceCaller', 'voiceSpoken'] as const)(
    'produces %s via outbox delivery and signed history',
    async (key) => {
      const expected = fixtures.messages[key];
      // The shapes production writes: host replies through the host's own outbox write, call
      // lines delivered directly by the voice channel with their mark and no source.
      const sourceId =
        key === 'host' ? `hcmd-reply-${randomUUID()}` : key === 'agentMarkdown' ? randomUUID() : undefined;
      if (key === 'host') hostWritten.add(sourceId!);
      const mark = key === 'voiceCaller' ? CALLER_MARK : key === 'voiceSpoken' ? SPOKEN_MARK : '';
      await deliver(conversation, null, {
        kind: 'chat',
        sourceId,
        content: { text: mark + expected.text, ...(expected.voice ? { voice: expected.voice } : {}) },
      });
      same((await items())[0], expected);
    },
  );
  it('replays the rich card fixture, preserves it on reaction and clears it on edit', async () => {
    const expected = fixtures.messages.richCard;
    const sourceId = randomUUID();
    const content = {
      type: 'card',
      fallbackText: expected.text,
      card: {
        title: 'Test results',
        description: 'Both suites passed.',
        children: [
          { type: 'Fields', children: [{ type: 'Field', props: { label: 'Passed', value: 20 } }] },
          {
            type: 'Table',
            props: {
              headers: ['Suite', 'Passed'],
              rows: [
                ['Unit', 12],
                ['Integration', 8],
              ],
              align: ['left', 'right'],
              caption: 'By suite',
            },
          },
          {
            type: 'Chart',
            props: {
              title: 'Checks by suite',
              chart: {
                type: 'bar',
                categories: ['Unit', 'Integration'],
                series: [{ name: 'Passed', values: [12, 8] }],
              },
            },
          },
          { type: 'Divider' },
          { type: 'Text', props: { content: 'All checks completed.', style: 'muted' } },
        ],
        actions: [
          { label: 'View report', url: 'https://example.com/report', style: 'primary' },
          { label: 'View logs', url: 'https://example.com/logs' },
        ],
      },
    };
    const id = await deliver(conversation, null, { kind: 'chat-sdk', sourceId, content });
    expect(await deliver(conversation, null, { kind: 'chat-sdk', sourceId, content })).toBe(id);
    const history = await items();
    expect(history).toHaveLength(1);
    same(history[0], expected);
    const raw = await replay(0);
    const frame = raw.split('\n\n').find((frame) => frame.startsWith(`id: ${history[0].seq}\nevent: message\n`));
    expect(JSON.parse(frame!.split('\ndata: ')[1])).toEqual(history[0]);

    await deliver(conversation, null, {
      kind: 'chat',
      sourceId: randomUUID(),
      content: { operation: 'reaction', messageId: id, emoji: '👍' },
    });
    const [reacted] = await items();
    expect(reacted).toMatchObject({
      id,
      order: history[0].order,
      text: expected.text,
      card: expected.card,
      reactions: [{ emoji: '👍', by: 'agent' }],
    });
    await deliver(conversation, null, {
      kind: 'chat',
      sourceId: randomUUID(),
      content: { operation: 'edit', messageId: id, text: 'Corrected' },
    });
    const [edited] = await items();
    expect(edited).toMatchObject({
      id,
      order: reacted.order,
      text: 'Corrected',
      card: null,
      editedAt: expect.any(Number),
      reactions: reacted.reactions,
    });
    const events = (await readEventsAfter(0, 100, user)).filter((row) => row.entity_id === id);
    expect(events.map((row) => JSON.parse(row.entity_json))).toEqual([history[0], reacted, edited]);
  });
  it('produces attachment metadata from real outbound bytes', async () => {
    const expected = fixtures.messages.agentWithFiles;
    const png = Buffer.alloc(expected.files[0].size);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
    png.write('IHDR', 12);
    png.writeUInt32BE(expected.files[0].width!, 16);
    png.writeUInt32BE(expected.files[0].height!, 20);
    const pdf = Buffer.alloc(expected.files[1].size);
    pdf.write('%PDF-1.7');
    await deliver(conversation, null, {
      kind: 'chat',
      sourceId: randomUUID(),
      content: { text: expected.text },
      files: [
        { filename: expected.files[0].name, data: png },
        { filename: expected.files[1].name, data: pdf },
      ],
    });
    same((await items())[0], expected);
  });
  it('produces the edit sequence without changing creation order', async () => {
    const id = await deliver(conversation, null, {
      kind: 'chat',
      sourceId: randomUUID(),
      content: { text: fixtures.messages.editSequence[0].text },
    });
    const actual = [(await items())[0]];
    await deliver(conversation, null, {
      kind: 'chat',
      sourceId: randomUUID(),
      content: { operation: 'edit', messageId: id, text: fixtures.messages.editSequence[1].text },
    });
    actual.push((await items())[0]);
    await deliver(conversation, null, {
      kind: 'chat',
      sourceId: randomUUID(),
      content: { operation: 'reaction', messageId: id, emoji: fixtures.messages.editSequence[2].reactions[0].emoji },
    });
    actual.push((await items())[0]);
    same(actual, fixtures.messages.editSequence);
  });
  it('mints, renews and uploads the fixture bytes through real handlers', async () => {
    const minted = await request('POST', '/app/files', fixtures.fileInitRequest);
    expect(minted.status).toBe(200);
    same(minted.body, fixtures.fileInitResponse);
    const renewed = await request('POST', `/app/files/${minted.body.fileId}/ticket`);
    same(renewed.body, fixtures.fileTicketRenewResponse);
    expect(
      (
        await request(
          'PUT',
          minted.body.uploadPath,
          Buffer.from(fixtures.fileUpload.bodyUtf8),
          `HeyDan-Ticket ${minted.body.ticket}`,
        )
      ).status,
    ).toBe(fixtures.fileUpload.successStatus);
  });
  it('returns fixture signature errors from actual dispatch', async () => {
    same(await request('GET', '/app/conversations', undefined, 'invalid'), fixtures.errors.badSignature);
    for (const [key, input] of [
      ['unknownDevice', { deviceId: 'dev_missing' }],
      ['staleTimestamp', { ts: 1 }],
      ['protocol', { protocol: 2 }],
    ] as const) {
      const auth = signRequest({
        privateKey: fixtures.testKey.privateKeyPkcs8Pem,
        method: 'GET',
        target: '/app/conversations',
        ...input,
        deviceId: 'deviceId' in input ? input.deviceId : device,
      });
      same(await request('GET', '/app/conversations', undefined, auth), fixtures.errors[key]);
    }
    const auth = signRequest({
      privateKey: fixtures.testKey.privateKeyPkcs8Pem,
      deviceId: device,
      method: 'GET',
      target: '/app/conversations',
    });
    await request('GET', '/app/conversations', undefined, auth);
    same(await request('GET', '/app/conversations', undefined, auth), fixtures.errors.replayed);
    await request('DELETE', '/app/devices/me');
    same(await request('GET', '/app/conversations'), fixtures.errors.deviceRevoked);
  });
  it('produces the list, history page, file message, statuses and call refusal over signed dispatch', async () => {
    // Calls are up and the fixture agent has its line; with sealed storage off the second agent
    // cannot get one, which is the fixture's call refusal.
    vi.stubEnv('APP_LIVEKIT_URL', fixtures.callGrant.url);
    resetAppConfigCache();
    voiceState.adapter = { isConnected: () => true };
    await createVoiceModeLine(
      { agentGroupId: agent.id, ownerUserId: user, messagingGroupId: conversation, threadId: null },
      Buffer.alloc(32, 7),
    );
    sealedStorage.on = false;
    const refused = fixtures.conversationCallRefused;
    await createAgentGroup({
      id: refused.agent.id,
      name: refused.agent.name,
      folder: 'fixture-second-agent',
      agent_provider: null,
      created_at: '2026-11-17',
    });
    await getDb().run('INSERT INTO device_auth_user_agents VALUES (?,?,?)', user, refused.agent.id, Date.now());
    await getDb().run('INSERT INTO device_auth_device_agents VALUES (?,?)', device, refused.agent.id);
    type ListBody = {
      conversations: Array<{ id: string; readOrder: number }>;
      statuses: Array<{ conversationId: string }>;
    };
    const list = async (): Promise<ListBody> => {
      const response = await request('GET', '/app/conversations');
      expect(response.status).toBe(200);
      return response.body;
    };
    const statusOf = (body: ListBody) => body.statuses.find((s) => s.conversationId === conversation);
    const send = (body: unknown) => request('POST', `/app/conversations/${conversation}/messages`, body);
    await list();

    const withFile = fixtures.messages.userWithFile;
    const minted = await request('POST', '/app/files', fixtures.fileInitRequest);
    expect(
      (
        await request(
          'PUT',
          minted.body.uploadPath,
          Buffer.from(fixtures.fileUpload.bodyUtf8),
          `HeyDan-Ticket ${minted.body.ticket}`,
        )
      ).status,
    ).toBe(fixtures.fileUpload.successStatus);
    const fileIds = [minted.body.fileId];
    const sent = await send({ clientId: withFile.clientId, text: withFile.text, fileIds });
    expect(sent.status).toBe(200);
    same(await send({ clientId: randomUUID(), text: withFile.text, fileIds }), fixtures.errors.badFile);
    same(await send({ clientId: withFile.clientId, text: 'Changed', fileIds }), fixtures.errors.clientIdConflict);
    await drainRoutingJobs(storeInSession);
    const fileMessage = (await items()).find((item) => item.id === sent.body.message.id)!;
    same(fileMessage, withFile);
    const readFile = await request('POST', `/app/conversations/${conversation}/read`, { order: fileMessage.order });
    expect(readFile.status).toBe(200);

    const page = {
      ...fixtures.historyPage,
      items: fixtures.historyPage.items.filter((item) => item.id !== fixtures.messages.future.id),
    };
    expect((await send(fixtures.sendRequest)).status).toBe(200);
    await drainRoutingJobs(storeInSession);
    await deliver(conversation, null, { kind: 'chat', sourceId: randomUUID(), content: { text: page.items[1].text } });
    const question = await ask(Date.now() + 300000);
    same(statusOf(await list()), fixtures.statuses.waiting);
    expect((await request('POST', `/app/questions/${question}/answer`, fixtures.answerRequest)).status).toBe(200);
    same(statusOf(await list()), fixtures.statuses.idle);
    const [draft, edited, reacted] = fixtures.messages.editSequence;
    const draftId = await deliver(conversation, null, {
      kind: 'chat',
      sourceId: randomUUID(),
      content: { text: draft.text },
    });
    // Reacting before the edit leaves the edit's conversation event last in the log, as the fixture list has it.
    await deliver(conversation, null, {
      kind: 'chat',
      sourceId: randomUUID(),
      content: { operation: 'reaction', messageId: draftId, emoji: reacted.reactions[0].emoji },
    });
    await deliver(conversation, null, {
      kind: 'chat',
      sourceId: randomUUID(),
      content: { operation: 'edit', messageId: draftId, text: edited.text },
    });
    const now = parseIsoTimestamp(new Date().toISOString());
    mailbox.containerState = {
      currentTool: 'Bash',
      toolDeclaredTimeoutMs: null,
      toolStartedAt: now,
      turn: 'working',
      updatedAt: now,
    };
    await setTyping(conversation, null);

    const listed = await list();
    const own = listed.conversations.find((c) => c.id === conversation)!;
    same({ ...listed, conversations: [own], statuses: [statusOf(listed)] }, fixtures.conversations);
    same(
      listed.conversations.find((c) => c.id !== conversation),
      refused,
    );
    const history = await request('GET', `/app/conversations/${conversation}/messages?after=${own.readOrder}`);
    expect(history.status).toBe(200);
    same(history.body, page);
    const readItem = page.items.findIndex((item) => item.order === fixtures.readRequest.order);
    const read = await request('POST', `/app/conversations/${conversation}/read`, {
      ...fixtures.readRequest,
      order: history.body.items[readItem].order,
    });
    expect(read.status).toBe(200);
    same(read.body, fixtures.readResponse);
    const unread = await request('POST', `/app/conversations/${conversation}/unread`);
    expect(unread.status).toBe(200);
    same(unread.body, fixtures.unreadResponse);
    const cursor = await lastEventSeq();
    expect((await request('PUT', `/app/agents/${agent.id}`, { shown: false })).status).toBe(200);
    const frame = (await replay(cursor)).match(/^id: (\d+)\nevent: conversation\ndata: (.+)$/m)!;
    const data = JSON.parse(frame[2]);
    expect(Number(frame[1])).toBe(data.seq);
    same(data, fixtures.hiddenEvent.data);
  });
  it('returns command, expired-question and rate-limit refusals from actual dispatch', async () => {
    const send = (text: string) =>
      request('POST', `/app/conversations/${conversation}/messages`, { clientId: randomUUID(), text, fileIds: [] });
    same(await send('/voice'), fixtures.errors.useCallScreen);
    same(await send('/pair'), fixtures.errors.usePairingScreen);

    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const question = await ask(now + 300000);
    clock.mockReturnValue((now += 300000));
    const expired = await request('POST', `/app/questions/${question}/answer`, fixtures.answerRequest);
    expect(expired.status).toBe(409);
    same(expired.body.question, fixtures.questions.expired);

    // Sixty failed authentications fill the address's ten-minute bucket; the next one, with 30 s
    // of that window left, is refused with the fixture's wait.
    for (let i = 0; i < 60; i++)
      expect((await request('GET', '/app/conversations', undefined, 'invalid')).status).toBe(401);
    clock.mockReturnValue(now + 570000);
    const limited = await fetch(base + '/app/conversations', { headers: { authorization: 'invalid' } });
    same(
      {
        status: limited.status,
        headers: { 'Retry-After': limited.headers.get('retry-after') },
        body: await limited.json(),
      },
      fixtures.errors.rateLimited,
    );
  });
});
