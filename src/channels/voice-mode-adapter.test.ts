/**
 * The voice adapter's request gate: which paths are voice routes, and which
 * peers may reach the browser routes through a reverse proxy. The routes
 * themselves are exercised over HTTP in voice-mode-livekit.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { admitsVoicePeer, pageRoute, parseCidrs, workerRoute, type VoiceProxyPolicy } from './voice-mode.js';

describe('voice routes and the reverse-proxy gate', () => {
  it('serves only browser routes on the page server and only the worker routes on the webhook server', () => {
    expect(pageRoute('/voice')).toBe('livekit');
    expect(pageRoute('/voice/')).toBe('livekit');
    expect(pageRoute('/voice/info')).toBe('info');
    expect(pageRoute('/voice/livekit/token')).toBe('livekit/token');
    expect(pageRoute('/voice/livekit/agent/events')).toBeNull();
    expect(pageRoute('/voice/livekit%2Fagent%2Fevents')).toBeNull();
    expect(pageRoute('/voice//livekit/agent/joined')).toBeNull();
    expect(pageRoute('/webhook/voice-mode/livekit')).toBeNull();
    expect(pageRoute('/voice/sip')).toBeNull();
    expect(pageRoute('/voicemail')).toBeNull();
    expect(workerRoute('/webhook/voice-mode/livekit/agent/events')).toBe('livekit/agent/events');
    expect(workerRoute('/webhook/voice-mode/livekit/agent')).toBe('livekit/agent');
    expect(workerRoute('/webhook/voice-mode/livekit/token')).toBeNull();
    expect(workerRoute('/webhook/voice-mode/livekit')).toBeNull();
    expect(workerRoute('/voice/livekit/agent/events')).toBeNull();
  });

  const policy = (trusted?: string, allowed?: string): VoiceProxyPolicy => ({
    trustedProxies: parseCidrs(trusted, 'VOICE_MODE_TRUSTED_PROXY_CIDRS'),
    allowedClients: parseCidrs(allowed, 'VOICE_MODE_ALLOWED_CLIENT_CIDRS'),
  });
  const tailnet = '100.64.0.0/10, fd7a:115c:a1e0::/48';

  it('admits loopback peers and refuses LAN peers with no proxy configured', () => {
    const p = policy();
    expect(admitsVoicePeer(p, '127.0.0.1', undefined)).toBe(true);
    expect(admitsVoicePeer(p, '::1', undefined)).toBe(true);
    expect(admitsVoicePeer(p, '::ffff:127.0.0.1', '203.0.113.9')).toBe(true);
    expect(admitsVoicePeer(p, '192.168.1.20', undefined)).toBe(false);
    expect(admitsVoicePeer(p, '172.17.0.5', '100.100.1.2')).toBe(false);
    expect(admitsVoicePeer(p, undefined, undefined)).toBe(false);
  });

  it('admits a trusted proxy forwarding an allowed client, and refuses a disallowed one', () => {
    const p = policy('172.17.0.0/16', tailnet);
    expect(admitsVoicePeer(p, '172.17.0.5', '100.100.1.2')).toBe(true);
    expect(admitsVoicePeer(p, '::ffff:172.17.0.5', 'fd7a:115c:a1e0::1234')).toBe(true);
    expect(admitsVoicePeer(p, '172.17.0.5', '203.0.113.9')).toBe(false);
    expect(admitsVoicePeer(p, '172.17.0.5', '192.168.1.20')).toBe(false);
    expect(admitsVoicePeer(p, '172.17.0.5', undefined)).toBe(false);
    expect(admitsVoicePeer(p, '172.17.0.5', 'not-an-ip')).toBe(false);
  });

  it('takes the rightmost hop outside the trusted proxies as the client', () => {
    const p = policy('172.17.0.0/16', tailnet);
    // A client cannot prepend its way in: the proxy appends the real peer last.
    expect(admitsVoicePeer(p, '172.17.0.5', '100.100.1.2, 203.0.113.9')).toBe(false);
    expect(admitsVoicePeer(p, '172.17.0.5', '203.0.113.9, 100.100.1.2')).toBe(true);
    expect(admitsVoicePeer(p, '172.17.0.5', ['203.0.113.9', '100.100.1.2, 172.17.0.9'])).toBe(true);
  });

  it('ignores X-Forwarded-For from a peer outside the trusted proxies', () => {
    const p = policy('172.17.0.0/16', tailnet);
    expect(admitsVoicePeer(p, '192.168.1.20', '100.100.1.2')).toBe(false);
    expect(admitsVoicePeer(p, '172.19.0.5', '100.100.1.2')).toBe(false);
  });

  it('admits any client a trusted proxy forwards when no client ranges are set', () => {
    const p = policy('172.17.0.5');
    expect(admitsVoicePeer(p, '172.17.0.5', '203.0.113.9')).toBe(true);
    expect(admitsVoicePeer(p, '172.17.0.6', '203.0.113.9')).toBe(false);
  });

  it('fails closed on invalid ranges', () => {
    expect(admitsVoicePeer(policy('172.17.0.0/33, nonsense'), '172.17.0.5', undefined)).toBe(false);
    // A client list whose entries are all invalid admits no client, not every client.
    expect(admitsVoicePeer(policy('172.17.0.0/16', '100.64.0.0/x'), '172.17.0.5', '100.100.1.2')).toBe(false);
  });
});
