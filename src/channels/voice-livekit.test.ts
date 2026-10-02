/**
 * The LiveKit path of the voice channel at the host boundary: the real adapter
 * behind the real webhook server, hit over HTTP the way the call page and the
 * worker do. Faked: the LiveKit server API (recorded calls), Google's token
 * endpoint (for the cross-engine test), the mirror's chats and the clock.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, InboundMessage, OutboundMessage } from './adapter.js';
import { createGptLiveAdapter, lineIdForToken, type GptLiveConfig } from './voice.js';
import {
  liveKitCallPageHtml,
  pickMirrorTarget,
  walkieMessageText,
  WALKIE_REPLY_NOTE,
  type LiveKitServerApi,
  type LiveKitVoiceConfig,
  type MirrorApi,
} from './voice-livekit.js';
import type { MessagingGroup } from '../types.js';
import {
  LIVEKIT_PROTOCOL_VERSION,
  liveKitCallSecret,
  WALKIE_THINKING_ATTRIBUTE,
  type LiveKitHostEvent,
  type LiveKitJobMetadata,
} from './voice-livekit-protocol.js';
import { stopWebhookServer } from '../webhook-server.js';

const LINE = lineIdForToken('tok123');
const MIN = 60_000;
const API_KEY = 'APIfakekey123';
const API_SECRET = 'fakesecretfakesecretfakesecretfakesecretfakesecr';

interface FakeLiveKit extends LiveKitServerApi {
  rooms: string[];
  deleted: string[];
  dispatches: Array<{ room: string; agentName: string; metadata: LiveKitJobMetadata }>;
  /** Every room operation in order, as `create:<room>` / `delete:<room>`. */
  ops: string[];
  failCreate: boolean;
  /** When set, createRoom waits for it, to widen the connecting window. */
  createGate: Promise<void> | null;
}

function fakeLiveKit(): FakeLiveKit {
  const fake: FakeLiveKit = {
    rooms: [],
    deleted: [],
    dispatches: [],
    ops: [],
    failCreate: false,
    createGate: null,
    async createRoom(options) {
      await fake.createGate;
      if (fake.failCreate) throw new Error('connection refused');
      fake.rooms.push(options.name);
      fake.ops.push(`create:${options.name}`);
      return {};
    },
    async deleteRoom(room) {
      fake.deleted.push(room);
      fake.ops.push(`delete:${room}`);
    },
    async createDispatch(room, agentName, options) {
      fake.dispatches.push({ room, agentName, metadata: JSON.parse(options.metadata) as LiveKitJobMetadata });
      return {};
    },
  };
  return fake;
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** A one-endpoint stand-in for Google's ephemeral token API. */
function startFakeGoogle(): Promise<{ apiBase: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'auth_tokens/fake' }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        apiBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    );
  });
}

/** The agent's chats and what was posted into them. */
function fakeMirror(groups: Array<Partial<MessagingGroup>>) {
  const posts: Array<{ instance: string; platformId: string; text: string }> = [];
  const api: MirrorApi = {
    groupsFor: async () => groups.map((g, i) => mg({ id: `mg-${i}`, ...g })),
    adapter: (instance) => ({
      deliver: async (platformId: string, _thread: string | null, message: OutboundMessage) => {
        posts.push({ instance, platformId, text: (message.content as { text: string }).text });
        return 'tg-1';
      },
    }),
  };
  return { api, posts };
}

function mg(overrides: Partial<MessagingGroup>): MessagingGroup {
  return {
    id: 'mg',
    channel_type: 'telegram',
    platform_id: 'telegram:100',
    instance: 'telegram',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: '2026-10-02T00:00:00Z',
    ...overrides,
  };
}

interface Harness {
  adapter: ChannelAdapter;
  /** Where the worker reaches the host, from its own settings. */
  hostUrl: string;
  base: string;
  inbound: InboundMessage[];
  clock: { now: number };
  access: { enabled: boolean };
  lk: FakeLiveKit;
  stop(): Promise<void>;
}

