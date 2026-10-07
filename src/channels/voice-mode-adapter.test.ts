/**
 * The voice adapter's request gate: which paths are voice routes, and which
 * peers may reach the browser routes through a reverse proxy. The routes
 * themselves are exercised over HTTP in voice-mode-livekit.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { admitsVoiceModePeer, parseCidrs, voiceRoute, type VoiceModeProxyPolicy } from './voice-mode.js';

describe('voice routes and the reverse-proxy gate', () => {
  it('maps the prefixes to routes, the worker routes only under /webhook/voice-mode', () => {
    expect(voiceRoute('/webhook/voice/livekit')).toBe('livekit');
    expect(voiceRoute('/webhook/voice-mode/livekit')).toBe('livekit');
    expect(voiceRoute('/webhook/voice-mode/livekit/agent/events')).toBe('livekit/agent/events');
    expect(voiceRoute('/webhook/voice/livekit/agent/events')).toBeNull();
    expect(voiceRoute('/webhook/voice/livekit/agent')).toBeNull();
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
  it('holds a loopback proxy listed as trusted to the allowed clients, and a direct local request too', () => {
    const p = policy('127.0.0.1/32, ::1/128', tailnet);
    expect(admitsVoiceModePeer(p, '127.0.0.1', '100.100.1.2')).toBe(true);
    expect(admitsVoiceModePeer(p, '::1', 'fd7a:115c:a1e0::1234')).toBe(true);
    expect(admitsVoiceModePeer(p, '127.0.0.1', '203.0.113.9')).toBe(false);
    expect(admitsVoiceModePeer(p, '127.0.0.1', undefined)).toBe(false);
    expect(admitsVoiceModePeer(policy('127.0.0.1/32, ::1/128', `${tailnet}, 127.0.0.1`), '127.0.0.1', undefined)).toBe(
      true,
    );
    // Loopback stays open unless it is a trusted proxy with client ranges set.
    expect(admitsVoiceModePeer(policy('127.0.0.1/32'), '127.0.0.1', '203.0.113.9')).toBe(true);
    expect(admitsVoiceModePeer(policy('172.17.0.0/16', tailnet), '127.0.0.1', '203.0.113.9')).toBe(true);
  });
});

describe('voice-mode environment compatibility', () => {
  it('reads old settings, prefers explicit new keys and never prints their values', async () => {
    const { voiceModeEnv, voiceModeEnvKeys, parseVoiceLanguages } = await import('./voice-mode-protocol.js');
    const warnings: string[] = [];
    const oldValue = 'private-' + 'value';
    expect(voiceModeEnvKeys(['VOICE_MODE_LINK_TOKEN', 'LIVEKIT_URL'])).toEqual([
      'VOICE_MODE_LINK_TOKEN',
      'VOICE_LINK_TOKEN',
      'LIVEKIT_URL',
    ]);
    expect(
      voiceModeEnv({ VOICE_LINK_TOKEN: oldValue, VOICE_MODE_LINK_TOKEN: 'new', VOICE_WAKE_MODEL: 'off' }, (s) =>
        warnings.push(s),
      ),
    ).toMatchObject({ VOICE_MODE_LINK_TOKEN: 'new', VOICE_MODE_WAKE_MODEL: 'off' });
    expect(warnings).toHaveLength(2);
    expect(warnings.join(' ')).not.toContain(oldValue);
    expect(parseVoiceLanguages(undefined)).toEqual(['uk-UA', 'en-US']);
    expect(parseVoiceLanguages('de-DE,en-US,de-de,invalid!')).toEqual(['de-DE', 'en-US']);
  });
});
