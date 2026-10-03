/**
 * Voice channel: browser calls with a NanoClaw agent. The caller talks to the
 * line's real agent: each turn of speech is transcribed and handed to the
 * agent, and the agent's own reply is spoken back. The call itself runs on
 * LiveKit (src/channels/voice-livekit.ts, with the worker in
 * src/voice-livekit-worker.ts); this module is the channel adapter around it.
 *
 * Shape: native adapter (no Chat SDK bridge). A *voice line* is one caller's
 * link to one agent: its platform id is `voice:<line id>`, where the line id
 * is the first 12 hex characters of the link token's SHA-256, so the token
 * itself never reaches the database, the logs or the agent's messages. The
 * messaging group and its wiring are created once (by the skill). There are
 * no threads. One call is active per line at a time; the newest wins.
 *
 * The link token gates the HTTP routes: a request without a known `t` gets a
 * 403 before any room is created. The page is at `/voice?t=<token>` behind a
 * loopback front (or a trusted reverse proxy) that terminates TLS.
 */
import { createHash } from 'node:crypto';
import type http from 'node:http';
import net from 'node:net';

import type { ChannelAdapter, ChannelDefaults, ChannelSetup, InboundEvent, OutboundMessage } from './adapter.js';
import { resolveThreadPolicy } from './channel-defaults.js';
import { getChannelAdapter, getChannelDefaults, registerChannelAdapter } from './channel-registry.js';
import type { VoiceUiConfig } from './voice-call-page.js';
import { resolveVoiceLine, type ResolveLineOptions, type VoiceLine } from './voice-line.js';
import { createLiveKitVoice, parseLiveKitUtteranceId, type LiveKitVoiceConfig } from './voice-livekit.js';
import { DEFAULT_VOICE_MIRROR, wakePhrase } from './voice-livekit-protocol.js';
import { getMessagingGroupAgentByPair, getMessagingGroupWithAgentCount } from '../db/messaging-groups.js';
import { findSessionByAgentGroup, findSessionForAgent } from '../db/sessions.js';
import { expediteDelivery } from '../delivery.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { holdIdleCeiling } from '../reconcile-session.js';
import { requestWake } from '../request-wake.js';
import type { Session } from '../types.js';
import { registerRootHandler, registerWebhookHandler } from '../webhook-server.js';

export const CHANNEL_TYPE = 'voice';
const MINUTE_MS = 60_000;
/** How often a running call rechecks that its caller may still use the line. */
const ACCESS_CHECK_INTERVAL_MS = 5000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** After a turn reaches the agent, its session's replies are picked up at once for this long, not on the 1 s poll. */
const CALL_REPLY_EXPEDITE_MS = 60_000;
/** A call's hold on its sessions' idle ceiling outlasts the longest call by this much, in case the end is missed. */
const CALL_HOLD_GRACE_MS = 5 * MINUTE_MS;

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

/**
 * The shared webhook server listens on every interface, and the voice routes are meant to be reached
 * through a loopback front (Tailscale Serve or a local reverse proxy) that terminates TLS.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** A set of address ranges from a comma-separated CIDR list (VOICE_TRUSTED_PROXY_CIDRS, VOICE_ALLOWED_CLIENT_CIDRS). */
export interface CidrSet {
  /** Whether any range was configured, valid or not: a list whose every entry is invalid matches nothing. */
  configured: boolean;
  has(address: string | undefined): boolean;
}

/** Parses `10.0.0.0/8, fd7a::/48, 192.0.2.7`; invalid entries are skipped with a warning (they match nothing). */
export function parseCidrs(raw: string | undefined, key: string): CidrSet {
  const list = new net.BlockList();
  const entries = (raw ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const [address, bits, extra] = entry.split('/');
    const type = net.isIPv4(address) ? 'ipv4' : net.isIPv6(address) ? 'ipv6' : null;
    const max = type === 'ipv4' ? 32 : 128;
    const prefix = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : NaN;
    if (!type || extra !== undefined || !(prefix >= 0 && prefix <= max)) {
      log.warn(`voice: ignoring an invalid ${key} entry`, { entry });
      continue;
    }
    list.addSubnet(address, prefix, type);
  }
  return {
    configured: entries.length > 0,
    has(address) {
      // An IPv4 peer on a dual-stack socket arrives as ::ffff:a.b.c.d.
      const plain = address?.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
      if (!plain) return false;
      const type = net.isIPv4(plain) ? 'ipv4' : net.isIPv6(plain) ? 'ipv6' : null;
      return type !== null && list.check(plain, type);
    },
  };
}

