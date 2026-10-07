/**
 * Voice channel: browser calls with a NanoClaw agent. The caller talks to the
 * line's real agent: each turn of speech is transcribed and handed to the
 * agent, and the agent's own reply is spoken back. The call itself runs on
 * LiveKit (src/channels/voice-mode-livekit.ts, with the worker in
 * src/voice-mode-worker.ts); this module is the channel adapter around it.
 *
 * Shape: native adapter (no Chat SDK bridge). A *voice line* is one caller's
 * link to one agent: a voice_mode_lines row that `/voice` creates
 * (voice-mode-command.ts), with the platform id `voice-mode:<line id>` for a
 * random line id. The row keeps only the link token's SHA-256, so the token
 * itself never reaches the database, the logs or the agent's messages. A line
 * from before the rename keeps its `voice:<hash>` id, its chat and wiring, and
 * its token in `.env`. There are no threads. One call is active per line at a
 * time; the newest wins.
 *
 * The link token gates the HTTP routes: a request without a known `t` gets a
 * 403 before any room is created. The page is at `/voice?t=<token>` behind a
 * loopback front (or a trusted reverse proxy) that terminates TLS.
 */
import http from 'node:http';
import net from 'node:net';

import type { ChannelAdapter, ChannelDefaults, ChannelSetup, InboundEvent, OutboundMessage } from './adapter.js';
import { wiringThreadsEnabled } from './channel-defaults.js';
import { getChannelAdapterExact, registerChannelAdapter } from './channel-registry.js';
import type { VoiceModeUiConfig } from './voice-mode-page.js';
import {
  LEGACY_VOICE_CHANNEL,
  linePlatformId,
  resolveVoiceModeLine,
  VOICE_MODE_CHANNEL,
  type ResolveLineOptions,
  type VoiceModeLine,
} from './voice-mode-line.js';
import { createLiveKitVoice, parseLiveKitUtteranceId, type LiveKitVoiceConfig } from './voice-mode-livekit.js';
import {
  DEFAULT_LIVEKIT_AGENT_NAME,
  DEFAULT_VOICE_MIRROR,
  LIVEKIT_PROTOCOL_VERSION,
  wakePhrase,
  voiceModeEnv,
  voiceModeEnvKeys,
  parseVoiceLanguages,
} from './voice-mode-protocol.js';
import { getMessagingGroupAgentByPair, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { findSessionByAgentGroup, findSessionForAgent } from '../db/sessions.js';
import { expediteDelivery } from '../delivery.js';
import { findVoiceModeLineByToken, hashLinkToken } from '../db/voice-mode-lines.js';
import { routeVoiceModeTurn } from './voice-mode-route.js';
import { handleVoiceCommand } from './voice-mode-command.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { requestWake } from '../request-wake.js';
import type { Session } from '../types.js';
import { registerRootHandler, registerWebhookHandler } from '../webhook-server.js';

const MINUTE_MS = 60_000;
/** How often a running call rechecks that its caller may still use the line. */
const ACCESS_CHECK_INTERVAL_MS = 5000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** After a turn reaches the agent, its session's replies are picked up at once for this long, not on the 1 s poll. */
const CALL_REPLY_EXPEDITE_MS = 60_000;

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

/**
 * The shared webhook server listens on every interface, and the voice routes are meant to be reached
 * through a loopback front (Tailscale Serve or a local reverse proxy) that terminates TLS.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** A set of address ranges from a comma-separated CIDR list (VOICE_MODE_TRUSTED_PROXY_CIDRS, VOICE_MODE_ALLOWED_CLIENT_CIDRS). */
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
      log.warn(`voice-mode: ignoring an invalid ${key} entry`, { entry });
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
export interface VoiceModeProxyPolicy {
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
export function admitsVoiceModePeer(
  policy: VoiceModeProxyPolicy,
  peer: string | undefined,
  forwardedFor: string | string[] | undefined,
): boolean {
  const trusted = policy.trustedProxies.has(peer);
  if (isLoopbackAddress(peer) && !(trusted && policy.allowedClients.configured)) return true;
  if (!trusted) return false;
  if (!policy.allowedClients.configured) return true;
  const hops = [forwardedFor ?? []]
    .flat()
    .flatMap((h) => h.split(','))
    .map((h) => h.trim())
    .filter(Boolean);
  const client = hops.findLast((h) => !policy.trustedProxies.has(h)) ?? hops[0] ?? peer;
  return policy.allowedClients.has(client);
}

/** Browser routes under the short /voice prefix a reverse proxy forwards; the bare prefix is the call page. */
const CLEAN_PREFIX_ROUTES = new Set(['info', 'livekit', 'livekit/token', 'livekit/end']);
const WEBHOOK_PREFIX = /^\/webhook\/(voice(?:-mode)?)(?:\/|$)/;
const CLEAN_PREFIX = /^\/voice(?:\/|$)/;

/**
 * The voice route of a request path: anything under /webhook/voice-mode, a browser route under
 * /webhook/voice (old links), or a browser route under /voice. Null for any other path, the
 * worker's routes outside /webhook/voice-mode included.
 */
export function voiceRoute(pathname: string): string | null {
  const webhook = WEBHOOK_PREFIX.exec(pathname);
  if (webhook) {
    const route = pathname.slice(webhook[0].length).replace(/\/+$/, '');
    // A front that forwards old /webhook/voice links may forward remote requests; the worker never uses it.
    return webhook[1] === 'voice-mode' || !isWorkerRoute(route) ? route : null;
  }
  if (!CLEAN_PREFIX.test(pathname)) return null;
  const route = pathname.replace(CLEAN_PREFIX, '').replace(/\/+$/, '') || 'livekit';
  return CLEAN_PREFIX_ROUTES.has(route) ? route : null;
}

/**
 * The worker's routes, only under /webhook/voice-mode: they keep their own per-call secret and stay
 * loopback-only, never admitted through a proxy.
 */
const isWorkerRoute = (route: string): boolean => /^livekit\/agent(?:\/|$)/.test(route);

/**
 * A voice line is DM-shaped: every caller turn is for the agent (pattern '.'),
 * there are no threads and no platform mention concept. The link token is the
 * credential: whoever holds the link is the line's caller. A call needs the
 * hashed-line table's caller to hold an owner or admin role over the agent, or,
 * failing a row there, a legacy line's named user with explicit membership on a
 * strict chat with a known-sender wiring.
 */
const VOICE_MODE_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'dm-only',
};

export interface VoiceModeConfig {
  /** Origin the caller's browser reaches the host at (for the call link). */
  publicUrl: string;
  /** The separate page listener's port; unset: no separate listener (the host's webhook port still serves the page). */
  pagePort?: number;
  /** The address the page listener binds; loopback unless set (VOICE_MODE_PAGE_HOST). */
  pageHost?: string;
  /** VOICE_MODE_PORT was set: a page listener that cannot bind fails setup instead of being skipped. */
  pagePortRequired?: boolean;
  /** Link tokens accepted on the HTTP routes; each is one voice line. */
  linkTokens?: string[];
  /** The line a link token opens, by platform id, or null. Defaults to the hashed-line table, then the env tokens. */
  lineForToken?: (token: string) => Promise<string | null>;
  /** Routes a turn instead of routeVoiceModeTurn; resolves true once the agent's session stored it. Test seam. */
  routeTurn?: (event: InboundEvent) => Promise<boolean>;
  /** The LiveKit server the calls run on. */
  livekit: LiveKitVoiceConfig;
  /** Resolves the named caller, single wiring and explicit access. Defaults to the central DB. */
  resolveLine?: (platformId: string, options?: ResolveLineOptions) => Promise<VoiceModeLine | null>;
  /** VOICE_MODE_VOCABULARY: comma-separated names every call's transcription is told; used by the default resolveLine. */
  vocabulary?: string;
  accessCheckIntervalMs?: number;
  /** Clock, overridable for tests. */
  now?: () => number;
  /** Look of the browser call page; injected at serve time, no rebuild needed (VOICE_MODE_UI). */
  ui?: VoiceModeUiConfig;
  /** The wake phrase the worker listens for (wakePhrase); null: `hey <agent>`. Unset: the page is not told. */
  wakePhrase?: string | null;
  maxCallDurationMs?: number;
  maxCallsPerHour?: number;
  /** Call time one line may use per UTC day. */
  maxCallMsPerDay?: number;
  /** Serve the voice routes to non-loopback peers too (VOICE_MODE_ALLOW_NON_LOOPBACK); for local development only. */
  allowNonLoopback?: boolean;
  /** VOICE_MODE_TRUSTED_PROXY_CIDRS: reverse proxies (e.g. a Docker bridge subnet) admitted for the browser routes. */
  trustedProxyCidrs?: string;
  /** VOICE_MODE_ALLOWED_CLIENT_CIDRS: clients those proxies may forward (X-Forwarded-For); unset is any. */
  allowedClientCidrs?: string;
  /** The session a call's turn went to: its replies are delivered without waiting on the poll. Test seam. */
  expediteReplies?: (session: Session) => void;
  /** How a call finds and starts the agent session it talks to (findCallSession, requestWake). Test seams. */
  prewarm?: {
    findSession?: (route: Omit<InboundEvent, 'message'>, agentGroupId: string) => Promise<Session | undefined>;
    wake?: (session: Session) => Promise<boolean>;
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
  const mg = await getMessagingGroupByPlatform(
    route.channelType,
    route.platformId,
    route.instance ?? route.channelType,
  );
  if (!mg) return undefined;
  const wiring = await getMessagingGroupAgentByPair(mg.id, agentGroupId);
  if (!wiring) return undefined;
  const threadsEnabled = wiringThreadsEnabled(wiring, mg);
  const threadId = threadsEnabled ? route.threadId : null;
  const mode =
    threadsEnabled && wiring.session_mode !== 'agent-shared' && mg.is_group !== 0 ? 'per-thread' : wiring.session_mode;
  if (mode === 'agent-shared') return findSessionByAgentGroup(agentGroupId);
  return findSessionForAgent(agentGroupId, mg.id, mode === 'shared' ? null : threadId);
}

/** The id an env link token's line had before the voice-mode rename: `voice:` + its SHA-256's first 12 hex characters. */
export function legacyLineIdForToken(token: string): string {
  return `${LEGACY_VOICE_CHANNEL}:${hashLinkToken(token).slice(0, 12)}`;
}

/** The voice adapter, plus the call link of one of its lines for the `/voice` command. */
export interface VoiceModeChannelAdapter extends ChannelAdapter {
  /** The line's call page URL, or null when the line has no link token here. */
  callLink(platformId: string): string | null;
  /** The call page URL for a link token. */
  callUrl(token: string): string;
  /** `/voice` in a chat, with this adapter's call URLs and saved links (voice-mode-command.ts). */
  handleVoiceCommand(event: InboundEvent): Promise<boolean>;
}

export function createVoiceModeAdapter(config: VoiceModeConfig): VoiceModeChannelAdapter {
  /** Main's env link tokens by the legacy line id each opens; lines made since are hashed-token rows. */
  const legacyLines = new Map(
    (config.linkTokens ?? [])
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => [t, legacyLineIdForToken(t)]),
  );
  const lineForToken =
    config.lineForToken ??
    (async (token: string) => {
      const line = await findVoiceModeLineByToken(token);
      if (line) return linePlatformId(line.line_id);
      const legacy = legacyLines.get(token);
      if (!legacy) return null;
      return (await getMessagingGroupByPlatform(LEGACY_VOICE_CHANNEL, legacy, LEGACY_VOICE_CHANNEL)) ? legacy : null;
    });
  const callUrl = (token: string): string =>
    `${config.publicUrl.replace(/\/+$/, '')}/voice?t=${encodeURIComponent(token)}`;
  const callLink = (platformId: string): string | null => {
    const token = [...legacyLines].find(([, id]) => id === platformId)?.[0];
    return token ? callUrl(token) : null;
  };
  const proxyPolicy: VoiceModeProxyPolicy = {
    trustedProxies: parseCidrs(config.trustedProxyCidrs, 'VOICE_MODE_TRUSTED_PROXY_CIDRS'),
    allowedClients: parseCidrs(config.allowedClientCidrs, 'VOICE_MODE_ALLOWED_CLIENT_CIDRS'),
  };
  const resolveLine =
    config.resolveLine ??
    ((platformId: string, options?: ResolveLineOptions) =>
      resolveVoiceModeLine(platformId, { vocabulary: config.vocabulary, ...options }));
  const now = config.now ?? (() => Date.now());
  const expediteReplies =
    config.expediteReplies ?? ((session: Session) => expediteDelivery(session, CALL_REPLY_EXPEDITE_MS));
  const findSession = config.prewarm?.findSession ?? findCallSession;
  const wakeSession = config.prewarm?.wake ?? ((session: Session) => requestWake(session, 'voice-call'));
  const maxCallDurationMs = config.maxCallDurationMs ?? 15 * 60_000;
  const maxCallsPerHour = config.maxCallsPerHour ?? 12;
  const maxCallMsPerDay = config.maxCallMsPerDay ?? 120 * MINUTE_MS;
  const accessCheckIntervalMs = config.accessCheckIntervalMs ?? ACCESS_CHECK_INTERVAL_MS;
  for (const [name, value] of Object.entries({ maxCallDurationMs, maxCallsPerHour })) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new Error(`voice-mode: ${name} must be a positive bounded integer`);
    }
  }
  if (!Number.isSafeInteger(maxCallMsPerDay) || maxCallMsPerDay <= 0) {
    throw new Error('voice-mode: maxCallMsPerDay must be a positive integer');
  }
  const starts = new Map<string, number[]>();
  let setup: ChannelSetup | null = null;
  let connected = false;
  let pageServer: http.Server | undefined;
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

  /** Calls whose caller joined and that have not ended: each is woken for once, and never after its end. */
  const joinedCalls = new Set<string>();

  /**
   * The caller is in: start the agent the first turn goes to, so that turn meets a running agent.
   * Nothing reaches the chat. A long silent call is reaped as idle like any session; its next turn
   * wakes the agent again.
   */
  const prewarmCall = async (callId: string, route: Omit<InboundEvent, 'message'>, agentGroupId: string) => {
    const session = await findSession(route, agentGroupId);
    if (!session || !joinedCalls.has(callId)) return;
    if (await wakeSession(session))
      log.info('livekit-voice-mode: agent running for the call', { callId, sessionId: session.id });
  };

  const livekit = createLiveKitVoice(config.livekit, {
    ui: config.ui,
    resolveLine,
    admitStart,
    remainingTodayMs: (platformId, t) => maxCallMsPerDay - usedTodayMs(platformId, t),
    chargeUsage,
    routeTurn: async (event, turn) => {
      if (!setup) throw new Error('the voice-mode channel is not running');
      const routed = { ...event, onStored: expediteReplies };
      try {
        return await (config.routeTurn ? config.routeTurn(routed) : routeVoiceModeTurn(routed, turn));
      } catch (err) {
        log.error('livekit-voice-mode: routing a turn failed', { platformId: event.platformId, err });
        throw err;
      }
    },
    callJoined: (callId, route, agentGroupId) => {
      if (joinedCalls.has(callId)) return;
      joinedCalls.add(callId);
      prewarmCall(callId, route, agentGroupId).catch((err: unknown) =>
        log.warn('livekit-voice-mode: could not start the agent for the call', { callId, err }),
      );
    },
    callEnded: (callId) => void joinedCalls.delete(callId),
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

  /** HTTP routes under /webhook/voice-mode/ and /webhook/voice/, and the browser's under /voice/, on the shared webhook server. */
  const handleHttp = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return reply(res, 400, 'Bad request');
    }
    // Dot segments (`/voice/../webhook/...`, `%2e%2e`) would route on a path the listener never checked.
    if (url.pathname !== (req.url ?? '/').split('?')[0]) return reply(res, 400, 'Bad request');
    const parsed = voiceRoute(url.pathname);
    const token = url.searchParams.get('t') ?? '';
    // The worker calls from the same host; a forwarded request came through a front from elsewhere.
    if (parsed !== null && isWorkerRoute(parsed) && (req.headers['x-forwarded-for'] || req.headers.forwarded)) {
      return reply(res, 403, 'Voice worker routes are not served through a proxy');
    }
    // Before any token check: a link must not be usable, or probed, from the LAN over plain HTTP.
    const peer = req.socket.remoteAddress;
    if (!config.allowNonLoopback) {
      const browserRoute = parsed !== null && !isWorkerRoute(parsed);
      if (
        browserRoute
          ? !admitsVoiceModePeer(proxyPolicy, peer, req.headers['x-forwarded-for'])
          : !isLoopbackAddress(peer)
      ) {
        if (proxyPolicy.trustedProxies.has(peer)) {
          log.warn('voice-mode: refused a proxied voice request', {
            peer,
            forwardedFor: req.headers['x-forwarded-for'],
          });
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
        return await livekit.handleHttp(req, res, route, url, lineForToken);
      }
      if (route === 'info') {
        // Who answers this line, so the page can greet by name before the call.
        if (req.method !== 'GET') return reply(res, 405, 'GET only');
        const platformId = await lineForToken(token);
        if (!platformId) return reply(res, 403, 'Unknown call link');
        const line = await resolveLine(platformId);
        if (!line) return reply(res, 403, 'Caller access denied or voice line is not set up');
        const info = {
          protocol: LIVEKIT_PROTOCOL_VERSION,
          agent: line.agent.name,
          caller: line.caller.name,
          wakePhrase: config.wakePhrase,
        };
        return reply(res, 200, JSON.stringify(info), JSON_HEADERS);
      }
      reply(res, 404, 'Not found');
    } catch (err) {
      // The shared webhook server has no other way to answer the browser.
      log.error('voice-mode: http route failed', { route, err });
      if (!res.headersSent) reply(res, 500, 'voice error');
      else res.end();
    }
  };

  return {
    name: VOICE_MODE_CHANNEL,
    channelType: VOICE_MODE_CHANNEL,
    supportsThreads: false,
    defaults: VOICE_MODE_DEFAULTS,

    callUrl,
    handleVoiceCommand: (event: InboundEvent): Promise<boolean> => handleVoiceCommand(event, callUrl, callLink),
    callLink,

    async setup(cfg: ChannelSetup): Promise<void> {
      setup = cfg;
      registerWebhookHandler(VOICE_MODE_CHANNEL, handleHttp);
      registerRootHandler('voice', handleHttp);
      registerWebhookHandler('voice', handleHttp);
      if (config.pagePort !== undefined) {
        const server = http.createServer((req, res) => {
          let pathname: string;
          try {
            pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
          } catch {
            // A request line like `GET //` is not a parsable URL.
            return reply(res, 400, 'Bad request');
          }
          if (!CLEAN_PREFIX.test(pathname)) return reply(res, 404, 'Not found');
          handleHttp(req, res).catch((err: unknown) => {
            log.error('voice-mode: page request failed', { err });
            if (!res.headersSent) reply(res, 500, 'voice error');
            else res.end();
          });
        });
        const address = `${config.pageHost ?? DEFAULT_PAGE_HOST}:${config.pagePort}`;
        try {
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(config.pagePort, config.pageHost ?? DEFAULT_PAGE_HOST, () => {
              server.off('error', reject);
              resolve();
            });
          });
          server.on('error', (err) => log.error('voice-mode: page listener error', { address, err }));
          pageServer = server;
        } catch (err) {
          if (config.pagePortRequired) throw err;
          // The webhook port still serves the page; a default port that is taken must not take the channel down.
          log.error('voice-mode: the page listener could not bind; serving the page on the webhook port only', {
            address,
            err,
          });
        }
      }
      connected = true;
      log.info('voice-mode: ready', {
        callUrl: `${callUrl('')}<link token>`,
        trustedProxies: config.trustedProxyCidrs?.trim() || 'none',
        envTokens: legacyLines.size,
        livekit: config.livekit.url,
        protocol: LIVEKIT_PROTOCOL_VERSION,
        agentName: config.livekit.agentName || DEFAULT_LIVEKIT_AGENT_NAME,
        pageListener: pageServer ? `${config.pageHost ?? DEFAULT_PAGE_HOST}:${config.pagePort}` : 'off',
      });
    },

    async teardown(): Promise<void> {
      connected = false;
      const server = pageServer;
      pageServer = undefined;
      try {
        await livekit.teardown();
      } finally {
        if (server) {
          // A half-sent request would otherwise hold close() open until the headers timeout.
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        setup = null;
      }
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const content = message.content as { text?: unknown; type?: unknown } | string;
      if (typeof content === 'object' && content?.type === 'ask_question') {
        throw new Error('voice-mode: question cards are unsupported; ask the caller in plain text');
      }
      if (message.files?.length) throw new Error('voice-mode: attachments cannot be delivered over a voice call');
      const text = typeof content === 'string' ? content : typeof content?.text === 'string' ? content.text : '';
      const target = message.inReplyTo ? parseLiveKitUtteranceId(message.inReplyTo) : null;
      const spoken = await livekit.deliver(platformId, target, message.inReplyTo, text);
      if (!spoken) throw new Error('voice-mode: no active call on this line');
      return spoken.id;
    },

    async setTyping(platformId: string): Promise<void> {
      await livekit.setTyping(platformId);
    },
  };
}

