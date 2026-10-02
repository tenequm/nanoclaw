/**
 * LiveKit + Gemini Live as a third voice engine for the voice channel.
 *
 * The caller's browser joins a LiveKit room over WebRTC; a LiveKit Agents
 * worker (`src/voice-livekit-worker.ts`, its own process: agents-js runs every
 * job in a forked child process) joins the same room and runs Gemini Live
 * through the google plugin's RealtimeModel. The host owns the call: it
 * admits it against the shared limits, creates a unique room, dispatches the
 * worker to it with the job metadata, mints the caller's token, charges the
 * daily minutes, rechecks access every few seconds and ends the call by
 * deleting the room, which disconnects caller and worker alike.
 *
 * The worker reaches the host over HTTP on the webhook server
 * (`/webhook/voice/livekit/agent/*`), authenticated by a per-call secret that
 * travels only in the dispatch metadata (never in the caller's token):
 *  - `GET  agent/events`  an NDJSON stream of what to speak (agent replies,
 *    proactive messages, holding notes) and when to end, with pings;
 *  - `POST agent/joined`  the caller is in the room; the clock starts here;
 *  - `POST agent/ask`     one ask_agent call, fed to the agent as an inbound
 *    message whose id (`livekit:<callId>:<consultId>`) routes the reply back;
 *  - `POST agent/ended`   the worker's session is over.
 */
import { createRequire } from 'node:module';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';

import { AccessToken, AgentDispatchClient, RoomServiceClient, TrackSource } from 'livekit-server-sdk';

import type { InboundMessage } from './adapter.js';
import { DEFAULT_GEMINI_LIVE_MODEL, DEFAULT_GEMINI_LIVE_VOICE, geminiToolScheduling } from './gemini-live.js';
import { geminiInstructions, type ResolveLineOptions, type VoiceLine } from './gpt-live-prompt.js';
import { log } from '../log.js';

export const DEFAULT_LIVEKIT_AGENT_NAME = 'nanoclaw-voice';
/** ask_agent requests longer than this are refused; a spoken request is a few sentences. */
export const MAX_ASK_REQUEST_BYTES = 4096;
/** Open ask_agent calls per call; the model is told to wait for answers beyond this. */
export const MAX_OPEN_CONSULTS = 3;
const PING_INTERVAL_MS = 15_000;
const MAX_QUEUED_EVENTS = 50;
const MAX_AGENT_BODY_BYTES = 8 * 1024;
const CALLER_TOKEN_TTL_SECONDS = 120;

const ASK_AGENT_NOTE =
  'An ask_agent answer arrives as its result, or later as a separate instruction starting with ' +
  '"Answer from the backend"; more than one can arrive for one request. Until an answer arrives, do not guess it.';

/** What the worker receives as job metadata; the secret authenticates its calls to the host. */
export interface LiveKitJobMetadata {
  v: 1;
  callId: string;
  lineId: string;
  agentName: string;
  callerName: string;
  callerIdentity: string;
  instructions: string;
  model: string;
  voice: string;
  /** Function response scheduling; null for models that close the session on it. */
  scheduling: 'WHEN_IDLE' | null;
  hostUrl: string;
  secret: string;
  /** Upper bound the worker enforces on itself if the host never ends the call. */
  maxDurationMs: number;
  /** The host answers an unanswered ask_agent with the timeout line after this long. */
  delegationTimeoutMs: number;
  joinTimeoutMs: number;
}

/** One line of the host-to-worker event stream. */
export type LiveKitHostEvent =
  | { type: 'reply'; text: string; timedOut?: boolean }
  | { type: 'say'; text: string }
  | { type: 'thinking'; status?: string }
  | { type: 'end'; reason: string }
  | { type: 'ping' };

const CONSULT_ID_PREFIX = 'livekit:';

export function liveKitConsultMessageId(callId: string, consultId: string): string {
  return `${CONSULT_ID_PREFIX}${callId}:${consultId}`;
}