async function startHarness(
  overrides: Partial<GptLiveConfig> = {},
  livekit = true,
  lkOverrides: Partial<LiveKitVoiceConfig> = {},
): Promise<Harness> {
  const port = await freePort();
  process.env.WEBHOOK_PORT = String(port);
  const inbound: InboundMessage[] = [];
  const clock = { now: Date.UTC(2026, 9, 2, 1, 0, 0) };
  const access = { enabled: true };
  const lk = fakeLiveKit();
  const adapter = createGptLiveAdapter({
    apiKey: 'sk-test-key',
    publicUrl: `http://127.0.0.1:${port}`,
    voice: 'marin',
    linkTokens: ['tok123'],
    apiBase: 'http://127.0.0.1:9/v1',
    wsBase: 'ws://127.0.0.1:9/v1',
    resolveLine: async (id) =>
      access.enabled
        ? {
            caller: { id, name: 'Ethan' },
            agentGroupId: 'ag-andy',
            agent: { name: 'Andy', personality: 'Dry humour, precise.', vocabulary: ['NanoClaw', 'Stan'] },
          }
        : null,
    now: () => clock.now,
    requestTimeoutMs: 1000,
    livekit: livekit
      ? {
          url: 'wss://lk.example.ts.net:47880',
          serverUrl: 'ws://127.0.0.1:7880',
          apiKey: API_KEY,
          apiSecret: API_SECRET,
          api: lk,
          ...lkOverrides,
        }
      : undefined,
    ...overrides,
  });
  await adapter.setup({
    onInbound: (_platformId, _threadId, message) => {
      inbound.push(message);
    },
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  });
  return {
    adapter,
    hostUrl: `http://127.0.0.1:${port}`,
    base: `http://127.0.0.1:${port}/webhook/voice`,
    inbound,
    clock,
    access,
    lk,
    stop: async () => {
      await adapter.teardown();
      await stopWebhookServer();
    },
  };
}

const post = (url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const jwtPayload = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;

interface TokenResponse {
  url: string;
  token: string;
  callId: string;
  agent: string;
}

/** The worker's side of one call: its metadata, an open event stream, and its POSTs. */
interface FakeWorker {
  meta: LiveKitJobMetadata;
  /** Post one transcribed turn; resolves the utterance id the host gave it. */
  utter(text: string): Promise<string>;
  events: LiveKitHostEvent[];
  streamClosed: Promise<void>;
  post(path: string, body?: Record<string, unknown>): Promise<Response>;
  waitFor(pred: (e: LiveKitHostEvent) => boolean): Promise<LiveKitHostEvent>;
  close(): void;
}

const workerAuth = (callId: string) => ({ Authorization: `Bearer ${liveKitCallSecret(API_SECRET, callId)}` });

async function attachWorker(h: Harness, meta: LiveKitJobMetadata): Promise<FakeWorker> {
  const events: LiveKitHostEvent[] = [];
  const waiters: Array<{ pred: (e: LiveKitHostEvent) => boolean; resolve: (e: LiveKitHostEvent) => void }> = [];
  const controller = new AbortController();
  const auth = workerAuth(meta.callId);
  const res = await fetch(`${h.hostUrl}/webhook/voice/livekit/agent/events?call=${meta.callId}`, {
    headers: auth,
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  const streamClosed = (async () => {
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const event = JSON.parse(buf.slice(0, nl)) as LiveKitHostEvent;
          buf = buf.slice(nl + 1);
          events.push(event);
          for (const w of waiters.splice(0)) {
            if (w.pred(event)) w.resolve(event);
            else waiters.push(w);
          }
        }
      }
    } catch {
      // aborted by close()
    }
  })();
  const workerPost = (path: string, body: Record<string, unknown> = {}) =>
    post(`${h.hostUrl}/webhook/voice/livekit/agent/${path}`, { callId: meta.callId, ...body }, auth);
  return {
    meta,
    events,
    streamClosed,
    post: workerPost,
    utter: async (text) => {
      const res = await workerPost('utterance', { text });
      expect(res.status).toBe(202);
      return ((await res.json()) as { id: string }).id;
    },
    waitFor: (pred) => {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => waiters.push({ pred, resolve }));
    },
    close: () => controller.abort(),
  };
}

