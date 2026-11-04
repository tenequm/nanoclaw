/**
 * The Recall ingress against Recall's documented payloads
 * (https://docs.recall.ai/docs/real-time-event-payloads): the fixtures below are those schemas
 * with concrete values. The translator is pure; the websocket half runs on a real HTTP server
 * with a real `ws` client.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

vi.mock('../../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { CallEvent, Speaker } from '../core/types.js';
import {
  createRecallIngress,
  recallEndpointUrl,
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

/** `[text, start, end]` per word, relative seconds. */
type W = [string, number, number | null];
const words = (ws: W[]) =>
  ws.map(([text, start, end]) => ({
    text,
    start_timestamp: { relative: start },
    end_timestamp: end === null ? null : { relative: end },
  }));

const partial = (p: P, ws: W[]) => ({
  event: 'transcript.partial_data',
  data: {
    data: { words: words(ws), participant: participant(p) },
    transcript: { id: 'tr-1', metadata: {} },
    ...artifacts,
  },
});

const final = (p: P, ws: W[]) => ({
  event: 'transcript.data',
  data: {
    data: { words: words(ws), language_code: 'en', participant: participant(p) },
    transcript: { id: 'tr-1', metadata: {} },
    ...artifacts,
  },
});

/** Recording began at this absolute time; `relative` counts from it. */
const START_MS = Date.parse('2026-11-04T12:00:00.000Z');
const stamp = (relative: number) => ({ absolute: new Date(START_MS + relative * 1000).toISOString(), relative });

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

/** Feeds messages in order; arrival is a fixed late host time so anchoring is visible. */
function run(messages: unknown[], arrivalMs = START_MS + 60_000) {
  const t = new RecallTranslator();
  return messages.flatMap((m) => t.translate(m, arrivalMs));
}
const eventsOf = (out: ReturnType<typeof run>): CallEvent[] =>
  out.flatMap((o) => (o.type === 'event' ? [o.event] : []));

