import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, createAgentGroup, initDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { composeGroupProjectDoc } from '../../project-doc-compose.js';
import type { AgentGroup } from '../../types.js';
import { appAgentInstructions } from './agent-docs.js';

let directory: string;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'n6-app-doc-'));
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
import { vi } from 'vitest';
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
vi.mock('../../response-registry.js', () => ({ getResponseHandlers: () => [async () => true] }));

import { createVoiceModeAdapter } from '../voice-mode.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { createServer as createH2Server, type IncomingHttpHeaders } from 'node:http2';
import { createApnsClient } from './apns.js';
import { subscribePush } from './push.js';
import { onEventAppended, readEventsAfter, lastEventSeq } from './log.js';
import { configureStream } from './stream.js';
import { stopStatus } from './status.js';
import type { Status } from './contract.js';
import { badgeFor, plainPreview } from './conversations.js';
import { readAppConfig } from './config.js';
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
vi.mock('../../secret-seal.js', async (original) => ({
  ...(await original<typeof import('../../secret-seal.js')>()),
  encryptionKey: () => Buffer.alloc(32, 7),
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
    const target = '/app/events?after=118';
    const controller = new AbortController();
    const response = await fetch(base + target, {
      signal: controller.signal,
      headers: {
        authorization: signRequest({
          privateKey: fixtures.testKey.privateKeyPkcs8Pem,
          deviceId: device,
          method: 'GET',
          target,
        }),
      },
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let raw = '';
    try {
      while (!raw.includes('event: synchronized')) {
        const next = await reader.read();
        if (next.done) break;
        raw += new TextDecoder().decode(next.value);
      }
      expect(raw).toBe(
        frames
          .slice(0, sync + 1)
          .map((frame) => frame.raw)
          .join(''),
      );
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  });
  it('produces the call grant through signed dispatch and the real voice adapter', async () => {
    vi.stubEnv('APP_LIVEKIT_URL', fixtures.callGrant.url);
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
      const draft = await deliver(conversation, null, {
        kind: 'chat',
        sourceId: randomUUID(),
        content: { text: fixtures.messages.editSequence[0].text },
      });
      await deliver(conversation, null, {
        kind: 'chat',
        sourceId: randomUUID(),
        content: { operation: 'edit', messageId: draft, text: fixtures.messages.editSequence[1].text },
      });
      const readOrder = (await items())[0].order;
      same(
        (await request('POST', `/app/conversations/${conversation}/read`, { order: readOrder })).body,
        fixtures.readResponse,
      );

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
    vi.stubEnv('APP_APNS_SANDBOX_KEY_ID', 'fixture-key');
    vi.stubEnv('APP_APNS_SANDBOX_KEY_PATH', keyPath);
    same((await request('GET', '/app/hello')).body, fixtures.hello);
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
  it('produces stored, routed and reached snapshots over signed history', async () => {
    const sent = await request('POST', `/app/conversations/${conversation}/messages`, fixtures.sendRequest);
    expect(sent.status).toBe(200);
    same(sent.body, fixtures.sendResponse);
    await drainRoutingJobs(async () => {});
    same((await items())[0], fixtures.messages.send.routed);
    const { setDelivery } = await import('./send.js');
    await setDelivery(sent.body.message.id, 'reached');
    same((await items())[0], fixtures.messages.send.reached);
  });
  it.each(['agentMarkdown', 'host', 'voiceCaller', 'voiceSpoken'] as const)(
    'produces %s via outbox delivery and signed history',
    async (key) => {
      const expected = fixtures.messages[key];
      await deliver(conversation, null, {
        kind: 'chat',
        sourceId: (key === 'host' || key === 'voiceCaller' ? 'hcmd-' : '') + randomUUID(),
        content: { text: expected.text, voice: expected.voice },
      });
      same((await items())[0], expected);
    },
  );
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
  it('produces open, answered and conflict question fixtures', async () => {
    const q = fixtures.questions.open;
    const questionId = randomUUID();
    await getDb().run(
      "INSERT INTO sessions (id,agent_group_id,messaging_group_id,created_at) VALUES ('fixture-session',?,?,'2026-11-17')",
      agent.id,
      conversation,
    );
    await getDb().run(
      "INSERT INTO pending_questions (question_id,session_id,message_out_id,title,options_json,created_at) VALUES (?,'fixture-session',?,'Deploy','[]','2026-11-17')",
      questionId,
      questionId,
    );
    const id = await deliver(conversation, null, {
      kind: 'chat-sdk',
      sourceId: randomUUID(),
      content: {
        type: 'ask_question',
        questionId,
        title: q.title,
        question: q.text,
        options: q.options,
        expiresAt: Date.now() + 300000,
      },
    });
    same((await items())[0], q);
    const answered = await request('POST', `/app/questions/${id}/answer`, fixtures.answerRequest);
    expect(answered.status).toBe(200);
    same(answered.body, fixtures.answerResponse);
    const conflict = await request('POST', `/app/questions/${id}/answer`, { value: 'production' });
    same(conflict, fixtures.answerConflict);
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
});

const fixtureChecks: Array<{ keys: string[]; file: string; test: string }> = [
  {
    keys: ['protocol', 'testKey', 'signing'],
    file: 'contract.test.ts',
    test: 'signing vectors and replay keyed by device and nonce',
  },
  { keys: ['pairProofText', 'pairProofTampered'], file: 'contract.test.ts', test: 'pair proof and tampered proof' },
  { keys: ['hello'], file: 'contract-fixtures.test.ts', test: 'produces the fully configured hello fixture' },
  {
    keys: ['pairLink', 'pairRequest', 'pairResponse'],
    file: 'contract-fixtures.test.ts',
    test: 'pairs the fixture proof through the real gate and consumes the code once',
  },
  {
    keys: ['messages.send', 'sendRequest', 'sendResponse'],
    file: 'contract-fixtures.test.ts',
    test: 'produces stored, routed and reached snapshots over signed history',
  },
  {
    keys: ['messages.agentMarkdown', 'messages.host', 'messages.voiceCaller', 'messages.voiceSpoken'],
    file: 'contract-fixtures.test.ts',
    test: 'produces %s via outbox delivery and signed history',
  },
  {
    keys: ['messages.editSequence'],
    file: 'contract-fixtures.test.ts',
    test: 'produces the edit sequence without changing creation order',
  },
  {
    keys: ['questions.open', 'questions.answered', 'answerRequest', 'answerResponse', 'answerConflict'],
    file: 'contract-fixtures.test.ts',
    test: 'produces open, answered and conflict question fixtures',
  },
  {
    keys: ['fileInitRequest', 'fileInitResponse', 'fileTicketRenewResponse', 'fileUpload'],
    file: 'contract-fixtures.test.ts',
    test: 'mints, renews and uploads the fixture bytes through real handlers',
  },
  {
    keys: [
      'errors.protocol',
      'errors.badSignature',
      'errors.unknownDevice',
      'errors.staleTimestamp',
      'errors.replayed',
      'errors.deviceRevoked',
    ],
    file: 'contract-fixtures.test.ts',
    test: 'returns fixture signature errors from actual dispatch',
  },
  {
    keys: ['errors.badBody'],
    file: '../../modules/device-auth/verify.test.ts',
    test: 'rejects altered and oversized bodies before reading oversized content length',
  },
  {
    keys: ['errors.badProof', 'errors.invalidCode', 'errors.rateLimited'],
    file: '../../modules/device-auth/verify.test.ts',
    test: 'rejects tampered proof, expired code and excess pairing attempts',
  },
  {
    keys: ['errors.forbidden', 'errors.notFound', 'errors.useCallScreen', 'errors.usePairingScreen'],
    file: 'n2a.test.ts',
    test: 'refuses commands without storing and distinguishes ownership from access',
  },
  {
    keys: ['errors.clientIdConflict'],
    file: 'n2a.test.ts',
    test: 'sends once even when the retry names consumed files, and conflicts on changed content',
  },
  {
    keys: ['errors.answerNotDelivered'],
    file: 'n2a.test.ts',
    test: 'undoes failed answer handoff and returns the fixture error',
  },
  {
    keys: ['errors.badFile', 'messages.userWithFile'],
    file: 'files.test.ts',
    test: 'userWithFile: rejects badFile, claims atomically and stages independent copies',
  },
  {
    keys: ['errors.tooLarge', 'errors.lengthRequired', 'errors.uploadConflict'],
    file: 'files.test.ts',
    test: 'tooLarge, lengthRequired, badBody, forged tickets and uploadConflict',
  },
  {
    keys: ['errors.ticketExpired'],
    file: 'files.test.ts',
    test: 'expired fixture authorization reaches the upload handler',
  },
  {
    keys: ['errors.uploadKeyConflict'],
    file: 'files.test.ts',
    test: 'fileInitResponse and fileTicketRenewResponse: lost mint and upload answers are retryable',
  },
  {
    keys: ['messages.agentWithFiles'],
    file: 'files.test.ts',
    test: 'agentWithFiles: detects PNG and PDF bytes and retains sent files during cleanup',
  },
  {
    keys: ['messages.userFailed', 'messages.userUnknown'],
    file: 'n2a.test.ts',
    test: 'routing handles %s without replay',
  },
  { keys: ['questions.expired'], file: 'n2a.test.ts', test: 'expires when %s is gone' },
  { keys: ['questions.noDeadline'], file: 'n2a.test.ts', test: 'questions normalize options and keep a null deadline' },
  {
    keys: ['conversations', 'historyPage', 'readRequest', 'readResponse'],
    file: 'n2a.test.ts',
    test: 'matches send, list, history and read response fixture shapes',
  },
  {
    keys: ['statuses.working', 'statuses.waiting', 'statuses.idle'],
    file: 'status.test.ts',
    test: 'persists revisions across restart, maps ticks, prioritizes questions and expires stale working',
  },
  {
    keys: ['stream', 'messages.future'],
    file: 'stream.test.ts',
    test: 'matches the complete fixture byte for byte, including unknown kinds, badge and pings',
  },
  {
    keys: ['callRequest', 'callGrant', 'callEndRequest', 'callErrors.stopped'],
    file: 'calls.test.ts',
    test: 'opens once concurrently, retries with a fresh token and ends idempotently',
  },
  { keys: ['callCancelRequest'], file: 'calls.test.ts', test: 'cancels during room setup and before a late start' },
  {
    keys: ['callErrors.protocol', 'callErrors.room'],
    file: 'calls.test.ts',
    test: 'enforces protocol, device scope, ownership, and room failures',
  },
  { keys: ['callErrors.limit'], file: 'calls.test.ts', test: 'does not rebind on a limit refusal' },
  {
    keys: ['callErrors.noChat', 'callErrors.voiceOffline', 'errors.attemptConflict'],
    file: 'calls.test.ts',
    test: 'returns no-chat, offline, not-found and attempt-conflict without extra rooms',
  },
  {
    keys: ['callErrors.noLine'],
    file: 'calls.test.ts',
    test: 'refuses another owner and stops the failed opening attempt',
  },
  {
    keys: ['callErrors.providerUnavailable', 'errors.badRequest'],
    file: 'calls.test.ts',
    test: 'shapes picker provider and query errors for paired clients',
  },
  {
    keys: ['conversationCallRefused'],
    file: 'contract.test.ts',
    test: 'conversation list and call-refused example remain separate',
  },
  {
    keys: ['pushTokenRequest'],
    file: 'push.test.ts',
    test: 'stores the fixture, transfers duplicate tokens atomically and accepts simulator lengths',
  },
  { keys: ['pushPayload'], file: 'push.test.ts', test: 'pushes the fixture to eligible devices with their own badges' },
  {
    keys: ['errors.futureError'],
    file: 'contract-fixtures.test.ts',
    test: 'keeps the unknown error example for forward-compatible decoders',
  },
];
function uncoveredFixtures(value: Record<string, unknown>): string[] {
  const covered = new Set(fixtureChecks.flatMap((entry) => entry.keys));
  const nested = new Set(['errors', 'callErrors', 'messages', 'questions', 'statuses']);
  return Object.entries(value).flatMap(([key, v]) => {
    if (key === 'about') return [];
    const keys = nested.has(key) ? Object.keys(v as object).map((child) => `${key}.${child}`) : [key];
    return keys.filter((k) => !covered.has(k));
  });
}
it('maps every fixture to a named check and rejects a throwaway unmapped key', () => {
  expect(uncoveredFixtures(fixtures)).toEqual([]);
  expect(uncoveredFixtures({ ...fixtures, throwaway: {} })).toEqual(['throwaway']);
  expect(uncoveredFixtures({ ...fixtures, errors: { ...fixtures.errors, throwaway: {} } })).toEqual([
    'errors.throwaway',
  ]);
  for (const { file, test } of fixtureChecks) {
    expect(readFileSync(new URL(file, import.meta.url), 'utf8')).toContain(test);
  }
});
it('keeps the unknown error example for forward-compatible decoders', () => {
  expect(fixtures.errors.futureError.status).toBeGreaterThanOrEqual(400);
  expect(fixtures.errors.futureError.body.error).toBeTypeOf('string');
  expect(fixtures.errors.futureError.body.message).toBeTypeOf('string');
});
