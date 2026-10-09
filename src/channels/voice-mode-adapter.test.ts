/**
 * The voice adapter's request gate: which paths are voice routes, and which
 * peers may reach the browser routes through a reverse proxy; and the line
 * voice routes (`/voice/tts`, `/voice/voices`) over HTTP against the real
 * central DB, answered as the contract fixtures say. The call routes are
 * exercised over HTTP in voice-mode-livekit.test.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { mintVoiceModeLine } from '../db/voice-mode-lines.js';
import { createUser } from '../modules/permissions/db/users.js';
import { grantRole, revokeRole } from '../modules/permissions/db/user-roles.js';
import { getWebhookStatus, stopWebhookServer } from '../webhook-server.js';
import type { LiveKitServerApi } from './voice-mode-livekit.js';
import fixtures from './voice-mode-tts.fixtures.json' with { type: 'json' };
import { createVoiceCatalog, ELEVENLABS_VOICES_URL, GEMINI_VOICES_URL } from './voice-mode-tts-catalog.js';
import {
  admitsVoiceModePeer,
  createVoiceModeAdapter,
  parseCidrs,
  voiceRoute,
  type VoiceModeChannelAdapter,
  type VoiceModeProxyPolicy,
} from './voice-mode.js';

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
    expect(voiceRoute('/voice/tts')).toBe('tts');
    expect(voiceRoute('/voice/voices/')).toBe('voices');
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
    expect(voiceModeEnvKeys(['VOICE_MODE_PUBLIC_URL', 'LIVEKIT_URL'])).toEqual([
      'VOICE_MODE_PUBLIC_URL',
      'VOICE_PUBLIC_URL',
      'LIVEKIT_URL',
    ]);
    expect(
      voiceModeEnv({ VOICE_PUBLIC_URL: oldValue, VOICE_MODE_PUBLIC_URL: 'new', VOICE_WAKE_MODEL: 'off' }, (s) =>
        warnings.push(s),
      ),
    ).toMatchObject({ VOICE_MODE_PUBLIC_URL: 'new', VOICE_MODE_WAKE_MODEL: 'off' });
    expect(warnings).toEqual([
      'voice-mode: VOICE_PUBLIC_URL is ignored because VOICE_MODE_PUBLIC_URL is set; remove it',
      'voice-mode: VOICE_WAKE_MODEL is deprecated; use VOICE_MODE_WAKE_MODEL',
    ]);
    expect(warnings.join(' ')).not.toContain(oldValue);
    expect(parseVoiceLanguages(undefined)).toEqual(['uk-UA', 'en-US']);
    expect(parseVoiceLanguages('de-DE,en-US,de-de,invalid!')).toEqual(['de-DE', 'en-US']);
  });

  it('aliases only the old keys main read: none for settings new to voice-mode', async () => {
    const { voiceModeEnv, voiceModeEnvKeys } = await import('./voice-mode-protocol.js');
    const fresh = ['VOICE_MODE_PORT', 'VOICE_MODE_PAGE_HOST', 'VOICE_MODE_LANGUAGES'];
    expect(voiceModeEnvKeys(fresh)).toEqual(fresh);
    const warnings: string[] = [];
    const env = voiceModeEnv({ VOICE_PORT: '9', VOICE_PAGE_HOST: '0.0.0.0', VOICE_LANGUAGES: 'de-DE' }, (s) =>
      warnings.push(s),
    );
    for (const key of fresh) expect(env[key]).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("aliases exactly the upgrade runbook's rename table", async () => {
    const { LEGACY_VOICE_KEYS } = await import('./voice-mode-protocol.js');
    const runbook = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../docs/2610-07-voice-mode-upgrade.md',
    );
    expect(LEGACY_VOICE_KEYS).toHaveLength(27);
    if (!existsSync(runbook)) return; // An installed payload does not carry the fork's docs.
    const table = [...readFileSync(runbook, 'utf8').matchAll(/^\| `(VOICE_[A-Z_]+)` \| `VOICE_MODE_[A-Z_]+` \|$/gm)];
    expect(table.map((m) => m[1])).toEqual([...LEGACY_VOICE_KEYS]);
  });
});

describe('voice-mode provider key aliases', () => {
  it('reads GEMINI_API_KEY as VOICE_MODE_GEMINI_API_KEY, prefers the new name and never prints values', async () => {
    const { voiceModeEnv, voiceModeEnvKeys, LEGACY_VOICE_KEYS } = await import('./voice-mode-protocol.js');
    const oldValue = 'private-' + 'gemini';
    expect(voiceModeEnvKeys(['VOICE_MODE_GEMINI_API_KEY', 'VOICE_MODE_ELEVENLABS_API_KEY'])).toEqual([
      'VOICE_MODE_GEMINI_API_KEY',
      'GEMINI_API_KEY',
      'VOICE_MODE_ELEVENLABS_API_KEY',
    ]);
    const warnings: string[] = [];
    expect(voiceModeEnv({ GEMINI_API_KEY: oldValue }, (s) => warnings.push(s))).toMatchObject({
      VOICE_MODE_GEMINI_API_KEY: oldValue,
    });
    expect(
      voiceModeEnv({ GEMINI_API_KEY: oldValue, VOICE_MODE_GEMINI_API_KEY: 'new' }, (s) => warnings.push(s)),
    ).toMatchObject({ VOICE_MODE_GEMINI_API_KEY: 'new' });
    expect(warnings).toEqual([
      'voice-mode: GEMINI_API_KEY is deprecated; use VOICE_MODE_GEMINI_API_KEY',
      'voice-mode: GEMINI_API_KEY is ignored because VOICE_MODE_GEMINI_API_KEY is set; remove it',
    ]);
    expect(warnings.join(' ')).not.toContain(oldValue);
    expect(LEGACY_VOICE_KEYS).not.toContain('GEMINI_API_KEY');
  });
});

describe('line voice routes (real handleHttp, real central DB)', () => {
  const GEMINI_KEY = 'gemini-' + 'secret-key';
  const ELEVEN_KEY = 'eleven-' + 'secret-key';
  const OWNER = 'telegram:7';
  const stamp = () => new Date().toISOString();
  let adapter: VoiceModeChannelAdapter;
  let base: string;
  let token: string;
  let upstream: { calls: Array<{ url: URL; headers: Record<string, string> }>; fail: boolean };

  /** Gemini's listing over two upstream pages: 101 voices, the two fixture voices at 98 and 99. */
  const geminiVoices = Array.from({ length: 101 }, (_, i) =>
    i === 98
      ? {
          id: 'achernar',
          display_name: 'Achernar',
          language_code: 'en-US',
          gender: 'female',
          persona: 'Storyteller & Narrator',
          description: 'Soft, calm, and soothing voice with a higher pitch.',
          accent: 'neutral',
        }
      : i === 99
        ? {
            id: 'en-us-techagent-4',
            display_name: 'Tech Advisor 4',
            language_code: 'en-US',
            gender: 'male',
            persona: 'Tech Support Agent / Tech Advisor',
            description: 'Confident and clear.',
          }
        : { id: `de-de-voice-${i}`, display_name: `Stimme ${i}`, language_code: 'de-DE', gender: 'neutral' },
  );
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    upstream.calls.push({ url, headers: init?.headers as Record<string, string> });
    if (upstream.fail) return new Response('nope', { status: 500 });
    if (url.href.startsWith(GEMINI_VOICES_URL)) {
      const second = url.searchParams.get('pageToken') === 'p2';
      return Response.json(
        second ? { voices: geminiVoices.slice(60) } : { voices: geminiVoices.slice(0, 60), next_page_token: 'p2' },
      );
    }
    return Response.json({
      voices: [
        {
          voice_id: 'bIHbv24MWmeRgasZH58o',
          name: 'Will',
          description: null,
          labels: { language: 'en', gender: 'male', accent: 'american' },
          preview_url: 'https://example.invalid/w.mp3',
        },
      ],
      has_more: false,
      next_page_token: null,
    });
  }) as typeof fetch;

  const freePort = (): Promise<number> =>
    new Promise((resolve) => {
      const server = http.createServer();
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        server.close(() => resolve(port));
      });
    });

  beforeEach(async () => {
    await runMigrations(await initTestDb());
    await createAgentGroup({
      id: 'ag-1',
      name: 'Andy',
      folder: 'voice-tts-fixture',
      agent_provider: null,
      created_at: stamp(),
    });
    await createUser({ id: OWNER, kind: 'telegram', display_name: 'Ethan', created_at: stamp() });
    await grantRole({ user_id: OWNER, role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: stamp() });
    token = (
      await mintVoiceModeLine({ agentGroupId: 'ag-1', ownerUserId: OWNER, messagingGroupId: 'mg-1', threadId: null })
    ).token;
    upstream = { calls: [], fail: false };
    const port = await freePort();
    process.env.WEBHOOK_PORT = String(port);
    base = `http://127.0.0.1:${port}/voice`;
    adapter = createVoiceModeAdapter({
      publicUrl: `http://127.0.0.1:${port}`,
      providerKeys: { gemini: GEMINI_KEY },
      catalog: createVoiceCatalog({ fetch: fakeFetch }),
      livekit: { url: 'wss://lk.example.invalid', apiKey: 'k', apiSecret: 's'.repeat(48), api: {} as LiveKitServerApi },
    });
    await adapter.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction: () => {} });
    await vi.waitFor(() => expect(getWebhookStatus()?.port).toBe(port), { timeout: 2000, interval: 10 });
  });
  afterEach(async () => {
    await adapter.teardown();
    await stopWebhookServer();
    await closeDb();
  });

  const tts = (method = 'GET', body?: string, t = token) =>
    fetch(`${base}/tts?t=${t}`, { method, body, headers: { 'Content-Type': 'application/json' } });
  const voices = (query: string, t = token) => fetch(`${base}/voices?t=${t}&${query}`);
  const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as unknown });
  const geminiCursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');

  it('refuses an unknown link on every voice route', async () => {
    const unknown = 'f'.repeat(32);
    for (const res of [
      await tts('GET', undefined, unknown),
      await tts('PATCH', '{"reset":true}', unknown),
      await voices('provider=gemini', unknown),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.text()).toBe('Unknown call link');
    }
  });

  it("answers the line's saved and effective voice, saves a pick and resets it", async () => {
    expect(await json(await tts())).toEqual({ status: 200, body: fixtures.ttsViewUnsaved });
    const pick = JSON.stringify({ provider: 'gemini', voice: 'en-us-techagent-4' });
    expect(await json(await tts('PATCH', pick))).toEqual({ status: 200, body: fixtures.ttsView });
    expect(await json(await tts())).toEqual({ status: 200, body: fixtures.ttsView });
    expect(await json(await tts('PATCH', '{"reset":true}'))).toEqual({ status: 200, body: fixtures.ttsViewUnsaved });
    expect(await json(await tts())).toEqual({ status: 200, body: fixtures.ttsViewUnsaved });
  });

  it('refuses an invalid pick, a provider without a key and malformed bodies, saving nothing', async () => {
    const bad = JSON.stringify({ provider: 'gemini', voice: 'not a voice!' });
    expect(await json(await tts('PATCH', bad))).toEqual({ status: 400, body: fixtures.patchInvalid });
    expect(await json(await tts('PATCH', '{"provider":"openai"}'))).toEqual({
      status: 400,
      body: { error: 'invalid', field: 'provider' },
    });
    expect(await json(await tts('PATCH', '{"provider":"elevenlabs","voice":"bIHbv24MWmeRgasZH58o"}'))).toEqual({
      status: 503,
      body: fixtures.patchUnavailable,
    });
    const oversize = JSON.stringify({ provider: 'gemini', voice: 'Alnilam', pad: 'x'.repeat(1024) });
    for (const body of [
      oversize,
      '[]',
      '"gemini"',
      '3',
      'null',
      '{not json',
      '',
      '{"reset":false}',
      '{"reset":true,"provider":"gemini"}',
    ]) {
      expect(await json(await tts('PATCH', body))).toEqual({ status: 400, body: { error: 'bad_request' } });
    }
    expect(await json(await tts())).toEqual({ status: 200, body: fixtures.ttsViewUnsaved });
    expect((await tts('POST', '{}')).status).toBe(405);
  });

  it('saves only for a caller who still holds an owner or admin role over the agent', async () => {
    await revokeRole(OWNER, 'admin', 'ag-1');
    const res = await tts('PATCH', '{"provider":"gemini","voice":"Kore"}');
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('Caller access denied or voice line is not set up');
    expect(await json(await tts())).toEqual({ status: 200, body: fixtures.ttsViewUnsaved });
    expect((await voices('provider=gemini')).status).toBe(403);
    expect(upstream.calls).toEqual([]);
  });

  it('saves nothing when the link is re-minted while the body is on its way', async () => {
    const encode = (s: string) => new TextEncoder().encode(s);
    const res = await fetch(`${base}/tts?t=${token}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: new ReadableStream({
        async start(stream) {
          stream.enqueue(encode('{"provider":"gemini",'));
          // Long enough for the route to pass its token and role checks and wait on the rest.
          await new Promise((resolve) => setTimeout(resolve, 100));
          await mintVoiceModeLine({
            agentGroupId: 'ag-1',
            ownerUserId: OWNER,
            messagingGroupId: 'mg-1',
            threadId: null,
          });
          stream.enqueue(encode('"voice":"Kore"}'));
          stream.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('Unknown call link');
  });

  it("pages Gemini's cached list with filters and a cursor, fetching it once", async () => {
    expect(await json(await voices(`provider=gemini&limit=2&cursor=${geminiCursor(98)}`))).toEqual({
      status: 200,
      body: fixtures.catalogGemini,
    });
    expect(await json(await voices('provider=gemini&language=EN-us&q=ADVISOR'))).toEqual({
      status: 200,
      body: { provider: 'gemini', voices: [fixtures.catalogGemini.voices[1]] },
    });
    const first = (await json(await voices('provider=gemini'))).body as { voices: unknown[]; next: string };
    expect(first.voices).toHaveLength(100);
    expect(first.next).toBe(geminiCursor(100));
    // Two upstream pages for the whole list, once, with the key in a header only.
    expect(upstream.calls.map((c) => c.url.searchParams.get('pageToken'))).toEqual([null, 'p2']);
    expect(upstream.calls.every((c) => c.headers['x-goog-api-key'] === GEMINI_KEY)).toBe(true);
    expect(upstream.calls.every((c) => !c.url.href.includes(GEMINI_KEY))).toBe(true);
  });

  it('proxies ElevenLabs page by page with its own parameters', async () => {
    await adapter.teardown();
    await stopWebhookServer();
    const port = Number(new URL(base).port);
    adapter = createVoiceModeAdapter({
      publicUrl: `http://127.0.0.1:${port}`,
      providerKeys: { gemini: GEMINI_KEY, elevenlabs: ELEVEN_KEY },
      catalog: createVoiceCatalog({ fetch: fakeFetch }),
      livekit: { url: 'wss://lk.example.invalid', apiKey: 'k', apiSecret: 's'.repeat(48), api: {} as LiveKitServerApi },
    });
    await adapter.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction: () => {} });
    await vi.waitFor(() => expect(getWebhookStatus()?.port).toBe(port), { timeout: 2000, interval: 10 });
    const res = await voices('provider=elevenlabs&q=will&language=en&cursor=tok-2&limit=10');
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual(fixtures.catalogElevenLast);
    expect(text).not.toContain(ELEVEN_KEY);
    const [call] = upstream.calls;
    expect(call.url.origin + call.url.pathname).toBe(ELEVENLABS_VOICES_URL);
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      page_size: '10',
      search: 'will',
      language: 'en',
      next_page_token: 'tok-2',
      include_total_count: 'false',
    });
    expect(call.headers['xi-api-key']).toBe(ELEVEN_KEY);
    // With the key, the provider is offered and a pick of it saves.
    const pick = await json(await tts('PATCH', '{"provider":"elevenlabs"}'));
    expect(pick).toMatchObject({
      status: 200,
      body: {
        effective: { provider: 'elevenlabs', model: 'eleven_turbo_v2_5', voice: 'bIHbv24MWmeRgasZH58o' },
        saved: { provider: 'elevenlabs', model: null, voice: null },
      },
    });
    expect((pick.body as { providers: Array<{ available: boolean }> }).providers.map((p) => p.available)).toEqual([
      true,
      true,
    ]);
  });

  it('refuses bad catalog requests, a provider without a key, and a failing upstream', async () => {
    for (const query of [
      '',
      'provider=openai',
      'provider=gemini&limit=0',
      'provider=gemini&limit=101',
      'provider=gemini&limit=2.5',
      'provider=gemini&cursor=bm9wZQ',
      `provider=gemini&q=${'x'.repeat(513)}`,
    ]) {
      expect(await json(await voices(query))).toEqual({ status: 400, body: { error: 'bad_request' } });
    }
    expect(await json(await voices('provider=elevenlabs'))).toEqual({ status: 503, body: fixtures.patchUnavailable });
    upstream.fail = true;
    const res = await voices('provider=gemini');
    const text = await res.text();
    expect({ status: res.status, body: JSON.parse(text) as unknown }).toEqual({
      status: 502,
      body: { error: 'upstream' },
    });
    expect(text).not.toContain(GEMINI_KEY);
    // A failed fetch is not cached: the next request tries again.
    upstream.fail = false;
    expect((await voices('provider=gemini&limit=1')).status).toBe(200);
  });
});
