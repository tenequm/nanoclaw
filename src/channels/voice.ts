/**
 * Live Voice channel — OpenAI's full-duplex voice model (`gpt-live-1`) as the
 * mouth and ears of a call, with the NanoClaw agent as the brain.
 *
 * Shape: native adapter (no Chat SDK bridge). A *voice line* is one
 * conversation: its platform id is `voice:<line id>`, where the line id is
 * the first 12 hex characters of the link token's SHA-256 — the router
 * namespaces ids for this channel that way, and the token itself never
 * reaches the database, the logs or the agent's messages. The messaging group
 * and its wiring are created once (by the skill) and every call on that link
 * lands in the same agent session — the agent remembers the last call. There
 * are no threads. One call is active per line at a time.
 *
 * The live session is created in *client delegation* mode. Whenever the
 * voice model decides a turn needs facts, memory or tools it emits a
 * delegation event; the adapter turns the transcript since the last
 * delegation into an inbound message, and the agent's reply comes back as
 * spoken commentary.
 *
 * Transports:
 *  - WebRTC (browser), this version: the call page at
 *    `/webhook/voice/call?t=<token>` posts its SDP offer to `…/sdp`; the
 *    host creates the session, attaches the sideband, and returns the answer.
 *  - SIP (phone), next: OpenAI posts `realtime.call.incoming` to `…/sip`.
 *
 * Both end in the same place: a server-side *sideband* WebSocket attached
 * to the session (`/v1/live/sessions/{id}/attach`, bearer auth — the URL the
 * OpenAI SDK builds), where transcripts and delegations arrive and results
 * are pushed. Node's built-in WebSocket client and fetch are used; no SDK.
 *
 * Credentials: `OPENAI_API_KEY` is read from `.env` on the host, like other
 * channel adapters read their tokens. The agent container never sees it.
 * The link token gates the HTTP routes: a request without a known `t` gets
 * a 403 before any session (and any billing) starts. The token is never
 * logged or stored; everything NanoClaw keeps is keyed by the line id.
 */
import { createHash } from 'node:crypto';
import type http from 'node:http';

