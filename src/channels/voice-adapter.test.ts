/**
 * Integration test for the gpt-live adapter at the host boundary.
 *
 * Real pieces: the adapter, its session state machine, the shared webhook
 * server (the call page and SDP routes are hit over HTTP the way a browser
 * would), Node's built-in fetch and WebSocket client. Faked: OpenAI only —
 * a local HTTP server that answers `POST /v1/live/sessions` and accepts the
 * sideband WebSocket upgrade at `/v1/live/sessions/{id}/attach`, so the test
 * can push transcript and delegation events and record every client frame
 * the adapter sends back.
 *
 * The WebSocket server side is ~40 lines of RFC 6455 by hand (handshake,
 * masked text frames, close) because the repo carries no `ws` package and
 * Node ships a client only.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, InboundMessage } from './adapter.js';
import type { ResolveLineOptions } from './gpt-live-prompt.js';
import {
  createGptLiveAdapter,
  delegationMessageId,
  DELEGATION_TIMEOUT_LINE,
  lineIdForToken,
  type GptLiveConfig,
} from './voice.js';
import type { LiveKitServerApi, MirrorApi } from './voice-livekit.js';
import type { LiveKitJobMetadata } from './voice-livekit-protocol.js';

/** What NanoClaw calls the line: a hash of the token, never the token. */
const LINE = lineIdForToken('tok123');
import { stopWebhookServer } from '../webhook-server.js';

// ---------------------------------------------------------------------------
// Minimal WebSocket server framing (text + close only)
// ---------------------------------------------------------------------------

function acceptKey(key: string): string {
  return createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  let header: Buffer;
  if (payload.length < 126) header = Buffer.from([0x80 | opcode, payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrames(input: Buffer): { frames: Array<{ opcode: number; payload: Buffer }>; rest: Buffer } {
  const frames: Array<{ opcode: number; payload: Buffer }> = [];
  let buf = input;
  for (;;) {
    if (buf.length < 2) break;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      len = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    const maskKey = masked ? buf.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (buf.length < offset + len) break;
    const payload = Buffer.from(buf.subarray(offset, offset + len));
    if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    frames.push({ opcode, payload });
    buf = buf.subarray(offset + len);
  }
  return { frames, rest: buf };
}

// ---------------------------------------------------------------------------
// Fake OpenAI Live API
// ---------------------------------------------------------------------------

interface FakeAttach {
  sessionId: string;
  auth: string | undefined;
  path: string | undefined;
  socket: Duplex;
  received: Array<Record<string, unknown>>;
  closedByClient: boolean;
}

interface FakeOpenAI {
  port: number;
  hangups: string[];
  sessionCreates: Array<{ auth: string | undefined; body: Record<string, unknown> }>;
  /** Every sideband attach in order; `attach` is the latest. */
  attaches: FakeAttach[];
  attach: { auth?: string; path?: string; socket?: Duplex };
  /** Frames from every attach, in arrival order. */
  received: Array<Record<string, unknown>>;
  closedByClient: boolean;
  /** Delay the next attach's 101 by this many ms (consumed once) — lets two calls overlap. */
  nextAttachDelayMs: number;
  nextCreateDelayMs: number;
  push(event: Record<string, unknown>): void;
  close(): Promise<void>;
}

function startFakeOpenAI(): Promise<FakeOpenAI> {
  let sessions = 0;
  const fake: FakeOpenAI = {
    port: 0,
    sessionCreates: [],
    hangups: [],
    attaches: [],
    attach: {},
    received: [],
    closedByClient: false,
    nextAttachDelayMs: 0,
    nextCreateDelayMs: 0,
    push(event) {
      fake.attach.socket?.write(encodeFrame(0x1, Buffer.from(JSON.stringify(event))));
    },
    close: async () => {},
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const hangup = /^\/v1\/live\/sessions\/([^/]+)\/hangup$/.exec(req.url ?? '');
      if (req.method === 'POST' && hangup) {
        expect(req.headers.authorization).toBe('Bearer sk-test-key');
        fake.hangups.push(hangup[1]);
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/live/sessions') {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw.includes('fail-me')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { message: 'Incorrect API key provided: sk-****', type: 'invalid_request_error' },
            }),
          );
          return;
        }
        fake.sessionCreates.push({
          auth: req.headers.authorization,
          body: JSON.parse(raw) as Record<string, unknown>,
        });
        const sessionId = `live_fake${++sessions}`;
        const delay = fake.nextCreateDelayMs;
        fake.nextCreateDelayMs = 0;
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ session: { id: sessionId }, transport: { type: 'webrtc', sdp: 'v=0\r\nanswer' } }));
        }, delay);
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'] as string;
    const sessionId = /\/v1\/live\/sessions\/([^/]+)\/attach/.exec(req.url ?? '')?.[1] ?? '';
    const delay = fake.nextAttachDelayMs;
    fake.nextAttachDelayMs = 0;
    const a: FakeAttach = {
      sessionId,
      auth: req.headers.authorization,
      path: req.url,
      socket,
      received: [],
      closedByClient: false,
    };
    fake.attaches.push(a);
    const opening = setTimeout(() => {
      if (socket.destroyed) return;
      fake.attach = { auth: a.auth, path: a.path, socket };
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
      );
    }, delay);
    let pending: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const { frames, rest } = decodeFrames(pending);
      pending = rest;
      for (const f of frames) {
        if (f.opcode === 0x1) {
          const ev = JSON.parse(f.payload.toString('utf8')) as Record<string, unknown>;
          a.received.push(ev);
          fake.received.push(ev);
        } else if (f.opcode === 0x8) {
          a.closedByClient = true;
          fake.closedByClient = true;
          socket.write(encodeFrame(0x8, f.payload.subarray(0, 2)));
          socket.end();
        } else if (f.opcode === 0x9) socket.write(encodeFrame(0xa, f.payload));
      }
    });
    socket.on('close', () => clearTimeout(opening));
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      fake.port = (server.address() as AddressInfo).port;
      fake.close = () =>
        new Promise((r) => {
          for (const a of fake.attaches) a.socket.destroy();
          server.close(() => r());
        });
      resolve(fake);
    });
  });
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

