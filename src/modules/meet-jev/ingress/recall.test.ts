/**
 * The Recall ingress against Recall's documented payloads
 * (https://docs.recall.ai/docs/real-time-event-payloads,
 * https://docs.recall.ai/docs/how-to-get-separate-audio-per-participant-realtime): the fixtures below
 * are those schemas with concrete values. The translator is pure; the websocket half runs on a real
 * HTTP server with a real `ws` client.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

vi.mock('../../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { log } from '../../../log.js';
import type { CallEvent, Speaker } from '../core/types.js';
import {
  createRecallIngress,
  decodePcm,
  recallEndpointUrl,
  recallRawSummary,
  RecallTranslator,
  type RecallIngress,
  type RecallIngressOptions,
} from './recall.js';

const artifacts = {
  realtime_endpoint: { id: 're-1', metadata: {} },
  recording: { id: 'rec-1', metadata: {} },
  bot: { id: 'bot-1', metadata: { nanoclaw_room: 'meet-r1' } },
};

type P = { id: number; name: string | null; is_host?: boolean };
const participant = (p: P) => ({
  id: p.id,
  name: p.name,
  is_host: p.is_host ?? false,
  platform: 'google_meet',
  extra_data: {},
  email: null,
});

const ALEX: P = { id: 100, name: 'Alex', is_host: true };
const BO: P = { id: 200, name: 'Bo' };

/** Recording began at this absolute time; `relative` counts from it. */
const START_MS = Date.parse('2026-11-04T12:00:00.000Z');
const stamp = (relative: number) => ({ absolute: new Date(START_MS + relative * 1000).toISOString(), relative });

/** Samples as Recall's base64 S16LE. */
const b64 = (samples: number[]) => {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => buf.writeInt16LE(v, i * 2));
  return buf.toString('base64');
};

const frame = (p: P, relative: number, samples: number[]) => ({
  event: 'audio_separate_raw.data',
  data: {
    data: { buffer: b64(samples), timestamp: stamp(relative), participant: participant(p) },
    audio_separate: { id: 'as-1', metadata: {} },
    ...artifacts,
  },
});

const participantEvent = (event: string, p: P, relative: number) => ({
  event,
  data: {
    data: { participant: participant(p), timestamp: stamp(relative), data: null },
    participant_events: { id: 'pe-1', metadata: {} },
    ...artifacts,
  },
});

const chat = (p: P, relative: number, text: string) => ({
  event: 'participant_events.chat_message',
  data: {
    data: { participant: participant(p), timestamp: stamp(relative), data: { text, to: 'everyone' } },
    participant_events: { id: 'pe-1', metadata: {} },
    ...artifacts,
  },
});

const alex: Speaker = { id: '100', name: 'Alex' };
const bo: Speaker = { id: '200', name: 'Bo' };

function run(messages: unknown[], botName?: string, arrivalMs = START_MS + 60_000) {
  const t = new RecallTranslator(botName);
  return messages.flatMap((m) => t.translate(m, arrivalMs));
}

describe('decodePcm', () => {
  it('reads base64 16-bit little-endian samples, dropping an odd trailing byte', () => {
    expect([...decodePcm(b64([0, 1, -1, 32767, -32768]))]).toEqual([0, 1, -1, 32767, -32768]);
    expect([...decodePcm(Buffer.from([1, 0, 7]).toString('base64'))]).toEqual([1]);
    expect(decodePcm('')).toHaveLength(0);
  });
});

