/**
 * `/meet <link> jev` ingress: the Recall bot's real-time websocket endpoint
 * (https://docs.recall.ai/docs/real-time-websocket-endpoints), one connection per call at
 * `/voice/recall/<callId>/?token=<per-call random>`, turned into `CallEvent`s.
 *
 * Payloads per https://docs.recall.ai/docs/real-time-event-payloads. Recall sends no utterance id,
 * so partials and finals are correlated per participant: with per-participant streams
 * (`diarization.use_separate_streams_when_available`) each participant has at most one utterance in
 * flight; its partials carry the words so far (`hel` -> `hello` -> `hello how`, per
 * https://docs.recall.ai/docs/bot-real-time-transcription#lowest-latency-partial-transcript-data)
 * and its next `transcript.data` is that utterance's final. After a final, the next partial opens a
 * new utterance; a partial whose words start before the last final's end is a late revision of
 * that final and is dropped.
 *
 * Times: `relative` is seconds since the recording began
 * (https://docs.recall.ai/docs/speaker-timeline#timestamps). Participant and chat events also carry
 * `absolute`, which pins the recording start in host ms; until one arrives, a transcript event
 * estimates it from its arrival.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import { log } from '../../../log.js';
import type { CallEvent, Speaker } from '../core/types.js';

/** The shared webhook server segment the ingress takes upgrades on (`registerUpgradeHandler`). */
export const RECALL_UPGRADE_SEGMENT = 'voice';
const PATH_PREFIX = '/voice/recall/';
const PATH_RE = /^\/voice\/recall\/([^/]+)\/?$/;
/** Recall events are small JSON; a long monologue's cumulative partial stays far below this. */
const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
/** Recall's FAQ: ping every 30 s so no proxy on the way drops the connection as idle. */
const DEFAULT_PING_INTERVAL_MS = 30_000;
const CALL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface RecallCallRegistration {
  /** The URL path Recall connects to, with the trailing slash Recall requires before a query. */
  path: string;
  token: string;
}

/** The URL for the bot's `realtime_endpoints` entry: `origin` is the public `wss://` origin. */
export function recallEndpointUrl(origin: string, registration: RecallCallRegistration): string {
  return `${origin.replace(/\/+$/, '')}${registration.path}?token=${encodeURIComponent(registration.token)}`;
}

/** What one Recall message became. */
export type RecallOutput =
  | { type: 'event'; event: CallEvent }
  /** A participant's partial carried words: the worker reflex's text confirmation. */
  | { type: 'words'; speaker: Speaker }
  | { type: 'presence'; speaker: Speaker; joined: boolean; at: number };

interface Participant {
  speaker: Speaker;
  /** Finals so far: the next utterance's sequence number. */
  seq: number;
  /** The utterance whose partials are in flight. */
  open: string | null;
  /** Relative seconds at the end of the last final; earlier partials are stale. */
  lastFinalEnd: number;
  speaking: boolean;
}

interface RecallWord {
  text: string;
  start: number;
  end: number | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function parseWords(raw: unknown): RecallWord[] | null {
  if (!Array.isArray(raw)) return null;
  const words: RecallWord[] = [];
  for (const w of raw) {
    if (!isRecord(w) || typeof w.text !== 'string') continue;
    const start = num(isRecord(w.start_timestamp) ? w.start_timestamp.relative : null);
    if (start === null) continue;
    const end = num(isRecord(w.end_timestamp) ? w.end_timestamp.relative : null);
    words.push({ text: w.text, start, end });
  }
  return words;
}

const wordsText = (words: RecallWord[]) =>
  words
    .map((w) => w.text.trim())
    .filter(Boolean)
    .join(' ');

/**
 * Per call, pure: Recall messages in, outputs out. Holds the participants' utterance state and the
 * recording's start; the websocket part only feeds it.
 */
export class RecallTranslator {
  private anchorMs: number | null = null;
  private anchorExact = false;
  private readonly participants = new Map<string, Participant>();