// ---------------------------------------------------------------------------

describe('gpt-live adapter (fake OpenAI, real webhook server)', () => {
  let fake: FakeOpenAI;
  let adapter: ChannelAdapter;
  let base: string;
  const clock = { now: Date.now() };
  let accessEnabled = true;
  const inbound: Array<{ platformId: string; threadId: string | null; message: InboundMessage }> = [];

  beforeAll(async () => {
    fake = await startFakeOpenAI();
    const webhookPort = await freePort();
    process.env.WEBHOOK_PORT = String(webhookPort);
    base = `http://127.0.0.1:${webhookPort}/webhook/voice`;
    adapter = createGptLiveAdapter({
      apiKey: 'sk-test-key',
      publicUrl: `http://127.0.0.1:${webhookPort}`,
      voice: 'marin',
      linkTokens: ['tok123'],
      apiBase: `http://127.0.0.1:${fake.port}/v1`,
      wsBase: `ws://127.0.0.1:${fake.port}/v1`,
      resolveLine: async (id) =>
        accessEnabled
          ? {
              caller: { id, name: 'Ethan' },
              agentGroupId: 'ag-andy',
              agent: { name: 'Andy 🐾', personality: 'Dry humour, precise.' },
            }
          : null,
      accessCheckIntervalMs: 50,
      now: () => clock.now,
      requestTimeoutMs: 500,
    });
    await adapter.setup({
      onInbound: (platformId, threadId, message) => {
        inbound.push({ platformId, threadId, message });
      },
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    });
  });

  afterAll(async () => {
    await adapter.teardown();
    await stopWebhookServer();
    await fake.close();
  });

  it('serves the call page', async () => {
    const res = await fetch(`${base}/call?t=tok123`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('RTCPeerConnection');
    expect(html).toContain('x-voice-session');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
  });

  it('refuses an SDP offer without a known link token', async () => {
    const res = await fetch(`${base}/sdp?t=nope`, { method: 'POST', body: 'v=0\r\noffer' });
    expect(res.status).toBe(403);
    expect(fake.sessionCreates).toHaveLength(0);
  });

  it('rejects an unregistered or revoked caller before exposing a name or creating a session', async () => {
    accessEnabled = false;
    try {
      expect((await fetch(`${base}/info?t=tok123`)).status).toBe(403);
      expect((await fetch(`${base}/sdp?t=tok123&caller=Ethan`, { method: 'POST', body: 'v=0\r\noffer' })).status).toBe(
        403,
      );
      expect(fake.sessionCreates).toHaveLength(0);
    } finally {
      accessEnabled = true;
    }
  });

  it('tells the page who answers the line, only with a known token', async () => {
    const ok = await fetch(`${base}/info?t=tok123`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ agent: 'Andy 🐾', caller: 'Ethan' });
    expect((await fetch(`${base}/info?t=nope`)).status).toBe(403);
  });

  it('creates the session in client-delegation mode with the wired agent, and attaches the sideband', async () => {
    const res = await fetch(`${base}/sdp?t=tok123`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: 'v=0\r\noffer',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-voice-session')).toBe('live_fake1');
    expect(res.headers.get('x-voice-agent')).toBeNull();
    expect(await res.text()).toBe('v=0\r\nanswer');

    expect(fake.sessionCreates).toHaveLength(1);
    const create = fake.sessionCreates[0];
    expect(create.auth).toBe('Bearer sk-test-key');
    const session = create.body.session as Record<string, unknown>;
    expect(session.model).toBe('gpt-live-1');
    expect(session.delegation).toEqual({ type: 'client' });
    expect(session.instructions).toContain('You are Andy 🐾');
    expect(session.instructions).toContain('Dry humour');
    expect(session.instructions).toContain(JSON.stringify({ id: LINE, name: 'Ethan' }));
    expect(create.body.transport).toEqual({ type: 'webrtc', sdp: 'v=0\r\noffer' });

    expect(fake.attach.path).toBe('/v1/live/sessions/live_fake1/attach');
    expect(fake.attach.auth).toBe('Bearer sk-test-key');
  });

  it('turns a delegation into an inbound message and acknowledges it to the voice model', async () => {
    fake.push({ type: 'session.started', session: { id: 'live_fake1' } });
    fake.push({ type: 'session.output_transcript.delta', delta: 'Hi, how can I help?', start_ms: 0, end_ms: 900 });
    fake.push({ type: 'session.input_transcript.delta', delta: 'What is on my ', start_ms: 1000, end_ms: 1600 });
    fake.push({ type: 'session.input_transcript.delta', delta: 'calendar tomorrow?', start_ms: 1600, end_ms: 2300 });
    fake.push({
      type: 'session.delegation.created',
      event_id: 'ev_1',
      offset_ms: 2400,
      delegation: { id: 'item_1', type: 'delegation', target: 'client' },
    });

    await vi.waitFor(() => expect(inbound).toHaveLength(1), { timeout: 5000 });
    const { platformId, threadId, message } = inbound[0];
    expect(platformId).toBe(LINE);
    expect(LINE).toMatch(/^voice:[0-9a-f]{12}$/);
    expect(JSON.stringify(message.content)).not.toContain('tok123');
    expect(threadId).toBeNull();
    expect(message.kind).toBe('chat');
    expect(message.isMention).toBe(true);
    expect(message.isGroup).toBe(false);
    expect(message.content).toMatchObject({
      text: 'Assistant: Hi, how can I help?\nCaller: What is on my calendar tomorrow?',
      sender: 'Ethan',
      senderId: LINE,
      gptLive: { sessionId: 'live_fake1', delegationId: 'item_1', supersedes: null },
    });
    expect(message.id).toBe(delegationMessageId('live_fake1', 'item_1'));

    await vi.waitFor(() => expect(fake.received.some((e) => e.type === 'session.thinking.append')).toBe(true));
    const ack = fake.received.find((e) => e.type === 'session.thinking.append');
    expect(ack).toMatchObject({ delegation_id: 'item_1', content: 'Working on it.' });
  });

  it('rate-limits typing notes: one per 20 s while a reply is pending', async () => {
    const thinking = () => fake.received.filter((e) => e.type === 'session.thinking.append').map((e) => e.content);
    const before = thinking().length; // 'Working on it.' from the delegation, sent just now
    await adapter.setTyping?.(LINE, null, 'Checking the calendar');
    await new Promise((r) => setTimeout(r, 150));
    expect(thinking().length).toBe(before); // within 20 s of the last note: suppressed
    clock.now += 21_000;
    await adapter.setTyping?.(LINE, null, 'Checking the calendar');
    await vi.waitFor(() => expect(thinking().length).toBe(before + 1));
    expect(thinking().at(-1)).toBe('Checking the calendar');
    await adapter.setTyping?.(LINE, null, 'Checking the calendar');
    await new Promise((r) => setTimeout(r, 150));
    expect(thinking().length).toBe(before + 1); // again within 20 s: suppressed
  });

  it('speaks the agent reply as commentary on the delegation it replies to', async () => {
    const id = await adapter.deliver(LINE, null, {
      kind: 'chat',
      content: { text: 'Two meetings: standup at nine and lunch with Dana.' },
      inReplyTo: inbound[0].message.id,
    });
    expect(id).toBeTruthy();
    await vi.waitFor(() => expect(fake.received.some((e) => e.type === 'session.commentary.append')).toBe(true));
    expect(fake.received.find((e) => e.type === 'session.commentary.append')).toMatchObject({
      event_id: id,
      delegation_id: 'item_1',
      content: 'Two meetings: standup at nine and lunch with Dana.',
    });
  });

  it('sends no typing notes once the reply went out', async () => {
    const count = () => fake.received.filter((e) => e.type === 'session.thinking.append').length;
    const before = count();
    clock.now += 60_000;
    await adapter.setTyping?.(LINE, null, 'Still checking');
    await new Promise((r) => setTimeout(r, 150));
    expect(count()).toBe(before);
  });

  it('routes each reply to its own delegation; proactive and repeat replies answer none', async () => {
    const commentary = () => fake.received.filter((e) => e.type === 'session.commentary.append');
    const delegate = (id: string) =>
      fake.push({ type: 'session.delegation.created', delegation: { id, type: 'delegation', target: 'client' } });
    fake.push({ type: 'session.input_transcript.delta', delta: 'Book a table.' });
    delegate('item_2');
    fake.push({ type: 'session.input_transcript.delta', delta: 'And remind me to call Dana.' });
    delegate('item_3');
    await vi.waitFor(() => expect(inbound).toHaveLength(3));
    const [, , second, third] = [null, ...inbound].map((e) => e?.message.id);

    await adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'By the way, it is raining.' } });
    await vi.waitFor(() => expect(commentary().at(-1)).toMatchObject({ content: 'By the way, it is raining.' }));
    expect(commentary().at(-1)?.delegation_id).toBeNull();

    // The newer delegation is answered first; the older one stays open for its own reply.
    await adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'Reminder set.' }, inReplyTo: third });
    await vi.waitFor(() => expect(commentary().at(-1)).toMatchObject({ delegation_id: 'item_3' }));
    await adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'Table booked.' }, inReplyTo: second });
    await vi.waitFor(() => expect(commentary().at(-1)).toMatchObject({ delegation_id: 'item_2' }));

    await adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'For eight people.' }, inReplyTo: second });
    await vi.waitFor(() => expect(commentary().at(-1)).toMatchObject({ content: 'For eight people.' }));
    expect(commentary().at(-1)?.delegation_id).toBeNull();
  });

  it('hangs up the specified session and rejects later replies', async () => {
    const res = await fetch(`${base}/hangup?t=tok123&session=live_fake1`, { method: 'POST' });
    expect(res.status).toBe(204);
    await vi.waitFor(() => expect(fake.received.some((e) => e.type === 'session.close')).toBe(true));
    await vi.waitFor(() => expect(fake.closedByClient).toBe(true));

    await expect(adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'too late' } })).rejects.toThrow(
      /no active call/,
    );
  });

  it('two calls in flight on one link: the newest wins, the older is refused and its session closed', async () => {
    const before = fake.sessionCreates.length;
    const loserId = `live_fake${before + 1}`;
    const winnerId = `live_fake${before + 2}`;
    fake.nextAttachDelayMs = 400; // the first call's sideband attaches slowly

    const first = fetch(`${base}/sdp?t=tok123`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: 'v=0\r\noffer-a',
    });
    await new Promise((r) => setTimeout(r, 120)); // first call has its session and is mid-attach
    const second = await fetch(`${base}/sdp?t=tok123`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: 'v=0\r\noffer-b',
    });
    expect(second.status).toBe(200);
    expect(second.headers.get('x-voice-session')).toBe(winnerId);

    const firstRes = await first;
    expect(firstRes.status).toBe(409);

    // Replacement cancels the pending handshake and ends its upstream session over HTTP.
    await vi.waitFor(() => expect(fake.hangups).toContain(loserId));
    expect(fake.hangups.filter((id) => id === loserId)).toHaveLength(1);
    const winner = fake.attaches.find((a) => a.sessionId === winnerId);
    expect(winner?.closedByClient).toBe(false);

    // The line delivers to the winner.
    const id = await adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'Still here.' } });
    expect(id).toBeTruthy();
    await vi.waitFor(() =>
      expect(winner?.received.some((e) => e.type === 'session.commentary.append' && e.content === 'Still here.')).toBe(
        true,
      ),
    );
  });

  it('a stale tab cannot hang up the newer call on the same line', async () => {
    const winner = fake.attaches.at(-1)!;
    const oldSession = fake.attaches.find((a) => a.sessionId !== winner.sessionId)!.sessionId;
    expect((await fetch(`${base}/hangup?t=tok123&session=${oldSession}`, { method: 'POST' })).status).toBe(204);
    expect((await fetch(`${base}/hangup?t=tok123`, { method: 'POST' })).status).toBe(400);
    await adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'New call still connected.' } });
    await vi.waitFor(() => expect(winner.received.some((e) => e.content === 'New call still connected.')).toBe(true));
    expect(winner.closedByClient).toBe(false);
  });

  it('drops a slow reply from an ended call instead of speaking it into the new one', async () => {
    const winner = fake.attaches.at(-1)!;
    const before = winner.received.length;
    const id = await adapter.deliver(LINE, null, {
      kind: 'chat',
      content: { text: 'Answer for the first call.' },
      inReplyTo: delegationMessageId('live_fake1', 'item_1'),
    });
    expect(id).toBeUndefined();
    await new Promise((r) => setTimeout(r, 100));
    expect(winner.received).toHaveLength(before);
  });

  it('rejects question cards and attachments instead of falsely reporting delivery', async () => {
    await expect(
      adapter.deliver(LINE, null, {
        kind: 'chat',
        content: {
          type: 'ask_question',
          questionId: 'q1',
          title: 'Choose a time',
          question: 'When?',
          options: ['Now', 'Later'],
        },
      }),
    ).rejects.toThrow(/question cards/);
    await expect(
      adapter.deliver(LINE, null, {
        kind: 'chat',
        content: {},
        files: [{ filename: 'report.txt', data: Buffer.from('report') }],
      }),
    ).rejects.toThrow(/attachments/);
  });

  it('bounds a stalled attach and hangs up the created upstream session', async () => {
    const failedId = `live_fake${fake.sessionCreates.length + 1}`;
    fake.nextAttachDelayMs = 1500;
    const response = await fetch(`${base}/sdp?t=tok123`, { method: 'POST', body: 'v=0\r\noffer' });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('sideband attach failed');
    expect(fake.hangups.filter((id) => id === failedId)).toHaveLength(1);
    await expect(adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'late' } })).rejects.toThrow(
      /no active call/,
    );
    const next = await fetch(`${base}/sdp?t=tok123`, { method: 'POST', body: 'v=0\r\noffer' });
    expect(next.status).toBe(200);
  });

  it('rechecks access before speaking a pending backend result', async () => {
    accessEnabled = false;
    const before = fake.received.filter((e) => e.type === 'session.commentary.append').length;
    await expect(adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'private result' } })).rejects.toThrow(
      /access|active call/,
    );
    expect(fake.received.filter((e) => e.type === 'session.commentary.append')).toHaveLength(before);
    accessEnabled = true;
  });

  it('ends an idle active call when its membership is revoked', async () => {
    const response = await fetch(`${base}/sdp?t=tok123`, { method: 'POST', body: 'v=0\r\noffer' });
    const id = response.headers.get('x-voice-session')!;
    accessEnabled = false;
    try {
      await vi.waitFor(() => expect(fake.hangups).toContain(id));
    } finally {
      accessEnabled = true;
    }
  });

  it('refuses an oversized SDP body with 413 before touching OpenAI', async () => {
    const creates = fake.sessionCreates.length;
    const res = await fetch(`${base}/sdp?t=tok123`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: 'v=0\r\n' + 'a'.repeat(70 * 1024),
    });
    expect(res.status).toBe(413);
    expect(fake.sessionCreates.length).toBe(creates);
  });

  it('answers 502 without the upstream detail when OpenAI refuses the credentials', async () => {
    const res = await fetch(`${base}/sdp?t=tok123`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: 'v=0\r\nfail-me',
    });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain('session create failed: 401');
    expect(text).not.toContain('Incorrect API key');
  });

  it('the call page hangs up with a keepalive request so a closing tab still reaches the host', async () => {
    const html = await (await fetch(`${base}/call?t=tok123`)).text();
    expect(html).toMatch(/keepalive\s*:\s*(true|!0)/);
  });

  it('after teardown every route answers 503 and starts nothing', async () => {
    await adapter.teardown();
    const creates = fake.sessionCreates.length;
    expect((await fetch(`${base}/call?t=tok123`)).status).toBe(503);
    const sdp = await fetch(`${base}/sdp?t=tok123`, { method: 'POST', body: 'v=0\r\noffer' });
    expect(sdp.status).toBe(503);
    expect(fake.sessionCreates.length).toBe(creates);
  });
});