export function parseLiveKitConsultMessageId(id: string): { callId: string; consultId: string } | null {
  if (!id.startsWith(CONSULT_ID_PREFIX)) return null;
  const rest = id.slice(CONSULT_ID_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { callId: rest.slice(0, sep), consultId: rest.slice(sep + 1) };
}

/** The slices of the LiveKit server API the host uses; injectable for tests. */
export interface LiveKitServerApi {
  createRoom(options: {
    name: string;
    emptyTimeout: number;
    departureTimeout: number;
    maxParticipants: number;
  }): Promise<unknown>;
  deleteRoom(room: string): Promise<void>;
  createDispatch(room: string, agentName: string, options: { metadata: string }): Promise<unknown>;
}

export interface LiveKitVoiceConfig {
  /** Signaling URL the caller's browser connects to (LIVEKIT_URL). */
  url: string;
  /** Server-side URL for the host's API calls (LIVEKIT_WORKER_URL); defaults to `url`. */
  serverUrl?: string;
  apiKey: string;
  apiSecret: string;
  /** Dispatch name the worker registers under. */
  agentName?: string;
  /** Base URL the worker reaches this host's webhook server at. */
  hostUrl: string;
  model?: string;
  voice?: string;
  /** How long the caller has to join the room after the token is minted. */
  joinTimeoutMs?: number;
  /** Test seam; defaults to the livekit-server-sdk clients. */
  api?: LiveKitServerApi;
}

/** What the voice adapter shares with this engine: limits, access, routing. */
export interface LiveKitHost {
  resolveLine(platformId: string, options?: ResolveLineOptions): Promise<VoiceLine | null>;
  sameCallerAndAgent(a: VoiceLine, b: VoiceLine): boolean;
  admitStart(platformId: string, t: number): { body: string; retryAfter: string } | null;
  /** Daily call time left on the line, all engines counted. */
  remainingTodayMs(platformId: string, t: number): number;
  chargeUsage(call: { platformId: string; startedAt: number }): void;
  /** Newest wins across engines: end any other engine's call on the line. */
  endOtherCalls(platformId: string, reason: string): void;
  onInbound(platformId: string, message: InboundMessage): Promise<void>;
  isRunning(): boolean;
  now(): number;
  maxCallDurationMs: number;
  delegationTimeoutMs: number;
  accessCheckIntervalMs: number;
  thinkIntervalMs: number;
  delegationTimeoutLine: string;
}

interface Consult {
  timer: ReturnType<typeof setTimeout>;
}

interface LiveKitCall {
  callId: string;
  platformId: string;
  line: VoiceLine;
  roomName: string;
  secret: string;
  callerIdentity: string;
  state: 'connecting' | 'live';
  /** Set when the worker reports the caller in the room; the daily budget is charged from here. */
  startedAt?: number;
  ended: boolean;
  consults: Map<string, Consult>;
  joinTimer?: ReturnType<typeof setTimeout>;
  expires?: ReturnType<typeof setTimeout>;
  accessTimer?: ReturnType<typeof setInterval>;
  pingTimer?: ReturnType<typeof setInterval>;
  stream?: http.ServerResponse;
  queue: LiveKitHostEvent[];
  lastThinkAt: number;
  sent: number;
  cleanup?: Promise<void>;
}

export interface LiveKitVoice {
  /** Routes under /webhook/voice/livekit. */
  handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: string,
    url: URL,
    tokens: ReadonlySet<string>,
    lineIdForToken: (token: string) => string,
  ): Promise<void>;
  /**
   * Speak an agent message on the line's LiveKit call. Returns null when the
   * message is not this engine's (no call here and no livekit reply id).
   */
  deliver(platformId: string, inReplyTo: string | undefined, text: string): Promise<{ id: string | undefined } | null>;
  setTyping(platformId: string, status?: string): Promise<void>;
  /** The running call on a line, for the shared daily budget. */
  activeCall(platformId: string): { platformId: string; startedAt: number } | undefined;
  endLine(platformId: string, reason: string): void;
  teardown(): Promise<void>;
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function defaultApi(config: LiveKitVoiceConfig): LiveKitServerApi {
  const host = config.serverUrl || config.url;
  const rooms = new RoomServiceClient(host, config.apiKey, config.apiSecret, { requestTimeout: 10 });
  const dispatch = new AgentDispatchClient(host, config.apiKey, config.apiSecret, { requestTimeout: 10 });
  return {
    createRoom: (options) => rooms.createRoom(options),
    deleteRoom: (room) => rooms.deleteRoom(room),
    createDispatch: (room, agentName, options) => dispatch.createDispatch(room, agentName, options),
  };
}

const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const isNotFound = (err: unknown): boolean => {
  const e = err as { status?: unknown; code?: unknown } | null;
  return e?.status === 404 || e?.code === 'not_found';
};

export function createLiveKitVoice(config: LiveKitVoiceConfig, host: LiveKitHost): LiveKitVoice {
  const api = config.api ?? defaultApi(config);
  const agentName = config.agentName || DEFAULT_LIVEKIT_AGENT_NAME;
  const model = config.model || DEFAULT_GEMINI_LIVE_MODEL;
  const voice = config.voice || DEFAULT_GEMINI_LIVE_VOICE;
  const joinTimeoutMs = config.joinTimeoutMs ?? 60_000;
  const calls = new Map<string, LiveKitCall>();
  const cleanups = new Set<Promise<void>>();
  let clientJs: string | undefined;
  let page: string | undefined;

  const reply = (res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };

  const findCall = (callId: unknown): LiveKitCall | undefined =>
    typeof callId === 'string' ? [...calls.values()].find((c) => c.callId === callId) : undefined;

  const push = (call: LiveKitCall, event: LiveKitHostEvent): void => {
    if (call.stream && !call.stream.writableEnded) {
      call.stream.write(`${JSON.stringify(event)}\n`);
      return;
    }
    call.queue.push(event);
    if (call.queue.length > MAX_QUEUED_EVENTS) call.queue.shift();
  };

  /** The room going away is what ends the call for caller and worker; retried, a missing room counts as gone. */
  const deleteRoom = async (call: LiveKitCall): Promise<void> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await api.deleteRoom(call.roomName);
        return;
      } catch (err) {
        if (isNotFound(err)) return;
        log.warn('livekit-voice: room delete failed', { callId: call.callId, attempt, err });
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)).unref());
      }
    }
    log.error('livekit-voice: room was not deleted; the worker stops on its own when the host link closes', {
      callId: call.callId,
      room: call.roomName,
    });
  };

  const endCall = (call: LiveKitCall, reason: string): void => {
    if (call.ended) return;
    call.ended = true;
    clearTimeout(call.joinTimer);
    clearTimeout(call.expires);
    clearInterval(call.accessTimer);
    clearInterval(call.pingTimer);
    for (const consult of call.consults.values()) clearTimeout(consult.timer);
    call.consults.clear();
    if (call.startedAt !== undefined) host.chargeUsage({ platformId: call.platformId, startedAt: call.startedAt });
    if (calls.get(call.platformId) === call) calls.delete(call.platformId);
    const stream = call.stream;
    call.stream = undefined;
    if (stream && !stream.writableEnded) {
      stream.write(`${JSON.stringify({ type: 'end', reason } satisfies LiveKitHostEvent)}\n`);
      stream.end();
    }
    const cleanup = deleteRoom(call).finally(() => cleanups.delete(cleanup));
    call.cleanup = cleanup;
    cleanups.add(cleanup);
    log.info('livekit-voice: call ended', { platformId: call.platformId, callId: call.callId, reason });
  };

  const checkAccess = async (call: LiveKitCall): Promise<boolean> => {
    if (call.ended) return false;
    try {
      const current = await host.resolveLine(call.platformId);
      if (current && host.sameCallerAndAgent(call.line, current) && calls.get(call.platformId) === call && !call.ended)
        return true;
    } catch (err) {
      log.warn('livekit-voice: call access check failed', { platformId: call.platformId, err });
    }
    endCall(call, 'caller access revoked or line changed');
    return false;
  };

  const readJson = async (req: http.IncomingMessage): Promise<Record<string, unknown> | null> => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > MAX_AGENT_BODY_BYTES) return null;
      chunks.push(chunk as Buffer);
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  /** Admit the call, open its room, dispatch the worker and hand the caller a token for that room only. */
  const startCall = async (res: http.ServerResponse, platformId: string): Promise<void> => {
    const line = await host.resolveLine(platformId, { persona: true });
    if (!line) return reply(res, 403, 'Caller access denied or voice line is not set up');
    const t = host.now();
    const refusal = host.admitStart(platformId, t);
    if (refusal) return reply(res, 429, refusal.body, { 'Retry-After': refusal.retryAfter });
    // Newest wins on the line, whatever engine holds it; the replaced call is charged first.
    const previous = calls.get(platformId);
    if (previous) endCall(previous, 'replaced by a new call');
    host.endOtherCalls(platformId, 'replaced by a new call');
    const remainingMs = host.remainingTodayMs(platformId, host.now());
    if (remainingMs <= 0) return reply(res, 429, 'This voice line has used its call minutes for today.');
    const callId = randomUUID();
    const call: LiveKitCall = {
      callId,
      platformId,
      line,
      roomName: `voice-${platformId.replace(/^voice:/, '')}-${randomBytes(6).toString('hex')}`,
      secret: randomBytes(32).toString('base64url'),
      callerIdentity: `caller-${callId.slice(0, 8)}`,
      state: 'connecting',
      ended: false,
      consults: new Map(),
      queue: [],
      lastThinkAt: 0,
      sent: 0,
    };
    calls.set(platformId, call);
    call.joinTimer = setTimeout(() => endCall(call, 'caller never joined'), joinTimeoutMs);
    call.joinTimer.unref();
    call.accessTimer = setInterval(() => void checkAccess(call), host.accessCheckIntervalMs);
    call.accessTimer.unref();
    const metadata: LiveKitJobMetadata = {
      v: 1,
      callId,
      lineId: platformId,
      agentName: line.agent.name,
      callerName: line.caller.name,
      callerIdentity: call.callerIdentity,
      instructions: `${geminiInstructions(line.agent, line.caller)} ${ASK_AGENT_NOTE}`,
      model,
      voice,
      scheduling: geminiToolScheduling(model),
      hostUrl: config.hostUrl.replace(/\/+$/, ''),
      secret: call.secret,
      maxDurationMs: Math.min(host.maxCallDurationMs, remainingMs),
      delegationTimeoutMs: host.delegationTimeoutMs,
      joinTimeoutMs,
    };
    let token: string;
    try {
      await api.createRoom({ name: call.roomName, emptyTimeout: 60, departureTimeout: 10, maxParticipants: 2 });
      await api.createDispatch(call.roomName, agentName, { metadata: JSON.stringify(metadata) });
      const at = new AccessToken(config.apiKey, config.apiSecret, {
        identity: call.callerIdentity,
        name: line.caller.name,
        ttl: CALLER_TOKEN_TTL_SECONDS,
      });
      at.addGrant({
        roomJoin: true,
        room: call.roomName,
        canPublish: true,
        canPublishSources: [TrackSource.MICROPHONE],
        canSubscribe: true,
        canPublishData: false,
        canUpdateOwnMetadata: false,
      });
      token = await at.toJwt();
    } catch (err) {
      log.warn('livekit-voice: room setup failed', { platformId, callId, err });
      endCall(call, 'room setup failed');
      return reply(res, 502, 'livekit-voice: could not open the call room');
    }
    if (call.ended || !host.isRunning()) {
      endCall(call, 'replaced while connecting');
      return reply(res, 409, 'This call attempt is no longer active');
    }
    log.info('livekit-voice: call started', { platformId, callId, room: call.roomName, model, agent: line.agent.name });
    reply(res, 200, JSON.stringify({ url: config.url, token, callId, agent: line.agent.name }), JSON_HEADERS);
  };

  /** The worker saw the caller join: start the clock and the duration / budget cap. */
  const onJoined = (res: http.ServerResponse, call: LiveKitCall): void => {
    if (call.state === 'live') return reply(res, 200, JSON.stringify({ ok: true }), JSON_HEADERS);
    const t = host.now();
    const remainingMs = host.remainingTodayMs(call.platformId, t);
    if (remainingMs <= 0) {
      endCall(call, 'daily minute budget');
      return reply(res, 409, 'This voice line has used its call minutes for today');
    }
    call.state = 'live';
    call.startedAt = t;
    clearTimeout(call.joinTimer);
    const budgetCaps = remainingMs < host.maxCallDurationMs;
    call.expires = setTimeout(
      () => endCall(call, budgetCaps ? 'daily minute budget' : 'duration limit'),
      Math.max(1, budgetCaps ? remainingMs : host.maxCallDurationMs),
    );
    call.expires.unref();
    log.info('livekit-voice: caller joined', { platformId: call.platformId, callId: call.callId });
    reply(res, 200, JSON.stringify({ ok: true }), JSON_HEADERS);
  };

  const onEvents = (res: http.ServerResponse, call: LiveKitCall): void => {
    const previous = call.stream;
    if (previous && !previous.writableEnded) previous.end();
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    res.flushHeaders();
    call.stream = res;
    for (const event of call.queue.splice(0)) res.write(`${JSON.stringify(event)}\n`);
    clearInterval(call.pingTimer);
    call.pingTimer = setInterval(() => push(call, { type: 'ping' }), PING_INTERVAL_MS);
    call.pingTimer.unref();
    res.on('close', () => {
      // Replies can no longer reach the caller, so the call is over.
      if (call.stream === res && !call.ended) endCall(call, 'worker link closed');
    });
  };

  const onAsk = async (res: http.ServerResponse, call: LiveKitCall, body: Record<string, unknown>): Promise<void> => {
    if (call.state !== 'live') return reply(res, 409, 'The caller is not in the call');
    const request = typeof body.request === 'string' ? body.request.trim() : '';
    if (!request) return reply(res, 400, 'request is required');
    if (Buffer.byteLength(request) > MAX_ASK_REQUEST_BYTES) return reply(res, 413, 'request is too long');
    if (call.consults.size >= MAX_OPEN_CONSULTS)
      return reply(res, 429, 'Too many requests are already open on this call');
    if (!(await checkAccess(call))) return reply(res, 403, 'Caller access denied');
    const consultId = randomBytes(6).toString('hex');
    const timer = setTimeout(() => {
      if (!call.consults.delete(consultId) || call.ended) return;
      log.warn('livekit-voice: ask_agent got no reply in time', { callId: call.callId, consultId });
      push(call, { type: 'reply', text: host.delegationTimeoutLine, timedOut: true });
    }, host.delegationTimeoutMs);
    timer.unref();
    call.consults.set(consultId, { timer });
    // The filler the model speaks for the tool result covers the first stretch of the wait.
    call.lastThinkAt = host.now();
    const message: InboundMessage = {
      id: liveKitConsultMessageId(call.callId, consultId),
      kind: 'chat',
      content: {
        text: request,
        sender: call.line.caller.name,
        senderId: call.line.caller.id,
        livekit: { callId: call.callId, consultId },
      },
      timestamp: new Date().toISOString(),
      isMention: true,
      isGroup: false,
    };
    try {
      await host.onInbound(call.platformId, message);
    } catch (err) {
      clearTimeout(timer);
      call.consults.delete(consultId);
      log.error('livekit-voice: onInbound threw', { platformId: call.platformId, err });
      return reply(res, 500, 'Could not reach the agent');
    }
    reply(res, 202, JSON.stringify({ id: consultId }), JSON_HEADERS);
  };

  /** /webhook/voice/livekit/agent/*: the worker's side, authenticated by the per-call secret. */
  const handleAgent = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: string,
    url: URL,
  ): Promise<void> => {
    const auth = req.headers.authorization ?? '';
    const secret = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (route === 'livekit/agent/events') {
      if (req.method !== 'GET') return reply(res, 405, 'GET only');
      const call = findCall(url.searchParams.get('call'));
      if (!call || call.ended || !secret || !sameSecret(secret, call.secret)) return reply(res, 404, 'No such call');
      return onEvents(res, call);
    }
    if (req.method !== 'POST') return reply(res, 405, 'POST only');
    const body = await readJson(req);
    if (!body) return reply(res, 400, 'Body must be a small JSON object');
    const call = findCall(body.callId);
    // Unknown, ended and unauthenticated look alike to the caller of these routes.
    if (!call || call.ended || !secret || !sameSecret(secret, call.secret)) return reply(res, 409, 'No such call');
    if (route === 'livekit/agent/joined') return onJoined(res, call);
    if (route === 'livekit/agent/ask') return onAsk(res, call, body);
    if (route === 'livekit/agent/ended') {
      endCall(call, typeof body.reason === 'string' ? `worker: ${body.reason.slice(0, 80)}` : 'worker ended');
      return reply(res, 204, '');
    }
    reply(res, 404, 'Not found');
  };

  const pageHeaders = (): Record<string, string> => {
    const lk = new URL(config.url);
    const https = `${lk.protocol === 'ws:' ? 'http:' : 'https:'}//${lk.host}`;
    return {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      // One document plus the same-origin client bundle; signaling to the LiveKit server. WebRTC
      // media is not governed by connect-src.
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; " +
        `connect-src 'self' ${lk.protocol}//${lk.host} ${https}; media-src 'self' blob: mediastream:; ` +
        "worker-src 'self' blob:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    };
  };

  return {
    async handleHttp(req, res, route, url, tokens, lineIdForToken) {
      if (route.startsWith('livekit/agent/')) return handleAgent(req, res, route, url);
      if (route === 'livekit') {
        if (req.method !== 'GET') return reply(res, 405, 'GET only');
        page ??= liveKitCallPageHtml();
        res.writeHead(200, pageHeaders());
        res.end(page);
        return;
      }
      // Also matched from a page opened with a trailing slash, where the relative src gains a segment.
      if (route === 'livekit/client.js' || route === 'livekit/livekit/client.js') {
        if (req.method !== 'GET') return reply(res, 405, 'GET only');
        // The UMD bundle of livekit-client, served same-origin so the page needs no CDN.
        clientJs ??= fs.readFileSync(createRequire(import.meta.url).resolve('livekit-client'), 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(clientJs);
        return;
      }
      if (req.method !== 'POST') return reply(res, 405, 'POST only');
      const token = url.searchParams.get('t') ?? '';
      if (!tokens.has(token)) return reply(res, 403, 'Unknown call link');
      const platformId = lineIdForToken(token);
      if (route === 'livekit/token') return startCall(res, platformId);
      if (route === 'livekit/end') {
        const body = await readJson(req);
        const call = calls.get(platformId);
        if (call && body && call.callId === body.callId) {
          endCall(call, 'hangup');
          await call.cleanup;
        }
        return reply(res, 204, '');
      }
      reply(res, 404, 'Not found');
    },

    async deliver(platformId, inReplyTo, text) {
      const target = inReplyTo ? parseLiveKitConsultMessageId(inReplyTo) : null;
      const call = calls.get(platformId);
      if (target && (!call || call.callId !== target.callId)) {
        // An answer for a call that is over must not be spoken into a later one; retrying cannot help.
        log.info('livekit-voice: dropping a reply for an ended call', { platformId, ...target });
        return { id: undefined };
      }
      if (!call || call.state !== 'live') return target ? { id: undefined } : null;
      if (!text.trim()) throw new Error('livekit-voice: reply contains no speakable text');
      if (!(await checkAccess(call))) return { id: undefined };
      if (target) {
        // A batched agent turn replies to its first inbound only, so any reply settles every open
        // ask_agent on the call. Later replies (an interim "let me check" followed by the answer)
        // are all spoken.
        for (const consult of call.consults.values()) clearTimeout(consult.timer);
        call.consults.clear();
        push(call, { type: 'reply', text });
        return { id: inReplyTo };
      }
      push(call, { type: 'say', text });
      return { id: `${CONSULT_ID_PREFIX}${call.callId}:out-${++call.sent}` };
    },

    async setTyping(platformId, status) {
      const call = calls.get(platformId);
      if (!call || call.state !== 'live' || call.consults.size === 0) return;
      const t = host.now();
      if (t - call.lastThinkAt < host.thinkIntervalMs) return;
      if (!(await checkAccess(call))) return;
      call.lastThinkAt = t;
      push(call, { type: 'thinking', status: status?.trim() || undefined });
    },

    activeCall(platformId) {
      const call = calls.get(platformId);
      return call && call.startedAt !== undefined && !call.ended
        ? { platformId, startedAt: call.startedAt }
        : undefined;
    },

    endLine(platformId, reason) {
      const call = calls.get(platformId);
      if (call) endCall(call, reason);
    },

    async teardown() {
      for (const call of [...calls.values()]) endCall(call, 'teardown');
      await Promise.all([...cleanups]);
    },
  };
}

// String.raw keeps the page script's escapes intact; the script avoids backticks and ${.
const PAGE_SCRIPT = String.raw`
const LK = window.LivekitClient;
const linkToken = new URLSearchParams(location.search).get('t') || '';
const base = location.pathname.replace(/\/livekit\/?$/, '');
const q = '?t=' + encodeURIComponent(linkToken);
const btn = document.getElementById('btn');
const audioBtn = document.getElementById('audio');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const names = { agent: 'the agent' };
const STATES = { listening: 'listening', thinking: 'thinking', speaking: 'speaking' };
let call = null;

function setStatus(text) { statusEl.textContent = text; }
function captionLine(role, label) {
  const p = document.createElement('p');
  p.className = 't ' + role;
  const b = document.createElement('b');
  b.textContent = label;
  const span = document.createElement('span');
  p.append(b, span);
  logEl.append(p);
  while (logEl.childElementCount > 200) logEl.firstElementChild.remove();
  return span;
}

// One text stream per transcript segment version; a newer stream for the same segment replaces it.
async function caption(c, reader, from) {
  const attrs = (reader.info && reader.info.attributes) || {};
  const mine = (c.localSid && attrs['lk.transcribed_track_id'] === c.localSid) ||
    (from && c.room && from.identity === c.room.localParticipant.identity);
  const key = attrs['lk.segment_id'] || reader.info.id;
  let entry = c.lines.get(key);
  if (!entry) {
    entry = { span: captionLine(mine ? 'caller' : 'agent', mine ? 'You' : names.agent) };
    c.lines.set(key, entry);
    if (c.lines.size > 300) c.lines.delete(c.lines.keys().next().value);
  }
  let text = '';
  for await (const chunk of reader) {
    if (c.ended) return;
    text += chunk;
    entry.span.textContent = text.trim();
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function endOnServer(c, beacon) {
  if (!c.callId || c.endSent) return;
  c.endSent = true;
  const url = base + '/livekit/end' + q;
  const body = JSON.stringify({ callId: c.callId });
  if (beacon && navigator.sendBeacon && navigator.sendBeacon(url, body)) return;
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

function hangup(c, message, beacon) {
  if (c.ended) return;
  c.ended = true;
  endOnServer(c, beacon);
  if (c.room) c.room.disconnect().catch(() => {});
  if (c.mic) c.mic.stop();
  for (const el of c.elements) el.remove();
  if (c.ctx) c.ctx.close().catch(() => {});
  if (call === c) call = null;
  audioBtn.hidden = true;
  setStatus(message);
  btn.textContent = 'Call';
  btn.className = '';
}

function start() {
  const c = { room: null, mic: null, ctx: null, callId: null, ended: false, endSent: false, localSid: null,
    lines: new Map(), elements: new Set() };
  call = c;
  btn.textContent = 'Hang up';
  btn.className = 'hang';
  // Inside the click: browsers (iOS Safari above all) unlock audio output only on a user gesture.
  c.ctx = new AudioContext();
  const resumed = c.ctx.resume().catch(() => {});
  const room = new LK.Room({ adaptiveStream: false, dynacast: false, disconnectOnPageLeave: false });
  c.room = room;
  room.startAudio().catch(() => {});
  run(c, room, resumed).catch((err) => hangup(c, 'Could not start: ' + ((err && err.message) || err)));
}

async function run(c, room, resumed) {
  setStatus('Starting the microphone...');
  c.mic = await LK.createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 });
  await resumed;
  if (c.ended) return hangup(c, 'Call ended.');
  setStatus('Connecting...');
  const res = await fetch(base + '/livekit/token' + q, { method: 'POST' });
  if (!res.ok) throw new Error((await res.text()) || 'HTTP ' + res.status);
  const s = await res.json();
  c.callId = s.callId;
  if (s.agent) names.agent = s.agent;
  if (c.ended) return endOnServer(c, false);
  room.registerTextStreamHandler('lk.transcription', (reader, from) => { caption(c, reader, from).catch(() => {}); });
  room.on(LK.RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== 'audio') return;
    const el = track.attach();
    el.hidden = true;
    document.body.append(el);
    c.elements.add(el);
  });
  room.on(LK.RoomEvent.TrackUnsubscribed, (track) => {
    for (const el of track.detach()) { c.elements.delete(el); el.remove(); }
  });
  room.on(LK.RoomEvent.AudioPlaybackStatusChanged, () => { audioBtn.hidden = room.canPlaybackAudio; });
  room.on(LK.RoomEvent.ParticipantConnected, (p) => { if (p.isAgent) setStatus('Live: talk to ' + names.agent + '.'); });
  room.on(LK.RoomEvent.ParticipantDisconnected, (p) => { if (p.isAgent) hangup(c, names.agent + ' left the call.'); });
  room.on(LK.RoomEvent.ParticipantAttributesChanged, (changed, p) => {
    const state = changed && changed['lk.agent.state'];
    if (p && p.isAgent && STATES[state]) setStatus('Live: ' + names.agent + ' is ' + STATES[state] + '.');
  });
  room.on(LK.RoomEvent.Disconnected, () => hangup(c, 'Call ended.'));
  await room.connect(s.url, s.token, { autoSubscribe: true });
  if (c.ended) return;
  // DTX off: Gemini 3.8 only ends a turn while audio keeps arriving, silence included.
  const pub = await room.localParticipant.publishTrack(c.mic, { source: LK.Track.Source.Microphone, dtx: false, red: false });
  c.localSid = pub.trackSid;
  audioBtn.hidden = room.canPlaybackAudio;
  const agentHere = [...room.remoteParticipants.values()].some((p) => p.isAgent);
  setStatus(agentHere ? 'Live: talk to ' + names.agent + '.' : 'Waiting for ' + names.agent + '...');
}

btn.addEventListener('click', () => (call ? hangup(call, 'Call ended.') : start()));
audioBtn.addEventListener('click', () => { if (call && call.room) call.room.startAudio().catch(() => {}); });
addEventListener('pagehide', () => { if (call) hangup(call, 'Call ended.', true); });
if (!LK) setStatus('The call client did not load.');
fetch(base + '/info' + q)
  .then((res) => (res.ok ? res.json() : null))
  .then((info) => {
    if (!info) return setStatus('This call link is not active.');
    names.agent = info.agent;
    document.getElementById('title').textContent = 'Call ' + info.agent;
  })
  .catch(() => {});
`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>Live Voice</title>
<style>
:root{--bg:#f6f5f2;--fg:#1d1d1f;--muted:#6b6b70;--card:#fff;--line:#e3e2de;--accent:#1a73e8;--danger:#c5221f}
@media (prefers-color-scheme: dark){:root{--bg:#141416;--fg:#ececef;--muted:#9a9aa2;--card:#1d1d21;--line:#2c2c31;--accent:#3b78e7;--danger:#d93025}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;justify-content:center;padding:24px 16px}
main{width:100%;max-width:560px;display:flex;flex-direction:column;gap:16px}
h1{font-size:20px;margin:0}
#status{color:var(--muted);min-height:1.45em}
.keys{display:flex;gap:12px;flex-wrap:wrap}
button{font:inherit;font-weight:600;border:0;border-radius:999px;padding:14px 28px;background:var(--accent);color:#fff;cursor:pointer}
button.hang{background:var(--danger)}
#audio{background:var(--card);color:var(--fg);border:1px solid var(--line)}
#log{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;min-height:200px;max-height:60vh;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
.t{margin:0}.t b{color:var(--muted);font-weight:600;margin-right:6px}.t.sys{color:var(--muted);font-style:italic}
</style>
</head>
<body>
<main>
<h1 id="title">Live Voice</h1>
<div id="status">Press Call to start.</div>
<div class="keys"><button id="btn" type="button">Call</button><button id="audio" type="button" hidden>Tap to hear the call</button></div>
<div id="log" aria-live="polite"></div>
</main>
<script src="livekit/client.js"></script>
<script>
${PAGE_SCRIPT}
</script>
</body>
</html>
`;

/** The LiveKit call page: one document; livekit-client loads from the same origin. */
export function liveKitCallPageHtml(): string {
  return PAGE;
}