  translate(message: unknown, arrivalMs: number): RecallOutput[] {
    if (!isRecord(message) || typeof message.event !== 'string') return [];
    const outer = isRecord(message.data) ? message.data : null;
    const data = outer && isRecord(outer.data) ? outer.data : null;
    if (!data || !isRecord(data.participant)) return [];
    const p = this.participant(data.participant);
    if (!p) return [];
    const event = message.event;

    if (event === 'transcript.partial_data' || event === 'transcript.data') {
      const words = parseWords(data.words);
      if (!words) return [];
      return this.transcript(p, words, event === 'transcript.data', arrivalMs);
    }

    const stamp = isRecord(data.timestamp) ? data.timestamp : null;
    const relative = num(stamp?.relative);
    if (relative !== null && typeof stamp?.absolute === 'string' && !this.anchorExact) {
      const absolute = Date.parse(stamp.absolute);
      if (!Number.isNaN(absolute)) {
        this.anchorMs = absolute - relative * 1000;
        this.anchorExact = true;
      }
    }
    const at = relative === null ? arrivalMs : this.toHostMs(relative, arrivalMs);
    const speaker = p.speaker;
    switch (event) {
      case 'participant_events.speech_on':
      case 'participant_events.speech_off': {
        p.speaking = event === 'participant_events.speech_on';
        return [{ type: 'event', event: { kind: 'speech', speaker, on: p.speaking, at } }];
      }
      case 'participant_events.join':
        return [{ type: 'presence', speaker, joined: true, at }];
      case 'participant_events.leave': {
        const out: RecallOutput[] = [];
        // A participant who leaves mid-turn gets no speech_off of their own.
        if (p.speaking) out.push({ type: 'event', event: { kind: 'speech', speaker, on: false, at } });
        p.speaking = false;
        out.push({ type: 'presence', speaker, joined: false, at });
        return out;
      }
      case 'participant_events.chat_message': {
        const text = isRecord(data.data) && typeof data.data.text === 'string' ? data.data.text.trim() : '';
        return text ? [{ type: 'event', event: { kind: 'chat', speaker, text, at } }] : [];
      }
      default:
        return [];
    }
  }

  private participant(raw: Record<string, unknown>): Participant | null {
    const id = typeof raw.id === 'number' || (typeof raw.id === 'string' && raw.id) ? String(raw.id) : null;
    if (id === null) return null;
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `Participant ${id}`;
    let p = this.participants.get(id);
    if (!p) {
      p = { speaker: { id, name }, seq: 0, open: null, lastFinalEnd: -Infinity, speaking: false };
      this.participants.set(id, p);
    } else if (p.speaker.name !== name) {
      p.speaker = { id, name };
    }
    return p;
  }

  private transcript(p: Participant, words: RecallWord[], final: boolean, arrivalMs: number): RecallOutput[] {
    const last = words.at(-1);
    const endRel = last ? (last.end ?? last.start) : null;
    if (endRel !== null && this.anchorMs === null) this.anchorMs = arrivalMs - endRel * 1000;
    const at = endRel === null ? arrivalMs : this.toHostMs(endRel, arrivalMs);
    const text = wordsText(words);
    const speaker = p.speaker;

    if (!final) {
      if (!text) return [];
      if (p.open === null) {
        if (words[0].start < p.lastFinalEnd) return [];
        p.open = `${speaker.id}-${p.seq}`;
      }
      return [
        { type: 'event', event: { kind: 'utterance', speaker, uttId: p.open, text, final: false, at } },
        { type: 'words', speaker },
      ];
    }

    // An empty final still closes partials in flight: the provider dropped what it had heard.
    if (!text && p.open === null) return [];
    const uttId = p.open ?? `${speaker.id}-${p.seq}`;
    p.open = null;
    p.seq++;
    if (endRel !== null) p.lastFinalEnd = Math.max(p.lastFinalEnd, endRel);
    return [{ type: 'event', event: { kind: 'utterance', speaker, uttId, text, final: true, at } }];
  }

