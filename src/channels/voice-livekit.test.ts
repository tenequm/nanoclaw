/**
 * The LiveKit path of the voice channel at the host boundary: the real adapter
 * behind the real webhook server, hit over HTTP the way the call page and the
 * worker do. Faked: the LiveKit server API (recorded calls), Google's token
 * endpoint (for the cross-engine test), the mirror's chats and the clock.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, InboundEvent, InboundMessage, OutboundMessage } from './adapter.js';
import { createGptLiveAdapter, lineIdForToken, type GptLiveConfig, type VoiceChannelAdapter } from './voice.js';
import {
  liveKitCallPageHtml,
  liveKitChatDelivered,
  liveKitChatTyping,
  pickMirrorTarget,
  spokenText,
  type BoundCallChat,
  walkieMessageText,
  WALKIE_CHAT_REPLY_NOTE,
  WALKIE_REPLY_NOTE,
  type LiveKitServerApi,
  type LiveKitVoiceConfig,
  type MirrorApi,
} from './voice-livekit.js';
import type { MessagingGroup } from '../types.js';
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

/** The agent's chats, the /voice binding, who administers the agent, and what was posted into the chats. */
function fakeMirror(
  groups: Array<Partial<MessagingGroup>>,
  options: { bound?: Omit<BoundCallChat, 'group'> & { group: Partial<MessagingGroup> }; admins?: string[] } = {},
) {
  const posts: Array<{ instance: string; platformId: string; threadId?: string | null; text: string }> = [];
  const state = { bound: options.bound, admins: new Set(options.admins ?? []) };
  const api: MirrorApi = {
    groupsFor: async () => groups.map((g, i) => mg({ id: `mg-${i}`, ...g })),
    adapter: (instance) => ({
      deliver: async (platformId: string, threadId: string | null, message: OutboundMessage) => {
        const text = (message.content as { text: string }).text;
        posts.push(threadId ? { instance, platformId, threadId, text } : { instance, platformId, text });
        return 'tg-1';
      },
    }),
    boundChat: async () => (state.bound ? { ...state.bound, group: mg(state.bound.group) } : null),
    isAdmin: async (userId) => state.admins.has(userId),
  };
  return { api, posts, state };
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
  /** Turns routed into a call chat. */
  events: InboundEvent[];
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
  const events: InboundEvent[] = [];
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
          mirrorApi: fakeMirror([]).api,
          ...lkOverrides,
        }
      : undefined,
    ...overrides,
  });
  await adapter.setup({
    onInbound: (_platformId, _threadId, message) => {
      inbound.push(message);
    },
    onInboundEvent: (event) => {
      events.push(event);
    },
    onMetadata: () => {},
    onAction: () => {},
  });
  return {
    adapter,
    events,
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

  it('has no walkie-talkie link to hand out', () => {
    expect((h.adapter as VoiceChannelAdapter).walkieLink(LINE)).toBeNull();
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

  it('renders the walkie-talkie link of a line it holds the token for, and no other', () => {
    const adapter = h.adapter as VoiceChannelAdapter;
    expect(adapter.walkieLink(LINE)).toBe(`${h.hostUrl}/webhook/voice/livekit?t=tok123`);
    expect(adapter.walkieLink(lineIdForToken('other'))).toBeNull();
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
      v: 2,
      callId: body.callId,
      lineId: LINE,
      agentName: 'Andy',
      callerName: 'Ethan',
      callerIdentity: expect.stringMatching(/^caller-/),
      vocabulary: ['NanoClaw', 'Stan'],
      sttModel: 'gemini-3.8-flash',
      ttsModel: 'gemini-3.1-flash-tts-preview',
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

describe('livekit call talking in the agent chat', () => {
  let h: Harness;
  afterEach(async () => {
    await h.stop();
  });

  const start = async (groups: Array<Partial<MessagingGroup>>, mirror = 'telegram', options = {}) => {
    const fake = fakeMirror(groups, options);
    h = await startHarness({ accessCheckIntervalMs: 60_000 }, true, { mirror, mirrorApi: fake.api });
    return fake;
  };

  /** What the delivery poll reports once the agent's message reached a chat. */
  const delivered = (platformId: string, text: string, threadId: string | null = null, agentGroupId = 'ag-andy') =>
    liveKitChatDelivered(
      {
        id: `out-${text.length}`,
        kind: 'chat',
        content: JSON.stringify({ text }),
        channelType: 'telegram',
        platformId,
        threadId,
      },
      agentGroupId,
    );

  it('routes each turn into the one Telegram chat as the line owner, posts the transcript and speaks the chat replies', async () => {
    const { posts } = await start([{ platform_id: 'telegram:100' }, { channel_type: 'voice', platform_id: LINE }]);
    const { worker } = await startCall(h);
    const id = await worker.utter('Book a table for two');
    expect(h.inbound).toEqual([]);
    expect(h.events).toHaveLength(1);
    const event = h.events[0];
    expect(event).toMatchObject({
      channelType: 'telegram',
      instance: 'telegram',
      platformId: 'telegram:100',
      threadId: null,
      agentGroupId: 'ag-andy',
      message: { id: `livekit:${worker.meta.callId}:${id}`, kind: 'chat', isMention: true, isGroup: false },
    });
    expect(JSON.parse(event.message.content)).toEqual({
      text: walkieMessageText('Book a table for two', WALKIE_CHAT_REPLY_NOTE),
      sender: 'Ethan',
      senderId: LINE,
      livekit: { callId: worker.meta.callId, utteranceId: id },
    });
    await vi.waitFor(() =>
      expect(posts).toEqual([
        { instance: 'telegram', platformId: 'telegram:100', text: '🎙 Ethan: Book a table for two' },
      ]),
    );

    // The agent answers in the chat; the host speaks what reached it, and only there.
    delivered('telegram:100', 'Booked for **eight**.');
    delivered('telegram:200', 'Another chat.');
    delivered('telegram:100', 'Another agent.', null, 'ag-other');
    // Thinking is this agent's typing in the call chat; another agent's typing there is not.
    liveKitChatTyping({ channelType: 'telegram', platformId: 'telegram:100', threadId: null }, 'ag-other');
    await settle();
    expect(worker.events.some((e) => e.type === 'thinking')).toBe(false);
    liveKitChatTyping({ channelType: 'telegram', platformId: 'telegram:100', threadId: null }, 'ag-andy');
    await worker.waitFor((e) => e.type === 'thinking');
    await worker.waitFor((e) => e.type === 'reply');
    expect(worker.events.filter((e) => e.type === 'reply')).toEqual([{ type: 'reply', text: 'Booked for **eight**.' }]);
    // Nothing of the reply is posted by the voice host: the agent's own message is the chat's copy.
    await settle();
    expect(posts).toHaveLength(1);
    worker.close();
  });

  it('talks in the chat /voice was run in, ahead of the default rule, still as the line caller', async () => {
    const topic = { id: 'mg-topic', platform_id: 'telegram:-300:7', is_group: 1 };
    const { posts } = await start([{ platform_id: 'telegram:100' }, topic], 'telegram', {
      bound: { group: topic, threadId: 'th-1', ownerIds: ['telegram:42'] },
      admins: ['telegram:42'],
    });
    const { worker } = await startCall(h);
    await worker.utter('hello');
    expect(h.events[0]).toMatchObject({ platformId: 'telegram:-300:7', threadId: 'th-1', message: { isGroup: true } });
    expect(JSON.parse(h.events[0].message.content)).toMatchObject({ sender: 'Ethan', senderId: LINE });
    await vi.waitFor(() =>
      expect(posts).toEqual([
        { instance: 'telegram', platformId: 'telegram:-300:7', threadId: 'th-1', text: '🎙 Ethan: hello' },
      ]),
    );
    delivered('telegram:-300:7', 'In the thread.', 'th-1');
    delivered('telegram:-300:7', 'Other thread.', 'th-2');
    await worker.waitFor((e) => e.type === 'reply');
    await settle();
    expect(worker.events.filter((e) => e.type === 'reply')).toEqual([{ type: 'reply', text: 'In the thread.' }]);
    worker.close();
  });

  it('speaks agent messages to the call chat from the join, before the first turn', async () => {
    await start([{ platform_id: 'telegram:100' }]);
    const { worker } = await startCall(h);
    await settle();
    delivered('telegram:100', 'Your taxi is here.');
    await worker.waitFor((e) => e.type === 'reply' && e.text === 'Your taxi is here.');
    worker.close();
  });

  it('ignores a /voice chat that is no longer the agent, or when no owner account is its admin', async () => {
    const gone = { id: 'mg-gone', platform_id: 'telegram:-9' };
    const topic = { id: 'mg-topic', platform_id: 'telegram:-300:7', is_group: 1 };
    const fake = await start([{ platform_id: 'telegram:100' }, topic], 'telegram', {
      bound: { group: gone, threadId: null, ownerIds: ['telegram:42'] },
      admins: ['telegram:42'],
    });
    const { worker } = await startCall(h);
    await worker.utter('one');
    expect(h.events[0].platformId).toBe('telegram:100');
    fake.state.bound = { group: topic, threadId: null, ownerIds: ['telegram:42'] };
    fake.state.admins.clear();
    await worker.utter('two');
    expect(h.events[1].platformId).toBe('telegram:100');
    fake.state.admins.add('telegram:42');
    await worker.utter('three');
    expect(h.events[2].platformId).toBe('telegram:-300:7');
    // Any owner account of the line that is still an admin keeps the binding.
    fake.state.bound = { group: topic, threadId: null, ownerIds: ['telegram:42', 'slack:U42'] };
    fake.state.admins.clear();
    fake.state.admins.add('slack:U42');
    await worker.utter('four');
    expect(h.events[3].platformId).toBe('telegram:-300:7');
    for (const event of h.events) {
      expect(JSON.parse(event.message.content)).toMatchObject({ sender: 'Ethan', senderId: LINE });
    }
    worker.close();
  });

  it('still speaks the answer in flight in the chat a mid-call /voice left, until that chat goes quiet for a turn', async () => {
    const topic = { id: 'mg-topic', platform_id: 'telegram:-300:7', is_group: 1 };
    const fake = await start([{ platform_id: 'telegram:100' }, topic], 'telegram', { admins: ['telegram:42'] });
    const { worker } = await startCall(h);
    await worker.utter('one');
    expect(h.events[0].platformId).toBe('telegram:100');
    fake.state.bound = { group: topic, threadId: null, ownerIds: ['telegram:42'] };
    await worker.utter('two');
    expect(h.events[1].platformId).toBe('telegram:-300:7');
    delivered('telegram:100', 'Answer to one.');
    delivered('telegram:-300:7', 'Answer to two.');
    await worker.utter('three');
    // A whole turn without anything from the agent in the old chat: it is no longer spoken.
    await worker.utter('four');
    delivered('telegram:100', 'Unrelated, later.');
    delivered('telegram:-300:7', 'Answer to four.');
    await worker.waitFor((e) => e.type === 'reply' && e.text === 'Answer to four.');
    await settle();
    expect(worker.events.filter((e) => e.type === 'reply').map((e) => (e as { text: string }).text)).toEqual([
      'Answer to one.',
      'Answer to two.',
      'Answer to four.',
    ]);
    worker.close();
  });

  it('keeps the call on the voice line when no single chat could be meant', async () => {
    for (const groups of [[], [{ platform_id: 'telegram:1' }, { id: 'x', platform_id: 'telegram:2' }]]) {
      const { posts } = await start(groups);
      const { worker } = await startCall(h);
      await worker.utter('hello');
      expect(h.events).toEqual([]);
      expect(h.inbound).toHaveLength(1);
      await h.adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'Hi.' }, inReplyTo: h.inbound[0].id });
      await worker.waitFor((e) => e.type === 'reply' && e.text === 'Hi.');
      await settle();
      expect(posts).toEqual([]);
      worker.close();
      await h.stop();
    }
    h = await startHarness({}, false);
  });

  it('keeps the call on the voice line with WALKIE_MIRROR=off and no /voice chat', async () => {
    const { posts } = await start([{}], 'off');
    const { worker } = await startCall(h);
    await worker.utter('hello');
    expect(h.events).toEqual([]);
    expect(h.inbound).toHaveLength(1);
    await settle();
    expect(posts).toEqual([]);
    worker.close();
  });
});

describe('spoken text of a delivered message', () => {
  const msg = (content: unknown, extra: Partial<{ id: string; kind: string }> = {}) => ({
    id: 'm1',
    kind: 'chat',
    content: JSON.stringify(content),
    ...extra,
  });
  it('is the text of a plain chat message, and nothing for edits, reactions, cards or host command replies', () => {
    expect(spokenText(msg({ text: ' Hi. ' }))).toBe('Hi.');
    expect(spokenText(msg({ text: 'x', operation: 'edit', messageId: 'a' }))).toBeNull();
    expect(spokenText(msg({ operation: 'reaction', messageId: 'a', emoji: 'ok' }))).toBeNull();
    expect(spokenText(msg({ type: 'ask_question', text: 'pick' }))).toBeNull();
    expect(spokenText(msg({ text: 'status' }, { id: 'hcmd-reply-1' }))).toBeNull();
    expect(spokenText(msg({ text: 'x' }, { kind: 'system' }))).toBeNull();
    expect(spokenText({ id: 'm', kind: 'chat', content: 'not json' })).toBeNull();
  });
});

describe('livekit call page', () => {
  const html = liveKitCallPageHtml();
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));

  it('is valid script', () => {
    expect(() => new Function(script)).not.toThrow();
  });

  it('shows the walkie-talkie states and labels the captions the worker sends', () => {
    expect(script).toContain("listening: () => 'Listening'");
    expect(script).toContain("sending: () => 'Sending...'");
    expect(script).toContain("thinking: () => names.agent + ' is thinking'");
    expect(script).toContain("speaking: () => names.agent + ' is speaking'");
    expect(script).toContain("registerTextStreamHandler('lk.transcription'");
    // The caller's own turns come back from the worker against the caller's track: "You".
    expect(script).toContain("attrs['lk.transcribed_track_id'] === c.localSid");
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

  it('warns a call in a chat that everything sent there is spoken', () => {
    expect(WALKIE_CHAT_REPLY_NOTE).toContain('every message you send to this chat is read aloud');
    expect(WALKIE_CHAT_REPLY_NOTE).not.toContain('separate written message');
  });
});