/** Who may reach the browser-facing voice routes besides loopback peers. */
export interface VoiceProxyPolicy {
  /** Reverse proxies whose X-Forwarded-For is believed; empty means none, today's loopback-only behaviour. */
  trustedProxies: CidrSet;
  /** Clients a trusted proxy may forward; not configured means any client it forwards. */
  allowedClients: CidrSet;
}

/**
 * Whether a browser-facing voice request is admitted: a loopback peer, or a trusted proxy forwarding
 * an allowed client. The client is the rightmost X-Forwarded-For hop outside the trusted proxies (the
 * leftmost when every hop is one): hops to its left are whatever the client claimed.
 */
export function admitsVoicePeer(
  policy: VoiceProxyPolicy,
  peer: string | undefined,
  forwardedFor: string | string[] | undefined,
): boolean {
  if (isLoopbackAddress(peer)) return true;
  if (!policy.trustedProxies.has(peer)) return false;
  if (!policy.allowedClients.configured) return true;
  const hops = [forwardedFor ?? []]
    .flat()
    .flatMap((h) => h.split(','))
    .map((h) => h.trim())
    .filter(Boolean);
  const client = hops.findLast((h) => !policy.trustedProxies.has(h)) ?? hops[0];
  return policy.allowedClients.has(client);
}

/** Browser routes under the short /voice prefix a reverse proxy forwards; the bare prefix is the call page. */
const CLEAN_PREFIX_ROUTES = new Set(['info', 'livekit', 'livekit/token', 'livekit/end']);
const LEGACY_PREFIX = /^\/webhook\/voice(?:\/|$)/;
const CLEAN_PREFIX = /^\/voice(?:\/|$)/;

/**
 * The voice route of a request path: anything under /webhook/voice (old links, the worker), or a
 * browser route under /voice. Null for a /voice path that is not one, the worker's routes included.
 */
export function voiceRoute(pathname: string): string | null {
  if (LEGACY_PREFIX.test(pathname)) return pathname.replace(LEGACY_PREFIX, '').replace(/\/+$/, '');
  if (!CLEAN_PREFIX.test(pathname)) return null;
  const route = pathname.replace(CLEAN_PREFIX, '').replace(/\/+$/, '') || 'livekit';
  return CLEAN_PREFIX_ROUTES.has(route) ? route : null;
}

/** The worker's routes keep their own per-call secret and stay loopback-only, never admitted through a proxy. */
const isWorkerRoute = (route: string): boolean => /^livekit\/agent(?:\/|$)/.test(route);

/**
 * A voice line is DM-shaped: every caller turn is for the agent (pattern '.'),
 * there are no threads and no platform mention concept. The link token is the
 * credential — whoever holds the link is the line's user. Only a named user
 * with explicit membership may start a call; both contexts are strict and the
 * skill creates a known-sender wiring.
 */
const VOICE_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'dm-only',
};

export interface VoiceConfig {
  /** Origin the caller's browser reaches the host at (for the call link). */
  publicUrl: string;
  /** Link tokens accepted on the HTTP routes; each is one voice line. */
  linkTokens: string[];
  /** The LiveKit server the calls run on. */
  livekit: LiveKitVoiceConfig;
  /** Resolves the named caller, single wiring and explicit access. Defaults to the central DB. */
  resolveLine?: (platformId: string, options?: ResolveLineOptions) => Promise<VoiceLine | null>;
  /** VOICE_VOCABULARY: comma-separated names every call's transcription is told; used by the default resolveLine. */
  vocabulary?: string;
  accessCheckIntervalMs?: number;
  /** Clock, overridable for tests. */
  now?: () => number;
  /** Look of the browser call page; injected at serve time, no rebuild needed (VOICE_UI). */
  ui?: VoiceUiConfig;
  /** The wake phrase the worker listens for (wakePhrase); null: `hey <agent>`. Unset: the page is not told. */
  wakePhrase?: string | null;
  maxCallDurationMs?: number;
  maxCallsPerHour?: number;
  /** Call time one line may use per UTC day. */
  maxCallMsPerDay?: number;
  /** Serve the voice routes to non-loopback peers too (VOICE_ALLOW_NON_LOOPBACK); for local development only. */
  allowNonLoopback?: boolean;
  /** VOICE_TRUSTED_PROXY_CIDRS: reverse proxies (e.g. a Docker bridge subnet) admitted for the browser routes. */
  trustedProxyCidrs?: string;
  /** VOICE_ALLOWED_CLIENT_CIDRS: clients those proxies may forward (X-Forwarded-For); unset is any. */
  allowedClientCidrs?: string;
  /** The session a call's turn went to: its replies are delivered without waiting on the poll. Test seam. */
  expediteReplies?: (session: Session) => void;
  /** How a call finds, starts and holds the agent session it talks to (findCallSession, requestWake, holdIdleCeiling). Test seams. */
  prewarm?: {
    findSession?: (route: Omit<InboundEvent, 'message'>, agentGroupId: string) => Promise<Session | undefined>;
    wake?: (session: Session) => Promise<boolean>;
    hold?: (sessionId: string, holder: string, untilMs: number) => () => void;
  };
}

