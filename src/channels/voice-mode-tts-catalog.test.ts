/**
 * The voice catalog against faked provider listings: Gemini's through the real `@google/genai`
 * client over the fetch seam, ElevenLabs' proxied directly. The routes over it are in
 * voice-mode-adapter.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

import { createVoiceCatalog, ELEVENLABS_VOICES_URL } from './voice-mode-tts-catalog.js';

const GEMINI_VOICES_URL = 'https://generativelanguage.googleapis.com/v1beta/voices';

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