describe('RecallTranslator', () => {
  it('correlates a participant’s partials and the final that replaces them, then opens a new utterance', () => {
    const out = run([
      participantEvent('participant_events.speech_on', ALEX, 1.0),
      partial(ALEX, [['hel', 1.1, 1.3]]),
      partial(ALEX, [
        ['hello', 1.1, 1.4],
        ['how', 1.5, 1.6],
      ]),
      final(ALEX, [
        ['Hello,', 1.1, 1.4],
        ['how', 1.5, 1.6],
        ['are', 1.7, 1.8],
        ['you?', 1.9, 2.1],
      ]),
      partial(ALEX, [['Dan', 3.0, 3.2]]),
    ]);
    expect(eventsOf(out)).toEqual([
      { kind: 'speech', speaker: alex, on: true, at: START_MS + 1000 },
      { kind: 'utterance', speaker: alex, uttId: '100-0', text: 'hel', final: false, at: START_MS + 1300 },
      { kind: 'utterance', speaker: alex, uttId: '100-0', text: 'hello how', final: false, at: START_MS + 1600 },
      {
        kind: 'utterance',
        speaker: alex,
        uttId: '100-0',
        text: 'Hello, how are you?',
        final: true,
        at: START_MS + 2100,
      },
      { kind: 'utterance', speaker: alex, uttId: '100-1', text: 'Dan', final: false, at: START_MS + 3200 },
    ]);
    expect(out.filter((o) => o.type === 'words')).toEqual([
      { type: 'words', speaker: alex },
      { type: 'words', speaker: alex },
      { type: 'words', speaker: alex },
    ]);
  });

  it('keeps each participant’s utterance in flight apart', () => {
    const out = eventsOf(
      run([
        partial(ALEX, [['one', 1, 1.2]]),
        partial(BO, [['two', 1.1, 1.3]]),
        final(BO, [['two.', 1.1, 1.3]]),
        final(ALEX, [['one.', 1, 1.2]]),
      ]),
    );
    expect(out.map((e) => e.kind === 'utterance' && [e.speaker.id, e.uttId, e.final])).toEqual([
      ['100', '100-0', false],
      ['200', '200-0', false],
      ['200', '200-0', true],
      ['100', '100-0', true],
    ]);
  });

  it('drops a late partial of an utterance that is already final', () => {
    const out = eventsOf(
      run([
        partial(ALEX, [['hello', 1.0, 1.2]]),
        final(ALEX, [['hello', 1.0, 1.2]]),
        partial(ALEX, [['hello', 1.0, 1.2]]),
        partial(ALEX, [['next', 2.0, 2.2]]),
      ]),
    );
    expect(out.map((e) => e.kind === 'utterance' && `${e.uttId}:${e.text}:${e.final}`)).toEqual([
      '100-0:hello:false',
      '100-0:hello:true',
      '100-1:next:false',
    ]);
  });

  it('gives a final with no partials its own utterance, and lets an empty final close partials', () => {
    const out = eventsOf(
      run([
        final(ALEX, [['Yes.', 1, 1.2]]),
        partial(ALEX, [['um', 2, 2.1]]),
        final(ALEX, []),
        final(ALEX, []),
        partial(ALEX, []),
      ]),
    );
    expect(out.map((e) => e.kind === 'utterance' && `${e.uttId}:${e.text}:${e.final}`)).toEqual([
      '100-0:Yes.:true',
      '100-1:um:false',
      '100-1::true',
    ]);
  });

  it('estimates the recording start from arrival until a participant event pins it', () => {
    const t = new RecallTranslator();
    const arrival = START_MS + 5_400; // 400 ms of delivery latency the estimate cannot see
    const [first] = t.translate(partial(ALEX, [['hi', 4.8, 5.0]]), arrival);
    expect(first).toMatchObject({ type: 'event', event: { at: arrival } });
    t.translate(participantEvent('participant_events.speech_off', ALEX, 5.2), START_MS + 5_600);
    const [next] = t.translate(final(ALEX, [['hi', 4.8, 5.0]]), START_MS + 7_000);
    expect(next).toMatchObject({ type: 'event', event: { at: START_MS + 5_000 } });
  });

  it('maps speech, presence and chat; a leave mid-speech ends the speech', () => {
    const out = run([
      participantEvent('participant_events.join', BO, 0.5),
      participantEvent('participant_events.speech_on', BO, 2),
      chat(BO, 3, '  link: https://example.com  '),
      chat(BO, 3.5, '   '),
      participantEvent('participant_events.leave', BO, 4),
      participantEvent('participant_events.speech_off', ALEX, 4.5),
      participantEvent('participant_events.leave', ALEX, 5),
    ]);
    expect(out).toEqual([
      { type: 'presence', speaker: bo, joined: true, at: START_MS + 500 },
      { type: 'event', event: { kind: 'speech', speaker: bo, on: true, at: START_MS + 2000 } },
      { type: 'event', event: { kind: 'chat', speaker: bo, text: 'link: https://example.com', at: START_MS + 3000 } },
      { type: 'event', event: { kind: 'speech', speaker: bo, on: false, at: START_MS + 4000 } },
      { type: 'presence', speaker: bo, joined: false, at: START_MS + 4000 },
      { type: 'event', event: { kind: 'speech', speaker: alex, on: false, at: START_MS + 4500 } },
      { type: 'presence', speaker: alex, joined: false, at: START_MS + 5000 },
    ]);
  });

  it('names a nameless participant by id, follows a rename, and ignores what it does not know', () => {
    const out = run([
      partial({ id: 7, name: null }, [['hey', 1, 1.1]]),
      partial({ id: 7, name: 'Kim' }, [
        ['hey', 1, 1.1],
        ['there', 1.2, 1.3],
      ]),
      participantEvent('participant_events.webcam_on', ALEX, 1),
      { event: 'transcript.data' },
      { event: 'transcript.data', data: { data: { words: 'nope', participant: participant(ALEX) } } },
      { event: 'transcript.data', data: { data: { words: [], participant: { id: null } } } },
      'not an object',
      null,
    ]);
    expect(eventsOf(out).map((e) => e.kind === 'utterance' && e.speaker)).toEqual([
      { id: '7', name: 'Participant 7' },
      { id: '7', name: 'Kim' },
    ]);
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
    const words: Array<[string, Speaker]> = [];
    const presence: Array<[string, string, boolean]> = [];
    const raw: unknown[] = [];
    ingress = createRecallIngress({
      onEvent: (callId, e) => events.push([callId, e]),
      onWords: (callId, s) => words.push([callId, s]),
      onPresence: (callId, s, joined) => presence.push([callId, s.id, joined]),
      onRaw: (_callId, m) => raw.push(m),
      ...overrides,
    });
    server = http.createServer((_req, res) => res.writeHead(500).end());
    server.on('upgrade', ingress.handleUpgrade);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const origin = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { ingress, origin, events, words, presence, raw };
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
    expect(recallEndpointUrl('wss://meet.opx.one/', a)).toBe(
      `wss://meet.opx.one/voice/recall/call-1/?token=${a.token}`,
    );
    expect(() => ingress.register('call-1')).toThrow(/registered already/);
    expect(() => ingress.register('../x')).toThrow(/unusable call id/);
  });

  it('delivers a connected call’s events, words, presence and raw messages', async () => {
    const { ingress, origin, events, words, presence, raw } = await start();
    const ws = await open(recallEndpointUrl(origin, ingress.register('call-1')));
    ws.send(JSON.stringify(participantEvent('participant_events.join', ALEX, 0.2)));
    ws.send('not json');
    ws.send(JSON.stringify(partial(ALEX, [['Dan', 1, 1.2]])));
    ws.send(JSON.stringify(final(ALEX, [['Dan,', 1, 1.2]])));
    await until(() => events.length === 2);
    expect(events).toEqual([
      ['call-1', { kind: 'utterance', speaker: alex, uttId: '100-0', text: 'Dan', final: false, at: START_MS + 1200 }],
      ['call-1', { kind: 'utterance', speaker: alex, uttId: '100-0', text: 'Dan,', final: true, at: START_MS + 1200 }],
    ]);
    expect(words).toEqual([['call-1', alex]]);
    expect(presence).toEqual([['call-1', '100', true]]);
    expect(raw).toHaveLength(3);
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

  it('closes the call’s connection on unregister and refuses it after', async () => {
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
    second.send(JSON.stringify(final(BO, [['hi', 1, 1.1]])));
    await until(() => events.length === 1);
  });

  it('closes a connection that sends a frame over the bound', async () => {
    const { ingress, origin, events } = await start({ maxFrameBytes: 1024 });
    const ws = await open(recallEndpointUrl(origin, ingress.register('call-1')));
    const closed = closeOf(ws);
    ws.send(JSON.stringify(final(ALEX, [['x'.repeat(2048), 1, 1.1]])));
    expect(await closed).toBe(1009);
    expect(events).toEqual([]);
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
    ws.send(JSON.stringify(final(ALEX, [['one', 1, 1.1]])));
    ws.send(JSON.stringify(final(ALEX, [['two', 2, 2.1]])));
    await until(() => calls === 2);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });
});