describe('RecallTranslator', () => {
  it("routes each participant's frames apart, as samples at Recall's time on the host clock", () => {
    const out = run([frame(ALEX, 1.0, [1, 2, 3]), frame(BO, 1.02, [4]), frame(ALEX, 1.04, [5])]);
    expect(out.map((o) => o.type === 'audio' && [o.speaker.id, [...o.pcm], o.at])).toEqual([
      ['100', [1, 2, 3], START_MS + 1000],
      ['200', [4], START_MS + 1020],
      ['100', [5], START_MS + 1040],
    ]);
  });

  it('takes a participant beside the inner data too; an empty buffer is an empty frame, a missing one none', () => {
    const beside = {
      event: 'audio_separate_raw.data',
      data: { data: { buffer: b64([9]), timestamp: stamp(2) }, participant: participant(BO), ...artifacts },
    };
    const empty = frame(ALEX, 1, []);
    const missing = { ...frame(ALEX, 1, [1]), data: { data: { timestamp: stamp(1), participant: participant(ALEX) } } };
    expect(run([beside, empty, missing])).toEqual([
      { type: 'audio', speaker: bo, pcm: Int16Array.from([9]), at: START_MS + 2000 },
      { type: 'audio', speaker: alex, pcm: new Int16Array(0), at: START_MS + 1000 },
    ]);
  });

  it("leaves out the bot's own participant, by its name in any case, and says so once", () => {
    const BOT: P = { id: 300, name: 'andy' };
    const out = run(
      [
        participantEvent('participant_events.join', BOT, 0.1),
        frame(BOT, 1, [1, 2]),
        frame(ALEX, 1.5, [3]),
        frame(BOT, 2, [4]),
        chat(BOT, 2.5, 'hello'),
      ],
      ' Andy ',
    );
    expect(out.map((o) => o.type)).toEqual(['self', 'audio']);
    expect(out[0]).toEqual({ type: 'self', speaker: { id: '300', name: 'andy' }, again: false });
    // A second participant of that name is left out as well, flagged: it may be a person.
    expect(run([frame(BOT, 1, [1]), frame({ id: 301, name: 'Andy' }, 2, [2])], 'Andy')).toEqual([
      { type: 'self', speaker: { id: '300', name: 'andy' }, again: false },
      { type: 'self', speaker: { id: '301', name: 'Andy' }, again: true },
    ]);
    // Without a bot name nobody is left out.
    expect(run([frame(BOT, 1, [1])])).toHaveLength(1);
  });

  it("maps presence and chat; Recall's speech_on/off are not events: the host's VAD decides", () => {
    const out = run([
      participantEvent('participant_events.join', BO, 0.5),
      participantEvent('participant_events.speech_on', BO, 2),
      chat(BO, 3, '  link: https://example.com  '),
      chat(BO, 3.5, '   '),
      participantEvent('participant_events.speech_off', BO, 3.8),
      participantEvent('participant_events.leave', BO, 4),
    ]);
    expect(out).toEqual([
      { type: 'presence', speaker: bo, joined: true, at: START_MS + 500 },
      { type: 'event', event: { kind: 'chat', speaker: bo, text: 'link: https://example.com', at: START_MS + 3000 } },
      { type: 'presence', speaker: bo, joined: false, at: START_MS + 4000 },
    ]);
  });

  it('names a nameless participant by id, follows a rename, and ignores what it does not know', () => {
    const out = run([
      frame({ id: 7, name: null }, 1, [1]),
      frame({ id: 7, name: 'Kim' }, 1.1, [1]),
      participantEvent('participant_events.webcam_on', ALEX, 1),
      { event: 'audio_separate_raw.data' },
      { event: 'audio_separate_raw.data', data: { data: { buffer: b64([1]), participant: { id: null } } } },
      'not an object',
      null,
    ]);
    expect(out.map((o) => o.type === 'audio' && o.speaker)).toEqual([
      { id: '7', name: 'Participant 7' },
      { id: '7', name: 'Kim' },
    ]);
  });

  it('places a message without a timestamp on its arrival', () => {
    const noStamp = {
      event: 'audio_separate_raw.data',
      data: { data: { buffer: b64([1]), participant: participant(ALEX) } },
    };
    expect(run([noStamp], undefined, 12_345)).toMatchObject([{ type: 'audio', at: 12_345 }]);
  });
});