  private toHostMs(relative: number, arrivalMs: number): number {
    return this.anchorMs === null ? arrivalMs : Math.round(this.anchorMs + relative * 1000);
  }
}

export interface RecallIngressOptions {
  onEvent(callId: string, event: CallEvent): void;
  /** A participant's partial carried words (the bot itself is not transcribed: `include_bot_in_recording.audio` is off). */
  onWords?(callId: string, speaker: Speaker): void;
  /** A participant joined or left; not a `CallEvent`, for the participant list. */
  onPresence?(callId: string, speaker: Speaker, joined: boolean, at: number): void;
  /** Every parsed message as Recall sent it, for the phase 2 raw log. */
  onRaw?(callId: string, message: unknown): void;
  now?: () => number;
  maxFrameBytes?: number;
  pingIntervalMs?: number;
}

export interface RecallIngress {
  /** A call's endpoint, before the bot create: events can race the create's answer. */
  register(callId: string): RecallCallRegistration;
  /** Closes the call's connection and forgets its token. */
  unregister(callId: string): void;
  /** For `registerUpgradeHandler(RECALL_UPGRADE_SEGMENT, ...)`. */
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
}

interface CallEntry {
  callId: string;
  tokenDigest: Buffer;
  translator: RecallTranslator;
  sockets: Set<WebSocket>;
  messages: number;
}

const digest = (token: string) => createHash('sha256').update(token).digest();

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createRecallIngress(options: RecallIngressOptions): RecallIngress {
  const now = options.now ?? Date.now;
  const pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const calls = new Map<string, CallEntry>();
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
  });

  function deliver(entry: CallEntry, data: RawData, isBinary: boolean): void {
    if (isBinary) return;
    let message: unknown;
    try {
      message = JSON.parse(String(data));
    } catch {
      log.warn('meet-jev recall: a frame that is not JSON', { callId: entry.callId });
      return;
    }
    if (entry.messages++ === 0) log.info('meet-jev recall: events flowing', { callId: entry.callId });
    try {
      options.onRaw?.(entry.callId, message);
      for (const out of entry.translator.translate(message, now())) {
        if (out.type === 'event') options.onEvent(entry.callId, out.event);
        else if (out.type === 'words') options.onWords?.(entry.callId, out.speaker);
        else options.onPresence?.(entry.callId, out.speaker, out.joined, out.at);
      }
    } catch (err) {
      log.error('meet-jev recall: an event consumer threw', { callId: entry.callId, err });
    }
  }

  function attach(entry: CallEntry, ws: WebSocket): void {
    // Recall reconnects on a drop (https://docs.recall.ai/docs/real-time-websocket-endpoints#retry-policy):
    // the newest connection is the live one.
    for (const old of entry.sockets) old.close(1000, 'replaced');
    entry.sockets.add(ws);
    log.info('meet-jev recall: websocket connected', { callId: entry.callId });
    let alive = true;
    const pinger = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, pingIntervalMs);
    pinger.unref();
    ws.on('pong', () => {
      alive = true;
    });
    ws.on('message', (data, isBinary) => {
      alive = true;
      deliver(entry, data, isBinary);
    });
    // Includes an oversize frame, which ws closes with 1009.
    ws.on('error', (err) => log.warn('meet-jev recall: websocket error', { callId: entry.callId, err }));
    ws.on('close', (code) => {
      clearInterval(pinger);
      entry.sockets.delete(ws);
      log.info('meet-jev recall: websocket closed', { callId: entry.callId, code });
    });
  }

  function unregister(callId: string): void {
    const entry = calls.get(callId);
    if (!entry) return;
    calls.delete(callId);
    for (const ws of entry.sockets) ws.close(1000, 'call ended');
  }

  return {
    register(callId) {
      if (!CALL_ID_RE.test(callId)) throw new Error(`meet-jev recall: unusable call id ${callId}`);
      if (calls.has(callId)) throw new Error(`meet-jev recall: call ${callId} is registered already`);
      const token = randomBytes(32).toString('base64url');
      calls.set(callId, {
        callId,
        tokenDigest: digest(token),
        translator: new RecallTranslator(),
        sockets: new Set(),
        messages: 0,
      });
      return { path: `${PATH_PREFIX}${callId}/`, token };
    },

    unregister,

    handleUpgrade(req, socket, head) {
      const raw = req.url ?? '/';
      let url: URL;
      try {
        url = new URL(raw, 'http://localhost');
      } catch {
        return refuse(socket, 400, 'Bad Request');
      }
      // Dot segments would route on a path the checks below never saw.
      if (url.pathname !== raw.split('?')[0]) return refuse(socket, 400, 'Bad Request');
      const match = PATH_RE.exec(url.pathname);
      if (!match) return refuse(socket, 404, 'Not Found');
      const entry = calls.get(match[1]);
      const token = url.searchParams.get('token') ?? '';
      if (!entry || !timingSafeEqual(digest(token), entry.tokenDigest)) {
        log.warn('meet-jev recall: refused a websocket', { callId: match[1], known: Boolean(entry) });
        return refuse(socket, 401, 'Unauthorized');
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (calls.get(entry.callId) !== entry) return ws.close(1000, 'call ended');
        attach(entry, ws);
      });
    },

    close() {
      for (const callId of [...calls.keys()]) unregister(callId);
      wss.close();
    },
  };
}
