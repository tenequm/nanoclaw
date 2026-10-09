/**
 * The speech providers a voice line can speak with, and the choice of provider, model and voice.
 * Dependency-free of the host's database and channels: the worker imports it, and so does the host
 * for the provider list and validation (no instance is built there).
 */
import type { APIConnectOptions } from '@livekit/agents';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as google from '@livekit/agents-plugin-google';

export type TtsProvider = 'gemini' | 'elevenlabs';
export interface TtsChoice {
  provider: TtsProvider;
  model: string;
  voice: string;
}
/** A line's saved choice; a null field takes the provider's default. */
export interface TtsSaved {
  provider: TtsProvider | null;
  model: string | null;
  voice: string | null;
}
export type TtsInvalid = 'provider' | 'model' | 'voice';
export interface TtsAudio {
  pcm: Int16Array;
  sampleRate: number;
  numChannels: number;
}
/** One provider instance: whole-line synthesis, cancellable, closable. */
export interface TtsInstance {
  readonly sampleRate: number;
  readonly numChannels: number;
  /**
   * The line's audio. Terminal failure is a throw: before any frame when the request failed outright
   * (`retryable` set from the SDK error), after frames when the stream ended with `stream.error` set
   * (iteration ends normally in the SDK; the wrapper rethrows), or `no audio` when it ended with none.
   * The underlying request is closed on abort, on the caller's early exit and on a throw.
   */
  synthesize(text: string, signal: AbortSignal): AsyncIterable<TtsAudio>;
  close(): Promise<void>;
}
export interface TtsEntry {
  readonly id: TtsProvider;
  readonly name: string;
  readonly models: readonly string[];
  readonly defaults: { model: string; voice: string };
  readonly envKey: 'VOICE_MODE_GEMINI_API_KEY' | 'VOICE_MODE_ELEVENLABS_API_KEY';
  /** Shape only, no network. */
  validate(choice: { model: string; voice: string }): TtsInvalid | null;
  /** What speaks a line this choice could not before any audio, or null. */
  fallback(choice: TtsChoice): TtsChoice | null;
  /** The Gemini whistle notch applies only to that provider's audio. */
  filters: { notch: boolean };
  build(choice: TtsChoice, apiKey: string, log: Pick<Console, 'info' | 'warn'>): TtsInstance;
}

/** The SDK surface the wrapper drives: an agents-js `tts.TTS`, or a test's fake. */
export interface SdkTts {
  readonly sampleRate: number;
  readonly numChannels: number;
  synthesize(text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal): SdkTtsStream;
  on(event: 'error', listener: (ev: unknown) => void): unknown;
  close(): Promise<void>;
}
export interface SdkTtsStream extends AsyncIterable<{
  frame: { data: Int16Array; sampleRate: number; channels: number };
}> {
  readonly error?: Error;
  close(): void;
}

const CONNECT_OPTIONS: APIConnectOptions = { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 60_000 };

/** A TtsInstance over an SDK TTS, per the wrapper contract above. */
export function wrapSdkTts(sdk: SdkTts, log: Pick<Console, 'info' | 'warn'>): TtsInstance {
  // The TTS reports a failed request as an event too; with no listener an EventEmitter would throw it.
  sdk.on('error', () => undefined);
  return {
    sampleRate: sdk.sampleRate,
    numChannels: sdk.numChannels,
    async *synthesize(text, signal) {
      if (signal.aborted) return;
      // Plugins that ignore the signal argument (ElevenLabs) are cancelled by closing the stream.
      const stream = sdk.synthesize(text, CONNECT_OPTIONS, signal);
      const stop = () => stream.close();
      signal.addEventListener('abort', stop, { once: true });
      let frames = 0;
      try {
        for await (const { frame } of stream) {
          frames++;
          yield { pcm: frame.data, sampleRate: frame.sampleRate, numChannels: frame.channels };
        }
        if (signal.aborted) return;
        if (stream.error) throw stream.error;
        if (!frames) throw Object.assign(new Error('no audio'), { retryable: true });
      } finally {
        signal.removeEventListener('abort', stop);
        stream.close();
      }
    },
    async close() {
      try {
        await sdk.close();
      } catch (err) {
        log.warn('voice-mode: closing a speech provider failed', { err: err instanceof Error ? err.message : err });
      }
    },
  };
}

