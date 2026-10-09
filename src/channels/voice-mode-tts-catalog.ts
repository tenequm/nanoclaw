/**
 * The voices a line can pick, per provider, for `GET /voice/voices` (voice-mode.ts). Gemini's
 * `voices.list` has no server-side filter, so its whole list is fetched once an hour and paged and
 * filtered here; ElevenLabs' `/v2/voices` filters and pages itself, so each page is proxied. The
 * provider keys stay in request headers: no answer or log line carries them.
 */
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
  cursor?: string;
  limit: number;
}
export type CatalogResult = { page: VoiceCatalogPage } | { error: 'bad_request' | 'upstream' };

export interface VoiceCatalog {
  page(provider: TtsProvider, apiKey: string, query: CatalogQuery): Promise<CatalogResult>;
}

export const GEMINI_VOICES_URL = 'https://generativelanguage.googleapis.com/v1beta/voices';
export const ELEVENLABS_VOICES_URL = 'https://api.elevenlabs.io/v2/voices';
const GEMINI_CACHE_MS = 3_600_000;
/** The listing's largest page; 2,089 voices took 3 pages on 2026-10-09 (21 at the default size). */
const GEMINI_PAGE_SIZE = 1000;
/** Headroom for a listing that grows or a page size the API caps lower. */
const GEMINI_MAX_PAGES = 50;
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

const encodeOffset = (offset: number): string => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');

function decodeOffset(cursor: string): number | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const o = (parsed as { o?: unknown } | null)?.o;
    return Number.isSafeInteger(o) && (o as number) >= 0 ? (o as number) : null;
  } catch {
    return null;
  }
}

export function createVoiceCatalog(
  options: { fetch?: typeof fetch; now?: () => number; cacheMs?: number } = {},
): VoiceCatalog {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now());
  const cacheMs = options.cacheMs ?? GEMINI_CACHE_MS;
  let gemini: { at: number; voices: Promise<CatalogVoice[]> } | null = null;

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

  const fetchGemini = async (apiKey: string): Promise<CatalogVoice[]> => {
    const voices: CatalogVoice[] = [];
    let pageToken: string | undefined;
    for (let pages = 0; pages < GEMINI_MAX_PAGES; pages++) {
      const url = new URL(GEMINI_VOICES_URL);
      url.searchParams.set('pageSize', String(GEMINI_PAGE_SIZE));
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const body = await getJson(url, { 'x-goog-api-key': apiKey });
      for (const raw of records(body)) {
        const v = geminiVoice(raw);
        if (v) voices.push(v);
      }
      pageToken = text(body.next_page_token);
      if (!pageToken) return voices;
    }
    throw new Error(`more than ${GEMINI_MAX_PAGES} pages`);
  };

  /** The cached list; one fetch serves every request while it runs, and a failed one is not kept. */
  const geminiVoices = (apiKey: string): Promise<CatalogVoice[]> => {
    if (gemini && now() - gemini.at < cacheMs) return gemini.voices;
    const entry = { at: now(), voices: fetchGemini(apiKey) };
    gemini = entry;
    entry.voices.catch(() => {
      if (gemini === entry) gemini = null;
    });
    return entry.voices;
  };

  const geminiPage = async (apiKey: string, query: CatalogQuery): Promise<CatalogResult> => {
    const offset = query.cursor === undefined ? 0 : decodeOffset(query.cursor);
    if (offset === null) return { error: 'bad_request' };
    const q = query.q?.toLowerCase();
    const language = query.language?.toLowerCase();
    const matches = (await geminiVoices(apiKey)).filter(
      (v) =>
        (!language || v.language?.toLowerCase() === language) &&
        (!q || [v.name, v.id, v.description ?? ''].some((f) => f.toLowerCase().includes(q))),
    );
    const end = offset + query.limit;
    const page: VoiceCatalogPage = { provider: 'gemini', voices: matches.slice(offset, end) };
    if (end < matches.length) page.next = encodeOffset(end);
    return { page };
  };

  const elevenLabsPage = async (apiKey: string, query: CatalogQuery): Promise<CatalogResult> => {
    const url = new URL(ELEVENLABS_VOICES_URL);
    url.searchParams.set('page_size', String(query.limit));
    if (query.q) url.searchParams.set('search', query.q);
    if (query.language) url.searchParams.set('language', query.language);
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
        // The message names a status or a parse failure, never the key or the request headers.
        log.warn('voice-mode: the voice catalog upstream failed', {
          provider,
          err: err instanceof Error ? err.message : String(err),
        });
        return { error: 'upstream' };
      }
    },
  };
}