import type { ChannelAdapter, ChannelDefaults, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { callPageHtml, type VoiceUiConfig } from './gpt-live-call-page.js';
import { resolveOpenAiKey } from './gpt-live-keychain.js';
import { attachSideband, type SidebandSocket } from './gpt-live-sideband.js';
import {
  resolveVoiceLine,
  sessionConfig,
  type ResolveLineOptions,
  type VoiceAgent,
  type VoiceCaller,
  type VoiceLine,
} from './gpt-live-prompt.js';
import {
  GptLiveSession,
  type DelegationRequest,
  type LiveClientEvent,
  type LiveServerEvent,
} from './gpt-live-session.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerWebhookHandler } from '../webhook-server.js';

export const CHANNEL_TYPE = 'voice';
const DEFAULT_API_BASE = 'https://api.openai.com/v1';
const DEFAULT_WS_BASE = 'wss://api.openai.com/v1';
/** Silent "still working" notes to the voice model go out at most this often while a reply is pending. */
export const THINK_INTERVAL_MS = 20_000;
/** Spoken for a delegation the agent did not answer within the deadline. */
export const DELEGATION_TIMEOUT_LINE = "I couldn't get that done in time.";
const DAY_MS = 86_400_000;

const CALL_PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  // The page is one self-contained document: inline module script and styles, data: fonts and
  // images, same-origin fetches. WebRTC media to OpenAI is not governed by connect-src.
  'Content-Security-Policy':
    "default-src 'self' 'unsafe-inline' blob: data:; connect-src 'self'; media-src 'self' blob: mediastream:; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

/**
 * The inbound message id for a delegation. The agent's reply carries it back as
 * `in_reply_to`, which is how deliver() knows which call and delegation it answers.
 */
const DELEGATION_ID_PREFIX = 'gptlive:';

export function delegationMessageId(sessionId: string, delegationId: string): string {
  return `${DELEGATION_ID_PREFIX}${sessionId}:${delegationId}`;
}

function parseDelegationMessageId(id: string): { sessionId: string; delegationId: string } | null {
  if (!id.startsWith(DELEGATION_ID_PREFIX)) return null;
  const rest = id.slice(DELEGATION_ID_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { sessionId: rest.slice(0, sep), delegationId: rest.slice(sep + 1) };
}

/**
 * A voice line is DM-shaped: everything the voice model delegates is for the
 * agent (pattern '.'), there are no threads and no platform mention concept.
 * The link token is the credential — whoever holds the link is the line's
 * user. Only a named user with explicit membership may start a call; both
 * contexts are strict and the skill creates a known-sender wiring.
 */
const GPT_LIVE_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'dm-only',
};

export interface GptLiveConfig {
  apiKey: string;
  /** Origin the caller's browser reaches the host at (for the call link). */
  publicUrl: string;
  /** Voice for new sessions. */
  voice: string;
  /** Link tokens accepted on the HTTP routes; each is one voice line. */
  linkTokens: string[];
  /** REST base; overridable for tests. */
  apiBase?: string;
  /** WebSocket base; overridable for tests. */
  wsBase?: string;
  /** Resolves the named caller, single wiring and explicit access. Defaults to the central DB. */
  resolveLine?: (platformId: string, options?: ResolveLineOptions) => Promise<VoiceLine | null>;
  accessCheckIntervalMs?: number;
  /** Observability tap: every sideband server event, before the state machine sees it. */
  onSidebandEvent?: (sessionId: string, event: LiveServerEvent) => void;
  /** Clock, overridable for tests. */
  now?: () => number;
  /** Look of the browser call page; injected at serve time, no rebuild needed (GPT_LIVE_UI). */
  ui?: VoiceUiConfig;
  /** Bounds upstream creation, attach and cleanup requests. */
  requestTimeoutMs?: number;
  maxCallDurationMs?: number;
  maxCallsPerHour?: number;
  /** Call time one line may use per UTC day. */
  maxCallMsPerDay?: number;
  /** How long a delegation may wait for the agent before the caller hears it failed. */
  delegationTimeoutMs?: number;
}

export type { SidebandSocket } from './gpt-live-sideband.js';

/** An OpenAI-side failure the caller should hear about: the route answers 502 with the message. */
export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'UpstreamError';
  }
}

/** Request body over the cap; the route answers 413. */
export class BodyTooLargeError extends Error {
  constructor() {
    super('gpt-live: request body too large');
    this.name = 'BodyTooLargeError';
  }
}

/** SDP offers are a few kilobytes; anything near this is not an offer. */
export const MAX_BODY_BYTES = 64 * 1024;

/** Thrown to the HTTP route when a newer call on the same line replaced this one mid-attach. */
export class CallReplacedError extends Error {
  constructor(readonly platformId: string) {
    super('gpt-live: a newer call replaced this one');
    this.name = 'CallReplacedError';
  }
}

interface LiveCall {
  platformId: string;
  line: VoiceLine;
  /** Config clock; the daily budget is charged from here. */
  startedAt: number;
  delegationTimers: Map<string, ReturnType<typeof setTimeout>>;
  accessTimer?: ReturnType<typeof setInterval>;
  session: GptLiveSession;
  socket: SidebandSocket | null;
  /** When the last thinking note went out (config clock). */
  lastThinkAt: number;
  ended: boolean;
  attachController: AbortController;
  cleanup?: Promise<void>;
  expires?: ReturnType<typeof setTimeout>;
}

/**
 * The line id for a link token: `voice:` + the first 12 hex characters of
 * the token's SHA-256. It is the platform id, the sender id and what the logs
 * show; the token itself stays in the adapter's allow-list and the call link.
 */