async function startCall(h: Harness): Promise<{ call: TokenResponse; worker: FakeWorker }> {
  const res = await post(`${h.base}/livekit/token?t=tok123`);
  expect(res.status).toBe(200);
  const call = (await res.json()) as TokenResponse;
  const dispatch = h.lk.dispatches.at(-1)!;
  const worker = await attachWorker(h, dispatch.metadata);
  expect((await worker.post('joined')).status).toBe(200);
  return { call, worker };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe('livekit voice path without LiveKit settings', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({}, false);
  });
  afterAll(async () => {
    await h.stop();
  });

  it('answers 503 on every livekit route and leaves the other engines alone', async () => {
    expect((await fetch(`${h.base}/livekit?t=tok123`)).status).toBe(503);
    expect((await post(`${h.base}/livekit/token?t=tok123`)).status).toBe(503);
    expect((await post(`${h.base}/livekit/agent/utterance`, {})).status).toBe(503);
    expect((await fetch(`${h.base}/call?t=tok123`)).status).toBe(200);
  });
});

describe('livekit voice path (fake LiveKit, real webhook server)', () => {
  let h: Harness;
  let google: { apiBase: string; close(): Promise<void> };

  beforeEach(async () => {
    google = await startFakeGoogle();
    h = await startHarness({
      accessCheckIntervalMs: 50,
      gemini: { apiKey: 'gk-test', apiBase: google.apiBase },
    });
  });
  afterEach(async () => {
    await h.stop();
    await google.close();
  });

  it('serves the call page and the same-origin client bundle', async () => {
    const res = await fetch(`${h.base}/livekit?t=tok123`);
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("connect-src 'self' wss://lk.example.ts.net:47880 https://lk.example.ts.net:47880");
    const html = await res.text();
    expect(html).toContain('<script src="livekit/client.js"></script>');
    expect(html).not.toContain('innerHTML');
    const js = await fetch(`${h.base}/livekit/client.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(await js.text()).toContain('LivekitClient');
  });

  it('refuses unknown links and callers without access before touching LiveKit', async () => {
    expect((await post(`${h.base}/livekit/token?t=nope`)).status).toBe(403);
    h.access.enabled = false;
    expect((await post(`${h.base}/livekit/token?t=tok123`)).status).toBe(403);
    expect(h.lk.rooms).toEqual([]);
  });

  it('opens a unique room, dispatches the worker with the call metadata and mints a room-only caller token', async () => {
    const res = await post(`${h.base}/livekit/token?t=tok123`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TokenResponse;
    expect(body.url).toBe('wss://lk.example.ts.net:47880');
    expect(body.agent).toBe('Andy');
    const room = h.lk.rooms[0];
    expect(room).toMatch(new RegExp(`^voice-${LINE.slice(6)}-[0-9a-f]{12}$`));
    const [dispatch] = h.lk.dispatches;
    expect(dispatch.room).toBe(room);
    expect(dispatch.agentName).toBe('nanoclaw-voice');
    const meta = dispatch.metadata;
    expect(meta).toEqual({
      v: LIVEKIT_PROTOCOL_VERSION,
      callId: body.callId,
      lineId: LINE,
      agentName: 'Andy',
      callerName: 'Ethan',
      callerIdentity: expect.stringMatching(/^caller-/),
      vocabulary: ['NanoClaw', 'Stan'],
      sttModel: 'gemini-3.5-transcribe-live',
      sttFallbackModel: 'gemini-3.5-transcribe',
      ttsModel: 'gemini-3.8-flash-tts',
      ttsFallbackModel: 'gemini-3.8-flash-lite-tts',
      ttsVoice: 'Alnilam',
      silenceMs: 2500,
      maxDurationMs: 15 * MIN,
      joinTimeoutMs: 60_000,
    });
    // Nothing secret in the dispatch (agents-js logs jobs), and no host address the worker would trust.
    expect(meta).not.toHaveProperty('secret');
    expect(meta).not.toHaveProperty('hostUrl');
    const secret = liveKitCallSecret(API_SECRET, meta.callId);
    expect(JSON.stringify(dispatch)).not.toContain(secret);
    expect(JSON.stringify(dispatch)).not.toContain(API_SECRET);

    const claims = jwtPayload(body.token);
    expect(claims.sub).toBe(meta.callerIdentity);
    expect(claims.iss).toBe(API_KEY);
    expect(Number(claims.exp) - Number(claims.nbf ?? claims.iat ?? Number(claims.exp) - 120)).toBeLessThanOrEqual(120);
    expect(claims.video).toMatchObject({
      roomJoin: true,
      room,
      canPublish: true,
      canPublishSources: ['microphone'],
      canSubscribe: true,
      canPublishData: false,
    });
    // The worker's secret is not in what the browser holds either.
    expect(body.token).not.toContain(secret);
    expect(JSON.stringify(claims)).not.toContain(secret);
  });

  it('answers 502 and cleans up when the LiveKit server is unreachable', async () => {
    h.lk.failCreate = true;
    expect((await post(`${h.base}/livekit/token?t=tok123`)).status).toBe(502);
    await settle();
    expect(h.lk.deleted).toHaveLength(1);
  });

  it('authenticates the worker routes with the per-call secret derived from the API secret', async () => {
    await post(`${h.base}/livekit/token?t=tok123`);
    const meta = h.lk.dispatches[0].metadata;
    const url = `${h.hostUrl}/webhook/voice/livekit/agent`;
    const secret = liveKitCallSecret(API_SECRET, meta.callId);
    expect((await post(`${url}/joined`, { callId: meta.callId })).status).toBe(409);
    expect((await post(`${url}/joined`, { callId: meta.callId }, { Authorization: `Bearer ${secret}x` })).status).toBe(
      409,
    );
    const otherKey = liveKitCallSecret('another-livekit-secret', meta.callId);
    expect((await post(`${url}/joined`, { callId: meta.callId }, { Authorization: `Bearer ${otherKey}` })).status).toBe(
      409,
    );
    expect((await fetch(`${url}/events?call=${meta.callId}`)).status).toBe(404);
    expect((await post(`${url}/joined`, { callId: meta.callId }, workerAuth(meta.callId))).status).toBe(200);
  });

  it('hands each transcribed turn to the agent as a spoken message and speaks every reply in full', async () => {
    const { worker } = await startCall(h);
    const id = await worker.utter('Що в мене завтра в календарі?');
    expect(h.inbound).toHaveLength(1);
    const msg = h.inbound[0];
    expect(msg.id).toBe(`livekit:${worker.meta.callId}:${id}`);
    expect(msg.content).toMatchObject({
      text: walkieMessageText('Що в мене завтра в календарі?'),
      sender: 'Ethan',
      senderId: LINE,
      livekit: { callId: worker.meta.callId, utteranceId: id },
    });
    const text = (msg.content as { text: string }).text;
    expect(text.startsWith('<voice source="livekit">Що в мене завтра в календарі?</voice>\n')).toBe(true);
    expect(text).toContain('no markdown, no links, no code blocks, numbers written as words');
    // A follow-up while the agent works is its own message with its own id.
    const second = await worker.utter('And the day after?');
    expect(second).not.toBe(id);

    const interim = await h.adapter.deliver(LINE, null, {
      kind: 'chat',
      content: { text: 'Checking.' },
      inReplyTo: msg.id,
    });
    expect(interim).toBe(msg.id);
    await h.adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'Dentist at nine.' }, inReplyTo: msg.id });
    await worker.waitFor((e) => e.type === 'reply' && e.text === 'Dentist at nine.');
    expect(worker.events.filter((e) => e.type === 'reply')).toEqual([
      { type: 'reply', text: 'Checking.' },
      { type: 'reply', text: 'Dentist at nine.' },
    ]);
    worker.close();
  });

  it('bounds utterance size and rate', async () => {
    const { worker } = await startCall(h);
    expect((await worker.post('utterance', { text: '   ' })).status).toBe(400);
    expect((await worker.post('utterance', { text: 'я'.repeat(4200) })).status).toBe(413);
    for (let i = 0; i < 20; i++) expect((await worker.post('utterance', { text: `t${i}` })).status).toBe(202);
    const refused = await worker.post('utterance', { text: 'one too many' });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBeTruthy();
    h.clock.now += MIN;
    expect((await worker.post('utterance', { text: 'later' })).status).toBe(202);
    worker.close();
  });

  it('refuses an utterance before the caller is in and after access is gone', async () => {
    expect((await post(`${h.base}/livekit/token?t=tok123`)).status).toBe(200);
    const meta = h.lk.dispatches[0].metadata;
    const url = `${h.hostUrl}/webhook/voice/livekit/agent/utterance`;
    expect((await post(url, { callId: meta.callId, text: 'hi' }, workerAuth(meta.callId))).status).toBe(409);
    expect((await post(url, { callId: meta.callId, text: 'hi' })).status).toBe(409);
    expect(h.inbound).toEqual([]);
  });

  it('speaks proactive agent messages and tells the worker while the agent works', async () => {
    const { worker } = await startCall(h);
    const id = await h.adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'Your taxi is here.' } });
    expect(id).toMatch(/^livekit:.*:out-1$/);
    await worker.waitFor((e) => e.type === 'reply' && e.text === 'Your taxi is here.');
    await h.adapter.setTyping!(LINE, null);
    await worker.waitFor((e) => e.type === 'thinking');
    worker.close();
  });

  it('drops a reply for an ended call instead of speaking it into the next one', async () => {
    const first = await startCall(h);
    await first.worker.utter('old question');
    const oldId = h.inbound[0].id;
    const second = await startCall(h);
    await expect(
      h.adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'stale' }, inReplyTo: oldId }),
    ).resolves.toBeUndefined();
    await settle();
    expect(second.worker.events.some((e) => e.type === 'reply')).toBe(false);
    first.worker.close();
    second.worker.close();
  });

  it('ends the call on hangup by deleting the room and tells the worker', async () => {
    const { call, worker } = await startCall(h);
    h.clock.now += 3 * MIN;
    expect((await post(`${h.base}/livekit/end?t=tok123`, { callId: call.callId })).status).toBe(204);
    expect(h.lk.deleted).toEqual([h.lk.rooms[0]]);
    await worker.streamClosed;
    expect(worker.events.at(-1)).toEqual({ type: 'end', reason: 'hangup' });
    // The worker's routes are closed for this call now.
    expect((await worker.post('utterance', { text: 'late' })).status).toBe(409);
  });

  it('turns a fallback model off when it is set to off or empty', async () => {
    await h.stop();
    h = await startHarness({ gemini: { apiKey: 'gk-test', apiBase: google.apiBase } }, true, {
      walkie: { sttFallbackModel: 'off', ttsFallbackModel: ' ', ttsModel: 'gemini-3.8-flash-lite-tts' },
    });
    expect((await post(`${h.base}/livekit/token?t=tok123`)).status).toBe(200);
    expect(h.lk.dispatches[0].metadata).toMatchObject({
      sttModel: 'gemini-3.5-transcribe-live',
      sttFallbackModel: '',
      ttsModel: 'gemini-3.8-flash-lite-tts',
      ttsFallbackModel: '',
    });
  });

  it('names a missing or mismatched worker when the page gives up on it', async () => {
    const first = await startCall(h);
    await post(`${h.base}/livekit/end?t=tok123`, { callId: first.call.callId, reason: 'no-agent' });
    await first.worker.streamClosed;
    expect(first.worker.events.at(-1)).toEqual({
      type: 'end',
      reason: 'no voice worker joined (worker down, or not on this protocol version)',
    });
    const second = await startCall(h);
    await post(`${h.base}/livekit/end?t=tok123`, { callId: second.call.callId, reason: 'updating' });
    await second.worker.streamClosed;
    expect(second.worker.events.at(-1)).toEqual({
      type: 'end',
      reason: 'the voice worker is on another protocol version',
    });
  });

  it('ends the call when the caller loses access', async () => {
    const { worker } = await startCall(h);
    h.access.enabled = false;
    await worker.streamClosed;
    expect(worker.events.at(-1)).toMatchObject({ type: 'end', reason: 'caller access revoked or line changed' });
    expect(h.lk.deleted).toHaveLength(1);
  });

  it('ends the call when the worker link drops', async () => {
    const { worker } = await startCall(h);
    worker.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(h.lk.deleted).toHaveLength(1);
  });

  it('charges the daily minutes from join to end and caps a call at the remaining budget', async () => {
    await h.stop();
    google = await startFakeGoogle();
    h = await startHarness({ maxCallMsPerDay: 2 * MIN, gemini: { apiKey: 'gk-test', apiBase: google.apiBase } });
    const first = await startCall(h);
    h.clock.now += 90_000;
    await post(`${h.base}/livekit/end?t=tok123`, { callId: first.call.callId });
    // 30 s of the day left: the next call is capped there by a host-side timer.
    const res = await post(`${h.base}/livekit/token?t=tok123`);
    expect(res.status).toBe(200);
    expect(h.lk.dispatches.at(-1)!.metadata.maxDurationMs).toBe(30_000);
    const worker = await attachWorker(h, h.lk.dispatches.at(-1)!.metadata);
    expect((await worker.post('joined')).status).toBe(200);
    h.clock.now += 30_000;
    await post(`${h.base}/livekit/end?t=tok123`, { callId: worker.meta.callId });
    // The day's minutes are gone for every engine.
    const refused = await post(`${h.base}/livekit/token?t=tok123`);
    expect(refused.status).toBe(429);
    expect((await post(`${h.base}/gemini/token?t=tok123`)).status).toBe(429);
  });

  it('ends a call that runs into the budget cap by deleting its room', async () => {
    await h.stop();
    google = await startFakeGoogle();
    h = await startHarness({ maxCallMsPerDay: 100, gemini: { apiKey: 'gk-test', apiBase: google.apiBase } });
    const { worker } = await startCall(h);
    await worker.streamClosed;
    expect(worker.events.at(-1)).toEqual({ type: 'end', reason: 'daily minute budget' });
    expect(h.lk.deleted).toHaveLength(1);
  });

  it('shares the hourly start cap with the other engines', async () => {
    await h.stop();
    google = await startFakeGoogle();
    h = await startHarness({ maxCallsPerHour: 2, gemini: { apiKey: 'gk-test', apiBase: google.apiBase } });
    expect((await post(`${h.base}/gemini/token?t=tok123`)).status).toBe(200);
    expect((await post(`${h.base}/livekit/token?t=tok123`)).status).toBe(200);
    const refused = await post(`${h.base}/livekit/token?t=tok123`);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBeTruthy();
  });

  it('deletes the room of a call that was replaced while it was connecting', async () => {
    let release!: () => void;
    h.lk.createGate = new Promise((r) => (release = r));
    const first = post(`${h.base}/livekit/token?t=tok123`);
    await settle();
    // A newer call takes the line while the room is still being created.
    expect((await post(`${h.base}/gemini/token?t=tok123`)).status).toBe(200);
    h.lk.createGate = null;
    release();
    expect((await first).status).toBe(409);
    const [room] = h.lk.rooms;
    // The replaced call's own cleanup ran before the room existed; the room still goes.
    expect(h.lk.ops.indexOf(`create:${room}`)).toBeGreaterThanOrEqual(0);
    expect(h.lk.ops.lastIndexOf(`delete:${room}`)).toBeGreaterThan(h.lk.ops.indexOf(`create:${room}`));
  });

  it('deletes the room when the page left while the room was being set up', async () => {
    let release!: () => void;
    h.lk.createGate = new Promise((r) => (release = r));
    const controller = new AbortController();
    const pending = fetch(`${h.base}/livekit/token?t=tok123`, { method: 'POST', signal: controller.signal });
    await settle();
    controller.abort();
    await expect(pending).rejects.toThrow();
    await settle();
    h.lk.createGate = null;
    release();
    // Nobody gets the token, so the room would otherwise wait for a caller until the join timeout.
    await vi.waitFor(() => expect(h.lk.deleted).toHaveLength(1));
    expect(h.lk.deleted).toEqual(h.lk.rooms);
  });

  it('teardown awaits the delete of a room replaced while connecting', async () => {
    let release!: () => void;
    h.lk.createGate = new Promise((r) => (release = r));
    const first = post(`${h.base}/livekit/token?t=tok123`);
    await settle();
    expect((await post(`${h.base}/gemini/token?t=tok123`)).status).toBe(200);
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((r) => (releaseDelete = r));
    const deleteRoom = h.lk.deleteRoom.bind(h.lk);
    h.lk.deleteRoom = async (room) => {
      await deleteGate;
      return deleteRoom(room);
    };
    h.lk.createGate = null;
    release();
    await settle();
    let tornDown = false;
    const teardown = h.adapter.teardown().then(() => (tornDown = true));
    await settle();
    expect(tornDown).toBe(false);
    releaseDelete();
    await teardown;
    expect((await first).status).toBe(409);
    expect(h.lk.deleted).toContain(h.lk.rooms[0]);
  });

  it('ends a call whose worker never opens its event stream after reporting the caller in', async () => {
    await h.stop();
    google = await startFakeGoogle();
    h = await startHarness({ gemini: { apiKey: 'gk-test', apiBase: google.apiBase } }, true, {
      workerStreamTimeoutMs: 100,
    });
    expect((await post(`${h.base}/livekit/token?t=tok123`)).status).toBe(200);
    const meta = h.lk.dispatches[0].metadata;
    const joined = await post(
      `${h.hostUrl}/webhook/voice/livekit/agent/joined`,
      { callId: meta.callId },
      workerAuth(meta.callId),
    );
    expect(joined.status).toBe(200);
    await new Promise((r) => setTimeout(r, 250));
    expect(h.lk.deleted).toEqual([h.lk.rooms[0]]);
  });

  it('refuses a delivery once the caller lost access instead of reporting it sent', async () => {
    await h.stop();
    google = await startFakeGoogle();
    h = await startHarness({ accessCheckIntervalMs: 60_000, gemini: { apiKey: 'gk-test', apiBase: google.apiBase } });
    const { worker } = await startCall(h);
    h.access.enabled = false;
    await expect(
      h.adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'Your taxi is here.' } }),
    ).rejects.toThrow(/revoked/);
    await worker.streamClosed;
  });

  it('refuses a start over the daily minutes without ending the running call', async () => {
    await h.stop();
    google = await startFakeGoogle();
    h = await startHarness({ maxCallMsPerDay: 2 * MIN, gemini: { apiKey: 'gk-test', apiBase: google.apiBase } });
    const { worker } = await startCall(h);
    h.clock.now += 2 * MIN;
    expect((await post(`${h.base}/livekit/token?t=tok123`)).status).toBe(429);
    await settle();
    expect(h.lk.deleted).toEqual([]);
    expect(worker.events.some((e) => e.type === 'end')).toBe(false);
    worker.close();
  });

  it('newest wins across engines on a line', async () => {
    const gemini = (await (await post(`${h.base}/gemini/token?t=tok123`)).json()) as { callId: string };
    const { worker } = await startCall(h);
    // The LiveKit call replaced the Gemini one.
    expect(
      (await post(`${h.base}/gemini/consult?t=tok123`, { callId: gemini.callId, functionCallId: 'f', request: 'x' }))
        .status,
    ).toBe(409);
    // And a Gemini call replaces the LiveKit one.
    expect((await post(`${h.base}/gemini/token?t=tok123`)).status).toBe(200);
    await worker.streamClosed;
    expect(worker.events.at(-1)).toEqual({ type: 'end', reason: 'replaced by a new call' });
    expect(h.lk.deleted).toHaveLength(1);
  });
});

describe('mirror target', () => {
  it('picks the one live chat of the channel, or the one direct chat among several', () => {
    expect(pickMirrorTarget([], 'telegram')).toEqual({ skip: 'no telegram chat is wired to the agent' });
    expect(
      pickMirrorTarget(
        [
          mg({ id: 'a', denied_at: '2026-01-01' }),
          mg({ id: 'b', detached_at: '2026-01-01' }),
          mg({ id: 'c', channel_type: 'slack' }),
        ],
        'telegram',
      ),
    ).toEqual({ skip: 'no telegram chat is wired to the agent' });
    const dm = mg({ id: 'dm' });
    expect(pickMirrorTarget([dm], 'telegram')).toEqual({ target: dm });
    // The same chat reached through two wirings is one chat.
    expect(pickMirrorTarget([dm, { ...dm }], 'telegram')).toEqual({ target: dm });
    const group = mg({ id: 'g', platform_id: 'telegram:-200', is_group: 1 });
    expect(pickMirrorTarget([group, dm], 'telegram')).toEqual({ target: dm });
    expect(pickMirrorTarget([group], 'telegram')).toEqual({ target: group });
    expect(pickMirrorTarget([dm, mg({ id: 'dm2', platform_id: 'telegram:101' })], 'telegram')).toMatchObject({
      skip: expect.stringContaining('2 telegram chats'),
    });
    expect(pickMirrorTarget([group, mg({ id: 'g2', is_group: 1 })], 'telegram')).toHaveProperty('skip');
  });
});

describe('livekit voice path mirrored into the agent chat', () => {
  let h: Harness;
  afterEach(async () => {
    await h.stop();
  });

  const start = async (groups: Array<Partial<MessagingGroup>>, mirror = 'telegram') => {
    const fake = fakeMirror(groups);
    h = await startHarness({ accessCheckIntervalMs: 60_000 }, true, { mirror, mirrorApi: fake.api });
    return fake;
  };

  it('posts the transcript and the reply once each, in order, to the one Telegram chat', async () => {
    const { posts } = await start([{ platform_id: 'telegram:100' }, { channel_type: 'voice', platform_id: LINE }]);
    const { worker } = await startCall(h);
    await worker.utter('Book a table for two');
    await h.adapter.deliver(LINE, null, {
      kind: 'chat',
      content: { text: 'Booked for **eight**.' },
      inReplyTo: h.inbound[0].id,
    });
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    await settle();
    expect(posts).toEqual([
      { instance: 'telegram', platformId: 'telegram:100', text: '🎙 Book a table for two' },
      { instance: 'telegram', platformId: 'telegram:100', text: 'Booked for **eight**.' },
    ]);
    worker.close();
  });

  it('mirrors nothing for a reply whose delivery failed, so the retry posts it once', async () => {
    const { posts } = await start([{}]);
    const { worker } = await startCall(h);
    await worker.utter('hello');
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    h.access.enabled = false;
    await expect(
      h.adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'Hi.' }, inReplyTo: h.inbound[0].id }),
    ).rejects.toThrow(/revoked/);
    await settle();
    expect(posts).toHaveLength(1);
    worker.close();
  });

  it('still mirrors a reply that arrives after the call ended', async () => {
    const { posts } = await start([{}]);
    const { call, worker } = await startCall(h);
    await worker.utter('Remind me later');
    await post(`${h.base}/livekit/end?t=tok123`, { callId: call.callId });
    await h.adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'Done.' }, inReplyTo: h.inbound[0].id });
    await vi.waitFor(() => expect(posts.map((p) => p.text)).toEqual(['🎙 Remind me later', 'Done.']));
    expect(worker.events.some((e) => e.type === 'reply')).toBe(false);
  });

  it('skips mirroring when no chat or more than one could be meant', async () => {
    for (const groups of [[], [{ platform_id: 'telegram:1' }, { id: 'x', platform_id: 'telegram:2' }]]) {
      const { posts } = await start(groups);
      const { worker } = await startCall(h);
      await worker.utter('hello');
      await h.adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'Hi.' }, inReplyTo: h.inbound[0].id });
      await settle();
      expect(posts).toEqual([]);
      worker.close();
      await h.stop();
    }
    h = await startHarness({}, false);
  });

  it('is off with WALKIE_MIRROR=off', async () => {
    const { posts } = await start([{}], 'off');
    const { worker } = await startCall(h);
    await worker.utter('hello');
    await h.adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'Hi.' }, inReplyTo: h.inbound[0].id });
    await settle();
    expect(posts).toEqual([]);
    worker.close();
  });
});

describe('livekit call page', () => {
  const html = liveKitCallPageHtml();
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));

  it('is valid script', () => {
    expect(() => new Function(script)).not.toThrow();
  });

  it('shows the walkie-talkie states and labels the captions the worker sends', () => {
    expect(script).toContain("setStatus('Listening')");
    expect(script).toContain("setStatus(names.agent + ' is thinking')");
    expect(script).toContain("setStatus(names.agent + ' is speaking')");
    // Thinking comes from the worker's own attribute, not lk.agent.state.
    expect(script).toContain(`const THINKING_ATTR = '${WALKIE_THINKING_ATTRIBUTE}'`);
    expect(script).toContain("registerTextStreamHandler('lk.transcription'");
    // The caller's own turns come back from the worker against the caller's track: "You".
    expect(script).toContain("attrs['lk.transcribed_track_id'] === c.localSid");
  });

  it('says the voice service is updating instead of waiting forever for a worker', () => {
    expect(script).toContain("hangup(c, UPDATING, false, 'updating')");
    expect(script).toContain("hangup(c, UPDATING, false, 'no-agent')");
    expect(script).toContain('The voice service is updating. Try again in a minute.');
  });

  it('keeps iOS on relay-only ICE', () => {
    expect(script).toContain("rtcConfig: { iceTransportPolicy: 'relay' }");
    expect(script).toContain('isIOS');
  });
});

describe('walkie message text', () => {
  it('marks the transcript as spoken and says how to answer', () => {
    expect(walkieMessageText('Привіт')).toBe(`<voice source="livekit">Привіт</voice>\n${WALKIE_REPLY_NOTE}`);
    expect(WALKIE_REPLY_NOTE).toContain('separate written message');
  });
});