/**
 * The `voice` channel of lines made before the voice-mode rename: their chat, session and stored
 * messages keep the `voice` address, so core delivery and typing look up a `voice` adapter. This
 * one hands them to the live voice-mode adapter, whose engine runs those lines' calls too; it
 * serves no routes of its own and starts only after the voice-mode adapter is up.
 */
export function createLegacyVoiceAdapter(
  live: VoiceModeChannelAdapter,
): ChannelAdapter & Pick<VoiceModeChannelAdapter, 'callLink'> {
  return {
    name: LEGACY_VOICE_CHANNEL,
    channelType: LEGACY_VOICE_CHANNEL,
    supportsThreads: false,
    defaults: VOICE_MODE_DEFAULTS,
    async setup() {},
    async teardown() {},
    isConnected: () => live.isConnected(),
    deliver: (platformId, threadId, message) => live.deliver(platformId, threadId, message),
    async setTyping(platformId, threadId) {
      await live.setTyping?.(platformId, threadId);
    },
    callLink: (platformId) => live.callLink(platformId),
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

/** VOICE_MODE_UI is a JSON object; anything unparsable falls back to the page defaults with a warning. */
export function parseUiConfig(raw: string | undefined): VoiceModeUiConfig | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // Only the documented keys travel to the page; the page validates values.
      const src = parsed as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of UI_CONFIG_KEYS) if (key in src) out[key] = src[key];
      return out as VoiceModeUiConfig;
    }
    log.warn('voice-mode: VOICE_MODE_UI must be a JSON object; using the default look');
  } catch (err) {
    log.warn('voice-mode: VOICE_MODE_UI is not valid JSON; using the default look', { err });
  }
  return undefined;
}