export function lineIdForToken(token: string): string {
  return `${CHANNEL_TYPE}:${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
}

export function createGptLiveAdapter(config: GptLiveConfig): ChannelAdapter {
  const apiBase = (config.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const wsBase = (config.wsBase ?? DEFAULT_WS_BASE).replace(/\/+$/, '');
  const tokens = new Set(config.linkTokens.map((t) => t.trim()).filter(Boolean));
  const resolveLine =
    config.resolveLine ??
    ((platformId: string, options?: ResolveLineOptions) => resolveVoiceLine(platformId, undefined, options));
  const now = config.now ?? (() => Date.now());
  const requestTimeoutMs = config.requestTimeoutMs ?? 15_000;
  const maxCallDurationMs = config.maxCallDurationMs ?? 15 * 60_000;
  const maxCallsPerHour = config.maxCallsPerHour ?? 12;
  const delegationTimeoutMs = config.delegationTimeoutMs ?? 90_000;
  const maxCallMsPerDay = config.maxCallMsPerDay ?? 120 * 60_000;
  for (const [name, value] of Object.entries({
    requestTimeoutMs,
    maxCallDurationMs,
    maxCallsPerHour,
    delegationTimeoutMs,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new Error(`gpt-live: ${name} must be a positive bounded integer`);
    }
  }
  if (!Number.isSafeInteger(maxCallMsPerDay) || maxCallMsPerDay <= 0) {
    throw new Error('gpt-live: maxCallMsPerDay must be a positive integer');
  }
  const cleanups = new Set<Promise<void>>();
  const starts = new Map<string, number[]>();
  const pendingStarts = new Map<string, number>();
  let nextStart = 0;
  /** Active call per voice line, keyed by platform id. */
  const lines = new Map<string, LiveCall>();
  let setup: ChannelSetup | null = null;
  let connected = false;
  let callPage: string | undefined;
  /** Call time already used per line, for the UTC day (epoch day number) it was used on. */
  const usage = new Map<string, { day: number; usedMs: number }>();
  const utcDay = (t: number): number => Math.floor(t / DAY_MS);
  /** Time a call has run today; a call that started before midnight counts from midnight. */
  const elapsedTodayMs = (call: LiveCall, t: number): number =>
    Math.max(0, t - Math.max(call.startedAt, utcDay(t) * DAY_MS));

  /** Today's call time on a line, including the call still running on it. */
  const usedTodayMs = (platformId: string, t: number): number => {
    const used = usage.get(platformId);
    const active = lines.get(platformId);
    return (used?.day === utcDay(t) ? used.usedMs : 0) + (active ? elapsedTodayMs(active, t) : 0);
  };

  const chargeUsage = (call: LiveCall): void => {
    const t = now();
    const day = utcDay(t);
    const used = usage.get(call.platformId);
    usage.set(call.platformId, {
      day,
      usedMs: (used?.day === day ? used.usedMs : 0) + elapsedTodayMs(call, t),
    });
  };

  const clearDelegationTimer = (call: LiveCall, delegationId: string): void => {
    clearTimeout(call.delegationTimers.get(delegationId));
    call.delegationTimers.delete(delegationId);
  };

  const expireDelegation = (call: LiveCall, delegationId: string): void => {
    call.delegationTimers.delete(delegationId);
    if (call.ended || !call.session.isPending(delegationId)) return;
    log.warn('gpt-live: delegation got no reply in time', {
      platformId: call.platformId,
      sessionId: call.session.sessionId,
      delegationId,
    });
    try {
      call.session.speak(DELEGATION_TIMEOUT_LINE, delegationId);
    } catch (err) {
      log.warn('gpt-live: could not report the timed-out delegation', { sessionId: call.session.sessionId, err });
    }
  };

  const sendEvent = (call: LiveCall, event: LiveClientEvent): void => {
    if (!call.socket) {
      // A pending attach is cancelled through the HTTP hangup endpoint.
      if (event.type === 'session.close') return;
      throw new Error('gpt-live: no sideband for this call');
    }
    call.socket.send(JSON.stringify(event));
  };

  const onDelegation = (req: DelegationRequest): void => {
    const call = [...lines.values()].find((c) => c.session.sessionId === req.sessionId);
    if (!call || !setup) return;
    const timer = setTimeout(() => expireDelegation(call, req.delegationId), delegationTimeoutMs);
    timer.unref();
    call.delegationTimers.set(req.delegationId, timer);
    void (async () => {
      if (!(await checkCallAccess(call)) || !setup) return;
      const message: InboundMessage = {
        id: delegationMessageId(req.sessionId, req.delegationId),
        kind: 'chat',
        content: {
          text: req.transcript,
          sender: call.line.caller.name,
          senderId: call.line.caller.id,
          gptLive: {
            sessionId: req.sessionId,
            delegationId: req.delegationId,
            offsetMs: req.offsetMs,
            supersedes: req.supersedes,
          },
        },
        timestamp: new Date().toISOString(),
        isMention: true,
        isGroup: false,
      };
      // Tell the voice model work has started; the reply lands through deliver(). Later typing
      // ticks are throttled against this note (setTyping below).
      call.lastThinkAt = now();
      call.session.think('Working on it.', req.delegationId);
      await setup.onInbound(call.platformId, null, message);
    })().catch((err) => {
      log.error('gpt-live: onInbound threw', { platformId: call.platformId, err });
      closeCall(call, 'inbound routing failed');
    });
  };

  const hangupSession = async (sessionId: string): Promise<void> => {
    try {
      const res = await fetch(`${apiBase}/live/sessions/${encodeURIComponent(sessionId)}/hangup`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!res.ok && res.status !== 404) throw new Error(`hangup returned ${res.status}`);
      await res.body?.cancel();
    } catch (err) {
      log.error('gpt-live: upstream hangup was not confirmed', { sessionId, err });
    }
  };

  const endCall = (call: LiveCall, reason: string): void => {
    if (call.ended) return;
    call.ended = true;
    chargeUsage(call);
    clearTimeout(call.expires);
    clearInterval(call.accessTimer);
    for (const timer of call.delegationTimers.values()) clearTimeout(timer);
    call.delegationTimers.clear();
    call.attachController.abort();
    if (lines.get(call.platformId) === call) lines.delete(call.platformId);
    const socket = call.socket;
    call.socket = null;
    socket?.close();
    // A sideband transport closing alone does not end the primary WebRTC call.
    // The REST control also works when the attach never opened.
    if (reason !== 'session.closed') {
      const cleanup = hangupSession(call.session.sessionId).finally(() => cleanups.delete(cleanup));
      call.cleanup = cleanup;
      cleanups.add(cleanup);
    }
    log.info('gpt-live: call ended', { platformId: call.platformId, sessionId: call.session.sessionId, reason });
  };

  const closeCall = (call: LiveCall, reason: string): void => {
    try {
      call.session.close();
    } catch (err) {
      log.warn('gpt-live: close command failed; using HTTP hangup', { sessionId: call.session.sessionId, err });
    } finally {
      endCall(call, reason);
    }
  };

  const sameCallerAndAgent = (a: VoiceLine, b: VoiceLine): boolean =>
    a.caller.id === b.caller.id && a.caller.name === b.caller.name && a.agentGroupId === b.agentGroupId;

  const checkCallAccess = async (call: LiveCall): Promise<boolean> => {
    if (call.ended) return false;
    try {
      const current = await resolveLine(call.platformId);
      if (current && sameCallerAndAgent(call.line, current) && lines.get(call.platformId) === call && !call.ended)
        return true;
    } catch (err) {
      log.warn('gpt-live: call access check failed', { platformId: call.platformId, err });
    }
    closeCall(call, 'caller access revoked or line changed');
    return false;
  };

  /** Attach the server-side sideband and pump its events into the call's state machine. */
  const connectSideband = (call: LiveCall): Promise<SidebandSocket> =>
    attachSideband({
      wsBase,
      apiKey: config.apiKey,
      sessionId: call.session.sessionId,
      timeoutMs: requestTimeoutMs,
      signal: call.attachController.signal,
      onEvent: (event) => {
        config.onSidebandEvent?.(call.session.sessionId, event);
        call.session.handle(event);
      },
      onClose: (code, reason) => {
        // The server closing the sideband means the session is over for us.
        if (!call.session.isClosed()) call.session.handle({ type: 'transport.failed', code, reason });
      },
    });

  /**
   * Open a call on a line. Newest wins: a call already on the line is ended
   * first. Two requests can overlap while the sideband attaches, so once the
   * socket is open the call checks it still owns the line; if a newer call
   * took it meanwhile, this one closes the session it just attached to (so
   * it stops billing) and its request is refused with a CallReplacedError.
   */
  const openCall = async (token: string, sessionId: string, line: VoiceLine): Promise<LiveCall> => {
    const platformId = lineIdForToken(token);
    const previous = lines.get(platformId);
    if (previous) {
      closeCall(previous, 'replaced by a new call');
    }
    // Charged after the replaced call above, so its minutes count against this one.
    const remainingMs = maxCallMsPerDay - usedTodayMs(platformId, now());
    const call: LiveCall = {
      platformId,
      line,
      startedAt: now(),
      delegationTimers: new Map(),
      socket: null,
      session: null as unknown as GptLiveSession,
      lastThinkAt: 0,
      ended: false,
      attachController: new AbortController(),
    };
    call.session = new GptLiveSession(sessionId, {
      send: (event) => sendEvent(call, event),
      onDelegation,
      onClosed: (reason) => endCall(call, reason),
    });
    lines.set(platformId, call);
    const budgetCaps = remainingMs < maxCallDurationMs;
    call.expires = setTimeout(
      () => closeCall(call, budgetCaps ? 'daily minute budget' : 'duration limit'),
      Math.max(1, budgetCaps ? remainingMs : maxCallDurationMs),
    );
    call.expires.unref();
    call.accessTimer = setInterval(() => {
      void checkCallAccess(call);
    }, config.accessCheckIntervalMs ?? 5000);
    call.accessTimer.unref();
    let socket: SidebandSocket;
    try {
      socket = await connectSideband(call);
    } catch (err) {
      // Ended while attaching: replaced by a newer call or closed by teardown, which hung up already.
      if (call.ended) throw new CallReplacedError(platformId);
      endCall(call, 'sideband attach failed');
      await call.cleanup;
      throw new UpstreamError(502, 'gpt-live: sideband attach failed', { cause: err });
    }
    if (lines.get(platformId) !== call || !connected) {
      socket.send(JSON.stringify({ type: 'session.close' }));
      socket.close();
      if (!call.ended) endCall(call, 'channel stopped while attaching');
      log.info('gpt-live: call refused, a newer call or teardown took the line while attaching', {
        platformId,
        sessionId,
      });
      throw new CallReplacedError(platformId);
    }
    call.socket = socket;
    return call;
  };

  /** Create a WebRTC session from the browser's SDP offer; returns the SDP answer. */
  const createWebRtcSession = async (
    offer: string,
    agent: VoiceAgent,
    caller: VoiceCaller,
  ): Promise<{ sessionId: string; answer: string }> => {
    const res = await fetch(`${apiBase}/live/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: sessionConfig(agent, config.voice, caller),
        transport: { type: 'webrtc', sdp: offer },
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    }).catch((err) => {
      throw new UpstreamError(502, 'gpt-live: session creation timed out or could not connect', { cause: err });
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      if (res.status === 401 || res.status === 403) {
        // The upstream body names the key and the project; the operator reads it in the log.
        log.warn('gpt-live: OpenAI refused the host credentials', { status: res.status, detail });
        throw new UpstreamError(
          res.status,
          `gpt-live: session create failed: ${res.status} (check the host's OpenAI key)`,
        );
      }
      throw new UpstreamError(res.status, `gpt-live: session create failed: ${res.status} ${detail}`);
    }
    const body = (await res.json()) as { session?: { id?: string }; transport?: { sdp?: string } };
    if (!body.session?.id || !body.transport?.sdp)
      throw new UpstreamError(502, 'gpt-live: session create returned no id/sdp');
    return { sessionId: body.session.id, answer: body.transport.sdp };
  };

  const readBody = async (req: http.IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > MAX_BODY_BYTES) throw new BodyTooLargeError();
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  };

  const reply = (
    res: http.ServerResponse,
    status: number,
    body: string,
    headers: Record<string, string> = {},
  ): void => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };

  /** HTTP routes under /webhook/voice/… on the shared webhook server. */
  const handleHttp = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = url.pathname.replace(/^\/webhook\/voice(?:\/|$)/, '').replace(/\/+$/, '');
    const token = url.searchParams.get('t') ?? '';
    try {
      // The shared webhook server has no unregister; after teardown the routes stay reachable
      // and must refuse rather than start sessions for a channel that is no longer running.
      if (!connected || !setup) return reply(res, 503, 'Live Voice is not running');
      if (req.method === 'GET' && route === 'call') {
        callPage ??= callPageHtml(config.ui);
        res.writeHead(200, CALL_PAGE_HEADERS);
        res.end(callPage);
        return;
      }
      if (route === 'info') {
        // Who answers this line, so the page can greet by name before the call.
        if (req.method !== 'GET') return reply(res, 405, 'GET only');
        if (!tokens.has(token)) return reply(res, 403, 'Unknown call link');
        const line = await resolveLine(lineIdForToken(token));
        if (!line) return reply(res, 403, 'Caller access denied or voice line is not set up');
        return reply(res, 200, JSON.stringify({ agent: line.agent.name, caller: line.caller.name }), {
          'Content-Type': 'application/json; charset=utf-8',
        });
      }
      if (route === 'sdp' || route === 'hangup') {
        if (req.method !== 'POST') return reply(res, 405, 'POST only');
        if (!tokens.has(token)) return reply(res, 403, 'Unknown call link');
      }
      if (route === 'sdp') {
        const offer = await readBody(req);
        if (!offer.trim().startsWith('v=')) return reply(res, 400, 'Body must be an SDP offer');
        const platformId = lineIdForToken(token);
        const line = await resolveLine(platformId, { persona: true });
        if (!line) return reply(res, 403, 'Caller access denied or voice line is not set up');
        const t = now();
        const recent = (starts.get(platformId) ?? []).filter((at) => at > t - 3_600_000);
        if (recent.length >= maxCallsPerHour) {
          return reply(res, 429, 'This voice line has reached its hourly call limit. Try again later.', {
            'Retry-After': String(Math.max(1, Math.ceil((recent[0] + 3_600_000 - t) / 1000))),
          });
        }
        if (usedTodayMs(platformId, t) >= maxCallMsPerDay) {
          return reply(res, 429, 'This voice line has used its call minutes for today. Try again tomorrow.', {
            'Retry-After': String(Math.max(1, Math.ceil((DAY_MS - (t % DAY_MS)) / 1000))),
          });
        }
        starts.set(platformId, [...recent, t]);
        const attempt = ++nextStart;
        pendingStarts.set(platformId, attempt);
        let sessionId: string;
        let answer: string;
        const superseded = (): boolean => !connected || res.destroyed || pendingStarts.get(platformId) !== attempt;
        try {
          ({ sessionId, answer } = await createWebRtcSession(offer, line.agent, line.caller));
          log.info('gpt-live: session created', { platformId, sessionId, agent: line.agent.name });
          // Creation and the access recheck can finish out of order or after teardown / browser cancellation.
          const current = superseded() ? null : await resolveLine(platformId);
          if (superseded()) {
            await hangupSession(sessionId);
            if (!res.destroyed) reply(res, 409, 'This call attempt is no longer active');
            return;
          }
          if (!current || !sameCallerAndAgent(line, current)) {
            await hangupSession(sessionId);
            return reply(res, 403, 'Caller access changed while connecting');
          }
          const call = await openCall(token, sessionId, line);
          if (res.destroyed) {
            closeCall(call, 'browser disconnected during attach');
            await call.cleanup;
            return;
          }
        } catch (err) {
          if (err instanceof CallReplacedError) {
            return connected
              ? reply(res, 409, 'A newer call replaced this one')
              : reply(res, 503, 'Live Voice is not running');
          }
          throw err;
        } finally {
          if (pendingStarts.get(platformId) === attempt) pendingStarts.delete(platformId);
        }
        reply(res, 200, answer, {
          'Content-Type': 'application/sdp',
          'X-Voice-Session': sessionId,
        });
        return;
      }
      if (route === 'hangup') {
        const sessionId = url.searchParams.get('session');
        if (!sessionId) return reply(res, 400, 'Session id is required');
        const call = lines.get(lineIdForToken(token));
        if (call?.session.sessionId === sessionId) {
          closeCall(call, 'hangup');
          await call.cleanup;
        }
        reply(res, 204, '');
        return;
      }
      if (req.method === 'POST' && route === 'sip') {
        // Next phase: realtime.call.incoming → accept (session config) or reject (603).
        return reply(res, 501, 'SIP calls are not wired yet');
      }
      reply(res, 404, 'Not found');
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        // Drain what is left so the 413 reaches the client, then let the connection close.
        req.resume();
        return reply(res, 413, 'SDP offer too large', { Connection: 'close' });
      }
      if (err instanceof UpstreamError) {
        // The caller sees why (a credit problem is actionable); credential detail stays in the log.
        log.warn('gpt-live: upstream failure on the sdp route', { route, status: err.status, err });
        if (!res.headersSent) return reply(res, 502, err.message.slice(0, 300));
        res.end();
        return;
      }
      // The shared webhook server has no other way to answer the browser.
      log.error('gpt-live: http route failed', { route, err });
      if (!res.headersSent) reply(res, 500, 'gpt-live error');
      else res.end();
    }
  };

  return {
    name: CHANNEL_TYPE,
    channelType: CHANNEL_TYPE,
    supportsThreads: false,
    defaults: GPT_LIVE_DEFAULTS,

    async setup(cfg: ChannelSetup): Promise<void> {
      setup = cfg;
      registerWebhookHandler(CHANNEL_TYPE, handleHttp);
      connected = true;
      log.info('gpt-live: ready', {
        callUrl: `${config.publicUrl.replace(/\/+$/, '')}/webhook/voice/call?t=<link token>`,
        lines: tokens.size,
        voice: config.voice,
      });
    },

    async teardown(): Promise<void> {
      connected = false;
      for (const call of [...lines.values()]) {
        closeCall(call, 'teardown');
      }
      connected = false;
      setup = null;
      await Promise.all([...cleanups]);
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const content = message.content as { text?: unknown; type?: unknown } | string;
      if (typeof content === 'object' && content?.type === 'ask_question') {
        throw new Error('gpt-live: question cards are unsupported; ask the caller in plain text');
      }
      if (message.files?.length) throw new Error('gpt-live: attachments cannot be delivered over a voice call');
      const target = message.inReplyTo ? parseDelegationMessageId(message.inReplyTo) : null;
      const call = lines.get(platformId);
      if (target && target.sessionId !== call?.session.sessionId) {
        // An answer for a call that is over must not be spoken into a later one; retrying cannot help.
        log.info('gpt-live: dropping a reply for an ended call', { platformId, ...target });
        return undefined;
      }
      if (!call || call.session.isClosed() || !call.socket) throw new Error('gpt-live: no active call on this line');
      if (!(await checkCallAccess(call))) throw new Error('gpt-live: caller access has been revoked');
      const text = typeof content === 'string' ? content : typeof content?.text === 'string' ? content.text : '';
      if (!text.trim()) throw new Error('gpt-live: reply contains no speakable text');
      // Only the reply to a still-open delegation answers it. Proactive messages, and second or late
      // replies to a delegation already answered or timed out, are spoken without answering any.
      const answering = target && call.session.isPending(target.delegationId) ? target.delegationId : null;
      const ids = call.session.speak(text, answering);
      if (answering) clearDelegationTimer(call, answering);
      return ids.at(-1);
    },

    async setTyping(platformId: string, _threadId: string | null, status?: string): Promise<void> {
      // The host re-fires typing every few seconds for as long as the agent works. The voice
      // model needs one quiet note now and then, not a drumbeat: at most one per
      // THINK_INTERVAL_MS while a reply is pending, none once the reply went out.
      const call = lines.get(platformId);
      if (!call || call.session.pendingDelegations().length === 0 || !(await checkCallAccess(call))) return;
      const t = now();
      if (t - call.lastThinkAt < THINK_INTERVAL_MS) return;
      call.lastThinkAt = t;
      call.session.think(status?.trim() || 'Still working on it.');
    },
  };
}

