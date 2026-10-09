/**
 * The voice catalog against faked provider listings: how Gemini's full list is cached and paged
 * locally, and how ElevenLabs pages are proxied. The routes over it are in voice-mode-adapter.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { createVoiceCatalog, ELEVENLABS_VOICES_URL } from './voice-mode-tts-catalog.js';

const cursor = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');

function fakeUpstream(respond: (url: URL) => Response | Promise<Response>) {
  const urls: URL[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    return respond(url);
  }) as typeof fetch;
  return { urls, fetchFn };
}

describe('voice catalog', () => {
  it("keeps Gemini's list for an hour, shares one fetch between requests, then fetches it again", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { urls, fetchFn } = fakeUpstream(async () => {
      await gate;
      return Response.json({ voices: [{ id: 'kore', display_name: 'Kore', language_code: 'en-US' }] });
    });
    const clock = { now: 0 };
    const catalog = createVoiceCatalog({ fetch: fetchFn, now: () => clock.now });
    const pending = [1, 2].map(() => catalog.page('gemini', 'key', { limit: 10 }));
    release();
    for (const result of await Promise.all(pending)) {
      expect(result).toEqual({
        page: { provider: 'gemini', voices: [{ id: 'kore', name: 'Kore', language: 'en-US' }] },
      });
    }
    clock.now = 3_599_999;
    await catalog.page('gemini', 'key', { limit: 10 });
    expect(urls).toHaveLength(1);
    expect(urls[0].searchParams.get('pageSize')).toBe('1000');
    clock.now = 3_600_000;
    await catalog.page('gemini', 'key', { limit: 10 });
    expect(urls).toHaveLength(2);
  });

  it('joins the persona and description, and pages past the filters with an offset cursor', async () => {
    const voices = [
      { id: 'a', display_name: 'Alpha', language_code: 'en-GB', persona: 'Narrator' },
      { id: 'b', display_name: 'Beta', language_code: 'en-US', description: 'Warm and low.' },
      { id: 'c', display_name: 'Gamma', language_code: 'en-US', persona: 'Host', description: 'Bright.' },
      { display_name: 'no id' },
      { id: 'd', language_code: 'fr-FR' },
    ];
    const { fetchFn } = fakeUpstream(() => Response.json({ voices }));
    const catalog = createVoiceCatalog({ fetch: fetchFn });
    expect(await catalog.page('gemini', 'key', { limit: 1, language: 'en-us' })).toEqual({
      page: {
        provider: 'gemini',
        voices: [{ id: 'b', name: 'Beta', language: 'en-US', description: 'Warm and low.' }],
        next: cursor(1),
      },
    });
    expect(await catalog.page('gemini', 'key', { limit: 1, language: 'en-us', cursor: cursor(1) })).toEqual({
      page: {
        provider: 'gemini',
        voices: [{ id: 'c', name: 'Gamma', language: 'en-US', description: 'Host. Bright.' }],
      },
    });
    const byText = await catalog.page('gemini', 'key', { limit: 10, q: 'narr' });
    expect(byText).toEqual({
      page: { provider: 'gemini', voices: [{ id: 'a', name: 'Alpha', language: 'en-GB', description: 'Narrator' }] },
    });
    expect(await catalog.page('gemini', 'key', { limit: 10, q: 'D' })).toMatchObject({
      page: { voices: [{ id: 'b' }, { id: 'd', name: 'd' }] },
    });
    for (const bad of ['%%%', cursor(-1), Buffer.from('{"o":1.5}').toString('base64url'), 'bnVsbA']) {
      expect(await catalog.page('gemini', 'key', { limit: 1, cursor: bad })).toEqual({ error: 'bad_request' });
    }
  });

  it('answers upstream for a failed, malformed or endless Gemini listing, and keeps none of them', async () => {
    const replies = [
      new Response('denied', { status: 403 }),
      Response.json({ error: 'shape' }),
      () => Promise.reject(new Error('socket hang up')),
    ];
    for (const r of replies) {
      const { fetchFn } = fakeUpstream(() => (typeof r === 'function' ? r() : r));
      expect(await createVoiceCatalog({ fetch: fetchFn }).page('gemini', 'key', { limit: 1 })).toEqual({
        error: 'upstream',
      });
    }
    const endless = fakeUpstream(() => Response.json({ voices: [], next_page_token: 'again' }));
    expect(await createVoiceCatalog({ fetch: endless.fetchFn }).page('gemini', 'key', { limit: 1 })).toEqual({
      error: 'upstream',
    });
    expect(endless.urls).toHaveLength(50);
    let calls = 0;
    const flaky = fakeUpstream(() =>
      ++calls === 1 ? new Response('', { status: 503 }) : Response.json({ voices: [] }),
    );
    const catalog = createVoiceCatalog({ fetch: flaky.fetchFn });
    expect(await catalog.page('gemini', 'key', { limit: 1 })).toEqual({ error: 'upstream' });
    expect(await catalog.page('gemini', 'key', { limit: 1 })).toEqual({ page: { provider: 'gemini', voices: [] } });
  });

  it('proxies an ElevenLabs page, sending only the parameters given and passing its token on', async () => {
    const { urls, fetchFn } = fakeUpstream(() =>
      Response.json({
        voices: [{ voice_id: 'abcdefghij1234567890', name: 'Rachel', labels: {}, description: 'Calm.' }],
        has_more: true,
        next_page_token: 'page-2',
      }),
    );
    expect(await createVoiceCatalog({ fetch: fetchFn }).page('elevenlabs', 'key', { limit: 5 })).toEqual({
      page: {
        provider: 'elevenlabs',
        voices: [{ id: 'abcdefghij1234567890', name: 'Rachel', description: 'Calm.' }],
        next: 'page-2',
      },
    });
    expect(urls[0].origin + urls[0].pathname).toBe(ELEVENLABS_VOICES_URL);
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({ page_size: '5', include_total_count: 'false' });
  });
});
