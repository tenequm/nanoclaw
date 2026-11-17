import net from 'node:net';
import type { IncomingMessage } from 'node:http';
import { envValue } from '../../env.js';
import { log } from '../../log.js';

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

// Refresh at most once a minute to avoid synchronous config reads on the request path.
let proxyCache: { raw: string | undefined; set: CidrSet; checkedAt: number } | undefined;
function trustedProxies(): CidrSet {
  const now = performance.now();
  if (!proxyCache || now - proxyCache.checkedAt >= 60_000) {
    const raw = envValue('VOICE_MODE_TRUSTED_PROXY_CIDRS');
    const set =
      proxyCache && proxyCache.raw === raw ? proxyCache.set : parseCidrs(raw, 'VOICE_MODE_TRUSTED_PROXY_CIDRS');
    proxyCache = { raw, set, checkedAt: now };
  }
  return proxyCache.set;
}
export function appPeerAllowed(req: IncomingMessage): boolean {
  return isLoopbackAddress(req.socket.remoteAddress) || trustedProxies().has(req.socket.remoteAddress);
}
export function clientAddress(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? 'unknown';
  const trusted = trustedProxies();
  if (!trusted.has(peer)) return peer;
  const hops = [req.headers['x-forwarded-for'] ?? []]
    .flat()
    .flatMap((h) => h.split(','))
    .map((h) => h.trim())
    .filter(Boolean);
  return hops.findLast((h) => !trusted.has(h)) ?? peer;
}
