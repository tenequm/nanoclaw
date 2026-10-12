/**
 * The voices a line can pick, per provider, for `GET /voice/voices` (voice-mode.ts), and the names
 * of the voices lines use. Both providers filter and page their own listings, so each page is a
 * proxied request, kept for a minute: Gemini's `voices.list` through `@google/genai`, ElevenLabs'
 * `/v2/voices` directly (the plugin's `listVoices()` reads the legacy v1 listing, without filters,
 * labels or samples). The host names voices from each provider's whole listing, held in its memory
 * only and refreshed in the background; an ElevenLabs voice outside it (a library voice) is asked
 * for by id. The worker (`lazy`) asks only about the voices its calls use. Everything kept is per
 * provider key. The keys stay in request headers: no answer, cache key or log line carries them.
 */
import { createHash } from 'node:crypto';

import { GoogleGenAI } from '@google/genai';

import { log as hostLog } from '../log.js';
import { TTS_REGISTRY, type ProviderKeys, type TtsChoice, type TtsProvider } from '../voice-mode-tts.js';

export interface CatalogVoice {
  /** What a saved or requested `voice` takes. */
  id: string;
  /** The provider's name for it, or its id when it gave none. */
  name: string;
  language?: string;
  gender?: string;
  description?: string;
  /** A sample to play; ElevenLabs only. */
  preview?: string;
}
/** A voice as the provider described it: a `name` only when it gave one. */
export type VoiceRecord = Omit<CatalogVoice, 'name'> & { name?: string };
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
type RecordPage = Omit<VoiceCatalogPage, 'voices'> & { voices: VoiceRecord[] };
type RecordResult = { page: RecordPage } | { error: 'bad_request' | 'upstream' };

/** `resolved`: the provider has the voice; `unavailable`: it certainly has not; `lookup_failed`: it could not be asked. */
export type VoiceStatus = 'resolved' | 'unavailable' | 'lookup_failed';
export type VoiceLookup = { status: 'resolved'; voice: VoiceRecord } | { status: 'unavailable' | 'lookup_failed' };
/** A speech choice with the names a client shows for it. */
export interface ChoiceDetails {
  provider: TtsProvider;
  providerName: string;
  model: string;
  modelName: string;
  voice: string;
  voiceName: string | null;
  language: string | null;
  gender: string | null;
  preview: string | null;
  status: VoiceStatus;
}

export interface VoiceCatalog {
  page(provider: TtsProvider, apiKey: string, query: CatalogQuery): Promise<CatalogResult>;
  /**
   * A voice by its exact id; never throws. On the host it waits LOOKUP_WAIT_MS at most for each load it
   * needs (a `confirm` can need two); the worker's (`lazy`) waits on its loads' own timeouts. `confirm`
   * (a save) asks again before an answer of `unavailable`: Gemini by a fresh listing, ElevenLabs by id.
   */
  lookup(
    provider: TtsProvider,
    apiKey: string | undefined,
    id: string,
    options?: { confirm?: boolean },
  ): Promise<VoiceLookup>;
  /** What memory already holds about a voice, asking nothing; undefined when it holds nothing certain. */
  known(provider: TtsProvider, apiKey: string | undefined, id: string): VoiceStatus | undefined;
  /** The choice's names, as lookup finds its voice. */
  details(choice: TtsChoice, apiKey: string | undefined): Promise<ChoiceDetails>;
  /** Loads the name listings of the providers with a key, in the background, and keeps them refreshed. */
  warm(keys: ProviderKeys): void;
  /** Stops the refreshes warm scheduled. */
  close(): void;
}

