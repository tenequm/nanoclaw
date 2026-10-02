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
import { createLiveKitVoice, LIVEKIT_ID_PREFIX, type LiveKitVoiceConfig } from './voice-livekit.js';
import { DEFAULT_WALKIE_MIRROR } from './voice-livekit-protocol.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerWebhookHandler } from '../webhook-server.js';

export const CHANNEL_TYPE = 'voice';
const DEFAULT_API_BASE = 'https://api.openai.com/v1';
const DEFAULT_WS_BASE = 'wss://api.openai.com/v1';
/** Silent "still working" notes to the voice model go out at most this often while a reply is pending. */
export const THINK_INTERVAL_MS = 20_000;
/** Spoken for a delegation the agent did not answer within the deadline; a late reply is still spoken. */
export const DELEGATION_TIMEOUT_LINE = "This is taking longer than expected, I'll tell you as soon as it's done.";
const MINUTE_MS = 60_000;
/** How often a running call rechecks that its caller may still use the line, on every engine. */
const ACCESS_CHECK_INTERVAL_MS = 5000;
const HOUR_MS = 3_600_000;
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

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

/*
 * Inbound message ids for delegations (`gptlive:<session>:<delegation>`). The agent's reply carries
 * one back as `in_reply_to`, which is how deliver() knows which call and delegation it answers.
 */
const DELEGATION_ID_PREFIX = 'gptlive:';

function parseScopedId(prefix: string, id: string): [string, string] | null {
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  return [rest.slice(0, sep), rest.slice(sep + 1)];
}

export function delegationMessageId(sessionId: string, delegationId: string): string {
  return `${DELEGATION_ID_PREFIX}${sessionId}:${delegationId}`;
}

function parseDelegationMessageId(id: string): { sessionId: string; delegationId: string } | null {
  const parts = parseScopedId(DELEGATION_ID_PREFIX, id);
  return parts && { sessionId: parts[0], delegationId: parts[1] };
}

/**
 * The shared webhook server listens on every interface, and the voice routes are meant to be reached
 * through a loopback front (Tailscale Serve or a local reverse proxy) that terminates TLS.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
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
  /** GPT_LIVE_VOCABULARY: comma-separated names every call's prompt lists; used by the default resolveLine. */
  vocabulary?: string;
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
  /** Enables the LiveKit walkie-talkie path under /webhook/voice/livekit; without it those routes answer 503. */
  livekit?: LiveKitVoiceConfig;
  /** Serve the voice routes to non-loopback peers too (GPT_LIVE_ALLOW_NON_LOOPBACK); for local development only. */
  allowNonLoopback?: boolean;
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

/** The voice adapter, plus the walkie-talkie link of one of its lines for the `/voice` command. */
export interface VoiceChannelAdapter extends ChannelAdapter {
  /** The line's LiveKit call page URL, or null when LiveKit is off or the line has no link token here. */
  walkieLink(platformId: string): string | null;
}

