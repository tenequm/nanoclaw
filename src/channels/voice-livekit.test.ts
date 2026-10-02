/**
 * The LiveKit path of the voice channel at the host boundary: the real adapter
 * behind the real webhook server, hit over HTTP the way the call page and the
 * worker do. Faked: the LiveKit server API (recorded calls), Google's token
 * endpoint (for the cross-engine test) and the clock.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, InboundMessage } from './adapter.js';
import { createGptLiveAdapter, DELEGATION_TIMEOUT_LINE, lineIdForToken, type GptLiveConfig } from './voice.js';
import type { LiveKitServerApi, LiveKitVoiceConfig } from './voice-livekit.js';
import { liveKitCallSecret, type LiveKitHostEvent, type LiveKitJobMetadata } from './voice-livekit-protocol.js';
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
            agent: { name: 'Andy', personality: 'Dry humour, precise.' },
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
  /** The consult id from each accepted ask, in order. */
  ask(request: string): Promise<string>;
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
    ask: async (request) => {
      const res = await workerPost('ask', { request });
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
    expect((await post(`${h.base}/livekit/agent/ask`, {})).status).toBe(503);
    expect((await fetch(`${h.base}/call?t=tok123`)).status).toBe(200);
  });
});

describe('livekit voice path (fake LiveKit, real webhook server)', () => {
  let h: Harness;
  let google: { apiBase: string; close(): Promise<void> };

  beforeEach(async () => {
    google = await startFakeGoogle();
    h = await startHarness({
      delegationTimeoutMs: 300,
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
    expect(meta).toMatchObject({
      v: 1,
      callId: body.callId,
      lineId: LINE,
      agentName: 'Andy',
      callerName: 'Ethan',
      model: 'gemini-3.8-live',
      voice: 'Kore',
      scheduling: 'WHEN_IDLE',
      delegationTimeoutMs: 300,
      timeoutLine: DELEGATION_TIMEOUT_LINE,
      maxDurationMs: 15 * MIN,
    });
    expect(meta.instructions).toContain('You are Andy');
    expect(meta.instructions).toContain('Dry humour, precise.');
    expect(meta.instructions).toContain('Answer from the backend');
    // The browser path's page-injected turns never reach this engine.
    expect(meta.instructions).not.toContain('Agent update:');
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

  it('routes ask_agent to the agent and speaks every reply to it, interim and final', async () => {
    const { worker } = await startCall(h);
    const ask = await worker.post('ask', { request: 'What is on my calendar tomorrow?' });
    expect(ask.status).toBe(202);
    const { id } = (await ask.json()) as { id: string };
    expect(h.inbound).toHaveLength(1);
    const msg = h.inbound[0];
    expect(msg.id).toBe(`livekit:${worker.meta.callId}:${id}`);
    expect(msg.content).toMatchObject({ text: 'What is on my calendar tomorrow?', sender: 'Ethan', senderId: LINE });

    const interim = await h.adapter.deliver(LINE, null, {
      kind: 'chat',
      content: { text: 'Let me check.' },
      inReplyTo: msg.id,
    });
    expect(interim).toBe(msg.id);
    await h.adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'Dentist at nine.' }, inReplyTo: msg.id });
    await worker.waitFor((e) => e.type === 'reply' && e.text === 'Dentist at nine.');
    // The first reply answers the consult; the second answers none and is spoken as a new turn.
    expect(worker.events.filter((e) => e.type === 'reply')).toEqual([
      { type: 'reply', text: 'Let me check.', consultIds: [id] },
      { type: 'reply', text: 'Dentist at nine.' },
    ]);
    // The reply settled the consult: no timeout line follows.
    await new Promise((r) => setTimeout(r, 400));
    expect(worker.events.some((e) => e.type === 'reply' && e.timedOut)).toBe(false);
    worker.close();
  });

  it('settles the targeted ask_agent and the ones opened after it with a batched reply', async () => {
    const { worker } = await startCall(h);
    const first = await worker.ask('first');
    const second = await worker.ask('second');
    // The agent's batched turn answers the first inbound only.
    await h.adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'Both done.' }, inReplyTo: h.inbound[0].id });
    await new Promise((r) => setTimeout(r, 400));
    expect(worker.events.filter((e) => e.type === 'reply')).toEqual([
      { type: 'reply', text: 'Both done.', consultIds: [first, second] },
    ]);
    worker.close();
  });

  it('routes out-of-order replies to their own consults and leaves earlier ones open', async () => {
    const { worker } = await startCall(h);
    const a = await worker.ask('a');
    const b = await worker.ask('b');
    const c = await worker.ask('c');
    const idOf = (consultId: string) => h.inbound.find((m) => m.id.endsWith(`:${consultId}`))!.id;
    await h.adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'C first.' }, inReplyTo: idOf(c) });
    await h.adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'Then B.' }, inReplyTo: idOf(b) });
    // A second reply to C answers nothing; it must not settle A.
    await h.adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'More on C.' }, inReplyTo: idOf(c) });
    await worker.waitFor((e) => e.type === 'reply' && e.text === 'More on C.');
    // A got no reply, so only A hits the timeout line.
    const timedOut = await worker.waitFor((e) => e.type === 'reply' && e.timedOut === true);
    expect(worker.events.filter((e) => e.type === 'reply')).toEqual([
      { type: 'reply', text: 'C first.', consultIds: [c] },
      { type: 'reply', text: 'Then B.', consultIds: [b] },
      { type: 'reply', text: 'More on C.' },
      { type: 'reply', text: DELEGATION_TIMEOUT_LINE, timedOut: true, consultIds: [a] },
    ]);
    expect(timedOut).toMatchObject({ consultIds: [a] });
    worker.close();
  });

  it('bounds open requests and request size', async () => {
    const { worker } = await startCall(h);
    expect((await worker.post('ask', { request: 'x'.repeat(5000) })).status).toBe(413);
    for (let i = 0; i < 3; i++) expect((await worker.post('ask', { request: `q${i}` })).status).toBe(202);
    expect((await worker.post('ask', { request: 'one too many' })).status).toBe(429);
    worker.close();
  });

  it('answers an unanswered ask_agent with the timeout line', async () => {
    const { worker } = await startCall(h);
    const id = await worker.ask('slow one');
    const event = await worker.waitFor((e) => e.type === 'reply');
    expect(event).toEqual({ type: 'reply', text: DELEGATION_TIMEOUT_LINE, timedOut: true, consultIds: [id] });
    worker.close();
  });

  it('speaks proactive agent messages and holding notes on the call', async () => {
    const { worker } = await startCall(h);
    const id = await h.adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'Your taxi is here.' } });
    expect(id).toMatch(/^livekit:/);
    await worker.waitFor((e) => e.type === 'say' && e.text === 'Your taxi is here.');
    await worker.post('ask', { request: 'book a table' });
    h.clock.now += 25_000;
    await h.adapter.setTyping!(LINE, null);
    await worker.waitFor((e) => e.type === 'thinking');
    worker.close();
  });

  it('drops a reply for an ended call instead of speaking it into the next one', async () => {
    const first = await startCall(h);
    await first.worker.post('ask', { request: 'old question' });
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
    expect((await worker.post('ask', { request: 'late' })).status).toBe(409);
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
