/**
 * The voice adapter's request gate: which paths are voice routes, and which
 * peers may reach the browser routes through a reverse proxy; and the line
 * voice routes (`/voice/tts`, `/voice/voices`) over HTTP against the real
 * central DB, answered as the contract fixtures say. The call routes are
 * exercised over HTTP in voice-mode-livekit.test.ts.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The host key; null as on a host without one. */
const hostKey = vi.hoisted(() => ({ value: null as Buffer | null }));
vi.mock('../secret-seal.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../secret-seal.js')>()),
  encryptionKey: () => hostKey.value,
}));

import { closeDb, getDb, initTestDb, runMigrations } from '../db/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { getVoiceModeLineForAgent, mintVoiceModeLine, openVoiceModeLink } from '../db/voice-mode-lines.js';
import { createUser } from '../modules/permissions/db/users.js';
import { grantRole, revokeRole } from '../modules/permissions/db/user-roles.js';
import { TTS_DEFAULT_CHOICE } from '../voice-mode-tts.js';
import { getWebhookStatus, stopWebhookServer } from '../webhook-server.js';
import type { LiveKitServerApi } from './voice-mode-livekit.js';
import fixtures from './voice-mode-tts.fixtures.json' with { type: 'json' };
import { choiceDetails, createVoiceCatalog, ELEVENLABS_VOICES_URL } from './voice-mode-tts-catalog.js';
import {
  admitsVoiceModePeer,
  createVoiceModeAdapter,
  parseCidrs,
  voiceRoute,
  type VoiceModeChannelAdapter,
  type VoiceModeConfig,
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

describe('voice-mode settings', () => {
  it('reads VOICE_MODE_LANGUAGES, dropping invalid and repeated codes', async () => {
    const { parseVoiceLanguages } = await import('./voice-mode-protocol.js');
    expect(parseVoiceLanguages(undefined)).toEqual(['uk-UA', 'en-US']);
    expect(parseVoiceLanguages('de-DE,en-US,de-de,invalid!')).toEqual(['de-DE', 'en-US']);
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
  let upstream: { calls: Array<{ url: URL; headers: Headers }>; fail: boolean };

  /** Gemini's listing: 101 voices, the backup voice first and the two fixture voices at 98 and 99. */
  const geminiVoices = Array.from({ length: 101 }, (_, i) =>
    i === 0
      ? { id: 'alnilam', display_name: 'Alnilam', language_code: 'en-US', gender: 'male' }
      : i === 98
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
  /** ElevenLabs' answer for a voice by id: a library voice outside the account's listing, or none. */
  const elevenLabsById = (id: string): Response =>
    id === 'S80713fa2M70CssGEBj5'
      ? Response.json({ voice_id: id, name: 'Maks', labels: { language: 'uk', gender: 'male' } })
      : Response.json({ detail: { status: 'voice_not_found' } }, { status: 400 });
  /** Gemini's `voices.list` as the service answers it: filtered, paged, with `p<offset>` page tokens. */
  const geminiListing = (params: URLSearchParams): Response => {
    const token = params.get('page_token');
    if (token !== null && !/^p\d+$/.test(token)) {
      return Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT' } }, { status: 400 });
    }
    const [gender, language, search] = ['gender', 'language_code', 'search'].map((k) => params.get(k)?.toLowerCase());
    const matches = geminiVoices.filter(
      (v) =>
        (!gender || v.gender === gender) &&
        (!language || v.language_code.toLowerCase() === language) &&
        (!search || [v.display_name, v.description ?? ''].some((f) => f.toLowerCase().includes(search))),
    );
    const offset = token ? Number(token.slice(1)) : 0;
    const end = offset + Number(params.get('page_size') ?? 50);
    return Response.json({
      voices: matches.slice(offset, end),
      ...(end < matches.length && { next_page_token: `p${end}` }),
    });
  };
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    upstream.calls.push({ url, headers: request.headers });
    if (upstream.fail) return new Response('nope', { status: 500 });
    if (url.hostname === 'generativelanguage.googleapis.com') return geminiListing(url.searchParams);
    if (url.pathname.startsWith('/v1/voices/')) return elevenLabsById(url.pathname.slice('/v1/voices/'.length));
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

  /** The adapter again on the same port, with other settings. */
  const restart = async (overrides: Partial<VoiceModeConfig>) => {
    await adapter.teardown();
    await stopWebhookServer();
    const port = Number(new URL(base).port);
    adapter = createVoiceModeAdapter({
      publicUrl: `http://127.0.0.1:${port}`,
      providerKeys: { gemini: GEMINI_KEY },
      catalog: createVoiceCatalog({ fetch: fakeFetch }),
      livekit: { url: 'wss://lk.example.invalid', apiKey: 'k', apiSecret: 's'.repeat(48), api: {} as LiveKitServerApi },
      ...overrides,
    });
    await adapter.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction: () => {} });
    await vi.waitFor(() => expect(getWebhookStatus()?.port).toBe(port), { timeout: 2000, interval: 10 });
  };
  /** A catalog whose lookups wait for `release`; `started` once one is waiting. */
  const heldLookups = () => {
    const real = createVoiceCatalog({ fetch: fakeFetch });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => (started = resolve));
    const catalog = {
      ...real,
      lookup: async (...args: Parameters<typeof real.lookup>) => {
        started();
        await gate;
        return real.lookup(...args);
      },
    };
    return { catalog, release, waiting };
  };

  const tts = (method = 'GET', body?: string, t = token) =>
    fetch(`${base}/tts?t=${t}`, { method, body, headers: { 'Content-Type': 'application/json' } });
  const voices = (query: string, t = token) => fetch(`${base}/voices?t=${t}&${query}`);
  const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as unknown });
  /** The upstream requests the routes made themselves, not the name listings' loads. */
  const listingCalls = () =>
    upstream.calls.filter(
      (c) =>
        !c.url.pathname.startsWith('/v1/voices/') &&
        c.url.searchParams.get('page_size') !== (c.url.hostname === 'api.elevenlabs.io' ? '100' : '1000'),
    );

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

  it('seals a link made before links were stored when it next opens the line, and only with a key', async () => {
    hostKey.value = null;
    expect((await tts()).status).toBe(200);
    expect((await getVoiceModeLineForAgent('ag-1'))?.link_sealed).toBeNull();
    hostKey.value = randomBytes(32);
    expect((await tts('GET', undefined, 'f'.repeat(32))).status).toBe(403);
    expect((await getVoiceModeLineForAgent('ag-1'))?.link_sealed).toBeNull();
    expect((await tts()).status).toBe(200);
    const line = (await getVoiceModeLineForAgent('ag-1'))!;
    expect(await openVoiceModeLink(line, hostKey.value)).toEqual({ token });
    hostKey.value = null;
  });

  it("answers the line's saved and effective voice with their names, saves a pick and resets it", async () => {
    expect(await json(await tts())).toEqual({ status: 200, body: fixtures.ttsViewNew });
    const pick = JSON.stringify({ provider: 'gemini', model: 'gemini-3.8-flash-lite-tts', voice: 'achernar' });
    expect(await json(await tts('PATCH', pick))).toEqual({ status: 200, body: fixtures.ttsView });
    expect(await json(await tts())).toEqual({ status: 200, body: fixtures.ttsView });
    expect(await json(await tts('PATCH', '{"reset":true}'))).toEqual({ status: 200, body: fixtures.ttsViewNew });
    expect(await json(await tts())).toEqual({ status: 200, body: fixtures.ttsViewNew });
    // Only the whole listing was asked for, once: every name came from memory.
    expect(upstream.calls.map((c) => Object.fromEntries(c.url.searchParams))).toEqual([{ page_size: '1000' }]);
  });

  it("matches ids exactly as the provider spells them, and loads Gemini's listing once more before refusing", async () => {
    let clock = 0;
    await restart({ catalog: createVoiceCatalog({ fetch: fakeFetch, now: () => clock }) });
    clock = 10_000;
    expect(await json(await tts('PATCH', '{"provider":"gemini","voice":"Achernar"}'))).toEqual({
      status: 400,
      body: fixtures.patchInvalid,
    });
    // A voice made after the listing loaded is found by that second load, and saved as it is spelled.
    geminiVoices.push({ id: 'Custom-Voice', display_name: 'Mine', language_code: 'en-US', gender: 'female' });
    clock = 20_000;
    try {
      const view = await json(await tts('PATCH', '{"provider":"gemini","voice":"Custom-Voice"}'));
      expect(view).toMatchObject({
        status: 200,
        body: {
          saved: { voice: 'Custom-Voice' },
          details: { saved: { voice: 'Custom-Voice', voiceName: 'Mine', status: 'resolved' } },
        },
      });
    } finally {
      geminiVoices.pop();
    }
    // The first start's load, the restart's, and one for each save.
    const loads = upstream.calls.filter((c) => c.url.searchParams.get('page_size') === '1000');
    expect(loads).toHaveLength(4);
  });

  it('reads a row from before every write stored a whole choice as it speaks, names included', async () => {
    await getDb().run('UPDATE voice_mode_lines SET tts_model = NULL, tts_voice = NULL');
    const view = (await json(await tts())).body as typeof fixtures.ttsView;
    expect(view.saved).toEqual({ provider: 'gemini', model: null, voice: null });
    expect(view.details.saved).toEqual(fixtures.ttsViewNew.providers[0].defaultDetails);
    expect(view.details.effective).toEqual(fixtures.ttsViewNew.providers[0].defaultDetails);
  });

  it('refuses a voice the provider does not have, and saves one it could not be asked about', async () => {
    expect(await json(await tts('PATCH', '{"provider":"gemini","voice":"Kore"}'))).toEqual({
      status: 400,
      body: fixtures.patchInvalid,
    });
    expect(await json(await tts())).toEqual({ status: 200, body: fixtures.ttsViewNew });
    upstream.fail = true;
    await restart({});
    const saved = await json(await tts('PATCH', '{"provider":"gemini","voice":"Kore"}'));
    expect(saved).toMatchObject({
      status: 200,
      body: {
        saved: { provider: 'gemini', model: 'gemini-3.8-flash-tts', voice: 'Kore' },
        details: {
          saved: { voice: 'Kore', voiceName: null, modelName: 'Gemini 3.8 Flash TTS', status: 'lookup_failed' },
        },
      },
    });
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
    expect(await json(await tts())).toEqual({ status: 200, body: fixtures.ttsViewNew });
    expect((await tts('POST', '{}')).status).toBe(405);
  });

  it('reads and saves only for a caller who still holds an owner or admin role, asking no provider otherwise', async () => {
    await vi.waitFor(() => expect(upstream.calls).toHaveLength(1));
    await revokeRole(OWNER, 'admin', 'ag-1');
    for (const res of [
      await tts('PATCH', '{"provider":"gemini","voice":"Kore"}'),
      await tts(),
      await voices('provider=gemini'),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.text()).toBe('Caller access denied or voice line is not set up');
    }
    expect(upstream.calls).toHaveLength(1);
    await grantRole({ user_id: OWNER, role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: stamp() });
    expect(await json(await tts())).toEqual({ status: 200, body: fixtures.ttsViewNew });
  });

  it('saves nothing when the role is revoked or the link re-minted while the voice is looked up', async () => {
    const regrant = () =>
      grantRole({ user_id: OWNER, role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: stamp() });
    const remint = () =>
      mintVoiceModeLine({ agentGroupId: 'ag-1', ownerUserId: OWNER, messagingGroupId: 'mg-1', threadId: null });
    for (const [meanwhile, after] of [
      [() => revokeRole(OWNER, 'admin', 'ag-1'), regrant],
      [remint, async () => undefined],
    ] as const) {
      const held = heldLookups();
      await restart({ catalog: held.catalog });
      const saving = tts('PATCH', '{"provider":"gemini","voice":"achernar"}');
      await held.waiting;
      await meanwhile();
      held.release();
      expect((await saving).status).toBe(403);
      expect(await getDb().get('SELECT tts_voice FROM voice_mode_lines')).toEqual({ tts_voice: 'en-us-techagent-4' });
      await after();
    }
  });

  it('saves a voice whose lookup outlasts the budget', async () => {
    const held = heldLookups();
    await restart({
      catalog: { ...held.catalog, details: async (c) => choiceDetails(c, { status: 'lookup_failed' }) },
      saveLookupBudgetMs: 50,
    });
    const res = await json(await tts('PATCH', '{"provider":"gemini","voice":"achernar"}'));
    expect(res).toMatchObject({ status: 200, body: { saved: { voice: 'achernar' } } });
    held.release();
  });

  it('shows the backup voice as effective for a saved voice the provider certainly lacks, keeping the saved id', async () => {
    await getDb().run("UPDATE voice_mode_lines SET tts_voice = 'en-us-gone-1'");
    const view = (await json(await tts())).body as typeof fixtures.ttsView;
    expect(view.saved).toEqual({ provider: 'gemini', model: 'gemini-3.8-flash-tts', voice: 'en-us-gone-1' });
    expect(view.effective).toEqual(TTS_DEFAULT_CHOICE);
    expect(view.details.saved).toMatchObject({ voice: 'en-us-gone-1', voiceName: null, status: 'unavailable' });
    expect(view.details.effective).toEqual(fixtures.ttsViewNew.providers[0].defaultDetails);
    // A listing that could not load says nothing certain: the saved voice stays effective.
    upstream.fail = true;
    await restart({});
    const doubtful = (await json(await tts())).body as typeof fixtures.ttsView;
    expect(doubtful.effective).toEqual(doubtful.saved);
    expect(doubtful.details.effective.status).toBe('lookup_failed');
  });

  it('resets nothing when the role is revoked while the body is on its way', async () => {
    await getDb().run("UPDATE voice_mode_lines SET tts_voice = 'achernar'");
    const encode = (s: string) => new TextEncoder().encode(s);
    const res = await fetch(`${base}/tts?t=${token}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: new ReadableStream({
        async start(stream) {
          stream.enqueue(encode('{"reset":'));
          // Long enough for the route to pass its token and role checks and wait on the rest.
          await new Promise((resolve) => setTimeout(resolve, 100));
          await revokeRole(OWNER, 'admin', 'ag-1');
          stream.enqueue(encode('true}'));
          stream.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('Caller access denied or voice line is not set up');
    expect(await getDb().get('SELECT tts_voice FROM voice_mode_lines')).toEqual({ tts_voice: 'achernar' });
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

  it("pages Gemini's listing with its own filters and page tokens", async () => {
    expect(await json(await voices('provider=gemini&limit=2&cursor=p98'))).toEqual({
      status: 200,
      body: fixtures.catalogGemini,
    });
    expect(await json(await voices('provider=gemini&language=EN-us&q=ADVISOR'))).toEqual({
      status: 200,
      body: { provider: 'gemini', voices: [fixtures.catalogGemini.voices[1]] },
    });
    expect(await json(await voices('provider=gemini&gender=FEMALE&language=en-US'))).toEqual({
      status: 200,
      body: { provider: 'gemini', voices: [fixtures.catalogGemini.voices[0]] },
    });
    const first = (await json(await voices('provider=gemini&gender=&limit=99'))).body as {
      voices: unknown[];
      next: string;
    };
    expect(first.voices).toHaveLength(99);
    expect(first.next).toBe('p99');
    // The same page again within the minute is the one already fetched.
    expect(await json(await voices('provider=gemini&limit=2&cursor=p98'))).toEqual({
      status: 200,
      body: fixtures.catalogGemini,
    });
    expect(listingCalls().map((c) => Object.fromEntries(c.url.searchParams))).toEqual([
      { page_size: '2', page_token: 'p98' },
      { page_size: '100', search: 'ADVISOR', language_code: 'EN-us' },
      { page_size: '100', language_code: 'en-US', gender: 'female' },
      { page_size: '99' },
    ]);
    expect(upstream.calls.every((c) => c.headers.get('x-goog-api-key') === GEMINI_KEY)).toBe(true);
    expect(upstream.calls.every((c) => !c.url.href.includes(GEMINI_KEY))).toBe(true);
  });

  it('proxies ElevenLabs page by page with its own parameters', async () => {
    await restart({ providerKeys: { gemini: GEMINI_KEY, elevenlabs: ELEVEN_KEY } });
    const res = await voices('provider=elevenlabs&q=will&language=en&gender=Male&cursor=tok-2&limit=10');
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual(fixtures.catalogElevenLast);
    expect(text).not.toContain(ELEVEN_KEY);
    const [call] = listingCalls().filter((c) => c.url.hostname === 'api.elevenlabs.io');
    expect(call.url.origin + call.url.pathname).toBe(ELEVENLABS_VOICES_URL);
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      page_size: '10',
      search: 'will',
      language: 'en',
      gender: 'male',
      next_page_token: 'tok-2',
      include_total_count: 'false',
    });
    expect(call.headers.get('xi-api-key')).toBe(ELEVEN_KEY);
    // With the key, the provider is offered and a pick of it saves.
    const pick = await json(await tts('PATCH', '{"provider":"elevenlabs"}'));
    const will = { provider: 'elevenlabs', model: 'eleven_v4_turbo', voice: 'bIHbv24MWmeRgasZH58o' };
    expect(pick).toMatchObject({
      status: 200,
      body: {
        effective: will,
        saved: will,
        details: { saved: fixtures.voiceAttribute.pendingDetails },
      },
    });
    expect((pick.body as { providers: Array<{ available: boolean }> }).providers.map((p) => p.available)).toEqual([
      true,
      true,
    ]);
    // A voice outside the account's listing is asked for by id, once; one ElevenLabs does not have is refused.
    const maks = await json(await tts('PATCH', '{"provider":"elevenlabs","voice":"S80713fa2M70CssGEBj5"}'));
    expect(maks).toMatchObject({
      status: 200,
      body: { details: { saved: { voiceName: 'Maks', status: 'resolved' } } },
    });
    await tts();
    expect(await json(await tts('PATCH', `{"provider":"elevenlabs","voice":"${'Z'.repeat(20)}"}`))).toEqual({
      status: 400,
      body: fixtures.patchInvalid,
    });
    expect(upstream.calls.filter((c) => c.url.pathname.startsWith('/v1/voices/')).map((c) => c.url.pathname)).toEqual([
      '/v1/voices/S80713fa2M70CssGEBj5',
      `/v1/voices/${'Z'.repeat(20)}`,
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
      'provider=gemini&gender=other',
      'provider=elevenlabs&gender=females',
      `provider=gemini&gender=${'f'.repeat(513)}`,
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
    // Nothing is kept: the next request asks again.
    upstream.fail = false;
    expect((await voices('provider=gemini&limit=1')).status).toBe(200);
  });
});