export const ELEVENLABS_VOICES_URL = 'https://api.elevenlabs.io/v2/voices';
const ELEVENLABS_VOICE_URL = 'https://api.elevenlabs.io/v1/voices';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const UPSTREAM_TIMEOUT_MS = 15_000;
const PAGE_TTL_MS = 60_000;
const MAX_CACHED_PAGES = 200;
/** A name listing is reloaded in the background once it is this old; the old one answers meanwhile. */
const NAMES_TTL_MS = 3_600_000;
/** After a listing failed to load, the next try waits this long. */
const NAMES_RETRY_MS = 30_000;
/** How long a lookup waits on the provider. */
const LOOKUP_WAIT_MS = 3_000;
/** How often warmed listings are checked for a refresh that is due. */
const REFRESH_CHECK_MS = 300_000;
/** A listing this old (its refreshes never ran) no longer proves a voice it lacks is gone. */
const ABSENCE_TTL_MS = 2 * NAMES_TTL_MS;
/** How long an answer about one voice is kept, by what it was. */
const VOICE_TTL_MS: Record<VoiceStatus, number> = {
  resolved: 3_600_000,
  unavailable: 600_000,
  lookup_failed: 15_000,
};
const NAMES_PAGE_SIZE: Record<TtsProvider, number> = { gemini: 1000, elevenlabs: 100 };
const MAX_NAMES_PAGES = 20;
const MAX_KEPT_VOICES = 500;
const MAX_ACCOUNTS = 8;
/** Lazy Gemini listings kept: one per key and language, and each key's whole one. */
const MAX_LAZY_LISTINGS = 32;

/**
 * The language Gemini lists a voice under: its id's locale prefix (`en-us-techagent-4`: en-US), or en-US
 * for the unprefixed ones (`alnilam`).
 */
const geminiLanguage = (id: string): string => {
  const locale = /^([a-z]{2,3})-([a-z0-9]{2,3})-/.exec(id);
  return locale ? `${locale[1]}-${locale[2].toUpperCase()}` : 'en-US';
};

/** A voice id the provider could not have, by the registry's shape check alone. */
const malformed = (provider: TtsProvider, id: string): boolean => {
  const entry = TTS_REGISTRY[provider];
  return entry.validate({ model: entry.defaults.model, voice: id }) !== null;
};