describe('voice call limits and pending creation', () => {
  let fake: FakeOpenAI;
  let adapter: ChannelAdapter;
  let base: string;
  let clock: number;
  const offer = (token = 'limited') => fetch(`${base}/sdp?t=${token}`, { method: 'POST', body: 'v=0\r\noffer' });

  beforeEach(async () => {
    fake = await startFakeOpenAI();
    const port = await freePort();
    clock = Date.now();
    vi.stubEnv('WEBHOOK_PORT', String(port));
    base = `http://127.0.0.1:${port}/webhook/voice`;
    adapter = createGptLiveAdapter({
      apiKey: 'sk-test-key',
      publicUrl: base,
      voice: 'marin',
      linkTokens: ['limited', 'other'],
      apiBase: `http://127.0.0.1:${fake.port}/v1`,
      wsBase: `ws://127.0.0.1:${fake.port}/v1`,
      resolveLine: async (id) => ({
        caller: { id, name: 'Caller' },
        agentGroupId: 'ag-test',
        agent: { name: 'Agent' },
      }),
      requestTimeoutMs: 500,
      maxCallDurationMs: 300,
      maxCallsPerHour: 2,
      now: () => clock,
    });
    await adapter.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction: () => {} });
  });

  afterEach(async () => {
    await adapter.teardown();
    await stopWebhookServer();
    await fake.close();
    vi.unstubAllEnvs();
  });

  it('rejects starts above the per-line hourly cap before contacting OpenAI and recovers next hour', async () => {
    expect((await offer()).status).toBe(200);
    expect((await offer()).status).toBe(200);
    const capped = await offer();
    expect(capped.status).toBe(429);
    expect(Number(capped.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(fake.sessionCreates).toHaveLength(2);
    expect((await offer('other')).status).toBe(200);
    clock += 3_600_001;
    expect((await offer()).status).toBe(200);
  });

  it('ends an unattended call at the duration limit, once', async () => {
    const response = await offer();
    const sessionId = response.headers.get('x-voice-session')!;
    await vi.waitFor(() => expect(fake.hangups).toContain(sessionId));
    expect(fake.hangups.filter((id) => id === sessionId)).toHaveLength(1);
    await expect(
      adapter.deliver(lineIdForToken('limited'), null, { kind: 'chat', content: { text: 'late' } }),
    ).rejects.toThrow(/no active call/);
  });

  it('an older creation finishing late cannot replace the newer call', async () => {
    fake.nextCreateDelayMs = 150;
    const older = offer();
    await vi.waitFor(() => expect(fake.sessionCreates).toHaveLength(1));
    const newer = await offer();
    expect(newer.status).toBe(200);
    const newerId = newer.headers.get('x-voice-session');
    expect((await older).status).toBe(409);
    expect(fake.hangups).toContain('live_fake1');
    expect(fake.hangups).not.toContain(newerId);
    await adapter.deliver(lineIdForToken('limited'), null, { kind: 'chat', content: { text: 'Newer call' } });
    await vi.waitFor(() =>
      expect(fake.attaches.find((a) => a.sessionId === newerId)?.received.some((e) => e.content === 'Newer call')).toBe(
        true,
      ),
    );
  });

  it('a browser disconnect during attach closes the created session', async () => {
    fake.nextAttachDelayMs = 150;
    const abort = new AbortController();
    const pending = fetch(`${base}/sdp?t=limited`, {
      method: 'POST',
      body: 'v=0\r\noffer',
      signal: abort.signal,
    }).catch(() => null);
    await vi.waitFor(() => expect(fake.attaches).toHaveLength(1));
    abort.abort();
    await pending;
    await vi.waitFor(() => expect(fake.hangups).toEqual(['live_fake1']));
    await expect(
      adapter.deliver(lineIdForToken('limited'), null, {
        kind: 'chat',
        content: { text: 'Must not be spoken' },
      }),
    ).rejects.toThrow(/no active call/);
  });

  it('a creation completing after teardown is hung up and never attached', async () => {
    fake.nextCreateDelayMs = 100;
    const pending = offer();
    await vi.waitFor(() => expect(fake.sessionCreates).toHaveLength(1));
    await adapter.teardown();
    expect((await pending).status).toBe(409);
    expect(fake.hangups).toEqual(['live_fake1']);
    expect(fake.attaches).toHaveLength(0);
  });
});