const DEFAULT_PAGE_PORT = 3100;
const DEFAULT_PAGE_HOST = '127.0.0.1';

/**
 * VOICE_MODE_PORT and VOICE_MODE_PAGE_HOST: where the separate page listener binds, by default
 * 127.0.0.1:3100. `0` or `off` turns it off, for installs whose front already forwards /voice to the
 * host's webhook port. An unusable port falls back to the default with a warning. `explicit`: the
 * port was set, so a failed bind fails setup; the default is skipped instead.
 */
export function pageListener(
  rawPort: string | undefined,
  rawHost: string | undefined,
): { port: number; host: string; explicit: boolean } | null {
  const value = rawPort?.trim().toLowerCase();
  if (value === '0' || value === 'off') return null;
  const host = rawHost?.trim() || DEFAULT_PAGE_HOST;
  if (!value) return { port: DEFAULT_PAGE_PORT, host, explicit: false };
  const port = Number(value);
  if (Number.isInteger(port) && port > 0 && port < 65_536) return { port, host, explicit: true };
  log.warn(`voice-mode: VOICE_MODE_PORT must be a port number, 0 or off; using ${DEFAULT_PAGE_PORT}`);
  return { port: DEFAULT_PAGE_PORT, host, explicit: false };
}

/** VOICE_MODE_SILENCE_MS: how long the caller is silent before their turn ends; nonsense falls back to the default. */
function parseSilenceMs(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined;
  const ms = Number(raw);
  if (Number.isInteger(ms) && ms >= 300 && ms <= 30_000) return ms;
  log.warn('voice-mode: VOICE_MODE_SILENCE_MS must be whole milliseconds between 300 and 30000; using the default');
  return undefined;
}