/**
 * The active session a turn to `route` would be stored in, found without creating anything: the
 * router's own resolution (routeInbound / deliverToAgent in src/router.ts) for the one agent. None
 * when the chat, the wiring or the session does not exist yet; the first turn then creates it.
 */
export async function findCallSession(
  route: Omit<InboundEvent, 'message'>,
  agentGroupId: string,
): Promise<Session | undefined> {
  const instance = route.instance ?? route.channelType;
  const found = await getMessagingGroupWithAgentCount(route.channelType, route.platformId, instance);
  if (!found) return undefined;
  const { mg } = found;
  const wiring = await getMessagingGroupAgentByPair(mg.id, agentGroupId);
  if (!wiring) return undefined;
  const supportsThreads = getChannelAdapter(instance)?.supportsThreads === true;
  const threadsEnabled = resolveThreadPolicy(
    wiring.threads ?? null,
    getChannelDefaults(mg.instance ?? mg.channel_type, mg.channel_type),
    mg.is_group === 1,
    supportsThreads,
  );
  const threadId = threadsEnabled ? route.threadId : null;
  const mode =
    threadsEnabled && wiring.session_mode !== 'agent-shared' && mg.is_group !== 0 ? 'per-thread' : wiring.session_mode;
  if (mode === 'agent-shared') return findSessionByAgentGroup(agentGroupId);
  return findSessionForAgent(agentGroupId, mg.id, mode === 'shared' ? null : threadId);
}

/**
 * The line id for a link token: `voice:` + the first 12 hex characters of
 * the token's SHA-256. It is the platform id, the sender id and what the logs
 * show; the token itself stays in the adapter's allow-list and the call link.
 */
