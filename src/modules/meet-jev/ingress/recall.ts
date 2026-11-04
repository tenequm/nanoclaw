/**
 * `/meet <link> jev` ingress: the Recall bot's real-time websocket endpoint
 * (https://docs.recall.ai/docs/real-time-websocket-endpoints), one connection per call at
 * `/voice/recall/<callId>/?token=<per-call random>`. Recall sends each participant's own audio
 * (`audio_separate_raw.data`, base64 16 kHz mono S16LE, per
 * https://docs.recall.ai/docs/how-to-get-separate-audio-per-participant-realtime) and participant
 * events (https://docs.recall.ai/docs/real-time-event-payloads); the host transcribes the audio
 * itself (recall-audio.ts). Recall's `speech_on/off` are only logged: the boundary is the host's VAD.
 *
 * Times: `relative` is seconds since the recording began
 * (https://docs.recall.ai/docs/speaker-timeline#timestamps), and every frame and event also carries
 * `absolute`, which pins the recording start in host ms; a message without it is placed on arrival.
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
/** An audio frame is tens of ms of 16 kHz PCM in base64, a few KB; events are smaller. */
const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
/** Recall's FAQ: ping every 30 s so no proxy on the way drops the connection as idle. */
const DEFAULT_PING_INTERVAL_MS = 30_000;
const CALL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const RECALL_AUDIO_EVENT = 'audio_separate_raw.data';

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
  /** A participant's audio: 16 kHz mono samples, `at` the host ms of its first sample. */
  | { type: 'audio'; speaker: Speaker; pcm: Int16Array; at: number }
  /** A typed chat line, as a `CallEvent`. */
  | { type: 'event'; event: CallEvent }
  | { type: 'presence'; speaker: Speaker; joined: boolean; at: number }
  /** The bot's own participant, the first time it shows: none of its frames or events reach the call. */
  | { type: 'self'; speaker: Speaker };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The message's inner `data` and its participant (inside it per the docs; beside it is taken too). */
function payloadOf(message: unknown): { event: string; data: Record<string, unknown>; participant: unknown } | null {
  if (!isRecord(message) || typeof message.event !== 'string') return null;
  const outer = isRecord(message.data) ? message.data : null;
  const data = outer && isRecord(outer.data) ? outer.data : null;
  if (!data) return null;
  return { event: message.event, data, participant: data.participant ?? outer?.participant };
}

/** A frame's base64 S16LE buffer as samples; an odd trailing byte is dropped. */
export function decodePcm(base64: string): Int16Array {
  const bytes = Buffer.from(base64, 'base64');
  const out = new Int16Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = bytes.readInt16LE(i * 2);
  return out;
}

/**
 * A Recall message for an info log line, without what was said or heard: the event, the participant,
 * the timestamps, a frame's size.
 */
export function recallRawSummary(message: unknown): Record<string, unknown> {
  const payload = payloadOf(message);
  if (!payload) return { event: isRecord(message) && typeof message.event === 'string' ? message.event : null };
  const { event, data } = payload;
  const p = isRecord(payload.participant) ? payload.participant : null;
  const stamp = isRecord(data.timestamp) ? data.timestamp : null;
  return {
    event,
    ...(p ? { participant: { id: p.id, name: p.name, is_host: p.is_host } } : {}),
    ...(stamp ? { relative: stamp.relative, absolute: stamp.absolute } : {}),
    ...(typeof data.buffer === 'string' ? { bytes: Buffer.byteLength(data.buffer, 'base64') } : {}),
    ...(isRecord(data.data) && typeof data.data.text === 'string' ? { chars: data.data.text.length } : {}),
  };
}

/**
 * Per call, pure: Recall messages in, outputs out. Holds the participants and the recording's start;
 * the websocket part only feeds it.
 */
export class RecallTranslator {
  private anchorMs: number | null = null;
  private readonly selfIds = new Set<string>();
  private readonly selfName: string | null;

  /**
   * `botName`: the bot's own `bot_name`. Recall flags no participant as the bot, and the bot is one
   * (https://docs.recall.ai/docs/bot-overview), its output media audio included: one with this name is
   * taken for it and left out.
   */
  constructor(botName?: string) {
    this.selfName = botName?.trim() ? botName.trim().toLowerCase() : null;
  }

