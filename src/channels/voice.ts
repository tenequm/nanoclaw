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
import { createHash, randomUUID } from 'node:crypto';
import type http from 'node:http';

import type { ChannelAdapter, ChannelDefaults, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import {
  DEFAULT_GEMINI_API_BASE,
  DEFAULT_GEMINI_LIVE_MODEL,
  DEFAULT_GEMINI_LIVE_VOICE,
  GEMINI_LIVE_WS_URL,
  GEMINI_MAX_CALL_MS,
  GeminiTokenError,
  geminiBrowserSetup,
  geminiCallPageHtml,
  geminiLiveSetup,
  geminiToolScheduling,
  mintGeminiToken,
} from './gemini-live.js';
import { callPageHtml, type VoiceUiConfig } from './gpt-live-call-page.js';
import { resolveOpenAiKey } from './gpt-live-keychain.js';
import { attachSideband, type SidebandSocket } from './gpt-live-sideband.js';
import {
  geminiInstructions,
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
/** ask_agent calls one Gemini call may have waiting on the agent at once. */
export const MAX_OPEN_CONSULTS = 3;
export const MAX_CONSULTS_PER_MINUTE = 10;
export const MAX_CONSULT_REQUEST_BYTES = 4 * 1024;
/** JSON bodies on the Gemini routes carry ids and one short request. */
const MAX_GEMINI_BODY_BYTES = 16 * 1024;
/** Agent messages waiting for the page's next poll; the oldest go first past this. */
const MAX_QUEUED_UPDATES = 20;
/** A message poll with nothing to deliver is answered empty after this, and the page polls again. */
const GEMINI_POLL_MS = 25_000;

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

const GEMINI_PAGE_HEADERS = {
  ...CALL_PAGE_HEADERS,
  // The page talks to Gemini directly over WebSocket; the mic worklet loads from a blob: URL.
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline' blob:; worker-src blob:; style-src 'unsafe-inline'; " +
    "connect-src 'self' wss://generativelanguage.googleapis.com; media-src 'self' blob: mediastream:; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

/*
 * Inbound message ids for delegations (`gptlive:<session>:<delegation>`) and ask_agent calls
 * (`gemini:<call>:<function call>`). The agent's reply carries one back as `in_reply_to`, which is
 * how deliver() knows which call, and which delegation or consult, it answers.
 */
const DELEGATION_ID_PREFIX = 'gptlive:';
const CONSULT_ID_PREFIX = 'gemini:';

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

export function geminiConsultMessageId(callId: string, functionCallId: string): string {
  return `${CONSULT_ID_PREFIX}${callId}:${functionCallId}`;
}

export function parseGeminiConsultMessageId(id: string): { callId: string; functionCallId: string } | null {
  const parts = parseScopedId(CONSULT_ID_PREFIX, id);
  return parts && { callId: parts[0], functionCallId: parts[1] };
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
  /** Enables the Gemini Live path under /webhook/voice/gemini; without it those routes answer 503. */
  gemini?: GeminiLiveConfig;
  /** Enables the LiveKit walkie-talkie path under /webhook/voice/livekit; without it those routes answer 503. */
  livekit?: LiveKitVoiceConfig;
  /** Serve the voice routes to non-loopback peers too (GPT_LIVE_ALLOW_NON_LOOPBACK); for local development only. */
  allowNonLoopback?: boolean;
}

export interface GeminiLiveConfig {
  apiKey: string;
  model?: string;
  voice?: string;
  /** REST base for the token endpoint; overridable for tests. */
  apiBase?: string;
  /** Defaults to 10 minutes and never exceeds the general maxCallDurationMs. */
  maxCallDurationMs?: number;
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

/** An ask_agent call waiting on the agent; settled with the reply, the timeout line, or null when the call is gone. */
interface GeminiConsult {
  settled: boolean;
  /** Order the agent got it in; consults are opened before their access check, so map order can differ. */
  forwardedSeq?: number;
  answer: Promise<string | null>;
  settle: (answer: string | null) => void;
}

/**
 * A browser-direct Gemini call. The host never sees its audio and cannot end
 * the Google session: the page holds a token that works until it expires. The
 * record exists from token mint to hangup, replacement, access loss or
 * expiry; once it ends, consults and message polls are refused, which makes a
 * well-behaved page hang up.
 */
interface GeminiCall {
  callId: string;
  platformId: string;
  line: VoiceLine;
  ended: boolean;
  endReason?: string;
  expires?: ReturnType<typeof setTimeout>;
  accessTimer?: ReturnType<typeof setInterval>;
  consults: Map<string, GeminiConsult>;
  /** Accepted consult start times (config clock), for the per-minute cap. */
  consultStarts: number[];
  forwardedConsults: number;
  /** Agent messages for the page that answer no waiting consult. */
  updates: string[];
  updateSeq: number;
  /** The page's waiting message poll, if any; null tells it the call is over. */
  poll?: (messages: string[] | null) => void;
}

const GEMINI_ACCESS_LOST = 'caller access revoked or line changed';

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
  // Never past GEMINI_MAX_CALL_MS: Google drops the connection there and the page cannot resume.
  const geminiMaxCallMs = Math.min(
    maxCallDurationMs,
    GEMINI_MAX_CALL_MS,
    config.gemini?.maxCallDurationMs ?? GEMINI_MAX_CALL_MS,
  );
  for (const [name, value] of Object.entries({
    requestTimeoutMs,
    maxCallDurationMs,
    maxCallsPerHour,
    delegationTimeoutMs,
    geminiMaxCallMs,
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
  /** Active Gemini call per voice line; it shares the hourly and daily limits with `lines`. */
  const geminiCalls = new Map<string, GeminiCall>();
  let setup: ChannelSetup | null = null;
  let connected = false;
  let callPage: string | undefined;
  /** Call time already used per line, for the UTC day (epoch day number) it was used on. */
  const usage = new Map<string, { day: number; usedMs: number }>();
  const utcDay = (t: number): number => Math.floor(t / DAY_MS);
  /** Time a call has run today; a call that started before midnight counts from midnight. */
  const elapsedTodayMs = (call: { startedAt: number }, t: number): number =>
    Math.max(0, t - Math.max(call.startedAt, utcDay(t) * DAY_MS));

  /**
   * Today's call time on a line, including the OpenAI or LiveKit call still running on it. Gemini
   * calls are charged their whole token lifetime when the token is minted, so they are already in
   * `usage`.
   */
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

  /** Add (or, for a Gemini token that was never issued, give back) call time on today's counter. */
  const addUsage = (platformId: string, ms: number, t: number): void => {
    const day = utcDay(t);
    const used = usage.get(platformId);
    usage.set(platformId, { day, usedMs: Math.max(0, (used?.day === day ? used.usedMs : 0) + ms) });
  };

  const chargeUsage = (call: { platformId: string; startedAt: number }): void => {
    const t = now();
    addUsage(call.platformId, elapsedTodayMs(call, t), t);
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
          const gemini = geminiCalls.get(platformId);
          if (gemini) endGeminiCall(gemini, reason);
          // An OpenAI start still creating its session sees itself superseded and hangs up.
          pendingStarts.delete(platformId);
        },
        onInbound: async (platformId, message) => {
          if (!setup) throw new Error('livekit-voice: channel is not running');
          await setup.onInbound(platformId, null, message);
        },
        onInboundEvent: async (event) => {
          if (!setup) throw new Error('livekit-voice: channel is not running');
          await setup.onInboundEvent(event);
        },
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
    // Its minutes were reserved at mint; the Google session runs on its token regardless.
    const gemini = geminiCalls.get(platformId);
    if (gemini) endGeminiCall(gemini, 'replaced by an OpenAI call');
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

  const readBody = async (req: http.IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<string> => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > maxBytes) throw new BodyTooLargeError();
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

  const endGeminiCall = (call: GeminiCall, reason: string): void => {
    if (call.ended) return;
    call.ended = true;
    call.endReason = reason;
    clearTimeout(call.expires);
    clearInterval(call.accessTimer);
    for (const consult of [...call.consults.values()]) consult.settle(null);
    call.updates.length = 0;
    call.poll?.(null);
    if (geminiCalls.get(call.platformId) === call) geminiCalls.delete(call.platformId);
    log.info('gemini-live: call ended', { platformId: call.platformId, callId: call.callId, reason });
  };

  /**
   * Same recheck as the OpenAI path. On loss the host ends its record of the call, so consults and
   * agent messages stop; the Google session itself cannot be killed from here and runs until the
   * page hangs up or its token expires.
   */
  const checkGeminiAccess = async (call: GeminiCall): Promise<boolean> => {
    if (call.ended) return false;
    try {
      const current = await resolveLine(call.platformId);
      if (current && sameCallerAndAgent(call.line, current)) return !call.ended;
    } catch (err) {
      log.warn('gemini-live: call access check failed', { platformId: call.platformId, err });
    }
    endGeminiCall(call, GEMINI_ACCESS_LOST);
    return false;
  };

  /** The active Gemini call on a line, if `callId` names it. */
  const activeGeminiCall = (platformId: string, callId: unknown): GeminiCall | null => {
    const call = geminiCalls.get(platformId);
    return call && !call.ended && call.callId === callId ? call : null;
  };

  /** Mint the constrained token the page opens its Gemini session with, and start the call's clock. */
  const startGeminiCall = async (
    res: http.ServerResponse,
    platformId: string,
    gemini: GeminiLiveConfig,
  ): Promise<void> => {
    const line = await resolveLine(platformId, { persona: true });
    if (!line) return reply(res, 403, 'Caller access denied or voice line is not set up');
    const t = now();
    const refusal = admitStart(platformId, t);
    if (refusal) return reply(res, 429, refusal.body, { 'Retry-After': refusal.retryAfter });
    const remainingMs = maxCallMsPerDay - usedTodayMs(platformId, t);
    const budgetCaps = remainingMs < geminiMaxCallMs;
    const durationMs = Math.max(1, budgetCaps ? remainingMs : geminiMaxCallMs);
    // The token keeps the Google session open for its whole lifetime whatever the host or page does,
    // so the call is charged that much now, before the mint so concurrent starts cannot overspend.
    addUsage(platformId, durationMs, t);
    // Past midnight the counter belongs to the new day, which this charge never touched.
    const refund = (): void => {
      if (utcDay(now()) === utcDay(t)) addUsage(platformId, -durationMs, t);
    };
    const expiresAt = t + durationMs;
    const model = gemini.model || DEFAULT_GEMINI_LIVE_MODEL;
    let ephemeral: string;
    try {
      ephemeral = await mintGeminiToken({
        apiKey: gemini.apiKey,
        apiBase: (gemini.apiBase ?? DEFAULT_GEMINI_API_BASE).replace(/\/+$/, ''),
        setup: geminiLiveSetup(
          model,
          gemini.voice || DEFAULT_GEMINI_LIVE_VOICE,
          geminiInstructions(line.agent, line.caller),
        ),
        expiresAt,
        now: t,
        timeoutMs: requestTimeoutMs,
      });
    } catch (err) {
      refund();
      const status = err instanceof GeminiTokenError ? err.status : 502;
      // Google's error body can name the project; the operator reads it in the log.
      log.warn('gemini-live: token mint failed', { platformId, status, err });
      return reply(
        res,
        502,
        status === 400 || status === 401 || status === 403
          ? `gemini-live: Google refused the token request: ${status} (check the host's Gemini key)`
          : `gemini-live: token request failed: ${status}`,
      );
    }
    if (!connected) {
      refund();
      return reply(res, 503, 'Live Voice is not running');
    }
    if (res.destroyed) {
      // The page went away during the mint and never gets the token, so nothing can use it.
      refund();
      log.info('gemini-live: page left during the token mint', { platformId });
      return;
    }
    // The mint took a while; the page must hang up before the token dies, not after.
    const remainingTokenMs = Math.max(1, expiresAt - now());
    // Newest wins across every engine. A replaced Gemini page's session runs out on its own token.
    const previous = geminiCalls.get(platformId);
    if (previous) endGeminiCall(previous, 'replaced by a new call');
    const openai = lines.get(platformId);
    if (openai) closeCall(openai, 'replaced by a Gemini call');
    // An OpenAI start still creating its session sees itself superseded and hangs up.
    pendingStarts.delete(platformId);
    livekit?.endLine(platformId, 'replaced by a new call');
    const call: GeminiCall = {
      callId: randomUUID(),
      platformId,
      line,
      ended: false,
      consults: new Map(),
      consultStarts: [],
      forwardedConsults: 0,
      updates: [],
      updateSeq: 0,
    };
    geminiCalls.set(platformId, call);
    call.expires = setTimeout(
      () => endGeminiCall(call, budgetCaps ? 'daily minute budget' : 'duration limit'),
      remainingTokenMs,
    );
    call.expires.unref();
    call.accessTimer = setInterval(() => {
      void checkGeminiAccess(call);
    }, accessCheckIntervalMs);
    call.accessTimer.unref();
    log.info('gemini-live: call started', { platformId, callId: call.callId, model, agent: line.agent.name });
    reply(
      res,
      200,
      JSON.stringify({
        token: ephemeral,
        callId: call.callId,
        websocketUrl: GEMINI_LIVE_WS_URL,
        setup: geminiBrowserSetup(model),
        scheduling: geminiToolScheduling(model),
        durationMs: remainingTokenMs,
      }),
      JSON_HEADERS,
    );
  };

  /** Register a waiting consult. Synchronous, so a duplicate id or a cancel cannot slip in between. */
  const openConsult = (call: GeminiCall, functionCallId: string): GeminiConsult => {
    let resolveAnswer!: (answer: string | null) => void;
    const consult: GeminiConsult = {
      settled: false,
      answer: new Promise<string | null>((resolve) => {
        resolveAnswer = resolve;
      }),
      settle: (value) => {
        if (consult.settled) return;
        consult.settled = true;
        clearTimeout(timer);
        if (call.consults.get(functionCallId) === consult) call.consults.delete(functionCallId);
        resolveAnswer(value);
      },
    };
    const timer = setTimeout(() => {
      log.warn('gemini-live: ask_agent got no reply in time', {
        platformId: call.platformId,
        callId: call.callId,
        functionCallId,
      });
      consult.settle(DELEGATION_TIMEOUT_LINE);
    }, delegationTimeoutMs);
    timer.unref();
    call.consults.set(functionCallId, consult);
    return consult;
  };

  /** One ask_agent call: feed it to the agent and hold the request open until the reply or the deadline. */
  const consultGemini = async (
    res: http.ServerResponse,
    call: GeminiCall | null,
    body: Record<string, unknown>,
  ): Promise<void> => {
    if (!call) return reply(res, 409, 'This call is no longer active');
    const functionCallId = typeof body.functionCallId === 'string' ? body.functionCallId.trim() : '';
    const request = typeof body.request === 'string' ? body.request.trim() : '';
    if (!functionCallId || !request) return reply(res, 400, 'functionCallId and request are required');
    if (Buffer.byteLength(request) > MAX_CONSULT_REQUEST_BYTES) {
      return reply(res, 413, `ask_agent request is too large (${MAX_CONSULT_REQUEST_BYTES / 1024} KB max)`);
    }
    if (call.consults.has(functionCallId)) return reply(res, 409, 'This function call is already pending');
    if (call.consults.size >= MAX_OPEN_CONSULTS) {
      return reply(res, 429, 'Too many ask_agent calls are waiting on the agent');
    }
    const t = now();
    call.consultStarts = call.consultStarts.filter((at) => at > t - MINUTE_MS);
    if (call.consultStarts.length >= MAX_CONSULTS_PER_MINUTE) {
      return reply(res, 429, 'Too many ask_agent calls this minute', {
        'Retry-After': String(Math.max(1, Math.ceil((call.consultStarts[0] + MINUTE_MS - t) / 1000))),
      });
    }
    call.consultStarts.push(t);
    const consult = openConsult(call, functionCallId);
    // The page aborts the fetch when it hangs up. Before the agent has the question nothing is sent;
    // after, a reply finds no waiting consult and is queued for the call.
    res.on('close', () => consult.settle(null));
    const allowed = await checkGeminiAccess(call);
    const current = setup;
    if (!allowed || !current || consult.settled) {
      consult.settle(null);
      if (res.destroyed || res.writableEnded) return;
      return call.endReason === GEMINI_ACCESS_LOST
        ? reply(res, 403, 'Caller access denied')
        : reply(res, 409, 'This call is no longer active');
    }
    const message: InboundMessage = {
      id: geminiConsultMessageId(call.callId, functionCallId),
      kind: 'chat',
      content: {
        text: request,
        sender: call.line.caller.name,
        senderId: call.line.caller.id,
        geminiLive: { callId: call.callId, functionCallId },
      },
      timestamp: new Date().toISOString(),
      isMention: true,
      isGroup: false,
    };
    consult.forwardedSeq = ++call.forwardedConsults;
    try {
      await current.onInbound(call.platformId, null, message);
    } catch (err) {
      consult.settle(null);
      throw err;
    }
    const result = await consult.answer;
    if (res.destroyed || res.writableEnded) return;
    if (result === null) return reply(res, 409, 'This call is no longer active');
    reply(res, 200, JSON.stringify({ answer: result }), JSON_HEADERS);
  };

  /** Hand queued agent messages to the waiting poll, if there is one. */
  const flushUpdates = (call: GeminiCall): void => {
    if (!call.poll || call.updates.length === 0) return;
    const poll = call.poll;
    call.poll = undefined;
    poll(call.updates.splice(0));
  };

  /** Queue an agent message that answers no waiting consult; the page speaks it as an agent update. */
  const queueUpdate = (call: GeminiCall, text: string): string => {
    call.updates.push(text);
    if (call.updates.length > MAX_QUEUED_UPDATES) {
      call.updates.shift();
      log.warn('gemini-live: agent message queue full; dropped the oldest', { callId: call.callId });
    }
    flushUpdates(call);
    return `gemini-update:${call.callId}:${++call.updateSeq}`;
  };

  /** GET /gemini/messages: long-poll for queued agent messages. */
  const pollGeminiMessages = async (res: http.ServerResponse, call: GeminiCall | null): Promise<void> => {
    if (!call) return reply(res, 409, 'This call is no longer active');
    // A newer poll replaces a stale one, which is answered empty.
    call.poll?.([]);
    const messages = await new Promise<string[] | null>((resolve) => {
      const done = (value: string[] | null): void => {
        clearTimeout(timer);
        if (call.poll === done) call.poll = undefined;
        resolve(value);
      };
      const timer = setTimeout(() => done([]), GEMINI_POLL_MS);
      timer.unref();
      call.poll = done;
      res.on('close', () => done([]));
      flushUpdates(call);
    });
    if (res.destroyed || res.writableEnded) {
      // The page went away between the hand-off and the write; keep the messages for its next poll.
      if (messages?.length && !call.ended) call.updates.unshift(...messages);
      return;
    }
    if (messages === null) return reply(res, 409, 'This call is no longer active');
    reply(res, 200, JSON.stringify({ messages }), JSON_HEADERS);
  };

  const parseJsonObject = (raw: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  /** /webhook/voice/gemini[/token|/consult|/messages|/end]: the browser-direct Gemini Live path. */
  const handleGemini = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: string,
    url: URL,
    token: string,
  ): Promise<void> => {
    const gemini = config.gemini;
    if (!gemini) return reply(res, 503, 'Gemini voice is not configured on this host');
    if (route === 'gemini') {
      if (req.method !== 'GET') return reply(res, 405, 'GET only');
      res.writeHead(200, GEMINI_PAGE_HEADERS);
      res.end(geminiCallPageHtml());
      return;
    }
    if (route === 'gemini/messages') {
      if (req.method !== 'GET') return reply(res, 405, 'GET only');
      if (!tokens.has(token)) return reply(res, 403, 'Unknown call link');
      return pollGeminiMessages(res, activeGeminiCall(lineIdForToken(token), url.searchParams.get('callId')));
    }
    if (req.method !== 'POST') return reply(res, 405, 'POST only');
    if (!tokens.has(token)) return reply(res, 403, 'Unknown call link');
    const platformId = lineIdForToken(token);
    if (route === 'gemini/token') return startGeminiCall(res, platformId, gemini);
    if (route !== 'gemini/consult' && route !== 'gemini/end') return reply(res, 404, 'Not found');
    const body = parseJsonObject(await readBody(req, MAX_GEMINI_BODY_BYTES));
    if (!body) return reply(res, 400, 'Body must be a JSON object');
    const call = activeGeminiCall(platformId, body.callId);
    if (route === 'gemini/end') {
      // Ends the host's record only; the minutes were charged at mint and are not given back.
      if (call) endGeminiCall(call, 'hangup');
      return reply(res, 204, '');
    }
    return consultGemini(res, call, body);
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
      if (route === 'gemini' || route.startsWith('gemini/')) return await handleGemini(req, res, route, url, token);
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

  /**
   * An agent message for a Gemini call. The first reply to a waiting consult answers it, together
   * with the waiting consults the agent got after it: the agent batches the messages that queued
   * while it was busy and replies once, in reply to the first. Consults it got earlier belong to an
   * earlier turn and keep waiting for their own reply. Everything else (an interim reply followed
   * by the real one, a reply after the timeout line, a proactive message) is queued for the page,
   * which speaks it as an agent update.
   */
  const deliverToGemini = async (
    call: GeminiCall,
    text: string,
    functionCallId: string | null,
  ): Promise<string | undefined> => {
    if (!text.trim()) throw new Error('gemini-live: reply contains no speakable text');
    const waiting = [...call.consults.values()];
    if (!(await checkGeminiAccess(call))) throw new Error('gemini-live: caller access has been revoked');
    const target = functionCallId ? call.consults.get(functionCallId) : undefined;
    if (functionCallId && target && waiting.includes(target)) {
      const from = target.forwardedSeq ?? 0;
      for (const consult of waiting) if ((consult.forwardedSeq ?? -1) >= from) consult.settle(text);
      return geminiConsultMessageId(call.callId, functionCallId);
    }
    return queueUpdate(call, text);
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
        gemini: config.gemini ? config.gemini.model || DEFAULT_GEMINI_LIVE_MODEL : 'off',
        livekit: config.livekit ? config.livekit.url : 'off',
      });
    },

    async teardown(): Promise<void> {
      connected = false;
      for (const call of [...lines.values()]) {
        closeCall(call, 'teardown');
      }
      for (const call of [...geminiCalls.values()]) endGeminiCall(call, 'teardown');
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
      const geminiTarget = message.inReplyTo ? parseGeminiConsultMessageId(message.inReplyTo) : null;
      if (geminiTarget) {
        const gemini = geminiCalls.get(platformId);
        if (gemini?.callId !== geminiTarget.callId) {
          // An answer for a call that is over must not be spoken into a later one; retrying cannot help.
          log.warn('gemini-live: dropping a reply for an ended call', { platformId, ...geminiTarget });
          return undefined;
        }
        return deliverToGemini(gemini, text, geminiTarget.functionCallId);
      }
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
      const gemini = geminiCalls.get(platformId);
      if ((!call || call.session.isClosed() || !call.socket) && gemini) return deliverToGemini(gemini, text, null);
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
export function parseWalkieSilenceMs(raw: string | undefined): number | undefined {
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
      'GEMINI_LIVE_MODEL',
      'GEMINI_LIVE_VOICE',
      'GEMINI_LIVE_MAX_CALL_SECONDS',
      'LIVEKIT_URL',
      'LIVEKIT_WORKER_URL',
      'LIVEKIT_API_KEY',
      'LIVEKIT_API_SECRET',
      'LIVEKIT_AGENT_NAME',
      'WALKIE_STT_MODEL',
      'WALKIE_TTS_MODEL',
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
      gemini: env.GEMINI_API_KEY
        ? {
            apiKey: env.GEMINI_API_KEY,
            model: env.GEMINI_LIVE_MODEL,
            voice: env.GEMINI_LIVE_VOICE,
            maxCallDurationMs: Number(env.GEMINI_LIVE_MAX_CALL_SECONDS ?? 600) * 1000,
          }
        : undefined,
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
                ttsModel: env.WALKIE_TTS_MODEL,
                ttsVoice: env.WALKIE_TTS_VOICE,
                silenceMs: parseWalkieSilenceMs(env.WALKIE_SILENCE_MS),
              },
              mirror: (env.WALKIE_MIRROR || 'telegram').trim().toLowerCase(),
            }
          : undefined,
    });
  },
  defaults: GPT_LIVE_DEFAULTS,
});
