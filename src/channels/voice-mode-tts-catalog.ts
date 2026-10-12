/**
 * The voices a line can pick, per provider, for `GET /voice/voices` (voice-mode.ts). Both providers
 * filter and page their own listings, so each page is a proxied request: Gemini's `voices.list`
 * through `@google/genai`, ElevenLabs' `/v2/voices` directly (the plugin's `listVoices()` reads the
 * legacy v1 listing, without filters, labels or samples). The provider keys stay in request headers:
 * no answer or log line carries them.
 */
import { GoogleGenAI } from '@google/genai';

import { log } from '../log.js';
import type { TtsProvider } from '../voice-mode-tts.js';

export interface CatalogVoice {
  /** What a saved or requested `voice` takes. */
  id: string;
  name: string;
  language?: string;
  gender?: string;
  description?: string;
  /** A sample to play; ElevenLabs only. */
  preview?: string;
}
export interface VoiceCatalogPage {
  provider: TtsProvider;
  voices: CatalogVoice[];
  /** The `cursor` of the next page; absent on the last. */
  next?: string;
}
export interface CatalogQuery {
  q?: string;
  language?: string;
  /** Lowercase `female`, `male` or `neutral`. */
  gender?: string;
  cursor?: string;
  limit: number;
}
export type CatalogResult = { page: VoiceCatalogPage } | { error: 'bad_request' | 'upstream' };

export interface VoiceCatalog {
  page(provider: TtsProvider, apiKey: string, query: CatalogQuery): Promise<CatalogResult>;
}

export const ELEVENLABS_VOICES_URL = 'https://api.elevenlabs.io/v2/voices';
const UPSTREAM_TIMEOUT_MS = 15_000;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Drops absent fields, so the JSON a client decodes carries only what the provider said. */
const voice = (fields: CatalogVoice): CatalogVoice =>
  Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as CatalogVoice;

function geminiVoice(raw: Record<string, unknown>): CatalogVoice | null {
  const id = text(raw.id);
  if (!id) return null;
  const description = [text(raw.persona), text(raw.description)].filter(Boolean).join('. ');
  return voice({
    id,
    name: text(raw.display_name) ?? id,
    language: text(raw.language_code),
    gender: text(raw.gender),
    description: description || undefined,
  });
}

function elevenLabsVoice(raw: Record<string, unknown>): CatalogVoice | null {
  const id = text(raw.voice_id);
  if (!id) return null;
  const labels = (raw.labels && typeof raw.labels === 'object' ? raw.labels : {}) as Record<string, unknown>;
  return voice({
    id,
    name: text(raw.name) ?? id,
    language: text(labels.language),
    gender: text(labels.gender),
    description: text(raw.description),
    preview: text(raw.preview_url),
  });
}

export function createVoiceCatalog(options: { fetch?: typeof fetch } = {}): VoiceCatalog {
  const fetchFn = options.fetch ?? fetch;

  const getJson = async (url: URL, headers: Record<string, string>): Promise<Record<string, unknown>> => {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${res.status}`);
    }
    const body: unknown = await res.json();
    if (!body || typeof body !== 'object' || !Array.isArray((body as { voices?: unknown }).voices)) {
      throw new Error('no voices list');
    }
    return body as Record<string, unknown>;
  };

  const records = (body: Record<string, unknown>): Record<string, unknown>[] =>
    (body.voices as unknown[]).filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');

  const geminiPage = async (apiKey: string, query: CatalogQuery): Promise<CatalogResult> => {
    // Pinned off: GOOGLE_GENAI_USE_VERTEXAI in the host's environment would route the request to Vertex AI.
    const ai = new GoogleGenAI({ apiKey, vertexai: false, httpOptions: { fetch: fetchFn } });
    let body: Awaited<ReturnType<typeof ai.voices.list>>;
    try {
      body = await ai.voices.list(
        {
          page_size: query.limit,
          search: query.q,
          language_code: query.language ? [query.language] : undefined,
          gender: query.gender ? [query.gender] : undefined,
          page_token: query.cursor,
        },
        { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), retries: { strategy: 'none' } },
      );
    } catch (err) {
      // A token that is not Gemini's, or one from a listing with other filters.
      if (query.cursor && (err as { status?: unknown }).status === 400) return { error: 'bad_request' };
      throw err;
    }
    const page: VoiceCatalogPage = {
      provider: 'gemini',
      voices: (body.voices ?? []).map(geminiVoice).filter((v): v is CatalogVoice => v !== null),
    };
    const next = text(body.next_page_token);
    if (next) page.next = next;
    return { page };
  };

  const elevenLabsPage = async (apiKey: string, query: CatalogQuery): Promise<CatalogResult> => {
    const url = new URL(ELEVENLABS_VOICES_URL);
    url.searchParams.set('page_size', String(query.limit));
    if (query.q) url.searchParams.set('search', query.q);
    if (query.language) url.searchParams.set('language', query.language);
    if (query.gender) url.searchParams.set('gender', query.gender);
    if (query.cursor) url.searchParams.set('next_page_token', query.cursor);
    url.searchParams.set('include_total_count', 'false');
    const body = await getJson(url, { 'xi-api-key': apiKey });
    const page: VoiceCatalogPage = {
      provider: 'elevenlabs',
      voices: records(body)
        .map(elevenLabsVoice)
        .filter((v): v is CatalogVoice => v !== null),
    };
    const next = text(body.next_page_token);
    if (body.has_more === true && next) page.next = next;
    return { page };
  };

  return {
    async page(provider, apiKey, query) {
      try {
        return await (provider === 'gemini' ? geminiPage(apiKey, query) : elevenLabsPage(apiKey, query));
      } catch (err) {
        // The message names a status, a parse failure or the provider's error body; never the key or headers.
        log.warn('voice-mode: the voice catalog upstream failed', {
          provider,
          err: err instanceof Error ? err.message : String(err),
        });
        return { error: 'upstream' };
      }
    },
  };
}