export function createGptLiveAdapter(config: GptLiveConfig): VoiceChannelAdapter {
  const apiBase = (config.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  const wsBase = (config.wsBase ?? DEFAULT_WS_BASE).replace(/\/+$/, '');
  const tokens = new Set(config.linkTokens.map((t) => t.trim()).filter(Boolean));
  const resolveLine =
    config.resolveLine ??
    ((platformId: string, options?: ResolveLineOptions) =>
      resolveVoiceLine(platformId, undefined, { vocabulary: config.vocabulary, ...options }));
  const now = config.now ?? (() => Date.now());
  const requestTimeoutMs = config.requestTimeoutMs ?? 15_000;
  const maxCallDurationMs = config.maxCallDurationMs ?? 15 * 60_000;
  const maxCallsPerHour = config.maxCallsPerHour ?? 12;
  const delegationTimeoutMs = config.delegationTimeoutMs ?? 90_000;
  const maxCallMsPerDay = config.maxCallMsPerDay ?? 120 * MINUTE_MS;
  const accessCheckIntervalMs = config.accessCheckIntervalMs ?? ACCESS_CHECK_INTERVAL_MS;
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
  const elapsedTodayMs = (call: { startedAt: number }, t: number): number =>
    Math.max(0, t - Math.max(call.startedAt, utcDay(t) * DAY_MS));

  /** Today's call time on a line, including the OpenAI or LiveKit call still running on it. */
  const usedTodayMs = (platformId: string, t: number): number => {
    const used = usage.get(platformId);
    const active = lines.get(platformId);
    const lk = livekit?.activeCall(platformId);
    return (
      (used?.day === utcDay(t) ? used.usedMs : 0) +
      (active ? elapsedTodayMs(active, t) : 0) +
      (lk ? elapsedTodayMs(lk, t) : 0)
    );
  };

  /** Hourly start cap and daily minutes, shared by every engine. Records the start when admitted. */
  const admitStart = (platformId: string, t: number): { body: string; retryAfter: string } | null => {
    const recent = (starts.get(platformId) ?? []).filter((at) => at > t - HOUR_MS);
    if (recent.length >= maxCallsPerHour) {
      return {
        body: 'This voice line has reached its hourly call limit. Try again later.',
        retryAfter: String(Math.max(1, Math.ceil((recent[0] + HOUR_MS - t) / 1000))),
      };
    }
    if (usedTodayMs(platformId, t) >= maxCallMsPerDay) {
      return {
        body: 'This voice line has used its call minutes for today. Try again tomorrow.',
        retryAfter: String(Math.max(1, Math.ceil((DAY_MS - (t % DAY_MS)) / 1000))),
      };
    }
    starts.set(platformId, [...recent, t]);
    return null;
  };

  /** Add an ended call's time today to the line's counter. */
  const chargeUsage = (call: { platformId: string; startedAt: number }): void => {
    const t = now();
    const day = utcDay(t);
    const used = usage.get(call.platformId);
    usage.set(call.platformId, { day, usedMs: (used?.day === day ? used.usedMs : 0) + elapsedTodayMs(call, t) });
  };

  const livekit = config.livekit
    ? createLiveKitVoice(config.livekit, {
        ui: config.ui,
        resolveLine,
        sameCallerAndAgent: (a, b) => sameCallerAndAgent(a, b),
        admitStart,
        remainingTodayMs: (platformId, t) => maxCallMsPerDay - usedTodayMs(platformId, t),
        chargeUsage,
        endOtherCalls: (platformId, reason) => {
          const openAi = lines.get(platformId);
          if (openAi) closeCall(openAi, reason);
          // An OpenAI start still creating its session sees itself superseded and hangs up.
          pendingStarts.delete(platformId);
        },
        // Resolves once the agent's session stored the turn, or with false once routing ended without that.
        routeTurn: (event) =>
          new Promise<boolean>((resolve, reject) => {
            if (!setup?.routeInboundEvent) return reject(new Error('the voice channel is not running'));
            setup.routeInboundEvent({ ...event, onStored: () => resolve(true) }).then(
              () => resolve(false),
              (err: unknown) => {
                log.error('livekit-voice: routing a turn failed', { platformId: event.platformId, err });
                reject(err instanceof Error ? err : new Error(String(err)));
              },
            );
          }),
        isRunning: () => connected,
        now,
        maxCallDurationMs,
        accessCheckIntervalMs,
      })
    : null;

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
    livekit?.endLine(platformId, 'replaced by a new call');
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
    }, accessCheckIntervalMs);
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
    // Before any token check: a link must not be usable, or probed, from the LAN over plain HTTP.
    if (!config.allowNonLoopback && !isLoopbackAddress(req.socket.remoteAddress)) {
      return reply(res, 403, 'Voice calls are served through the host front only');
    }
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
      if (route === 'livekit' || route.startsWith('livekit/')) {
        if (!livekit) return reply(res, 503, 'LiveKit voice is not configured on this host');
        return await livekit.handleHttp(req, res, route, url, tokens, lineIdForToken);
      }
      if (route === 'info') {
        // Who answers this line, so the page can greet by name before the call.
        if (req.method !== 'GET') return reply(res, 405, 'GET only');
        if (!tokens.has(token)) return reply(res, 403, 'Unknown call link');
        const line = await resolveLine(lineIdForToken(token));
        if (!line) return reply(res, 403, 'Caller access denied or voice line is not set up');
        return reply(res, 200, JSON.stringify({ agent: line.agent.name, caller: line.caller.name }), JSON_HEADERS);
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
        const refusal = admitStart(platformId, now());
        if (refusal) return reply(res, 429, refusal.body, { 'Retry-After': refusal.retryAfter });
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
        return reply(res, 413, route === 'sdp' ? 'SDP offer too large' : 'Request body too large', {
          Connection: 'close',
        });
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

    walkieLink(platformId: string): string | null {
      if (!livekit) return null;
      const token = [...tokens].find((t) => lineIdForToken(t) === platformId);
      return token
        ? `${config.publicUrl.replace(/\/+$/, '')}/webhook/voice/livekit?t=${encodeURIComponent(token)}`
        : null;
    },

    async setup(cfg: ChannelSetup): Promise<void> {
      setup = cfg;
      registerWebhookHandler(CHANNEL_TYPE, handleHttp);
      connected = true;
      log.info('gpt-live: ready', {
        callUrl: `${config.publicUrl.replace(/\/+$/, '')}/webhook/voice/call?t=<link token>`,
        lines: tokens.size,
        voice: config.voice,
        livekit: config.livekit ? config.livekit.url : 'off',
      });
    },

    async teardown(): Promise<void> {
      connected = false;
      for (const call of [...lines.values()]) {
        closeCall(call, 'teardown');
      }
      await livekit?.teardown();
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
      const text = typeof content === 'string' ? content : typeof content?.text === 'string' ? content.text : '';
      const target = message.inReplyTo ? parseDelegationMessageId(message.inReplyTo) : null;
      if (!target && livekit) {
        const parts = message.inReplyTo ? parseScopedId(LIVEKIT_ID_PREFIX, message.inReplyTo) : null;
        const lkTarget = parts && { callId: parts[0], utteranceId: parts[1] };
        const spoken = await livekit.deliver(platformId, lkTarget, message.inReplyTo, text);
        if (spoken) return spoken.id;
      }
      const call = lines.get(platformId);
      if (target && target.sessionId !== call?.session.sessionId) {
        // An answer for a call that is over must not be spoken into a later one; retrying cannot help.
        log.info('gpt-live: dropping a reply for an ended call', { platformId, ...target });
        return undefined;
      }
      if (!call || call.session.isClosed() || !call.socket) throw new Error('gpt-live: no active call on this line');
      if (!(await checkCallAccess(call))) throw new Error('gpt-live: caller access has been revoked');
      if (!text.trim()) throw new Error('gpt-live: reply contains no speakable text');
      // Only the reply to a still-open delegation answers it. Proactive messages, and second or late
      // replies to a delegation already answered or timed out, are spoken without answering any.
      const answering = target && call.session.isPending(target.delegationId) ? target.delegationId : null;
      const ids = call.session.speak(text, answering);
      if (answering) clearDelegationTimer(call, answering);
      return ids.at(-1);
    },

    async setTyping(platformId: string, _threadId: string | null, status?: string): Promise<void> {
      await livekit?.setTyping(platformId);
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

/** WALKIE_SILENCE_MS: how long the caller is silent before their turn ends; nonsense falls back to the default. */
function parseWalkieSilenceMs(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined;
  const ms = Number(raw);
  if (Number.isInteger(ms) && ms >= 300 && ms <= 30_000) return ms;
  log.warn('gpt-live: WALKIE_SILENCE_MS must be whole milliseconds between 300 and 30000; using the default');
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
      'GPT_LIVE_ALLOW_NON_LOOPBACK',
      'GPT_LIVE_VOCABULARY',
      'GEMINI_API_KEY',
      'LIVEKIT_URL',
      'LIVEKIT_WORKER_URL',
      'LIVEKIT_API_KEY',
      'LIVEKIT_API_SECRET',
      'LIVEKIT_AGENT_NAME',
      'WALKIE_STT_MODEL',
      'WALKIE_STT_FALLBACK_MODEL',
      'WALKIE_TTS_MODEL',
      'WALKIE_TTS_FALLBACK_MODEL',
      'WALKIE_TTS_VOICE',
      'WALKIE_SILENCE_MS',
      'WALKIE_MIRROR',
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
      allowNonLoopback: env.GPT_LIVE_ALLOW_NON_LOOPBACK === '1',
      maxCallDurationMs: Number(env.GPT_LIVE_MAX_CALL_SECONDS ?? 900) * 1000,
      maxCallsPerHour: Number(env.GPT_LIVE_MAX_CALLS_PER_HOUR ?? 12),
      maxCallMsPerDay: Number(env.GPT_LIVE_MAX_MINUTES_PER_DAY ?? 120) * 60_000,
      delegationTimeoutMs: Number(env.GPT_LIVE_DELEGATION_TIMEOUT_SECONDS ?? 90) * 1000,
      vocabulary: env.GPT_LIVE_VOCABULARY,
      // The worker holds the Gemini key; the host only needs to know the engine can run.
      livekit:
        env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET && env.GEMINI_API_KEY
          ? {
              url: env.LIVEKIT_URL,
              serverUrl: env.LIVEKIT_WORKER_URL,
              apiKey: env.LIVEKIT_API_KEY,
              apiSecret: env.LIVEKIT_API_SECRET,
              agentName: env.LIVEKIT_AGENT_NAME,
              walkie: {
                sttModel: env.WALKIE_STT_MODEL,
                sttFallbackModel: env.WALKIE_STT_FALLBACK_MODEL,
                ttsModel: env.WALKIE_TTS_MODEL,
                ttsFallbackModel: env.WALKIE_TTS_FALLBACK_MODEL,
                ttsVoice: env.WALKIE_TTS_VOICE,
                silenceMs: parseWalkieSilenceMs(env.WALKIE_SILENCE_MS),
              },
              mirror: (env.WALKIE_MIRROR || DEFAULT_WALKIE_MIRROR).trim().toLowerCase(),
            }
          : undefined,
    });
  },
  defaults: GPT_LIVE_DEFAULTS,
});