/** What everything kept is filed under: the provider and a digest of its key, never the key. */
const accountOf = (provider: TtsProvider, apiKey: string): string =>
  `${provider}:${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;

/** A failure this module describes itself; its message is safe to log. */
class CatalogError extends Error {}

/**
 * What a log may say about a failure: its HTTP status, this module's own message, or the error's name.
 * Never a provider's message: the SDK puts the upstream body there, which can echo the key.
 */
const failureOf = (err: unknown): string => {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return `HTTP ${status}`;
  if (err instanceof CatalogError) return err.message;
  return err instanceof Error ? err.name : 'error';
};

/** The choice's names from what a lookup found. */
export function choiceDetails(choice: TtsChoice, found: VoiceLookup): ChoiceDetails {
  const entry = TTS_REGISTRY[choice.provider];
  const voice = found.status === 'resolved' ? found.voice : undefined;
  return {
    provider: entry.id,
    providerName: entry.name,
    model: choice.model,
    modelName: entry.modelNames[choice.model] ?? choice.model,
    voice: choice.voice,
    voiceName: voice?.name ?? null,
    language: voice?.language ?? null,
    gender: voice?.gender ?? null,
    preview: voice?.preview ?? null,
    status: found.status,
  };
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Drops absent fields, so the JSON a client decodes carries only what the provider said. */
const record = (fields: VoiceRecord): VoiceRecord =>
  Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as VoiceRecord;

function geminiVoice(raw: Record<string, unknown>): VoiceRecord | null {
  const id = text(raw.id);
  if (!id) return null;
  const description = [text(raw.persona), text(raw.description)].filter(Boolean).join('. ');
  return record({
    id,
    name: text(raw.display_name),
    language: text(raw.language_code),
    gender: text(raw.gender),
    description: description || undefined,
  });
}

function elevenLabsVoice(raw: Record<string, unknown>): VoiceRecord | null {
  const id = text(raw.voice_id);
  if (!id) return null;
  const labels = (raw.labels && typeof raw.labels === 'object' ? raw.labels : {}) as Record<string, unknown>;
  return record({
    id,
    name: text(raw.name),
    language: text(labels.language),
    gender: text(labels.gender),
    description: text(raw.description),
    preview: text(raw.preview_url),
  });
}

/** A voice asked for by id: shared while asked, then kept by what it was. */
interface KeptLookup {
  at: number;
  found: Promise<VoiceLookup>;
  status?: VoiceStatus;
}

/** A worker's Gemini listing: shared while it loads, then kept for its hour, or a short while when it failed. */
interface LazyListing {
  at: number;
  ok?: boolean;
  voices: Promise<Map<string, VoiceRecord> | undefined>;
}

/** One provider key's names: its last whole listing and the voices asked for by id. */
interface Names {
  voices?: Map<string, VoiceRecord>;
  /** When the load of `voices` started: it may lack a voice made while it ran. */
  loadedAt: number;
  failedAt: number;
  /** The last load failed: what the listing lacks proves nothing until one succeeds. */
  stale: boolean;
  loading?: Promise<void>;
  byId: Map<string, KeptLookup>;
  /**
   * Ids a save could not confirm missing, by when it asked: the listing lacking one proves nothing
   * until a load started after that succeeds.
   */
  doubted: Map<string, number>;
}

export function createVoiceCatalog(
  options: {
    fetch?: typeof fetch;
    log?: Pick<Console, 'info' | 'warn'>;
    now?: () => number;
    /** Names only for the ids asked about, nothing loaded ahead (the worker): ElevenLabs by id, Gemini one language's voices. */
    lazy?: boolean;
  } = {},
): VoiceCatalog {
  const fetchFn = options.fetch ?? fetch;
  const log = options.log ?? hostLog;
  const now = options.now ?? (() => Date.now());

  const getJson = async (url: URL, headers: Record<string, string>): Promise<Record<string, unknown>> => {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new CatalogError(`HTTP ${res.status}`);
    }
    const body: unknown = await res.json();
    if (!body || typeof body !== 'object' || !Array.isArray((body as { voices?: unknown }).voices)) {
      throw new CatalogError('no voices list');
    }
    return body as Record<string, unknown>;
  };

  const records = (body: Record<string, unknown>): Record<string, unknown>[] =>
    (body.voices as unknown[]).filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');

  const geminiPage = async (apiKey: string, query: CatalogQuery): Promise<RecordResult> => {
    // Pinned: GOOGLE_GENAI_USE_VERTEXAI or GOOGLE_GEMINI_BASE_URL in the env would send the key elsewhere.
    const ai = new GoogleGenAI({ apiKey, vertexai: false, httpOptions: { baseUrl: GEMINI_BASE_URL, fetch: fetchFn } });
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
        // Not `signal`: the SDK fetches a clone of its Request, which loses the caller's signal after a GC.
        { timeout_ms: UPSTREAM_TIMEOUT_MS, retries: { strategy: 'none' } },
      );
    } catch (err) {
      // A token that is not Gemini's, or one from a listing with other filters; a rejected key is a 400 too.
      const apiError = err as { status?: unknown; error?: { error?: { details?: Array<{ reason?: unknown }> } } };
      const keyRejected = apiError.error?.error?.details?.some((d) => d.reason === 'API_KEY_INVALID');
      if (query.cursor && apiError.status === 400 && !keyRejected) return { error: 'bad_request' };
      throw err;
    }
    const page: RecordPage = {
      provider: 'gemini',
      voices: (body.voices ?? [])
        .filter((v) => !!v && typeof v === 'object')
        .map(geminiVoice)
        .filter((v): v is VoiceRecord => v !== null),
    };
    const next = text(body.next_page_token);
    if (next) page.next = next;
    return { page };
  };

  const elevenLabsPage = async (apiKey: string, query: CatalogQuery): Promise<RecordResult> => {
    const url = new URL(ELEVENLABS_VOICES_URL);
    url.searchParams.set('page_size', String(query.limit));
    if (query.q) url.searchParams.set('search', query.q);
    if (query.language) url.searchParams.set('language', query.language);
    if (query.gender) url.searchParams.set('gender', query.gender);
    if (query.cursor) url.searchParams.set('next_page_token', query.cursor);
    url.searchParams.set('include_total_count', 'false');
    const body = await getJson(url, { 'xi-api-key': apiKey });
    const page: RecordPage = {
      provider: 'elevenlabs',
      voices: records(body)
        .map(elevenLabsVoice)
        .filter((v): v is VoiceRecord => v !== null),
    };
    const next = text(body.next_page_token);
    if (body.has_more === true && next) page.next = next;
    return { page };
  };

  const fetchPage = async (provider: TtsProvider, apiKey: string, query: CatalogQuery): Promise<RecordResult> => {
    const started = now();
    try {
      return await (provider === 'gemini' ? geminiPage(apiKey, query) : elevenLabsPage(apiKey, query));
    } catch (err) {
      log.warn('voice-mode: the voice catalog upstream failed', {
        provider,
        failure: failureOf(err),
        ms: now() - started,
      });
      return { error: 'upstream' };
    }
  };

  /** Drops the oldest entry of a full map. */
  const makeRoom = (map: Map<string, unknown>, max: number): void => {
    if (map.size >= max) map.delete(map.keys().next().value as string);
  };

  const pages = new Map<string, { at: number; result: Promise<CatalogResult> }>();
  const accounts = new Map<string, Names>();

  const namesOf = (provider: TtsProvider, apiKey: string, create = true): Names | undefined => {
    const account = accountOf(provider, apiKey);
    let names = accounts.get(account);
    if (!names && create) {
      makeRoom(accounts, MAX_ACCOUNTS);
      names = { loadedAt: 0, failedAt: -Infinity, stale: false, byId: new Map(), doubted: new Map() };
      accounts.set(account, names);
    }
    return names;
  };

  /** Every page of the listing (of one language's voices, given one), or a throw: a listing cut short is no listing. */
  const loadAll = async (provider: TtsProvider, apiKey: string, language?: string): Promise<VoiceRecord[]> => {
    const all: VoiceRecord[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let n = 0; n < MAX_NAMES_PAGES; n++) {
      const result = await fetchPage(provider, apiKey, { limit: NAMES_PAGE_SIZE[provider], language, cursor });
      if ('error' in result) throw new CatalogError(result.error);
      all.push(...result.page.voices);
      cursor = result.page.next;
      if (!cursor) return all;
      if (seen.has(cursor)) throw new CatalogError('the listing repeated a page token');
      seen.add(cursor);
    }
    throw new CatalogError('the listing has too many pages');
  };

  /**
   * The load of the listing under way: a running one, else a new one when there is none or an old one
   * (any, when `force`d). None for a while after a failed load.
   */
  const refresh = (names: Names, provider: TtsProvider, apiKey: string, force = false): Promise<void> | undefined => {
    if (names.loading) return names.loading;
    const started = now();
    if (started - names.failedAt < NAMES_RETRY_MS) return undefined;
    if (!force && names.voices && started - names.loadedAt < NAMES_TTL_MS) return undefined;
    names.loading = loadAll(provider, apiKey)
      .then(
        (voices) => {
          names.voices = new Map(voices.map((v) => [v.id, v]));
          names.loadedAt = started;
          names.stale = false;
          for (const [id, asked] of names.doubted) if (asked <= started) names.doubted.delete(id);
          log.info('voice-mode: voice names loaded', { provider, voices: voices.length, ms: now() - started });
        },
        (err: unknown) => {
          names.failedAt = now();
          names.stale = true;
          log.warn('voice-mode: loading the voice names failed', {
            provider,
            failure: failureOf(err),
            ms: now() - started,
          });
        },
      )
      .finally(() => {
        names.loading = undefined;
      });
    return names.loading;
  };

  const within = async (pending: Promise<unknown> | undefined): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([pending, new Promise((resolve) => (timer = setTimeout(resolve, LOOKUP_WAIT_MS)))]);
    clearTimeout(timer);
  };

  const elevenLabsById = async (apiKey: string, id: string): Promise<VoiceLookup> => {
    const started = now();
    let found: VoiceLookup = { status: 'lookup_failed' };
    let outcome: string;
    try {
      const res = await fetchFn(`${ELEVENLABS_VOICE_URL}/${encodeURIComponent(id)}`, {
        headers: { 'xi-api-key': apiKey },
        signal: AbortSignal.timeout(LOOKUP_WAIT_MS),
      });
      const body = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
      const voice = res.ok && body ? elevenLabsVoice(body) : null;
      // ElevenLabs answers an unknown id with a 400 that says so; any other failure proves nothing.
      const detail = (body?.detail ?? {}) as { status?: unknown };
      if (voice) found = { status: 'resolved', voice };
      else if (res.status === 404 || (res.status === 400 && detail.status === 'voice_not_found')) {
        found = { status: 'unavailable' };
      }
      outcome = `HTTP ${res.status}`;
    } catch (err) {
      outcome = err instanceof Error ? err.name : 'error';
    }
    const fields = { provider: 'elevenlabs', status: found.status, outcome, ms: now() - started };
    if (found.status === 'lookup_failed') log.warn('voice-mode: looking up a voice failed', fields);
    else log.info('voice-mode: voice looked up', fields);
    return found;
  };

  /** The status a kept by-id answer still stands for, or undefined once it is past its while (or still asked). */
  const keptStatus = (kept: KeptLookup | undefined): VoiceStatus | undefined =>
    kept?.status && now() - kept.at < VOICE_TTL_MS[kept.status] ? kept.status : undefined;

  /** An ElevenLabs voice by id, shared while asked and kept by what it was; `confirm` asks again unless it was found. */
  const elevenLabsKept = (names: Names, apiKey: string, id: string, confirm: boolean): Promise<VoiceLookup> => {
    const kept = names.byId.get(id);
    if (kept && !kept.status) return kept.found;
    const status = keptStatus(kept);
    if (kept && status && !(confirm && status !== 'resolved')) return kept.found;
    names.byId.delete(id);
    makeRoom(names.byId, MAX_KEPT_VOICES);
    const entry: KeptLookup = { at: now(), found: elevenLabsById(apiKey, id) };
    void entry.found.then((r) => {
      entry.status = r.status;
      entry.at = now();
    });
    names.byId.set(id, entry);
    return entry.found;
  };

  /** Lazy Gemini listings by key and language (none: the whole listing). */
  const listings = new Map<string, LazyListing>();

  const lazyListing = (apiKey: string, language?: string): Promise<Map<string, VoiceRecord> | undefined> => {
    const key = `${accountOf('gemini', apiKey)}:${language ?? ''}`;
    const kept = listings.get(key);
    const ttl = kept?.ok ? NAMES_TTL_MS : VOICE_TTL_MS.lookup_failed;
    if (kept && (kept.ok === undefined || now() - kept.at < ttl)) return kept.voices;
    listings.delete(key);
    makeRoom(listings, MAX_LAZY_LISTINGS);
    const entry: LazyListing = {
      at: now(),
      voices: loadAll('gemini', apiKey, language).then(
        (voices) => new Map(voices.map((v) => [v.id, v])),
        () => undefined,
      ),
    };
    void entry.voices.then((voices) => {
      entry.ok = voices !== undefined;
      entry.at = now();
    });
    listings.set(key, entry);
    return entry.voices;
  };

  /** The language its id names first, then, since an id's prefix proves nothing, the whole listing. */
  const lazyGemini = async (apiKey: string, id: string): Promise<VoiceLookup> => {
    const voice = (await lazyListing(apiKey, geminiLanguage(id)))?.get(id);
    if (voice) return { status: 'resolved', voice };
    const all = await lazyListing(apiKey);
    const listed = all?.get(id);
    if (listed) return { status: 'resolved', voice: listed };
    return { status: all ? 'unavailable' : 'lookup_failed' };
  };

  /** Whether the listing proves a voice it lacks is gone: whole, fresh, and no save left the id in doubt. */
  const provesAbsent = (names: Names, id: string): boolean =>
    !!names.voices && !names.stale && now() - names.loadedAt < ABSENCE_TTL_MS && !names.doubted.has(id);

  const lookup: VoiceCatalog['lookup'] = async (provider, apiKey, id, { confirm = false } = {}) => {
    if (!apiKey) return { status: 'lookup_failed' };
    if (malformed(provider, id)) return { status: 'unavailable' };
    if (options.lazy && provider === 'gemini') return lazyGemini(apiKey, id);
    const names = namesOf(provider, apiKey)!;
    if (options.lazy) return elevenLabsKept(names, apiKey, id, confirm);
    const asked = now();
    const loading = refresh(names, provider, apiKey);
    if (!names.voices) await within(loading);
    let listed = names.voices?.get(id);
    if (!listed && provider === 'elevenlabs') return elevenLabsKept(names, apiKey, id, confirm);
    if (!listed && confirm && names.voices && names.loadedAt < asked) {
      // A save is refused only on a listing loaded since it asked: one more load, unless one is under way.
      await within(refresh(names, provider, apiKey, true));
      listed = names.voices?.get(id);
    }
    if (listed) return { status: 'resolved', voice: listed };
    if (confirm && !(provesAbsent(names, id) && names.loadedAt >= asked)) {
      // No whole listing loaded since the save asked (a cold, stale or older one): the save goes through,
      // and nothing says the voice is gone until a load started after it succeeds.
      makeRoom(names.doubted, MAX_KEPT_VOICES);
      names.doubted.set(id, asked);
      return { status: 'lookup_failed' };
    }
    // Gemini's listing holds the caller's own voices too, and its get covers only those.
    return { status: provesAbsent(names, id) ? 'unavailable' : 'lookup_failed' };
  };

  let refreshing: ReturnType<typeof setInterval> | undefined;

  return {
    async page(provider, apiKey, query) {
      const key = JSON.stringify([
        accountOf(provider, apiKey),
        query.q,
        query.language,
        query.gender,
        query.cursor,
        query.limit,
      ]);
      const kept = pages.get(key);
      if (kept && now() - kept.at < PAGE_TTL_MS) return kept.result;
      pages.delete(key);
      makeRoom(pages, MAX_CACHED_PAGES);
      const result: Promise<CatalogResult> = fetchPage(provider, apiKey, query).then((r) =>
        'error' in r ? r : { page: { ...r.page, voices: r.page.voices.map((v) => ({ ...v, name: v.name ?? v.id })) } },
      );
      const entry = { at: now(), result };
      pages.set(key, entry);
      // Only an answer is kept; a failure is asked again.
      void result.then((r) => 'error' in r && pages.get(key) === entry && pages.delete(key));
      return result;
    },
    lookup,
    known(provider, apiKey, id) {
      if (!apiKey || options.lazy) return undefined;
      if (malformed(provider, id)) return 'unavailable';
      const names = namesOf(provider, apiKey, false);
      if (!names) return undefined;
      if (names.voices?.has(id)) return 'resolved';
      if (provider === 'gemini') return provesAbsent(names, id) ? 'unavailable' : undefined;
      return keptStatus(names.byId.get(id));
    },
    details: async (choice, apiKey) => choiceDetails(choice, await lookup(choice.provider, apiKey, choice.voice)),
    warm(keys) {
      const load = () => {
        for (const [provider, apiKey] of Object.entries(keys) as Array<[TtsProvider, string | undefined]>) {
          if (apiKey) void refresh(namesOf(provider, apiKey)!, provider, apiKey);
        }
      };
      load();
      clearInterval(refreshing);
      refreshing = setInterval(load, REFRESH_CHECK_MS);
      refreshing.unref();
    },
    close() {
      clearInterval(refreshing);
      refreshing = undefined;
    },
  };
}