/** The settings a call cannot run without, beyond the link token; the worker holds the Gemini key, the host checks it is there. */
const LIVEKIT_REQUIRED = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'GEMINI_API_KEY'] as const;

registerChannelAdapter(VOICE_MODE_CHANNEL, {
  factory: () => {
    const env = voiceModeEnv(
      readEnvFile(
        voiceModeEnvKeys([
          'VOICE_MODE_PUBLIC_URL',
          'VOICE_MODE_PORT',
          'VOICE_MODE_PAGE_HOST',
          'VOICE_MODE_LANGUAGES',
          'VOICE_MODE_LINK_TOKEN',
          'VOICE_MODE_UI',
          'VOICE_MODE_MAX_CALL_SECONDS',
          'VOICE_MODE_MAX_CALLS_PER_HOUR',
          'VOICE_MODE_MAX_MINUTES_PER_DAY',
          'VOICE_MODE_ALLOW_NON_LOOPBACK',
          'VOICE_MODE_TRUSTED_PROXY_CIDRS',
          'VOICE_MODE_ALLOWED_CLIENT_CIDRS',
          'VOICE_MODE_VOCABULARY',
          ...LIVEKIT_REQUIRED,
          'LIVEKIT_WORKER_URL',
          'LIVEKIT_AGENT_NAME',
          'VOICE_MODE_STT_MODEL',
          'VOICE_MODE_STT_FALLBACK_MODEL',
          'VOICE_MODE_TTS_MODEL',
          'VOICE_MODE_TTS_FALLBACK_MODEL',
          'VOICE_MODE_TTS_VOICE',
          'VOICE_MODE_SILENCE_MS',
          'VOICE_MODE_MIRROR',
          'VOICE_MODE_WAKE_MODEL',
          'VOICE_MODE_WAKE_PHRASE',
        ]),
      ),
      (message) => log.warn(message),
    );
    const missing = LIVEKIT_REQUIRED.filter((key) => !env[key]);
    if (missing.length > 0) {
      log.warn('voice-mode: LiveKit is not configured; the channel stays offline', { missing });
      return null;
    }
    const linkTokens = (env.VOICE_MODE_LINK_TOKEN ?? '').split(',');
    const short = linkTokens.map((t) => t.trim()).filter((t) => t && t.length < 32);
    if (short.length > 0) {
      log.warn('voice-mode: link tokens shorter than 32 characters are weak; replace their lines with /voice new', {
        lines: short.map(legacyLineIdForToken),
      });
    }
    const page = pageListener(env.VOICE_MODE_PORT, env.VOICE_MODE_PAGE_HOST);
    return createVoiceModeAdapter({
      pagePort: page?.port,
      pageHost: page?.host,
      pagePortRequired: page?.explicit,
      publicUrl: (env.VOICE_MODE_PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, ''),
      linkTokens,
      ui: parseUiConfig(env.VOICE_MODE_UI),
      wakePhrase: wakePhrase(env),
      allowNonLoopback: env.VOICE_MODE_ALLOW_NON_LOOPBACK === '1',
      trustedProxyCidrs: env.VOICE_MODE_TRUSTED_PROXY_CIDRS,
      allowedClientCidrs: env.VOICE_MODE_ALLOWED_CLIENT_CIDRS,
      maxCallDurationMs: Number(env.VOICE_MODE_MAX_CALL_SECONDS ?? 900) * 1000,
      maxCallsPerHour: Number(env.VOICE_MODE_MAX_CALLS_PER_HOUR ?? 12),
      maxCallMsPerDay: Number(env.VOICE_MODE_MAX_MINUTES_PER_DAY ?? 120) * 60_000,
      vocabulary: env.VOICE_MODE_VOCABULARY,
      livekit: {
        url: env.LIVEKIT_URL,
        languages: parseVoiceLanguages(env.VOICE_MODE_LANGUAGES),
        serverUrl: env.LIVEKIT_WORKER_URL,
        apiKey: env.LIVEKIT_API_KEY,
        apiSecret: env.LIVEKIT_API_SECRET,
        agentName: env.LIVEKIT_AGENT_NAME,
        speech: {
          sttModel: env.VOICE_MODE_STT_MODEL,
          sttFallbackModel: env.VOICE_MODE_STT_FALLBACK_MODEL,
          ttsModel: env.VOICE_MODE_TTS_MODEL,
          ttsFallbackModel: env.VOICE_MODE_TTS_FALLBACK_MODEL,
          ttsVoice: env.VOICE_MODE_TTS_VOICE,
          silenceMs: parseSilenceMs(env.VOICE_MODE_SILENCE_MS),
        },
        mirror: (env.VOICE_MODE_MIRROR || DEFAULT_VOICE_MIRROR).trim().toLowerCase(),
      },
    });
  },
  defaults: VOICE_MODE_DEFAULTS,
});

// Registered after voice-mode, so the registry has started that adapter when this factory runs.
registerChannelAdapter(LEGACY_VOICE_CHANNEL, {
  factory: () => {
    const live = getChannelAdapterExact(VOICE_MODE_CHANNEL) as VoiceModeChannelAdapter | undefined;
    return live ? createLegacyVoiceAdapter(live) : null;
  },
  defaults: VOICE_MODE_DEFAULTS,
});