describe('createRecallIngress', () => {
  let server: http.Server | null = null;
  let ingress: RecallIngress | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    ingress?.close();
    ingress = null;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  async function start(overrides: Partial<RecallIngressOptions> = {}) {
    const events: Array<[string, CallEvent]> = [];
    const audio: Array<[string, string, number[]]> = [];
    const presence: Array<[string, string, boolean]> = [];
    const raw: unknown[] = [];
    ingress = createRecallIngress({
      onAudio: (callId, s, pcm) => audio.push([callId, s.id, [...pcm]]),
      onEvent: (callId, e) => events.push([callId, e]),
      onPresence: (callId, s, joined) => presence.push([callId, s.id, joined]),
      onRaw: (_callId, m, seq) => raw.push([seq, m]),
      ...overrides,
    });
    server = http.createServer((_req, res) => res.writeHead(500).end());
    server.on('upgrade', ingress.handleUpgrade);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const origin = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { ingress, origin, events, audio, presence, raw };
  }

  type Outcome = { open: WebSocket } | { status: number };
  function connect(url: string): Promise<Outcome> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      sockets.push(ws);
      ws.once('open', () => resolve({ open: ws }));
      ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0 }));
      ws.once('error', reject);
    });
  }
  async function open(url: string): Promise<WebSocket> {
    const outcome = await connect(url);
    if (!('open' in outcome)) throw new Error(`refused with ${outcome.status}`);
    return outcome.open;
  }
  const closeOf = (ws: WebSocket) => new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(check()).toBe(true);
  };

  it('registers a call with a trailing-slash path and a random token, once', async () => {
    const { ingress } = await start();
    const a = ingress.register('call-1');
    const b = ingress.register('call-2');
    expect(a.path).toBe('/voice/recall/call-1/');
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(recallEndpointUrl('wss://meet.example.com/', a)).toBe(
      `wss://meet.example.com/voice/recall/call-1/?token=${a.token}`,
    );
    expect(() => ingress.register('call-1')).toThrow(/registered already/);
    expect(() => ingress.register('../x')).toThrow(/unusable call id/);
  });

  it("delivers a connected call's audio, chat, presence and raw messages; never the bot's", async () => {
    const { ingress, origin, events, audio, presence, raw } = await start();
    const ws = await open(recallEndpointUrl(origin, ingress.register('call-1', { botName: 'Andy' })));
    ws.send(JSON.stringify(participantEvent('participant_events.join', ALEX, 0.2)));
    ws.send('not json');
    ws.send(JSON.stringify(frame({ id: 300, name: 'Andy' }, 0.9, [7, 7])));
    ws.send(JSON.stringify(frame(ALEX, 1, [1, -1])));
    ws.send(JSON.stringify(chat(ALEX, 1.2, 'hi')));
    await until(() => events.length === 1);
    expect(audio).toEqual([['call-1', '100', [1, -1]]]);
    expect(events).toEqual([['call-1', { kind: 'chat', speaker: alex, text: 'hi', at: START_MS + 1200 }]]);
    expect(presence).toEqual([['call-1', '100', true]]);
    expect(raw.map((r) => (r as [number, unknown])[0])).toEqual([1, 2, 3, 4]);
  });

  it("warns once when a second participant has the bot's name", async () => {
    const { ingress, origin } = await start();
    const ws = await open(recallEndpointUrl(origin, ingress.register('call-1', { botName: 'Andy' })));
    vi.mocked(log.warn).mockClear();
    ws.send(JSON.stringify(frame({ id: 300, name: 'Andy' }, 1, [1])));
    ws.send(JSON.stringify(frame({ id: 301, name: 'andy' }, 2, [2])));
    ws.send(JSON.stringify(frame({ id: 301, name: 'andy' }, 3, [3])));
    await until(() => vi.mocked(log.warn).mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(vi.mocked(log.warn).mock.calls).toEqual([
      [expect.stringContaining("another participant has the bot's name"), { callId: 'call-1', participantId: '301' }],
    ]);
  });

  it('accepts the path without the trailing slash too', async () => {
    const { ingress, origin } = await start();
    const { token } = ingress.register('call-1');
    await open(`${origin}/voice/recall/call-1?token=${token}`);
  });

  it('refuses a wrong or missing token, an unknown call, another path and dot segments', async () => {
    const { ingress, origin } = await start();
    const { token } = ingress.register('call-1');
    ingress.register('call-2');
    expect(await connect(`${origin}/voice/recall/call-1/?token=${token}x`)).toEqual({ status: 401 });
    expect(await connect(`${origin}/voice/recall/call-1/`)).toEqual({ status: 401 });
    expect(await connect(`${origin}/voice/recall/call-2/?token=${token}`)).toEqual({ status: 401 });
    expect(await connect(`${origin}/voice/recall/nope/?token=${token}`)).toEqual({ status: 401 });
    expect(await connect(`${origin}/voice/recall/call-1/extra?token=${token}`)).toEqual({ status: 404 });
    expect(await connect(`${origin}/voice/other?token=${token}`)).toEqual({ status: 404 });
    const logged = JSON.stringify(Object.values(log).flatMap((fn) => vi.mocked(fn).mock.calls));
    expect(logged).toContain('refused a websocket');
    expect(logged).not.toContain(token);
    // A websocket client normalizes dot segments away; a raw upgrade request keeps them.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: Number(new URL(origin).port),
        path: `/voice/x/../recall/call-1/?token=${token}`,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
        },
      });
      req.once('response', (res) => resolve(res.statusCode ?? 0));
      req.once('upgrade', (_res, socket) => {
        socket.destroy();
        resolve(101);
      });
      req.once('error', reject);
      req.end();
    });
    expect(status).toBe(400);
  });

  it("closes the call's connection on unregister and refuses it after", async () => {
    const { ingress, origin } = await start();
    const reg = ingress.register('call-1');
    const ws = await open(recallEndpointUrl(origin, reg));
    const closed = closeOf(ws);
    ingress.unregister('call-1');
    expect(await closed).toBe(1000);
    expect(await connect(recallEndpointUrl(origin, reg))).toEqual({ status: 401 });
  });

  it('keeps only the newest connection of a call', async () => {
    const { ingress, origin, events } = await start();
    const url = recallEndpointUrl(origin, ingress.register('call-1'));
    const first = await open(url);
    const firstClosed = closeOf(first);
    const second = await open(url);
    expect(await firstClosed).toBe(1000);
    second.send(JSON.stringify(chat(BO, 1, 'hi')));
    await until(() => events.length === 1);
  });

  it('closes a connection that sends a frame over the bound', async () => {
    const { ingress, origin, audio } = await start({ maxFrameBytes: 1024 });
    const ws = await open(recallEndpointUrl(origin, ingress.register('call-1')));
    const closed = closeOf(ws);
    ws.send(JSON.stringify(frame(ALEX, 1, new Array(2048).fill(1))));
    expect(await closed).toBe(1009);
    expect(audio).toEqual([]);
  });

  it('keeps the connection when a consumer throws', async () => {
    let calls = 0;
    const { ingress, origin } = await start({
      onEvent: () => {
        calls++;
        throw new Error('consumer exploded');
      },
    });
    const ws = await open(recallEndpointUrl(origin, ingress.register('call-1')));
    ws.send(JSON.stringify(chat(ALEX, 1, 'one')));
    ws.send(JSON.stringify(chat(ALEX, 2, 'two')));
    await until(() => calls === 2);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe('recallRawSummary', () => {
  it('keeps the event, participant, times and a frame size, never the audio or the words', () => {
    expect(recallRawSummary(frame(ALEX, 1.5, [1, 2, 3, 4]))).toEqual({
      event: 'audio_separate_raw.data',
      participant: { id: 100, name: 'Alex', is_host: true },
      relative: 1.5,
      absolute: new Date(START_MS + 1500).toISOString(),
      bytes: 8,
    });
    expect(recallRawSummary(participantEvent('participant_events.speech_off', BO, 2.5))).toEqual({
      event: 'participant_events.speech_off',
      participant: { id: 200, name: 'Bo', is_host: false },
      relative: 2.5,
      absolute: new Date(START_MS + 2500).toISOString(),
    });
    expect(recallRawSummary(chat(BO, 3, 'my secret'))).toMatchObject({ chars: 9 });
    expect(JSON.stringify(recallRawSummary(chat(BO, 3, 'my secret')))).not.toContain('secret');
    expect(recallRawSummary('nope')).toEqual({ event: null });
  });
});