export function lineIdForToken(token: string): string {
  return `${CHANNEL_TYPE}:${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
}

/** The voice adapter, plus the call link of one of its lines for the `/voice` command. */
export interface VoiceChannelAdapter extends ChannelAdapter {
  /** The line's call page URL, or null when the line has no link token here. */
  callLink(platformId: string): string | null;
}

export function createVoiceAdapter(config: VoiceConfig): VoiceChannelAdapter {
  const tokens = new Set(config.linkTokens.map((t) => t.trim()).filter(Boolean));
  const proxyPolicy: VoiceProxyPolicy = {
    trustedProxies: parseCidrs(config.trustedProxyCidrs, 'VOICE_TRUSTED_PROXY_CIDRS'),
    allowedClients: parseCidrs(config.allowedClientCidrs, 'VOICE_ALLOWED_CLIENT_CIDRS'),
  };
  const resolveLine =
    config.resolveLine ??
    ((platformId: string, options?: ResolveLineOptions) =>
      resolveVoiceLine(platformId, undefined, { vocabulary: config.vocabulary, ...options }));
  const now = config.now ?? (() => Date.now());
  const expediteReplies =
    config.expediteReplies ?? ((session: Session) => expediteDelivery(session, CALL_REPLY_EXPEDITE_MS));
  const findSession = config.prewarm?.findSession ?? findCallSession;
  const wakeSession = config.prewarm?.wake ?? ((session: Session) => requestWake(session, 'voice-call'));
  const holdSession = config.prewarm?.hold ?? holdIdleCeiling;
  const maxCallDurationMs = config.maxCallDurationMs ?? 15 * 60_000;
  const maxCallsPerHour = config.maxCallsPerHour ?? 12;
  const maxCallMsPerDay = config.maxCallMsPerDay ?? 120 * MINUTE_MS;
  const accessCheckIntervalMs = config.accessCheckIntervalMs ?? ACCESS_CHECK_INTERVAL_MS;
  for (const [name, value] of Object.entries({ maxCallDurationMs, maxCallsPerHour })) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new Error(`voice: ${name} must be a positive bounded integer`);
    }
  }
  if (!Number.isSafeInteger(maxCallMsPerDay) || maxCallMsPerDay <= 0) {
    throw new Error('voice: maxCallMsPerDay must be a positive integer');
  }
  const starts = new Map<string, number[]>();
  let setup: ChannelSetup | null = null;
  let connected = false;
  /** Call time already used per line, for the UTC day (epoch day number) it was used on. */
  const usage = new Map<string, { day: number; usedMs: number }>();
  const utcDay = (t: number): number => Math.floor(t / DAY_MS);
  /** Time a call has run today; a call that started before midnight counts from midnight. */
  const elapsedTodayMs = (call: { startedAt: number }, t: number): number =>
    Math.max(0, t - Math.max(call.startedAt, utcDay(t) * DAY_MS));

  /** Today's call time on a line, including the call still running on it. */
  const usedTodayMs = (platformId: string, t: number): number => {
    const used = usage.get(platformId);
    const active = livekit.activeCall(platformId);
    return (used?.day === utcDay(t) ? used.usedMs : 0) + (active ? elapsedTodayMs(active, t) : 0);
  };

  /** Hourly start cap and daily minutes. Records the start when admitted. */
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

  /** Per live call: releases of its holds on the idle ceiling of the sessions it talks to, by session id. */
  const callHolds = new Map<string, Map<string, () => void>>();
  const holdForCall = (callId: string, sessionId: string): void => {
    const holds = callHolds.get(callId);
    if (!holds || holds.has(sessionId)) return;
    holds.set(
      sessionId,
      holdSession(sessionId, `voice-call:${callId}`, now() + maxCallDurationMs + CALL_HOLD_GRACE_MS),
    );
  };

  /**
   * The caller is in: start the agent the first turn goes to, so that turn meets a running agent,
   * and keep it from being reaped as idle while the call lasts. Nothing reaches the chat.
   */
  const prewarmCall = async (callId: string, route: Omit<InboundEvent, 'message'>, agentGroupId: string) => {
    const session = await findSession(route, agentGroupId);
    if (!session || !callHolds.has(callId)) return;
    holdForCall(callId, session.id);
    if (await wakeSession(session))
      log.info('livekit-voice: agent running for the call', { callId, sessionId: session.id });
  };

  const livekit = createLiveKitVoice(config.livekit, {
    ui: config.ui,
    resolveLine,
    admitStart,
    remainingTodayMs: (platformId, t) => maxCallMsPerDay - usedTodayMs(platformId, t),
    chargeUsage,
    // Resolves once the agent's session stored the turn (to answer, or as context), or with false once routing ended without that.
    routeTurn: (event) =>
      new Promise<boolean>((resolve, reject) => {
        if (!setup?.routeInboundEvent) {
          log.warn('livekit-voice: channel is not running; turn dropped', { platformId: event.platformId });
          return reject(new Error('the voice channel is not running'));
        }
        const onStored = (session: Session) => {
          expediteReplies(session);
          const turn = parseLiveKitUtteranceId(event.message.id);
          if (turn) holdForCall(turn.callId, session.id);
          resolve(true);
        };
        setup.routeInboundEvent({ ...event, onStored }).then(
          () => resolve(false),
          (err: unknown) => {
            log.error('livekit-voice: routing a turn failed', { platformId: event.platformId, err });
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
      }),
    callJoined: (callId, route, agentGroupId) => {
      if (callHolds.has(callId)) return;
      callHolds.set(callId, new Map());
      prewarmCall(callId, route, agentGroupId).catch((err: unknown) =>
        log.warn('livekit-voice: could not start the agent for the call', { callId, err }),
      );
    },
    callEnded: (callId) => {
      for (const release of callHolds.get(callId)?.values() ?? []) release();
      callHolds.delete(callId);
    },
    isRunning: () => connected,
    now,
    maxCallDurationMs,
    accessCheckIntervalMs,
  });

  const reply = (
    res: http.ServerResponse,
    status: number,
    body: string,
    headers: Record<string, string> = {},
  ): void => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };

  /** HTTP routes under /webhook/voice/… and the browser's under /voice/… on the shared webhook server. */
  const handleHttp = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parsed = voiceRoute(url.pathname);
    const token = url.searchParams.get('t') ?? '';
    // Before any token check: a link must not be usable, or probed, from the LAN over plain HTTP.
    const peer = req.socket.remoteAddress;
    if (!config.allowNonLoopback && !isLoopbackAddress(peer)) {
      const browserRoute = parsed !== null && !isWorkerRoute(parsed);
      if (!browserRoute || !admitsVoicePeer(proxyPolicy, peer, req.headers['x-forwarded-for'])) {
        if (proxyPolicy.trustedProxies.has(peer)) {
          log.warn('voice: refused a proxied voice request', { peer, forwardedFor: req.headers['x-forwarded-for'] });
        }
        return reply(res, 403, 'Voice calls are served through the host front only');
      }
    }
    if (parsed === null) return reply(res, 404, 'Not found');
    const route = parsed;
    try {
      // The shared webhook server has no unregister; after teardown the routes stay reachable
      // and must refuse rather than start calls for a channel that is no longer running.
      if (!connected || !setup) return reply(res, 503, 'Voice is not running');
      if (route === 'livekit' || route.startsWith('livekit/')) {
        return await livekit.handleHttp(req, res, route, url, tokens, lineIdForToken);
      }
      if (route === 'info') {
        // Who answers this line, so the page can greet by name before the call.
        if (req.method !== 'GET') return reply(res, 405, 'GET only');
        if (!tokens.has(token)) return reply(res, 403, 'Unknown call link');
        const line = await resolveLine(lineIdForToken(token));
        if (!line) return reply(res, 403, 'Caller access denied or voice line is not set up');
        const info = { agent: line.agent.name, caller: line.caller.name, wakePhrase: config.wakePhrase };
        return reply(res, 200, JSON.stringify(info), JSON_HEADERS);
      }
      reply(res, 404, 'Not found');
    } catch (err) {
      // The shared webhook server has no other way to answer the browser.
      log.error('voice: http route failed', { route, err });
      if (!res.headersSent) reply(res, 500, 'voice error');
      else res.end();
    }
  };

  return {
    name: CHANNEL_TYPE,
    channelType: CHANNEL_TYPE,
    supportsThreads: false,
    defaults: VOICE_DEFAULTS,

    callLink(platformId: string): string | null {
      const token = [...tokens].find((t) => lineIdForToken(t) === platformId);
      return token ? `${config.publicUrl.replace(/\/+$/, '')}/voice?t=${encodeURIComponent(token)}` : null;
    },

    async setup(cfg: ChannelSetup): Promise<void> {
      setup = cfg;
      registerWebhookHandler(CHANNEL_TYPE, handleHttp);
      registerRootHandler(CHANNEL_TYPE, handleHttp);
      connected = true;
      log.info('voice: ready', {
        callUrl: `${config.publicUrl.replace(/\/+$/, '')}/voice?t=<link token>`,
        trustedProxies: config.trustedProxyCidrs?.trim() || 'none',
        lines: tokens.size,
        livekit: config.livekit.url,
      });
    },

    async teardown(): Promise<void> {
      connected = false;
      await livekit.teardown();
      setup = null;
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const content = message.content as { text?: unknown; type?: unknown } | string;
      if (typeof content === 'object' && content?.type === 'ask_question') {
        throw new Error('voice: question cards are unsupported; ask the caller in plain text');
      }
      if (message.files?.length) throw new Error('voice: attachments cannot be delivered over a voice call');
      const text = typeof content === 'string' ? content : typeof content?.text === 'string' ? content.text : '';
      const target = message.inReplyTo ? parseLiveKitUtteranceId(message.inReplyTo) : null;
      const spoken = await livekit.deliver(platformId, target, message.inReplyTo, text);
      if (!spoken) throw new Error('voice: no active call on this line');
      return spoken.id;
    },

    async setTyping(platformId: string): Promise<void> {
      await livekit.setTyping(platformId);
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

/** VOICE_UI is a JSON object; anything unparsable falls back to the page defaults with a warning. */
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
    log.warn('voice: VOICE_UI must be a JSON object; using the default look');
  } catch (err) {
    log.warn('voice: VOICE_UI is not valid JSON; using the default look', { err });
  }
  return undefined;
}

/** VOICE_SILENCE_MS: how long the caller is silent before their turn ends; nonsense falls back to the default. */
function parseSilenceMs(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined;
  const ms = Number(raw);
  if (Number.isInteger(ms) && ms >= 300 && ms <= 30_000) return ms;
  log.warn('voice: VOICE_SILENCE_MS must be whole milliseconds between 300 and 30000; using the default');
  return undefined;
}

/** The settings a call cannot run without, beyond the link token; the worker holds the Gemini key, the host checks it is there. */
const LIVEKIT_REQUIRED = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'GEMINI_API_KEY'] as const;

registerChannelAdapter(CHANNEL_TYPE, {
  factory: () => {
    const env = readEnvFile([
      'VOICE_PUBLIC_URL',
      'VOICE_LINK_TOKEN',
      'VOICE_UI',
      'VOICE_MAX_CALL_SECONDS',
      'VOICE_MAX_CALLS_PER_HOUR',
      'VOICE_MAX_MINUTES_PER_DAY',
      'VOICE_ALLOW_NON_LOOPBACK',
      'VOICE_TRUSTED_PROXY_CIDRS',
      'VOICE_ALLOWED_CLIENT_CIDRS',
      'VOICE_VOCABULARY',
      ...LIVEKIT_REQUIRED,
      'LIVEKIT_WORKER_URL',
      'LIVEKIT_AGENT_NAME',
      'VOICE_STT_MODEL',
      'VOICE_STT_FALLBACK_MODEL',
      'VOICE_TTS_MODEL',
      'VOICE_TTS_FALLBACK_MODEL',
      'VOICE_TTS_VOICE',
      'VOICE_SILENCE_MS',
      'VOICE_MIRROR',
      'VOICE_WAKE_MODEL',
      'VOICE_WAKE_PHRASE',
    ]);
    if (!env.VOICE_LINK_TOKEN) {
      if (env.LIVEKIT_URL) log.warn('voice: VOICE_LINK_TOKEN is not set; the channel stays offline');
      return null;
    }
    const missing = LIVEKIT_REQUIRED.filter((key) => !env[key]);
    if (missing.length > 0) {
      log.warn('voice: LiveKit is not configured; the channel stays offline', { missing });
      return null;
    }
    const linkTokens = env.VOICE_LINK_TOKEN.split(',');
    const short = linkTokens.map((t) => t.trim()).filter((t) => t && t.length < 32);
    if (short.length > 0) {
      log.warn('voice: link tokens shorter than 32 characters are weak; mint new ones with openssl rand -hex 16', {
        lines: short.map(lineIdForToken),
      });
    }
    return createVoiceAdapter({
      publicUrl: (env.VOICE_PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, ''),
      linkTokens,
      ui: parseUiConfig(env.VOICE_UI),
      wakePhrase: wakePhrase(env),
      allowNonLoopback: env.VOICE_ALLOW_NON_LOOPBACK === '1',
      trustedProxyCidrs: env.VOICE_TRUSTED_PROXY_CIDRS,
      allowedClientCidrs: env.VOICE_ALLOWED_CLIENT_CIDRS,
      maxCallDurationMs: Number(env.VOICE_MAX_CALL_SECONDS ?? 900) * 1000,
      maxCallsPerHour: Number(env.VOICE_MAX_CALLS_PER_HOUR ?? 12),
      maxCallMsPerDay: Number(env.VOICE_MAX_MINUTES_PER_DAY ?? 120) * 60_000,
      vocabulary: env.VOICE_VOCABULARY,
      livekit: {
        url: env.LIVEKIT_URL,
        serverUrl: env.LIVEKIT_WORKER_URL,
        apiKey: env.LIVEKIT_API_KEY,
        apiSecret: env.LIVEKIT_API_SECRET,
        agentName: env.LIVEKIT_AGENT_NAME,
        speech: {
          sttModel: env.VOICE_STT_MODEL,
          sttFallbackModel: env.VOICE_STT_FALLBACK_MODEL,
          ttsModel: env.VOICE_TTS_MODEL,
          ttsFallbackModel: env.VOICE_TTS_FALLBACK_MODEL,
          ttsVoice: env.VOICE_TTS_VOICE,
          silenceMs: parseSilenceMs(env.VOICE_SILENCE_MS),
        },
        mirror: (env.VOICE_MIRROR || DEFAULT_VOICE_MIRROR).trim().toLowerCase(),
      },
    });
  },
  defaults: VOICE_DEFAULTS,
});