describe('voice delegation deadlines, daily budget and teardown races', () => {
  const NOON_UTC = Date.UTC(2026, 9, 2, 12);
  let fake: FakeOpenAI;
  let adapter: ChannelAdapter;
  let base: string;
  let clock: number;
  let inbound: InboundMessage[];
  /** Holds the next access recheck (a resolve without persona) until released. */
  let recheckGate: Promise<void> | null;
  let recheckStarted: boolean;
  const offer = () => fetch(`${base}/sdp?t=tok`, { method: 'POST', body: 'v=0\r\noffer' });
  const commentary = () => fake.received.filter((e) => e.type === 'session.commentary.append');

  const boot = async (overrides: Partial<GptLiveConfig> = {}): Promise<void> => {
    adapter = createGptLiveAdapter({
      apiKey: 'sk-test-key',
      publicUrl: base,
      voice: 'marin',
      linkTokens: ['tok'],
      apiBase: `http://127.0.0.1:${fake.port}/v1`,
      wsBase: `ws://127.0.0.1:${fake.port}/v1`,
      resolveLine: async (id: string, options?: ResolveLineOptions) => {
        if (!options?.persona && recheckGate) {
          const gate = recheckGate;
          recheckGate = null;
          recheckStarted = true;
          await gate;
        }
        return { caller: { id, name: 'Caller' }, agentGroupId: 'ag-test', agent: { name: 'Agent' } };
      },
      requestTimeoutMs: 500,
      now: () => clock,
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
  };

  const delegate = (id: string) =>
    fake.push({ type: 'session.delegation.created', delegation: { id, type: 'delegation', target: 'client' } });

  beforeEach(async () => {
    fake = await startFakeOpenAI();
    const port = await freePort();
    clock = NOON_UTC;
    inbound = [];
    recheckGate = null;
    recheckStarted = false;
    vi.stubEnv('WEBHOOK_PORT', String(port));
    base = `http://127.0.0.1:${port}/webhook/voice`;
  });

  afterEach(async () => {
    await adapter.teardown();
    await stopWebhookServer();
    await fake.close();
    vi.unstubAllEnvs();
  });

  it('tells the caller a delegation is taking longer when the agent misses the deadline', async () => {
    await boot({ delegationTimeoutMs: 150 });
    expect((await offer()).status).toBe(200);
    delegate('item_1');
    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    await vi.waitFor(() =>
      expect(commentary().at(-1)).toMatchObject({ delegation_id: 'item_1', content: DELEGATION_TIMEOUT_LINE }),
    );

    // The reply arriving after the deadline is still spoken, but answers nothing.
    await adapter.deliver(lineIdForToken('tok'), null, {
      kind: 'chat',
      content: { text: 'Found it after all.' },
      inReplyTo: inbound[0].id,
    });
    await vi.waitFor(() => expect(commentary().at(-1)).toMatchObject({ content: 'Found it after all.' }));
    expect(commentary().at(-1)?.delegation_id).toBeNull();
  });

  it('an answered delegation never times out', async () => {
    await boot({ delegationTimeoutMs: 200 });
    expect((await offer()).status).toBe(200);
    delegate('item_1');
    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    await adapter.deliver(lineIdForToken('tok'), null, {
      kind: 'chat',
      content: { text: 'Done.' },
      inReplyTo: inbound[0].id,
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(commentary().map((e) => e.content)).toEqual(['Done.']);
  });

  it('refuses a call once the line used its daily minutes, and recovers the next day', async () => {
    await boot({ maxCallMsPerDay: 1000 });
    const first = await offer();
    expect(first.status).toBe(200);
    clock += 1200; // the running call alone spends the budget
    const capped = await offer();
    expect(capped.status).toBe(429);
    expect(Number(capped.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(fake.sessionCreates).toHaveLength(1);
    const session = first.headers.get('x-voice-session')!;
    expect((await fetch(`${base}/hangup?t=tok&session=${session}`, { method: 'POST' })).status).toBe(204);
    expect((await offer()).status).toBe(429);
    clock += 86_400_000;
    expect((await offer()).status).toBe(200);
  });

  it('caps the call timer at the minutes left today', async () => {
    await boot({ maxCallMsPerDay: 1000 });
    expect((await offer()).status).toBe(200);
    clock += 800;
    const second = await offer(); // replaces the first, which is charged 800 ms
    expect(second.status).toBe(200);
    const sessionId = second.headers.get('x-voice-session')!;
    await vi.waitFor(() => expect(fake.hangups).toContain(sessionId), { timeout: 2000 });
  });

  it('the newest call wins across engines, and the daily minutes are shared', async () => {
    const MIN = 60_000;
    const rooms: string[] = [];
    const deleted: string[] = [];
    const dispatches: LiveKitJobMetadata[] = [];
    const api: LiveKitServerApi = {
      createRoom: async (options) => {
        rooms.push(options.name);
        return {};
      },
      deleteRoom: async (room) => {
        deleted.push(room);
      },
      createDispatch: async (_room, _agent, options) => {
        dispatches.push(JSON.parse(options.metadata) as LiveKitJobMetadata);
        return {};
      },
    };
    const mirrorApi: MirrorApi = {
      groupsFor: async () => [],
      adapter: () => undefined,
      boundChat: async () => null,
      isAdmin: async () => false,
    };
    await boot({
      maxCallMsPerDay: 12 * MIN,
      livekit: { url: 'wss://lk.example', apiKey: 'APIkey', apiSecret: 'x'.repeat(48), api, mirrorApi },
    });
    const walkie = async (): Promise<LiveKitJobMetadata> => {
      expect((await fetch(`${base}/livekit/token?t=tok`, { method: 'POST' })).status).toBe(200);
      return dispatches.at(-1)!;
    };

    expect((await offer()).status).toBe(200);
    clock += 5 * MIN;
    // A walkie call hangs up the OpenAI call, whose 5 minutes leave it 7.
    expect((await walkie()).maxDurationMs).toBe(7 * MIN);
    await vi.waitFor(() => expect(fake.hangups).toEqual(['live_fake1']));

    clock += MIN;
    // An OpenAI call ends the walkie call and deletes its room.
    const second = await offer();
    expect(second.status).toBe(200);
    await vi.waitFor(() => expect(deleted).toEqual(rooms));
    clock += 3 * MIN;
    const session = second.headers.get('x-voice-session')!;
    expect((await fetch(`${base}/hangup?t=tok&session=${session}`, { method: 'POST' })).status).toBe(204);
    // The walkie caller never joined, so it cost nothing: 5 + 3 of 12 minutes used.
    expect((await walkie()).maxDurationMs).toBe(4 * MIN);
  });

  it('a teardown during the access recheck hangs up the session and never attaches', async () => {
    await boot();
    let release!: () => void;
    recheckGate = new Promise((r) => (release = r));
    const pending = offer();
    await vi.waitFor(() => expect(recheckStarted).toBe(true));
    await adapter.teardown();
    release();
    expect((await pending).status).toBe(409);
    expect(fake.hangups).toEqual(['live_fake1']);
    expect(fake.attaches).toHaveLength(0);
  });

  it('a teardown during the attach hangs up the session and refuses the call', async () => {
    await boot();
    fake.nextAttachDelayMs = 300;
    const pending = offer();
    await vi.waitFor(() => expect(fake.attaches).toHaveLength(1));
    await adapter.teardown();
    expect((await pending).status).toBe(503);
    expect(fake.hangups).toEqual(['live_fake1']);
  });
});