const GEMINI_MODEL = /^gemini-[a-z0-9.-]+-tts$/;
const GEMINI_VOICE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const GEMINI_FALLBACK_MODEL = 'gemini-3.8-flash-lite-tts';
const ELEVENLABS_MODELS = ['eleven_turbo_v2_5', 'eleven_flash_v2_5', 'eleven_multilingual_v2'];
const ELEVENLABS_VOICE = /^[A-Za-z0-9]{10,40}$/;

export const TTS_DEFAULT_CHOICE: TtsChoice = { provider: 'gemini', model: 'gemini-3.8-flash-tts', voice: 'Alnilam' };

export const TTS_REGISTRY: Readonly<Record<TtsProvider, TtsEntry>> = {
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    models: [TTS_DEFAULT_CHOICE.model, GEMINI_FALLBACK_MODEL],
    defaults: { model: TTS_DEFAULT_CHOICE.model, voice: TTS_DEFAULT_CHOICE.voice },
    envKey: 'VOICE_MODE_GEMINI_API_KEY',
    validate: ({ model, voice }) => (!GEMINI_MODEL.test(model) ? 'model' : !GEMINI_VOICE.test(voice) ? 'voice' : null),
    fallback: (choice) => (choice.model === GEMINI_FALLBACK_MODEL ? null : { ...choice, model: GEMINI_FALLBACK_MODEL }),
    filters: { notch: true },
    build: (choice, apiKey, log) =>
      wrapSdkTts(
        new google.beta.TTS({ apiKey, model: choice.model, voiceName: choice.voice, instructions: '' }) as SdkTts,
        log,
      ),
  },
  elevenlabs: {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    models: ELEVENLABS_MODELS,
    defaults: { model: ELEVENLABS_MODELS[0], voice: 'bIHbv24MWmeRgasZH58o' },
    envKey: 'VOICE_MODE_ELEVENLABS_API_KEY',
    validate: ({ model, voice }) =>
      !ELEVENLABS_MODELS.includes(model) ? 'model' : !ELEVENLABS_VOICE.test(voice) ? 'voice' : null,
    fallback: () => null,
    filters: { notch: false },
    build: (choice, apiKey, log) =>
      wrapSdkTts(new elevenlabs.TTS({ apiKey, model: choice.model, voiceId: choice.voice }) as SdkTts, log),
  },
};

export function isTtsProvider(value: unknown): value is TtsProvider {
  return typeof value === 'string' && Object.hasOwn(TTS_REGISTRY, value);
}

/** What a line speaks with: its saved choice, each missing or malformed field the provider's default. */
export function effectiveTts(saved: TtsSaved | null | undefined): TtsChoice {
  const entry = TTS_REGISTRY[saved?.provider ?? TTS_DEFAULT_CHOICE.provider];
  const model =
    saved?.model && entry.validate({ model: saved.model, voice: entry.defaults.voice }) === null
      ? saved.model
      : entry.defaults.model;
  const voice =
    saved?.voice && entry.validate({ model, voice: saved.voice }) === null ? saved.voice : entry.defaults.voice;
  return { provider: entry.id, model, voice };
}

/** A requested `{provider, model?, voice?}`: absent (or null) model and voice take the provider's defaults. */
export function readTtsChoice(raw: unknown): { choice: TtsChoice } | { invalid: TtsInvalid } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { invalid: 'provider' };
  const { provider, model, voice } = raw as Record<string, unknown>;
  if (!isTtsProvider(provider)) return { invalid: 'provider' };
  if (model != null && typeof model !== 'string') return { invalid: 'model' };
  if (voice != null && typeof voice !== 'string') return { invalid: 'voice' };
  const entry = TTS_REGISTRY[provider];
  const choice: TtsChoice = { provider, model: model ?? entry.defaults.model, voice: voice ?? entry.defaults.voice };
  const invalid = entry.validate(choice);
  return invalid ? { invalid } : { choice };
}
