/**
 * The LiveKit path of the voice channel at the host boundary: the real adapter
 * behind the real webhook server, hit over HTTP the way the call page and the
 * worker do. Faked: the LiveKit server API (recorded calls), the mirror's
 * chats and the clock.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboundEvent, InboundMessage, OutboundMessage } from './adapter.js';
import { createVoiceAdapter, type VoiceChannelAdapter, type VoiceConfig } from './voice-mode.js';
import {
  liveKitChatDelivered,
  liveKitChatTyping,
  parseLiveKitUtteranceId,
  pickMirrorTarget,
  spokenText,
  type BoundCallChat,
  turnMessageText,
  turnReplyNote,
  CALL_REPLY_NOTE,
  type LiveKitServerApi,
  type LiveKitVoiceConfig,
  type MirrorApi,
} from './voice-mode-livekit.js';
import type { MessagingGroup } from '../types.js';
import {
  LIVEKIT_PROTOCOL_VERSION,
  liveKitCallSecret,
  type LiveKitHostEvent,
  type LiveKitJobMetadata,
  CALL_END_REASONS,
  CALL_PENDING_ATTRIBUTE,
  CALL_REPLY_TOPIC,
  CALL_THINKING_ATTRIBUTE,
  CALL_TURN_TOPIC,
  CALL_UPDATING_ATTRIBUTE,
  parseVoiceLanguages,
} from './voice-mode-protocol.js';
import { stopWebhookServer } from '../webhook-server.js';
import { callPageHtml } from './voice-mode-page.js';

const LINE = 'voice-mode:4f6e1f650552';
const MIN = 60_000;
const API_KEY = 'APIfakekey123';
const API_SECRET = 'fakesecretfakesecretfakesecretfakesecretfakesecr';

interface FakeLiveKit extends LiveKitServerApi {
  rooms: string[];
  deleted: string[];
  dispatches: Array<{ room: string; agentName: string; metadata: LiveKitJobMetadata }>;
  /** Room metadata writes, in order. */
  roomMetadata: Array<{ room: string; metadata: unknown }>;
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
    roomMetadata: [],
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
    async updateRoomMetadata(room, metadata) {
      fake.roomMetadata.push({ room, metadata: JSON.parse(metadata) });
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

/** The agent's chats, the /voice binding, who administers the agent, and what was posted into the chats. */
function fakeMirror(
  groups: Array<Partial<MessagingGroup>>,
  options: { bound?: Omit<BoundCallChat, 'group'> & { group: Partial<MessagingGroup> } } = {},
) {
  const posts: Array<{ instance: string; platformId: string; threadId?: string | null; text: string }> = [];
  const state = { bound: options.bound };
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
  adapter: VoiceChannelAdapter;
  /** Turns routed into a call chat. */
  events: InboundEvent[];
  /** Where the worker reaches the host, from its own settings. */
  hostUrl: string;
  /** The page server, where the browser's /voice routes live. */
  pageUrl: string;
  inbound: InboundMessage[];
  clock: { now: number };
  access: { enabled: boolean };
  /** What the router does with the next turns: store them, drop them, hang until `hung` is called (storing it on `true`), or throw. */
  routing: { mode: 'store' | 'drop' | 'hang' | 'throw'; hung: Array<(store?: boolean) => void> };
  lk: FakeLiveKit;
  stop(): Promise<void>;
}

/** An agent message delivered to the harness's call chat, as the delivery tap sees it. */
function deliverToChat(text: string, inReplyTo?: string): void {
  liveKitChatDelivered(
    {
      id: 'out-1',
      kind: 'chat',
      content: JSON.stringify({ text }),
      channelType: 'telegram',
      platformId: 'telegram:100',
      threadId: null,
      // The router's inbound row id: the message id scoped to the agent group.
      inReplyTo: inReplyTo ? `${inReplyTo}:ag-andy` : null,
    },
    'ag-andy',
  );
}

async function startHarness(
  overrides: Partial<VoiceConfig> = {},
  lkOverrides: Partial<LiveKitVoiceConfig> = {},
): Promise<Harness> {
  const port = await freePort();
  const pagePort = await freePort();
  process.env.WEBHOOK_PORT = String(port);
  const inbound: InboundMessage[] = [];
  const events: InboundEvent[] = [];
  const clock = { now: Date.UTC(2026, 9, 2, 1, 0, 0) };
  const access = { enabled: true };
  const routing: Harness['routing'] = { mode: 'store', hung: [] };
  const lk = fakeLiveKit();
  const adapter = createVoiceAdapter({
    publicUrl: `http://127.0.0.1:${pagePort}`,
    pagePort,
    lineForToken: async (token) => (token === 'tok123' ? LINE : null),
    // The engine routes turns here: recorded as the event and as the message it carries.
    routeTurn: async (event, agentGroupId) => {
      events.push({ ...event, agentGroupId } as InboundEvent);
      inbound.push({ ...event.message, content: JSON.parse(event.message.content) as unknown });
      if (routing.mode === 'hang')
        return new Promise<boolean>((resolve) => routing.hung.push((store) => resolve(!!store)));
      if (routing.mode === 'throw') throw new Error('router exploded');
      return routing.mode === 'store';
    },
    resolveLine: async (id) =>
      access.enabled
        ? {
            caller: { id, name: 'Ethan' },
            agentGroupId: 'ag-andy',
            agent: { name: 'Andy', vocabulary: ['NanoClaw', 'Grafana'] },
          }
        : null,
    now: () => clock.now,
    livekit: {
      url: 'wss://lk.example.com:7880',
      serverUrl: 'ws://127.0.0.1:7880',
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      api: lk,
      // One telegram chat wired to the agent: the default call chat (VOICE_MODE_MIRROR).
      mirror: 'telegram',
      mirrorApi: fakeMirror([{ platform_id: 'telegram:100', name: 'Family' }]).api,
      ...lkOverrides,
    },
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
    routing,
    hostUrl: `http://127.0.0.1:${port}`,
    pageUrl: `http://127.0.0.1:${pagePort}`,
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
  /** The call chat's name, for the page. */
  chat?: string;
  silenceMs: number;
  limit: { ms: number; kind: 'duration' | 'daily' };
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
  const res = await fetch(`${h.hostUrl}/webhook/voice-mode/livekit/agent/events?call=${meta.callId}`, {
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
    post(`${h.hostUrl}/webhook/voice-mode/livekit/agent/${path}`, { callId: meta.callId, ...body }, auth);
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
  const res = await post(`${h.pageUrl}/voice/livekit/token?t=tok123`);
  expect(res.status).toBe(200);
  const call = (await res.json()) as TokenResponse;
  const dispatch = h.lk.dispatches.at(-1)!;
  const worker = await attachWorker(h, dispatch.metadata);
  expect((await worker.post('joined')).status).toBe(200);
  return { call, worker };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

/** The room of the call a newer one replaced while connecting: the one the newer call was not given. */
function replacedRoom(h: Harness, newer: TokenResponse): string {
  const newerRoom = h.lk.dispatches.find((d) => d.metadata.callId === newer.callId)!.room;
  return h.lk.rooms.find((r) => r !== newerRoom)!;
}

describe('livekit voice path (fake LiveKit, real webhook server)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness({ accessCheckIntervalMs: 50 });
  });
  afterEach(async () => {
    await h.stop();
  });

  it('renders the call page URL for a token', () => {
    expect(h.adapter.callUrl('tok123')).toBe(`${h.pageUrl}/voice?t=tok123`);
  });

  it('serves the voice call page', async () => {
    const res = await fetch(`${h.pageUrl}/voice/livekit?t=tok123`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self' wss://lk.example.com:7880 https://lk.example.com:7880");
    const html = await res.text();
    expect(html).toBe(callPageHtml());
    // The page keeps its own copy of the worker's wire names (it cannot import the protocol module).
    for (const name of [
      CALL_THINKING_ATTRIBUTE,
      CALL_UPDATING_ATTRIBUTE,
      CALL_TURN_TOPIC,
      CALL_PENDING_ATTRIBUTE,
      CALL_REPLY_TOPIC,
      // The end reasons it names, as keys of its own table.
      ...CALL_END_REASONS,
      '"no-agent"',
      '"updating"',
    ]) {
      expect(html).toContain(name);
    }
  });

  it('tells the page who answers the line, only with a known token and a caller with access', async () => {
    const ok = await fetch(`${h.pageUrl}/voice/info?t=tok123`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ agent: 'Andy', caller: 'Ethan' });
    expect((await fetch(`${h.pageUrl}/voice/info?t=nope`)).status).toBe(403);
    h.access.enabled = false;
    expect((await fetch(`${h.pageUrl}/voice/info?t=tok123`)).status).toBe(403);
  });

  it('serves the page to a trusted loopback proxy only for allowed clients, and the worker routes never through it', async () => {
    await h.stop();
    h = await startHarness({ trustedProxyCidrs: '127.0.0.1/32, ::1/128', allowedClientCidrs: '100.64.0.0/10' });
    const via = (client?: string) => (client ? { 'X-Forwarded-For': client } : undefined);
    expect((await fetch(`${h.pageUrl}/voice/info?t=tok123`, { headers: via('100.100.1.2') })).status).toBe(200);
    expect((await fetch(`${h.pageUrl}/voice/info?t=tok123`, { headers: via('203.0.113.9') })).status).toBe(403);
    expect((await fetch(`${h.pageUrl}/voice?t=tok123`, { headers: via('203.0.113.9') })).status).toBe(403);
    expect((await fetch(`${h.pageUrl}/voice/info?t=tok123`)).status).toBe(403);
    // The worker's routes stay loopback-only and ignore the browser policy.
    expect((await post(`${h.hostUrl}/webhook/voice-mode/livekit/agent/joined`, { callId: 'x' })).status).not.toBe(403);
  });

  it('serves no other page or route under either prefix', async () => {
    for (const path of ['/voice/call', '/webhook/voice-mode/call', '/voice/sip', '/voicemail']) {
      expect((await fetch(`${h.hostUrl}${path}?t=tok123`)).status).toBe(404);
    }
    for (const route of ['sdp', 'hangup']) {
      expect((await post(`${h.pageUrl}/voice/${route}?t=tok123`)).status).toBe(404);
    }
    expect(h.lk.rooms).toEqual([]);
  });

  it('after teardown the page server is gone, the worker routes answer 503, and no room opens', async () => {
    await h.adapter.teardown();
    await expect(fetch(`${h.pageUrl}/voice?t=tok123`)).rejects.toThrow();
    expect((await post(`${h.hostUrl}/webhook/voice-mode/livekit/agent/joined`, { callId: 'x' })).status).toBe(503);
    expect(h.lk.rooms).toEqual([]);
  });

  it('refuses unknown links and callers without access before touching LiveKit', async () => {
    expect((await post(`${h.pageUrl}/voice/livekit/token?t=nope`)).status).toBe(403);
    h.access.enabled = false;
    expect((await post(`${h.pageUrl}/voice/livekit/token?t=tok123`)).status).toBe(403);
    expect(h.lk.rooms).toEqual([]);
  });

  it('serves the call page and its routes under the short /voice prefix, never the worker routes', async () => {
    const page = await fetch(`${h.pageUrl}/voice?t=tok123`);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(callPageHtml());
    expect((await fetch(`${h.pageUrl}/voice/?t=tok123`)).status).toBe(200);
    expect((await fetch(`${h.pageUrl}/voice/info?t=tok123`)).status).toBe(200);
    const res = await post(`${h.pageUrl}/voice/livekit/token?t=tok123`);
    expect(res.status).toBe(200);
    const { callId } = (await res.json()) as TokenResponse;
    expect(h.lk.rooms).toHaveLength(1);
    for (const path of ['events', 'joined', 'utterance', 'ended']) {
      expect((await post(`${h.pageUrl}/voice/livekit/agent/${path}?call=${callId}`, { callId })).status).toBe(404);
    }
    expect((await post(`${h.pageUrl}/voice/livekit/end?t=tok123`, { callId })).status).toBe(204);
  });

  it('opens a unique room, dispatches the worker with the call metadata and mints a room-only caller token', async () => {
    const res = await post(`${h.pageUrl}/voice/livekit/token?t=tok123`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TokenResponse;
    expect(body.url).toBe('wss://lk.example.com:7880');
    expect(body.agent).toBe('Andy');
    // For the page's hints: the silence that sends a turn, and the cap that will end the call.
    expect(body.silenceMs).toBe(2500);
    expect(body.limit).toEqual({ ms: 15 * MIN, kind: 'duration' });
    const room = h.lk.rooms[0];
    expect(room).toMatch(new RegExp(`^voice-mode-${LINE.slice('voice-mode:'.length)}-[0-9a-f]{12}$`));
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
      vocabulary: ['NanoClaw', 'Grafana'],
      sttModel: 'gemini-3.5-transcribe-live',
      sttFallbackModel: 'gemini-3.5-transcribe',
      ttsModel: 'gemini-3.8-flash-tts',
      ttsFallbackModel: 'gemini-3.8-flash-lite-tts',
      ttsVoice: 'Alnilam',
      silenceMs: 2500,
      languages: ['en-US'],
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
    expect((await post(`${h.pageUrl}/voice/livekit/token?t=tok123`)).status).toBe(502);
    await settle();
    expect(h.lk.deleted).toHaveLength(1);
  });

  it('authenticates the worker routes with the per-call secret derived from the API secret', async () => {
    await post(`${h.pageUrl}/voice/livekit/token?t=tok123`);
    const meta = h.lk.dispatches[0].metadata;
    const url = `${h.hostUrl}/webhook/voice-mode/livekit/agent`;
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
      text: turnMessageText('Що в мене завтра в календарі?'),
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

    deliverToChat('Checking.', msg.id);
    deliverToChat('Dentist at nine.', msg.id);
    await worker.waitFor((e) => e.type === 'reply' && e.text === 'Dentist at nine.');
    // Both answer the first turn, and say so: the page labels them with it.
    expect(worker.events.filter((e) => e.type === 'reply')).toEqual([
      { type: 'reply', text: 'Checking.', turn: id },
      { type: 'reply', text: 'Dentist at nine.', turn: id },
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

  it('answers 202 only once the agent session stored the turn', async () => {
    await h.stop();
    h = await startHarness({}, { routeTimeoutMs: 100 });
    const { worker } = await startCall(h);
    h.routing.mode = 'drop';
    expect((await worker.post('utterance', { text: 'dropped' })).status).toBe(422);
    h.routing.mode = 'throw';
    expect((await worker.post('utterance', { text: 'broken' })).status).toBe(500);
    h.routing.mode = 'hang';
    expect((await worker.post('utterance', { text: 'stuck' })).status).toBe(504);
    h.routing.mode = 'store';
    expect((await worker.post('utterance', { text: 'taken' })).status).toBe(202);
    expect(h.inbound).toHaveLength(4);
    worker.close();
  });

  it('tells the worker when a turn it heard 504 for reaches the agent after all', async () => {
    await h.stop();
    h = await startHarness({}, { routeTimeoutMs: 100 });
    const { worker } = await startCall(h);
    h.routing.mode = 'hang';
    expect((await worker.post('utterance', { text: 'late', turnKey: 'k-late' })).status).toBe(504);
    expect((await worker.post('utterance', { text: 'never', turnKey: 'k-never' })).status).toBe(504);
    expect((await worker.post('utterance', { text: 'keyless' })).status).toBe(504);
    const [late, never, keyless] = h.routing.hung;
    never(false);
    keyless(true);
    late(true);
    const stored = await worker.waitFor((e) => e.type === 'turn-stored');
    expect(stored).toEqual({ type: 'turn-stored', turnKey: 'k-late', id: '1' });
    await settle();
    // A turn the router dropped in the end, or one with no key to name it by, is not reported.
    expect(worker.events.filter((e) => e.type === 'turn-stored')).toHaveLength(1);
    // A retry under that key now hears it was taken.
    const again = await worker.post('utterance', { text: 'late', turnKey: 'k-late' });
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ id: '1' });
    worker.close();
  });

  it('answers a retried turn from its first outcome and routes it once', async () => {
    const { worker } = await startCall(h);
    const first = await worker.post('utterance', { text: 'once', turnKey: 'k-1' });
    const again = await worker.post('utterance', { text: 'once', turnKey: 'k-1' });
    expect(first.status).toBe(202);
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual(await first.json());
    expect(h.inbound).toHaveLength(1);
    // A refusal is remembered as well: the retry is not routed a second time.
    h.routing.mode = 'drop';
    expect((await worker.post('utterance', { text: 'no', turnKey: 'k-2' })).status).toBe(422);
    h.routing.mode = 'store';
    expect((await worker.post('utterance', { text: 'no', turnKey: 'k-2' })).status).toBe(422);
    expect(h.inbound).toHaveLength(2);
    worker.close();
  });

  it('caps the turns still being routed on one call', async () => {
    await h.stop();
    h = await startHarness({}, { routeTimeoutMs: 300 });
    const { worker } = await startCall(h);
    h.routing.mode = 'hang';
    const pending = [1, 2, 3].map((i) => worker.post('utterance', { text: `t${i}`, turnKey: `k${i}` }));
    await vi.waitFor(() => expect(h.inbound).toHaveLength(3));
    expect((await worker.post('utterance', { text: 't4' })).status).toBe(429);
    // A retry of a turn in flight joins it rather than counting against the cap.
    const retried = worker.post('utterance', { text: 't1', turnKey: 'k1' });
    expect((await Promise.all([...pending, retried])).map((r) => r.status)).toEqual([504, 504, 504, 504]);
    h.routing.mode = 'store';
    // A 504 does not free the slot: the router is still working on those turns.
    expect((await worker.post('utterance', { text: 't5' })).status).toBe(429);
    for (const finish of h.routing.hung) finish();
    await settle();
    expect((await worker.post('utterance', { text: 't6' })).status).toBe(202);
    expect(h.inbound).toHaveLength(4);
    worker.close();
  });

  it('refuses an utterance before the caller is in and after access is gone', async () => {
    expect((await post(`${h.pageUrl}/voice/livekit/token?t=tok123`)).status).toBe(200);
    const meta = h.lk.dispatches[0].metadata;
    const url = `${h.hostUrl}/webhook/voice-mode/livekit/agent/utterance`;
    expect((await post(url, { callId: meta.callId, text: 'hi' }, workerAuth(meta.callId))).status).toBe(409);
    expect((await post(url, { callId: meta.callId, text: 'hi' })).status).toBe(409);
    expect(h.inbound).toEqual([]);
  });

  it('speaks proactive agent messages and tells the worker while the agent works', async () => {
    const { worker } = await startCall(h);
    deliverToChat('Your taxi is here.');
    // It answers no turn, so it carries none.
    expect(await worker.waitFor((e) => e.type === 'reply')).toEqual({
      type: 'reply',
      text: 'Your taxi is here.',
      turn: null,
    });
    liveKitChatTyping({ channelType: 'telegram', platformId: 'telegram:100', threadId: null }, 'ag-andy');
    await worker.waitFor((e) => e.type === 'thinking');
    worker.close();
  });

  it('takes no delivery on the line itself: calls talk in an agent chat', async () => {
    await expect(h.adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'Hello?' } })).rejects.toThrow(
      'is a call line, not a chat',
    );
  });

  it("speaks a late answer to an earlier call's turn in the next call, labelled as answering none of its turns", async () => {
    const first = await startCall(h);
    await first.worker.utter('old question');
    const oldId = h.inbound[0].id;
    const second = await startCall(h);
    deliverToChat('late', oldId);
    expect(await second.worker.waitFor((e) => e.type === 'reply')).toEqual({ type: 'reply', text: 'late', turn: null });
    first.worker.close();
    second.worker.close();
  });

  it('ends the call on hangup by deleting the room and tells the worker', async () => {
    const { call, worker } = await startCall(h);
    h.clock.now += 3 * MIN;
    expect((await post(`${h.pageUrl}/voice/livekit/end?t=tok123`, { callId: call.callId })).status).toBe(204);
    expect(h.lk.deleted).toEqual([h.lk.rooms[0]]);
    await worker.streamClosed;
    expect(worker.events.at(-1)).toEqual({ type: 'end', reason: 'hangup' });
    // The worker's routes are closed for this call now.
    expect((await worker.post('utterance', { text: 'late' })).status).toBe(409);
  });

  it('puts why the call ended on its room before the worker hears of it, answers it or the room goes', async () => {
    const { worker } = await startCall(h);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const setMetadata = h.lk.updateRoomMetadata.bind(h.lk);
    h.lk.updateRoomMetadata = async (room, metadata) => {
      await gate;
      return setMetadata(room, metadata);
    };
    let answered = false;
    const ended = worker.post('ended', { reason: 'session closed: error' }).then((res) => {
      answered = true;
      return res;
    });
    await settle();
    // The worker leaves and deletes the room once it hears or is answered; the page reads why first.
    expect(answered).toBe(false);
    expect(worker.events.some((e) => e.type === 'end')).toBe(false);
    expect(h.lk.deleted).toEqual([]);
    release();
    expect((await ended).status).toBe(204);
    await worker.streamClosed;
    expect(h.lk.roomMetadata).toEqual([{ room: h.lk.rooms[0], metadata: { chat: 'Family', end: 'worker_gone' } }]);
    expect(h.lk.deleted).toEqual([h.lk.rooms[0]]);
  });

  it('names a call the worker ended while shutting down a restart, not a dropped call', async () => {
    const { worker } = await startCall(h);
    expect((await worker.post('ended', { reason: 'job shutdown', restart: true })).status).toBe(204);
    await worker.streamClosed;
    expect(h.lk.roomMetadata).toEqual([{ room: h.lk.rooms[0], metadata: { chat: 'Family', end: 'worker_restart' } }]);
  });

  it('ends a call the page hung up on without naming it there: nobody is left to read it', async () => {
    const { call, worker } = await startCall(h);
    expect((await post(`${h.pageUrl}/voice/livekit/end?t=tok123`, { callId: call.callId })).status).toBe(204);
    await worker.streamClosed;
    expect(h.lk.roomMetadata).toEqual([]);
    expect(h.lk.deleted).toEqual([h.lk.rooms[0]]);
  });

  it('names a call replaced by a newer one, a duration limit and a shutdown on the room', async () => {
    const first = await startCall(h);
    await startCall(h);
    await vi.waitFor(() =>
      expect(h.lk.roomMetadata).toContainEqual({
        room: h.lk.dispatches[0].room,
        metadata: { chat: 'Family', end: 'newer_call' },
      }),
    );
    first.worker.close();
    await h.adapter.teardown();
    expect(h.lk.roomMetadata.at(-1)).toEqual({
      room: h.lk.dispatches[1].room,
      metadata: { chat: 'Family', end: 'shutdown' },
    });
    await h.stop();
    h = await startHarness({ maxCallDurationMs: 50 });
    const { worker } = await startCall(h);
    await worker.streamClosed;
    expect(h.lk.roomMetadata).toEqual([{ room: h.lk.rooms[0], metadata: { chat: 'Family', end: 'limit_duration' } }]);
  });

  it('turns a fallback model off when it is set to off or empty', async () => {
    await h.stop();
    h = await startHarness(
      {},
      {
        speech: { sttFallbackModel: 'off', ttsFallbackModel: ' ', ttsModel: 'gemini-3.8-flash-lite-tts' },
      },
    );
    expect((await post(`${h.pageUrl}/voice/livekit/token?t=tok123`)).status).toBe(200);
    expect(h.lk.dispatches[0].metadata).toMatchObject({
      sttModel: 'gemini-3.5-transcribe-live',
      sttFallbackModel: '',
      ttsModel: 'gemini-3.8-flash-lite-tts',
      ttsFallbackModel: '',
    });
  });

  it('names a missing or mismatched worker when the page gives up on it', async () => {
    const first = await startCall(h);
    await post(`${h.pageUrl}/voice/livekit/end?t=tok123`, { callId: first.call.callId, reason: 'no-agent' });
    await first.worker.streamClosed;
    expect(first.worker.events.at(-1)).toEqual({
      type: 'end',
      reason: 'no voice worker joined (worker down, or not on this protocol version)',
    });
    const second = await startCall(h);
    await post(`${h.pageUrl}/voice/livekit/end?t=tok123`, { callId: second.call.callId, reason: 'updating' });
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
    expect(h.lk.roomMetadata.at(-1)?.metadata).toEqual({ chat: 'Family', end: 'revoked' });
  });

  it('ends the call when the worker link drops', async () => {
    const { worker } = await startCall(h);
    worker.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(h.lk.deleted).toHaveLength(1);
    expect(h.lk.roomMetadata.at(-1)?.metadata).toEqual({ chat: 'Family', end: 'worker_gone' });
  });

  it('charges the daily minutes from join to end and caps a call at the remaining budget', async () => {
    await h.stop();
    h = await startHarness({ maxCallMsPerDay: 2 * MIN });
    const first = await startCall(h);
    h.clock.now += 90_000;
    await post(`${h.pageUrl}/voice/livekit/end?t=tok123`, { callId: first.call.callId });
    // 30 s of the day left: the next call is capped there by a host-side timer.
    const res = await post(`${h.pageUrl}/voice/livekit/token?t=tok123`);
    expect(res.status).toBe(200);
    expect(h.lk.dispatches.at(-1)!.metadata.maxDurationMs).toBe(30_000);
    expect(((await res.json()) as TokenResponse).limit).toEqual({ ms: 30_000, kind: 'daily' });
    const worker = await attachWorker(h, h.lk.dispatches.at(-1)!.metadata);
    expect((await worker.post('joined')).status).toBe(200);
    h.clock.now += 30_000;
    await post(`${h.pageUrl}/voice/livekit/end?t=tok123`, { callId: worker.meta.callId });
    // The day's minutes are gone.
    const refused = await post(`${h.pageUrl}/voice/livekit/token?t=tok123`);
    expect(refused.status).toBe(429);
  });

  it('ends a call that runs into the budget cap by deleting its room', async () => {
    await h.stop();
    h = await startHarness({ maxCallMsPerDay: 100 });
    const { worker } = await startCall(h);
    await worker.streamClosed;
    expect(worker.events.at(-1)).toEqual({ type: 'end', reason: 'daily minute budget' });
    expect(h.lk.deleted).toHaveLength(1);
    expect(h.lk.roomMetadata.at(-1)?.metadata).toEqual({ chat: 'Family', end: 'limit_daily' });
  });

  it('refuses starts over the hourly cap with a retry time', async () => {
    await h.stop();
    h = await startHarness({ maxCallsPerHour: 2 });
    expect((await post(`${h.pageUrl}/voice/livekit/token?t=tok123`)).status).toBe(200);
    expect((await post(`${h.pageUrl}/voice/livekit/token?t=tok123`)).status).toBe(200);
    const refused = await post(`${h.pageUrl}/voice/livekit/token?t=tok123`);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBeTruthy();
  });

  it('deletes the room of a call that was replaced while it was connecting', async () => {
    let release!: () => void;
    h.lk.createGate = new Promise((r) => (release = r));
    const first = post(`${h.pageUrl}/voice/livekit/token?t=tok123`);
    await settle();
    // A newer call takes the line while the room is still being created.
    h.lk.createGate = null;
    const second = await post(`${h.pageUrl}/voice/livekit/token?t=tok123`);
    expect(second.status).toBe(200);
    release();
    expect((await first).status).toBe(409);
    const room = replacedRoom(h, (await second.json()) as TokenResponse);
    // The replaced call's own cleanup ran before the room existed; the room still goes.
    expect(h.lk.ops.indexOf(`create:${room}`)).toBeGreaterThanOrEqual(0);
    expect(h.lk.ops.lastIndexOf(`delete:${room}`)).toBeGreaterThan(h.lk.ops.indexOf(`create:${room}`));
  });

  it('deletes the room when the page left while the room was being set up', async () => {
    let release!: () => void;
    h.lk.createGate = new Promise((r) => (release = r));
    const controller = new AbortController();
    const pending = fetch(`${h.pageUrl}/voice/livekit/token?t=tok123`, { method: 'POST', signal: controller.signal });
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
    const first = post(`${h.pageUrl}/voice/livekit/token?t=tok123`);
    await settle();
    h.lk.createGate = null;
    const second = await post(`${h.pageUrl}/voice/livekit/token?t=tok123`);
    expect(second.status).toBe(200);
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((r) => (releaseDelete = r));
    const deleteRoom = h.lk.deleteRoom.bind(h.lk);
    h.lk.deleteRoom = async (room) => {
      await deleteGate;
      return deleteRoom(room);
    };
    release();
    await settle();
    let tornDown = false;
    const teardown = h.adapter.teardown().then(() => (tornDown = true));
    await settle();
    expect(tornDown).toBe(false);
    releaseDelete();
    await teardown;
    expect((await first).status).toBe(409);
    expect(h.lk.deleted).toContain(replacedRoom(h, (await second.json()) as TokenResponse));
  });

  it('ends a call whose worker never opens its event stream after reporting the caller in', async () => {
    await h.stop();
    h = await startHarness(
      {},
      {
        workerStreamTimeoutMs: 100,
      },
    );
    expect((await post(`${h.pageUrl}/voice/livekit/token?t=tok123`)).status).toBe(200);
    const meta = h.lk.dispatches[0].metadata;
    const joined = await post(
      `${h.hostUrl}/webhook/voice-mode/livekit/agent/joined`,
      { callId: meta.callId },
      workerAuth(meta.callId),
    );
    expect(joined.status).toBe(200);
    await new Promise((r) => setTimeout(r, 250));
    expect(h.lk.deleted).toEqual([h.lk.rooms[0]]);
  });

  it('refuses a start over the daily minutes without ending the running call', async () => {
    await h.stop();
    h = await startHarness({ maxCallMsPerDay: 2 * MIN });
    const { worker } = await startCall(h);
    h.clock.now += 2 * MIN;
    expect((await post(`${h.pageUrl}/voice/livekit/token?t=tok123`)).status).toBe(429);
    await settle();
    expect(h.lk.deleted).toEqual([]);
    expect(worker.events.some((e) => e.type === 'end')).toBe(false);
    worker.close();
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
    h = await startHarness({ accessCheckIntervalMs: 60_000 }, { mirror, mirrorApi: fake.api });
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

  it('routes each turn into the one Telegram chat as the line caller, posts the transcript and speaks the chat replies', async () => {
    const { posts } = await start([
      { platform_id: 'telegram:100', name: 'Family' },
      { channel_type: 'voice-mode', platform_id: LINE },
    ]);
    const { call, worker } = await startCall(h);
    expect(call.chat).toBe('Family');
    const id = await worker.utter('Book a table for two');
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
      text: turnMessageText('Book a table for two', CALL_REPLY_NOTE),
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
    expect(worker.events.filter((e) => e.type === 'reply')).toEqual([
      { type: 'reply', text: 'Booked for **eight**.', turn: null },
    ]);
    // Nothing of the reply is posted by the voice host: the agent's own message is the chat's copy.
    await settle();
    expect(posts).toHaveLength(1);
    worker.close();
  });

  it('says which turn of the call a chat reply answers, and nothing for any other reply', async () => {
    await start([{ platform_id: 'telegram:100' }]);
    const { worker } = await startCall(h);
    const id = await worker.utter('Book a table');
    const reply = (text: string, inReplyTo: string | null) =>
      liveKitChatDelivered(
        {
          id: `out-${text.length}`,
          kind: 'chat',
          content: JSON.stringify({ text }),
          channelType: 'telegram',
          platformId: 'telegram:100',
          threadId: null,
          inReplyTo,
        },
        'ag-andy',
      );
    // In the session, the turn's id carries the agent's scope; delivery hands it over like that.
    reply('Booked.', `livekit:${worker.meta.callId}:${id}:ag-andy`);
    reply('The dentist called.', null);
    reply('About the last call.', 'livekit:another-call:1:ag-andy');
    reply('About what you typed.', 'tg-555:ag-andy');
    await worker.waitFor((e) => e.type === 'reply' && e.text === 'About what you typed.');
    expect(worker.events.filter((e) => e.type === 'reply')).toEqual([
      { type: 'reply', text: 'Booked.', turn: id },
      { type: 'reply', text: 'The dentist called.', turn: null },
      { type: 'reply', text: 'About the last call.', turn: null },
      { type: 'reply', text: 'About what you typed.', turn: null },
    ]);
    worker.close();
  });

  it('names an unnamed direct chat by its channel for the page header', async () => {
    await start([{ platform_id: 'telegram:100' }, { channel_type: 'voice-mode', platform_id: LINE }]);
    const { call } = await startCall(h);
    expect(call.chat).toBe('telegram DM');
  });

  it('talks in the chat /voice was run in, ahead of the default rule, still as the line caller', async () => {
    const topic = { id: 'mg-topic', platform_id: 'telegram:-300:7', is_group: 1 };
    const { posts } = await start([{ platform_id: 'telegram:100' }, topic], 'telegram', {
      bound: { group: topic, threadId: 'th-1' },
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
    expect(worker.events.filter((e) => e.type === 'reply')).toEqual([
      { type: 'reply', text: 'In the thread.', turn: null },
    ]);
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

  it('ignores a /voice chat that is no longer the agent and uses the default chat', async () => {
    const gone = { id: 'mg-gone', platform_id: 'telegram:-9' };
    const topic = { id: 'mg-topic', platform_id: 'telegram:-300:7', is_group: 1 };
    const fake = await start([{ platform_id: 'telegram:100' }, topic], 'telegram', {
      bound: { group: gone, threadId: null },
    });
    const { worker } = await startCall(h);
    await worker.utter('one');
    expect(h.events[0].platformId).toBe('telegram:100');
    fake.state.bound = { group: topic, threadId: null };
    await worker.utter('two');
    expect(h.events[1].platformId).toBe('telegram:-300:7');
    for (const event of h.events) {
      expect(JSON.parse(event.message.content)).toMatchObject({ sender: 'Ethan', senderId: LINE });
    }
    worker.close();
  });

  it('still speaks the answer in flight in the chat a mid-call /voice left, until that chat goes quiet for a turn', async () => {
    const topic = { id: 'mg-topic', platform_id: 'telegram:-300:7', is_group: 1 };
    const fake = await start([{ platform_id: 'telegram:100' }, topic], 'telegram');
    const { worker } = await startCall(h);
    await worker.utter('one');
    expect(h.events[0].platformId).toBe('telegram:100');
    fake.state.bound = { group: topic, threadId: null };
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

  it('names why the call ended only after a chat move the page was still being told of', async () => {
    const topic = { id: 'mg-topic', platform_id: 'telegram:-300:7', is_group: 1, name: 'Ops' };
    const fake = await start([{ platform_id: 'telegram:100', name: 'Family' }, topic], 'telegram', {});
    const { worker } = await startCall(h);
    await worker.utter('one');
    let release!: () => void;
    const slowLabel = new Promise<void>((resolve) => (release = resolve));
    const setMetadata = h.lk.updateRoomMetadata.bind(h.lk);
    h.lk.updateRoomMetadata = async (room, metadata) => {
      if (!(JSON.parse(metadata) as { end?: string }).end) await slowLabel;
      return setMetadata(room, metadata);
    };
    fake.state.bound = { group: topic, threadId: null };
    await worker.utter('two');
    worker.close();
    await settle();
    expect(h.lk.roomMetadata).toEqual([]);
    release();
    await vi.waitFor(() => expect(h.lk.deleted).toEqual([h.lk.rooms[0]]));
    expect(h.lk.roomMetadata.map((m) => m.metadata)).toEqual([{ chat: 'Ops' }, { chat: 'Ops', end: 'worker_gone' }]);
  });

  it('tells the page when a mid-call /voice moves the call to another chat', async () => {
    const topic = { id: 'mg-topic', platform_id: 'telegram:-300:7', is_group: 1, name: 'Ops' };
    const fake = await start([{ platform_id: 'telegram:100', name: 'Family' }, topic], 'telegram', {});
    const { call, worker } = await startCall(h);
    expect(call.chat).toBe('Family');
    await worker.utter('one');
    // The token reply named the first chat; nothing more is written while the call stays there.
    expect(h.lk.roomMetadata).toEqual([]);
    fake.state.bound = { group: topic, threadId: null };
    await worker.utter('two');
    expect(h.lk.roomMetadata).toEqual([{ room: h.lk.rooms[0], metadata: { chat: 'Ops' } }]);
    // The worker hears that the call has a chat once, not again for a move between chats.
    expect(worker.events.filter((e) => e.type === 'chat')).toEqual([{ type: 'chat', chat: true }]);
    worker.close();
  });

  it('posts the transcript of a turn only once the agent has it', async () => {
    const { posts } = await start([{ platform_id: 'telegram:100', name: 'Family' }]);
    const { worker } = await startCall(h);
    h.routing.mode = 'drop';
    expect((await worker.post('utterance', { text: 'lost words' })).status).toBe(422);
    h.routing.mode = 'store';
    await worker.utter('kept words');
    await vi.waitFor(() =>
      expect(posts).toEqual([{ instance: 'telegram', platformId: 'telegram:100', text: '🎙 Ethan: kept words' }]),
    );
    worker.close();
  });

  it('refuses a call when no chat could be meant, and deletes its room', async () => {
    for (const [groups, mirror] of [
      [[], 'telegram'],
      [[{ platform_id: 'telegram:1' }, { id: 'x', platform_id: 'telegram:2' }], 'telegram'],
      [[{}], 'off'],
    ] as const) {
      await start([...groups], mirror);
      const res = await post(`${h.pageUrl}/voice/livekit/token?t=tok123`);
      expect(res.status).toBe(409);
      expect(await res.text()).toContain('Run /voice in a chat with the agent');
      expect(h.lk.rooms).toEqual([]);
      await h.stop();
    }
    h = await startHarness();
  });

  it('refuses turns, and tells the worker, once the call has lost its chat', async () => {
    const topic = { id: 'mg-topic', platform_id: 'telegram:-300:7', is_group: 1 };
    const fake = await start([topic], 'off', {
      bound: { group: topic, threadId: null },
    });
    const { worker } = await startCall(h);
    await worker.utter('one');
    fake.state.bound = undefined;
    const lost = await worker.post('utterance', { text: 'two' });
    expect(lost.status).toBe(409);
    expect(h.events).toHaveLength(1);
    await worker.waitFor((e) => e.type === 'chat' && !e.chat);
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

describe('turn message text', () => {
  it('marks the transcript as spoken and says every message sent to the chat is read aloud', () => {
    expect(turnMessageText('Привіт')).toBe(`<voice source="livekit">Привіт</voice>\n${CALL_REPLY_NOTE}`);
    expect(CALL_REPLY_NOTE).toContain('every message you send to this chat is read aloud');
  });

  it('adds no language note for English-only callers (the default)', () => {
    expect(turnReplyNote(['en-US'])).toBe(CALL_REPLY_NOTE);
    expect(turnReplyNote(['en-US', 'en-GB'])).toBe(CALL_REPLY_NOTE);
  });

  it('names the configured languages, and with Ukrainian says Russian spelling is Ukrainian, never to answer in Russian', () => {
    expect(turnMessageText('Привет.')).toContain('<voice source="livekit">Привет.</voice>');
    const note = turnReplyNote(['uk-UA', 'en-US']);
    expect(note.startsWith(CALL_REPLY_NOTE)).toBe(true);
    expect(note).toContain('The caller speaks Ukrainian or English; answer in the language of their transcript.');
    expect(note).toContain('looks Russian is Ukrainian misspelled by speech recognition');
    expect(note).toContain('never in Russian');
    expect(turnReplyNote(['de-DE'])).toBe(`${CALL_REPLY_NOTE} The caller speaks German; answer in German.`);
    expect(turnReplyNote(['uk-UA', 'ru-RU'])).not.toContain('misspelled');
  });
});

describe('VOICE_MODE_LANGUAGES', () => {
  it('parses BCP-47 codes, drops nonsense and duplicates, and defaults to English', () => {
    expect(parseVoiceLanguages(undefined)).toEqual(['en-US']);
    expect(parseVoiceLanguages(' uk-UA , en-US,uk-ua,not a code,')).toEqual(['uk-UA', 'en-US']);
    expect(parseVoiceLanguages('???')).toEqual(['en-US']);
  });
});

describe('parseLiveKitUtteranceId', () => {
  it('reads the call and turn of a caller turn id, and nothing else', () => {
    expect(parseLiveKitUtteranceId('livekit:c-1:3')).toEqual({ callId: 'c-1', utteranceId: '3' });
    expect(parseLiveKitUtteranceId('livekit:c-1:3:ag-other')).toBeNull();
    expect(parseLiveKitUtteranceId('livekit:c-1')).toBeNull();
    expect(parseLiveKitUtteranceId('tg-1')).toBeNull();
  });
});
