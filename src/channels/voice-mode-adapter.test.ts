/**
 * The voice adapter's request gate: which paths are voice routes, and which
 * peers may reach the browser routes through a reverse proxy. The routes
 * themselves are exercised over HTTP in voice-mode-livekit.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { admitsVoiceModePeer, parseCidrs, voiceRoute, type VoiceModeProxyPolicy } from './voice-mode.js';

describe('voice routes and the reverse-proxy gate', () => {
  it('maps both prefixes to routes, the short one only for browser routes', () => {
    expect(voiceRoute('/webhook/voice/livekit')).toBe('livekit');
    expect(voiceRoute('/webhook/voice/livekit/agent/events')).toBe('livekit/agent/events');
    expect(voiceRoute('/voice')).toBe('livekit');
    expect(voiceRoute('/voice/')).toBe('livekit');
    expect(voiceRoute('/voice/info')).toBe('info');
    expect(voiceRoute('/voice/call')).toBeNull();
    expect(voiceRoute('/voice/livekit/token')).toBe('livekit/token');
    expect(voiceRoute('/voice/livekit/agent/events')).toBeNull();
    expect(voiceRoute('/voice/livekit%2Fagent%2Fevents')).toBeNull();
    expect(voiceRoute('/voice//livekit/agent/joined')).toBeNull();
    expect(voiceRoute('/voice/sip')).toBeNull();
    expect(voiceRoute('/voicemail')).toBeNull();
  });

  const policy = (trusted?: string, allowed?: string): VoiceModeProxyPolicy => ({
    trustedProxies: parseCidrs(trusted, 'VOICE_MODE_TRUSTED_PROXY_CIDRS'),
    allowedClients: parseCidrs(allowed, 'VOICE_MODE_ALLOWED_CLIENT_CIDRS'),
  });
  const tailnet = '100.64.0.0/10, fd7a:115c:a1e0::/48';

  it('admits loopback peers and refuses LAN peers with no proxy configured', () => {
    const p = policy();
    expect(admitsVoiceModePeer(p, '127.0.0.1', undefined)).toBe(true);
    expect(admitsVoiceModePeer(p, '::1', undefined)).toBe(true);
    expect(admitsVoiceModePeer(p, '::ffff:127.0.0.1', '203.0.113.9')).toBe(true);
    expect(admitsVoiceModePeer(p, '192.168.1.20', undefined)).toBe(false);
    expect(admitsVoiceModePeer(p, '172.18.0.5', '100.100.1.2')).toBe(false);
    expect(admitsVoiceModePeer(p, undefined, undefined)).toBe(false);
  });

  it('admits a trusted proxy forwarding an allowed client, and refuses a disallowed one', () => {
    const p = policy('172.18.0.0/16', tailnet);
    expect(admitsVoiceModePeer(p, '172.18.0.5', '100.100.1.2')).toBe(true);
    expect(admitsVoiceModePeer(p, '::ffff:172.18.0.5', 'fd7a:115c:a1e0::1234')).toBe(true);
    expect(admitsVoiceModePeer(p, '172.18.0.5', '203.0.113.9')).toBe(false);
    expect(admitsVoiceModePeer(p, '172.18.0.5', '192.168.1.20')).toBe(false);
    expect(admitsVoiceModePeer(p, '172.18.0.5', undefined)).toBe(false);
    expect(admitsVoiceModePeer(p, '172.18.0.5', 'not-an-ip')).toBe(false);
  });

  it('takes the rightmost hop outside the trusted proxies as the client', () => {
    const p = policy('172.18.0.0/16', tailnet);
    // A client cannot prepend its way in: the proxy appends the real peer last.
    expect(admitsVoiceModePeer(p, '172.18.0.5', '100.100.1.2, 203.0.113.9')).toBe(false);
    expect(admitsVoiceModePeer(p, '172.18.0.5', '203.0.113.9, 100.100.1.2')).toBe(true);
    expect(admitsVoiceModePeer(p, '172.18.0.5', ['203.0.113.9', '100.100.1.2, 172.18.0.9'])).toBe(true);
  });

  it('ignores X-Forwarded-For from a peer outside the trusted proxies', () => {
    const p = policy('172.18.0.0/16', tailnet);
    expect(admitsVoiceModePeer(p, '192.168.1.20', '100.100.1.2')).toBe(false);
    expect(admitsVoiceModePeer(p, '172.19.0.5', '100.100.1.2')).toBe(false);
  });

  it('admits any client a trusted proxy forwards when no client ranges are set', () => {
    const p = policy('172.18.0.5');
    expect(admitsVoiceModePeer(p, '172.18.0.5', '203.0.113.9')).toBe(true);
    expect(admitsVoiceModePeer(p, '172.18.0.6', '203.0.113.9')).toBe(false);
  });

  it('fails closed on invalid ranges', () => {
    expect(admitsVoiceModePeer(policy('172.18.0.0/33, nonsense'), '172.18.0.5', undefined)).toBe(false);
    // A client list whose entries are all invalid admits no client, not every client.
    expect(admitsVoiceModePeer(policy('172.18.0.0/16', '100.64.0.0/x'), '172.18.0.5', '100.100.1.2')).toBe(false);
  });
});