const UI_CONFIG_KEYS = [
  'skin',
  'colorway',
  'layout',
  'presence',
  'brand',
  'footer',
  'shortcuts',
  'timestamps',
  'colorwayPicker',
] as const;

/** GPT_LIVE_UI is a JSON object; anything unparsable falls back to the page defaults with a warning. */
export function parseUiConfig(raw: string | undefined): VoiceUiConfig | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // Only the documented keys travel to the page; the page validates values.
      const src = parsed as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of UI_CONFIG_KEYS) if (key in src) out[key] = src[key];
      return out as VoiceUiConfig;
    }
    log.warn('gpt-live: GPT_LIVE_UI must be a JSON object; using the default look');
  } catch (err) {
    log.warn('gpt-live: GPT_LIVE_UI is not valid JSON; using the default look', { err });
  }
  return undefined;
}

registerChannelAdapter(CHANNEL_TYPE, {
  factory: () => {
    const env = readEnvFile([
      'OPENAI_API_KEY',
      'GPT_LIVE_KEYCHAIN_SERVICE',
      'GPT_LIVE_KEYCHAIN_ACCOUNT',
      'GPT_LIVE_PUBLIC_URL',
      'GPT_LIVE_VOICE',
      'GPT_LIVE_LINK_TOKEN',
      'GPT_LIVE_UI',
      'GPT_LIVE_MAX_CALL_SECONDS',
      'GPT_LIVE_MAX_CALLS_PER_HOUR',
      'GPT_LIVE_MAX_MINUTES_PER_DAY',
      'GPT_LIVE_DELEGATION_TIMEOUT_SECONDS',
    ]);
    const key = resolveOpenAiKey(env);
    if (!key) return null;
    if (!env.GPT_LIVE_LINK_TOKEN) {
      log.warn('gpt-live: GPT_LIVE_LINK_TOKEN is not set; the channel stays offline');
      return null;
    }
    log.info('gpt-live: OpenAI key loaded', { source: key.source });
    const linkTokens = env.GPT_LIVE_LINK_TOKEN.split(',');
    const short = linkTokens.map((t) => t.trim()).filter((t) => t && t.length < 32);
    if (short.length > 0) {
      log.warn('gpt-live: link tokens shorter than 32 characters are weak; mint new ones with openssl rand -hex 16', {
        lines: short.map(lineIdForToken),
      });
    }
    return createGptLiveAdapter({
      apiKey: key.key,
      publicUrl: (env.GPT_LIVE_PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, ''),
      voice: env.GPT_LIVE_VOICE || 'marin',
      linkTokens,
      ui: parseUiConfig(env.GPT_LIVE_UI),
      maxCallDurationMs: Number(env.GPT_LIVE_MAX_CALL_SECONDS ?? 900) * 1000,
      maxCallsPerHour: Number(env.GPT_LIVE_MAX_CALLS_PER_HOUR ?? 12),
      maxCallMsPerDay: Number(env.GPT_LIVE_MAX_MINUTES_PER_DAY ?? 120) * 60_000,
      delegationTimeoutMs: Number(env.GPT_LIVE_DELEGATION_TIMEOUT_SECONDS ?? 90) * 1000,
    });
  },
  defaults: GPT_LIVE_DEFAULTS,
});
