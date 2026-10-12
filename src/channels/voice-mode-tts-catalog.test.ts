/**
 * The voice catalog against faked provider listings: Gemini's through the real `@google/genai`
 * client over the fetch seam, ElevenLabs' proxied directly. The routes over it are in
 * voice-mode-adapter.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

import { createVoiceCatalog, ELEVENLABS_VOICES_URL } from './voice-mode-tts-catalog.js';

const GEMINI_VOICES_URL = 'https://generativelanguage.googleapis.com/v1beta/voices';
const quiet = { info: vi.fn(), warn: vi.fn() };

function fakeUpstream(respond: (url: URL) => Response | Promise<Response>) {
  const calls: Array<{ url: URL; headers: Headers }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    calls.push({ url, headers: request.headers });
    return respond(url);
  }) as typeof fetch;
  return { calls, urls: () => calls.map((c) => c.url), fetchFn };
}

describe('voice catalog', () => {
  it("asks Gemini's listing to filter and page itself, with the key in a header only", async () => {
    const { calls, fetchFn } = fakeUpstream((url) =>
      Response.json(
        url.searchParams.get('page_token') === 'p2'
          ? { voices: [{ id: 'c', display_name: 'Gamma', language_code: 'en-US', gender: 'female' }] }
          : {
              voices: [
                {
                  id: 'b',
                  display_name: 'Beta',
                  language_code: 'en-US',
                  gender: 'female',
                  persona: 'Host',
                  description: 'Warm and low.',
                },
                { display_name: 'no id' },
                null,
                { id: 'd', gender: 'female' },
              ],
              next_page_token: 'p2',
            },
      ),
    );
    const catalog = createVoiceCatalog({ fetch: fetchFn });
    const query = { limit: 2, q: 'warm', language: 'en-US', gender: 'female' };
    expect(await catalog.page('gemini', 'gemini-key', query)).toEqual({
      page: {
        provider: 'gemini',
        voices: [
          { id: 'b', name: 'Beta', language: 'en-US', gender: 'female', description: 'Host. Warm and low.' },
          { id: 'd', name: 'd', gender: 'female' },
        ],
        next: 'p2',
      },
    });
    expect(await catalog.page('gemini', 'gemini-key', { ...query, cursor: 'p2' })).toEqual({
      page: { provider: 'gemini', voices: [{ id: 'c', name: 'Gamma', language: 'en-US', gender: 'female' }] },
    });
    expect(calls[0].url.origin + calls[0].url.pathname).toBe(GEMINI_VOICES_URL);
    expect(calls.map((c) => Object.fromEntries(c.url.searchParams))).toEqual([
      { page_size: '2', search: 'warm', language_code: 'en-US', gender: 'female' },
      { page_size: '2', search: 'warm', language_code: 'en-US', gender: 'female', page_token: 'p2' },
    ]);
    expect(calls.every((c) => c.headers.get('x-goog-api-key') === 'gemini-key')).toBe(true);
    expect(calls.every((c) => !c.url.href.includes('gemini-key'))).toBe(true);
  });

  it('sends Gemini only the page size when nothing else is asked, and takes a page without voices as empty', async () => {
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'https://elsewhere.invalid');
    const { urls, fetchFn } = fakeUpstream(() => Response.json({}));
    try {
      expect(await createVoiceCatalog({ fetch: fetchFn }).page('gemini', 'key', { limit: 5 })).toEqual({
        page: { provider: 'gemini', voices: [] },
      });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(urls()[0].origin + urls()[0].pathname).toBe(GEMINI_VOICES_URL);
    expect(Object.fromEntries(urls()[0].searchParams)).toEqual({ page_size: '5' });
  });

  it('answers bad_request for a cursor Gemini refuses, and upstream for any other failure, asking once', async () => {
    const invalid = () =>
      Response.json({ error: { code: 400, message: 'bad token', status: 'INVALID_ARGUMENT' } }, { status: 400 });
    const refused = fakeUpstream(invalid);
    const catalog = createVoiceCatalog({ fetch: refused.fetchFn });
    expect(await catalog.page('gemini', 'key', { limit: 1, cursor: 'nope' })).toEqual({ error: 'bad_request' });
    expect(await catalog.page('gemini', 'key', { limit: 1 })).toEqual({ error: 'upstream' });
    const replies = [
      () => new Response('denied', { status: 403 }),
      () =>
        Response.json(
          { error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } },
          { status: 400 },
        ),
      () => new Response('', { status: 503 }),
      () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      () => Promise.reject(new Error('socket hang up')),
    ];
    for (const reply of replies) {
      const upstream = fakeUpstream(reply);
      expect(
        await createVoiceCatalog({ fetch: upstream.fetchFn }).page('gemini', 'key', { limit: 1, cursor: 'p2' }),
      ).toEqual({ error: 'upstream' });
      expect(upstream.calls).toHaveLength(1);
    }
  });

  it('proxies an ElevenLabs page, sending only the parameters given and passing its token on', async () => {
    const { urls, fetchFn } = fakeUpstream(() =>
      Response.json({
        voices: [{ voice_id: 'abcdefghij1234567890', name: 'Rachel', labels: {}, description: 'Calm.' }],
        has_more: true,
        next_page_token: 'page-2',
      }),
    );
    const catalog = createVoiceCatalog({ fetch: fetchFn });
    expect(await catalog.page('elevenlabs', 'key', { limit: 5 })).toEqual({
      page: {
        provider: 'elevenlabs',
        voices: [{ id: 'abcdefghij1234567890', name: 'Rachel', description: 'Calm.' }],
        next: 'page-2',
      },
    });
    expect(urls()[0].origin + urls()[0].pathname).toBe(ELEVENLABS_VOICES_URL);
    expect(Object.fromEntries(urls()[0].searchParams)).toEqual({ page_size: '5', include_total_count: 'false' });
    await catalog.page('elevenlabs', 'key', { limit: 5, gender: 'male', cursor: 'page-2' });
    expect(Object.fromEntries(urls()[1].searchParams)).toEqual({
      page_size: '5',
      gender: 'male',
      next_page_token: 'page-2',
      include_total_count: 'false',
    });
  });

  it('answers upstream for a failed or malformed ElevenLabs page', async () => {
    for (const reply of [() => new Response('denied', { status: 401 }), () => Response.json({ error: 'shape' })]) {
      const { fetchFn } = fakeUpstream(reply);
      expect(await createVoiceCatalog({ fetch: fetchFn }).page('elevenlabs', 'key', { limit: 1 })).toEqual({
        error: 'upstream',
      });
    }
  });
});

describe('voice names', () => {
  const alnilam = { id: 'alnilam', display_name: 'Alnilam', language_code: 'en-US', gender: 'male' };
  const tech = { id: 'en-us-techagent-4', display_name: 'Tech Advisor 4', language_code: 'en-US', gender: 'male' };
  /** Gemini's whole listing over two pages, or a failure while `down`. */
  const gemini = (state: { down?: boolean; voices?: unknown[] } = {}) =>
    fakeUpstream((url) => {
      if (state.down) return new Response('', { status: 503 });
      const voices = state.voices ?? [alnilam, tech];
      return Response.json(
        url.searchParams.get('page_token') === 'p1'
          ? { voices: voices.slice(1) }
          : { voices: voices.slice(0, 1), next_page_token: 'p1' },
      );
    });
  const will = {
    voice_id: 'bIHbv24MWmeRgasZH58o',
    name: 'Will',
    labels: { language: 'en', gender: 'male' },
    preview_url: 'https://example.invalid/w.mp3',
  };

  it("names a voice from Gemini's whole listing by its exact id, and knows a voice it does not have", async () => {
    const { urls, fetchFn } = gemini();
    const catalog = createVoiceCatalog({ fetch: fetchFn });
    catalog.warm({ gemini: 'key' });
    expect(await catalog.lookup('gemini', 'key', 'alnilam')).toEqual({
      status: 'resolved',
      voice: { id: 'alnilam', name: 'Alnilam', language: 'en-US', gender: 'male' },
    });
    expect(await catalog.lookup('gemini', 'key', 'Alnilam')).toEqual({ status: 'unavailable' });
    expect(await catalog.lookup('gemini', 'key', 'kore')).toEqual({ status: 'unavailable' });
    expect(await catalog.lookup('gemini', 'key', 'not a voice')).toEqual({ status: 'unavailable' });
    expect(
      await catalog.details({ provider: 'gemini', model: 'gemini-3.8-flash-tts', voice: 'en-us-techagent-4' }, 'key'),
    ).toEqual({
      provider: 'gemini',
      providerName: 'Gemini',
      model: 'gemini-3.8-flash-tts',
      modelName: 'Gemini 3.8 Flash TTS',
      voice: 'en-us-techagent-4',
      voiceName: 'Tech Advisor 4',
      language: 'en-US',
      gender: 'male',
      preview: null,
      status: 'resolved',
    });
    expect(urls().map((u) => Object.fromEntries(u.searchParams))).toEqual([
      { page_size: '1000' },
      { page_size: '1000', page_token: 'p1' },
    ]);
  });

  it('answers lookup_failed without a key or a listing, retries after a pause, and never throws', async () => {
    let t = 0;
    const state = { down: true };
    const { calls, fetchFn } = gemini(state);
    const catalog = createVoiceCatalog({ fetch: fetchFn, now: () => t, log: quiet });
    expect(await catalog.lookup('gemini', undefined, 'alnilam')).toEqual({ status: 'lookup_failed' });
    expect(calls).toHaveLength(0);
    const failed = {
      provider: 'gemini',
      providerName: 'Gemini',
      model: 'gemini-9-tts',
      modelName: 'gemini-9-tts',
      voice: 'alnilam',
      voiceName: null,
      language: null,
      gender: null,
      preview: null,
      status: 'lookup_failed',
    };
    expect(await catalog.details({ provider: 'gemini', model: 'gemini-9-tts', voice: 'alnilam' }, 'key')).toEqual(
      failed,
    );
    state.down = false;
    t = 29_000;
    expect(await catalog.lookup('gemini', 'key', 'alnilam')).toEqual({ status: 'lookup_failed' });
    expect(calls).toHaveLength(1);
    t = 30_000;
    expect((await catalog.lookup('gemini', 'key', 'alnilam')).status).toBe('resolved');
  });

  it('keeps answering from the old listing while one refresh runs, then from the new one', async () => {
    let t = 0;
    const state: { voices?: unknown[] } = {};
    const { calls, fetchFn } = gemini(state);
    const catalog = createVoiceCatalog({ fetch: fetchFn, now: () => t });
    expect((await catalog.lookup('gemini', 'key', 'alnilam')).status).toBe('resolved');
    state.voices = [tech, { ...alnilam, id: 'kore', display_name: 'Kore' }];
    t = 3_600_000;
    const [during, again] = await Promise.all([
      catalog.lookup('gemini', 'key', 'alnilam'),
      catalog.lookup('gemini', 'key', 'alnilam'),
    ]);
    expect([during.status, again.status]).toEqual(['resolved', 'resolved']);
    await vi.waitFor(async () => expect((await catalog.lookup('gemini', 'key', 'kore')).status).toBe('resolved'));
    expect(await catalog.lookup('gemini', 'key', 'alnilam')).toEqual({ status: 'unavailable' });
    expect(calls).toHaveLength(4);
  });

  it('asks ElevenLabs for a voice outside the listing by id, keeping each answer for its own while', async () => {
    let t = 0;
    let byIdFails = true;
    const { urls, fetchFn } = fakeUpstream((url) => {
      if (url.pathname === '/v2/voices') return Response.json({ voices: [will], has_more: false });
      if (byIdFails) return new Response('', { status: 500 });
      return url.pathname.endsWith('/S80713fa2M70CssGEBj5')
        ? Response.json({ voice_id: 'S80713fa2M70CssGEBj5', name: 'Maks', labels: { gender: 'male' } })
        : Response.json(
            { detail: { status: 'voice_not_found', message: 'A voice with ID was not found.' } },
            { status: 400 },
          );
    });
    const catalog = createVoiceCatalog({ fetch: fetchFn, now: () => t, log: quiet });
    expect(await catalog.lookup('elevenlabs', 'key', 'bIHbv24MWmeRgasZH58o')).toEqual({
      status: 'resolved',
      voice: {
        id: 'bIHbv24MWmeRgasZH58o',
        name: 'Will',
        language: 'en',
        gender: 'male',
        preview: 'https://example.invalid/w.mp3',
      },
    });
    expect(await catalog.lookup('elevenlabs', 'key', 'S80713fa2M70CssGEBj5')).toEqual({ status: 'lookup_failed' });
    byIdFails = false;
    expect(await catalog.lookup('elevenlabs', 'key', 'S80713fa2M70CssGEBj5')).toEqual({ status: 'lookup_failed' });
    t = 15_000;
    for (let i = 0; i < 2; i++) {
      expect(await catalog.lookup('elevenlabs', 'key', 'S80713fa2M70CssGEBj5')).toEqual({
        status: 'resolved',
        voice: { id: 'S80713fa2M70CssGEBj5', name: 'Maks', gender: 'male' },
      });
      expect(await catalog.lookup('elevenlabs', 'key', 'ZZZZZZZZZZZZZZZZZZZZ')).toEqual({ status: 'unavailable' });
    }
    // ElevenLabs ids are exact; a save asks again rather than trust a kept answer.
    expect(await catalog.lookup('elevenlabs', 'key', 'BIHBV24MWMERGASZH58O')).toEqual({ status: 'unavailable' });
    expect(await catalog.lookup('elevenlabs', 'key', 'ZZZZZZZZZZZZZZZZZZZZ', { confirm: true })).toEqual({
      status: 'unavailable',
    });
    expect(catalog.known('elevenlabs', 'key', 'ZZZZZZZZZZZZZZZZZZZZ')).toBe('unavailable');
    // A miss is kept ten minutes, a voice found for the hour.
    t = 15_000 + 600_000;
    expect(catalog.known('elevenlabs', 'key', 'ZZZZZZZZZZZZZZZZZZZZ')).toBeUndefined();
    expect(catalog.known('elevenlabs', 'key', 'S80713fa2M70CssGEBj5')).toBe('resolved');
    expect(await catalog.lookup('elevenlabs', 'key', 'ZZZZZZZZZZZZZZZZZZZZ')).toEqual({ status: 'unavailable' });
    expect(urls().map((u) => u.pathname)).toEqual([
      '/v2/voices',
      '/v1/voices/S80713fa2M70CssGEBj5',
      '/v1/voices/S80713fa2M70CssGEBj5',
      '/v1/voices/ZZZZZZZZZZZZZZZZZZZZ',
      '/v1/voices/BIHBV24MWMERGASZH58O',
      '/v1/voices/ZZZZZZZZZZZZZZZZZZZZ',
      '/v1/voices/ZZZZZZZZZZZZZZZZZZZZ',
    ]);
  });

  it("takes only ElevenLabs' own not-found as proof a voice is gone", async () => {
    const replies: Array<[() => Response | Promise<Response>, string]> = [
      [() => new Response('', { status: 404 }), 'unavailable'],
      [() => Response.json({ detail: { status: 'voice_not_found' } }, { status: 400 }), 'unavailable'],
      [() => Response.json({ detail: { status: 'invalid_uid' } }, { status: 400 }), 'lookup_failed'],
      [() => Response.json({ detail: { status: 'voice_not_found' } }, { status: 401 }), 'lookup_failed'],
      [() => new Response('', { status: 500 }), 'lookup_failed'],
      [() => Promise.reject(new Error('timed out')), 'lookup_failed'],
    ];
    for (const [reply, status] of replies) {
      const { fetchFn } = fakeUpstream((url) =>
        url.pathname === '/v2/voices' ? Response.json({ voices: [], has_more: false }) : reply(),
      );
      const catalog = createVoiceCatalog({ fetch: fetchFn, log: quiet });
      expect(await catalog.lookup('elevenlabs', 'key', 'S80713fa2M70CssGEBj5', { confirm: true })).toEqual({ status });
    }
  });

  it("loads Gemini's listing once more, for every save waiting on it, before a save is refused", async () => {
    let t = 0;
    const state: { voices?: unknown[]; down?: boolean } = {};
    const { calls, fetchFn } = gemini(state);
    const catalog = createVoiceCatalog({ fetch: fetchFn, now: () => t, log: quiet });
    expect((await catalog.lookup('gemini', 'key', 'alnilam')).status).toBe('resolved');
    expect(calls).toHaveLength(2);
    // Plain lookups trust the listing, and so does a save while it is seconds old.
    expect(await catalog.lookup('gemini', 'key', 'voice_new')).toEqual({ status: 'unavailable' });
    expect(await catalog.lookup('gemini', 'key', 'voice_new', { confirm: true })).toEqual({ status: 'unavailable' });
    expect(calls).toHaveLength(2);
    state.voices = [alnilam, { id: 'voice_new', display_name: 'New' }];
    t = 10_000;
    const saves = await Promise.all([
      catalog.lookup('gemini', 'key', 'voice_new', { confirm: true }),
      catalog.lookup('gemini', 'key', 'voice_new', { confirm: true }),
    ]);
    expect(saves.map((r) => r.status)).toEqual(['resolved', 'resolved']);
    expect(calls).toHaveLength(4);
    t = 20_000;
    expect(await catalog.lookup('gemini', 'key', 'voice_gone', { confirm: true })).toEqual({ status: 'unavailable' });
    expect(calls).toHaveLength(6);
    // A listing that cannot load again proves nothing: the save goes through, and the next waits out the pause.
    state.down = true;
    t = 30_000;
    expect(await catalog.lookup('gemini', 'key', 'voice_gone', { confirm: true })).toEqual({ status: 'lookup_failed' });
    expect(await catalog.lookup('gemini', 'key', 'voice_gone', { confirm: true })).toEqual({ status: 'lookup_failed' });
    expect(calls).toHaveLength(7);
    // What the last whole listing had still resolves; what it lacked is no longer certain.
    expect((await catalog.lookup('gemini', 'key', 'voice_new')).status).toBe('resolved');
    expect(await catalog.lookup('gemini', 'key', 'voice_gone')).toEqual({ status: 'lookup_failed' });
    expect(catalog.known('gemini', 'key', 'voice_gone')).toBeUndefined();
  });

  it('takes no listing cut short by a failed page or a repeated page token', async () => {
    for (const second of [
      () => new Response('', { status: 503 }),
      () => Response.json({ voices: [tech], next_page_token: 'p1' }),
    ]) {
      let t = 0;
      let broken = false;
      const { fetchFn } = fakeUpstream((url) =>
        url.searchParams.get('page_token') === 'p1'
          ? broken
            ? second()
            : Response.json({ voices: [tech] })
          : Response.json({ voices: [alnilam], next_page_token: 'p1' }),
      );
      const catalog = createVoiceCatalog({ fetch: fetchFn, now: () => t, log: quiet });
      broken = true;
      expect(await catalog.lookup('gemini', 'key', 'alnilam')).toEqual({ status: 'lookup_failed' });
      broken = false;
      t = 30_000;
      expect((await catalog.lookup('gemini', 'key', 'en-us-techagent-4')).status).toBe('resolved');
      broken = true;
      t = 30_000 + 3_600_000;
      await catalog.lookup('gemini', 'key', 'alnilam');
      await vi.waitFor(() => expect(catalog.known('gemini', 'key', 'kore')).toBeUndefined());
      expect(catalog.known('gemini', 'key', 'alnilam')).toBe('resolved');
      expect(await catalog.lookup('gemini', 'key', 'kore')).toEqual({ status: 'lookup_failed' });
    }
  });

  it("keeps each key's names and pages apart, a bounded number of them", async () => {
    const { calls, fetchFn } = gemini();
    const catalog = createVoiceCatalog({ fetch: fetchFn });
    expect((await catalog.lookup('gemini', 'key-a', 'alnilam')).status).toBe('resolved');
    expect(catalog.known('gemini', 'key-b', 'alnilam')).toBeUndefined();
    expect((await catalog.lookup('gemini', 'key-b', 'alnilam')).status).toBe('resolved');
    expect(calls).toHaveLength(4);
    expect(calls.map((c) => c.headers.get('x-goog-api-key'))).toEqual(['key-a', 'key-a', 'key-b', 'key-b']);
    await catalog.page('gemini', 'key-a', { limit: 3 });
    await catalog.page('gemini', 'key-b', { limit: 3 });
    expect(calls).toHaveLength(6);
    for (let i = 0; i < 250; i++) await catalog.page('gemini', 'key-a', { limit: 3, q: `q${i}` });
    // The oldest pages gave way: asking for the first again goes upstream.
    await catalog.page('gemini', 'key-a', { limit: 3 });
    expect(calls).toHaveLength(6 + 250 + 1);
  });

  it("asks lazily for only the ids in use: the id's language on every page, then the whole listing", async () => {
    const custom = { id: 'my_voice', display_name: 'Mine', language_code: 'de-DE' };
    const { urls, fetchFn } = fakeUpstream((url) => {
      if (url.hostname === 'api.elevenlabs.io') {
        return Response.json({ voice_id: 'S80713fa2M70CssGEBj5', name: 'Maks', labels: {} });
      }
      const language = url.searchParams.get('language_code');
      if (language === 'en-US') {
        return Response.json(
          url.searchParams.get('page_token') === 'p1'
            ? { voices: [tech] }
            : { voices: [alnilam], next_page_token: 'p1' },
        );
      }
      return Response.json({ voices: language ? [] : [alnilam, tech, custom] });
    });
    const catalog = createVoiceCatalog({ fetch: fetchFn, lazy: true });
    expect(urls()).toEqual([]);
    expect((await catalog.lookup('gemini', 'key', 'en-us-techagent-4')).status).toBe('resolved');
    expect((await catalog.lookup('gemini', 'key', 'alnilam')).status).toBe('resolved');
    // An id's prefix is only where to look first: a custom voice is in the whole listing.
    expect(await catalog.lookup('gemini', 'key', 'my_voice')).toEqual({
      status: 'resolved',
      voice: { id: 'my_voice', name: 'Mine', language: 'de-DE' },
    });
    expect(await catalog.lookup('gemini', 'key', 'de-de-voice-1')).toEqual({ status: 'unavailable' });
    expect((await catalog.lookup('elevenlabs', 'key', 'S80713fa2M70CssGEBj5')).status).toBe('resolved');
    expect(urls().map((u) => [u.pathname, Object.fromEntries(u.searchParams)])).toEqual([
      ['/v1beta/voices', { page_size: '1000', language_code: 'en-US' }],
      ['/v1beta/voices', { page_size: '1000', language_code: 'en-US', page_token: 'p1' }],
      ['/v1beta/voices', { page_size: '1000' }],
      ['/v1beta/voices', { page_size: '1000', language_code: 'de-DE' }],
      ['/v1/voices/S80713fa2M70CssGEBj5', {}],
    ]);
  });

  it("keeps a worker's listing for the hour, and a failed one for a short while", async () => {
    let t = 0;
    const state = { down: true };
    const { calls, fetchFn } = gemini(state);
    const catalog = createVoiceCatalog({ fetch: fetchFn, now: () => t, log: quiet, lazy: true });
    expect(await catalog.lookup('gemini', 'key', 'alnilam')).toEqual({ status: 'lookup_failed' });
    expect(calls).toHaveLength(2);
    state.down = false;
    t = 14_000;
    expect(await catalog.lookup('gemini', 'key', 'alnilam')).toEqual({ status: 'lookup_failed' });
    expect(calls).toHaveLength(2);
    t = 15_000;
    expect((await catalog.lookup('gemini', 'key', 'alnilam')).status).toBe('resolved');
    expect(calls).toHaveLength(4);
    t = 15_000 + 3_599_000;
    expect((await catalog.lookup('gemini', 'key', 'alnilam')).status).toBe('resolved');
    expect(calls).toHaveLength(4);
    t = 15_000 + 3_600_000;
    expect((await catalog.lookup('gemini', 'key', 'alnilam')).status).toBe('resolved');
    expect(calls).toHaveLength(6);
  });

  it("logs a provider's failure by its status or name only, never its message or body", async () => {
    const secret = 'AIzaSECRET-in-an-error-body';
    const warn = vi.fn();
    for (const reply of [
      () =>
        Response.json(
          { error: { code: 403, message: `API key ${secret} is not allowed`, status: 'PERMISSION_DENIED' } },
          { status: 403 },
        ),
      () => Promise.reject(new Error(`connect failed for ${secret}`)),
      () => new Response(`{"voices": ${secret}`, { status: 200, headers: { 'content-type': 'application/json' } }),
    ]) {
      const { fetchFn } = fakeUpstream(reply);
      const catalog = createVoiceCatalog({ fetch: fetchFn, log: { info: vi.fn(), warn } });
      expect(await catalog.page('gemini', 'key', { limit: 1 })).toEqual({ error: 'upstream' });
      expect(await catalog.page('elevenlabs', 'key', { limit: 1 })).toEqual({ error: 'upstream' });
      expect((await catalog.lookup('gemini', 'key', 'alnilam')).status).toBe('lookup_failed');
    }
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    expect(warn.mock.calls.map(([, fields]) => (fields as { failure: string }).failure)).toContain('HTTP 403');
  });

  it('keeps a voice a save could not confirm in doubt until a load started after the save proves it gone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let t = 0;
      let release: (() => void) | undefined;
      const state: { voices: unknown[] } = { voices: [alnilam] };
      const { calls, fetchFn } = fakeUpstream(async () => {
        if (release === undefined) return Response.json({ voices: state.voices });
        await new Promise<void>((resolve) => (release = resolve));
        return Response.json({ voices: state.voices });
      });
      const catalog = createVoiceCatalog({ fetch: fetchFn, now: () => t, log: quiet });
      expect((await catalog.lookup('gemini', 'key', 'alnilam')).status).toBe('resolved');
      expect(catalog.known('gemini', 'key', 'voice_new')).toBe('unavailable');
      // The save's own load hangs past the wait: the save goes through, and the voice is in doubt everywhere.
      release = () => undefined;
      t = 10_000;
      const saving = catalog.lookup('gemini', 'key', 'voice_new', { confirm: true });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await saving).toEqual({ status: 'lookup_failed' });
      expect(calls).toHaveLength(2);
      expect(catalog.known('gemini', 'key', 'voice_new')).toBeUndefined();
      expect(await catalog.lookup('gemini', 'key', 'voice_new')).toEqual({ status: 'lookup_failed' });
      expect(
        (await catalog.details({ provider: 'gemini', model: 'gemini-3.8-flash-tts', voice: 'voice_new' }, 'key'))
          .status,
      ).toBe('lookup_failed');
      // What the listing has still resolves, and what it lacks with no doubt on it is still gone.
      expect(catalog.known('gemini', 'key', 'alnilam')).toBe('resolved');
      expect(catalog.known('gemini', 'key', 'kore')).toBe('unavailable');
      // That load finishing without the voice proves it gone.
      release();
      await vi.waitFor(() => expect(catalog.known('gemini', 'key', 'voice_new')).toBe('unavailable'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes warmed listings on its own until closed, and stops trusting an absence nobody refreshed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      let t = 0;
      const { calls, fetchFn } = gemini();
      const catalog = createVoiceCatalog({ fetch: fetchFn, now: () => t });
      catalog.warm({ gemini: 'key' });
      await vi.waitFor(() => expect(catalog.known('gemini', 'key', 'alnilam')).toBe('resolved'));
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(calls).toHaveLength(2);
      t = 3_600_000;
      await vi.advanceTimersByTimeAsync(300_000);
      await vi.waitFor(() => expect(calls).toHaveLength(4));
      catalog.close();
      t = 2 * 3_600_000;
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(calls).toHaveLength(4);
      expect(catalog.known('gemini', 'key', 'kore')).toBe('unavailable');
      t = 3 * 3_600_000;
      expect(catalog.known('gemini', 'key', 'kore')).toBeUndefined();
      expect(catalog.known('gemini', 'key', 'alnilam')).toBe('resolved');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves a voice the provider gave no name as nameless, while its page shows the id', async () => {
    const { fetchFn } = fakeUpstream(() => Response.json({ voices: [{ id: 'nameless-1' }] }));
    const catalog = createVoiceCatalog({ fetch: fetchFn });
    expect(
      await catalog.details({ provider: 'gemini', model: 'gemini-3.8-flash-tts', voice: 'nameless-1' }, 'key'),
    ).toMatchObject({ voice: 'nameless-1', voiceName: null, status: 'resolved' });
    expect(await catalog.page('gemini', 'key', { limit: 1 })).toEqual({
      page: { provider: 'gemini', voices: [{ id: 'nameless-1', name: 'nameless-1' }] },
    });
  });

  it('asks once for the same page wanted twice at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { calls, fetchFn } = fakeUpstream(async () => {
      await gate;
      return Response.json({ voices: [will], has_more: false });
    });
    const catalog = createVoiceCatalog({ fetch: fetchFn });
    const both = Promise.all([0, 1].map(() => catalog.page('elevenlabs', 'key', { limit: 5 })));
    release();
    const [a, b] = await both;
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
  });

  it('keeps a page for a minute, by provider and the whole query', async () => {
    let t = 0;
    const { calls, fetchFn } = fakeUpstream(() => Response.json({ voices: [will], has_more: false }));
    const catalog = createVoiceCatalog({ fetch: fetchFn, now: () => t });
    const query = { limit: 5, gender: 'male' };
    await catalog.page('elevenlabs', 'key', query);
    await catalog.page('elevenlabs', 'key', query);
    await catalog.page('elevenlabs', 'key', { ...query, gender: 'female' });
    await catalog.page('gemini', 'key', query);
    expect(calls).toHaveLength(3);
    t = 60_000;
    await catalog.page('elevenlabs', 'key', query);
    expect(calls).toHaveLength(4);
  });
});