  translate(message: unknown, arrivalMs: number): RecallOutput[] {
    const payload = payloadOf(message);
    if (!payload || !isRecord(payload.participant)) return [];
    const speaker = this.speaker(payload.participant);
    if (!speaker) return [];
    if (this.selfIds.has(speaker.id)) return [];
    if (this.selfName !== null && speaker.name.toLowerCase() === this.selfName) {
      this.selfIds.add(speaker.id);
      return [{ type: 'self', speaker }];
    }
    const { event, data } = payload;
    const stamp = isRecord(data.timestamp) ? data.timestamp : null;
    const relative = num(stamp?.relative);
    if (relative !== null && this.anchorMs === null && typeof stamp?.absolute === 'string') {
      const absolute = Date.parse(stamp.absolute);
      if (!Number.isNaN(absolute)) this.anchorMs = absolute - relative * 1000;
    }
    const at = relative === null || this.anchorMs === null ? arrivalMs : Math.round(this.anchorMs + relative * 1000);
    switch (event) {
      case RECALL_AUDIO_EVENT: {
        // An empty buffer (a silent, unmuted participant) still goes out: its arrival is cadence.
        if (typeof data.buffer !== 'string') return [];
        return [{ type: 'audio', speaker, pcm: decodePcm(data.buffer), at }];
      }
      case 'participant_events.join':
        return [{ type: 'presence', speaker, joined: true, at }];
      case 'participant_events.leave':
        return [{ type: 'presence', speaker, joined: false, at }];
      case 'participant_events.chat_message': {
        const text = isRecord(data.data) && typeof data.data.text === 'string' ? data.data.text.trim() : '';
        return text ? [{ type: 'event', event: { kind: 'chat', speaker, text, at } }] : [];
      }
      default:
        return [];
    }
  }

  private speaker(raw: Record<string, unknown>): Speaker | null {
    const id = typeof raw.id === 'number' || (typeof raw.id === 'string' && raw.id) ? String(raw.id) : null;
    if (id === null) return null;
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `Participant ${id}`;
    return { id, name };
  }
}

export interface RecallIngressOptions {
  /** A participant's audio frame (never the bot's). */
  onAudio(callId: string, speaker: Speaker, pcm: Int16Array, at: number): void;
  /** A chat line. */
  onEvent(callId: string, event: CallEvent): void;
  /** A participant joined or left; not a `CallEvent`, for the participant list. */
  onPresence?(callId: string, speaker: Speaker, joined: boolean, at: number): void;
  /** Every parsed message as Recall sent it, for the phase 2 raw log; `seq` counts the call's messages from 1. */
  onRaw?(callId: string, message: unknown, seq: number): void;
  now?: () => number;
  maxFrameBytes?: number;
  pingIntervalMs?: number;
}

export interface RecallIngress {
  /**
   * A call's endpoint, before the bot create: events can race the create's answer. `botName`: the
   * bot's name in the meeting, whose participant is left out (RecallTranslator).
   */
  register(callId: string, options?: { botName?: string }): RecallCallRegistration;
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
    const seq = ++entry.messages;
    if (seq === 1) log.info('meet-jev recall: events flowing', { callId: entry.callId });
    try {
      options.onRaw?.(entry.callId, message, seq);
      for (const out of entry.translator.translate(message, now())) {
        if (out.type === 'audio') options.onAudio(entry.callId, out.speaker, out.pcm, out.at);
        else if (out.type === 'event') options.onEvent(entry.callId, out.event);
        else if (out.type === 'self')
          log.info("meet-jev recall: the bot's own participant; its events are left out", {
            callId: entry.callId,
            participantId: out.speaker.id,
          });
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
    register(callId, { botName } = {}) {
      if (!CALL_ID_RE.test(callId)) throw new Error(`meet-jev recall: unusable call id ${callId}`);
      if (calls.has(callId)) throw new Error(`meet-jev recall: call ${callId} is registered already`);
      const token = randomBytes(32).toString('base64url');
      calls.set(callId, {
        callId,
        tokenDigest: digest(token),
        translator: new RecallTranslator(botName),
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
