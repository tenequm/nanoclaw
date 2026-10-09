import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  effectiveTts,
  readTtsChoice,
  TTS_DEFAULT_CHOICE,
  TTS_REGISTRY,
  wrapSdkTts,
  type SdkTts,
  type TtsAudio,
} from './voice-mode-tts.js';

const log = { info: vi.fn(), warn: vi.fn() };
const frame = (n: number) => ({ frame: { data: new Int16Array(n), sampleRate: 22_050, channels: 1 } });

/**
 * An SDK-shaped TTS: each stream yields `frames`, then ends normally (as agents-js does on failure)
 * with `error` set; a stream closed early stops yielding.
 */
function fakeSdk(frames: number[], error?: Error) {
  const streams: { close: ReturnType<typeof vi.fn>; signal?: AbortSignal }[] = [];
  const sdk = {
    sampleRate: 22_050,
    numChannels: 1,
    on: vi.fn(),
    close: vi.fn(async () => undefined),
    synthesize: vi.fn((_text: string, _opts?: unknown, signal?: AbortSignal) => {
      let closed = false;
      let gate: (() => void) | undefined;
      const close = vi.fn(() => {
        closed = true;
        gate?.();
      });
      streams.push({ close, signal });
      return {
        get error() {
          return error;
        },
        close,
        async *[Symbol.asyncIterator]() {
          for (const n of frames) {
            if (closed) return;
            yield frame(n);
          }
          // An open stream waits here until it is closed, like a request still being answered.
          if (frames.length === 0 && !error) await new Promise<void>((resolve) => (gate = resolve));
        },
      };
    }),
  };
  return { sdk, streams };
}

async function collect(audio: AsyncIterable<TtsAudio>): Promise<TtsAudio[]> {
  const out: TtsAudio[] = [];
  for await (const chunk of audio) out.push(chunk);
  return out;
}

describe('the TTS wrapper over an SDK TTS', () => {
  it('listens for the SDK error event and passes the line once without retries', async () => {
    const { sdk } = fakeSdk([4]);
    const tts = wrapSdkTts(sdk as SdkTts, log);
    expect(sdk.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(await collect(tts.synthesize('hi', new AbortController().signal))).toEqual([
      { pcm: new Int16Array(4), sampleRate: 22_050, numChannels: 1 },
    ]);
    expect(sdk.synthesize).toHaveBeenCalledWith(
      'hi',
      { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 60_000 },
      expect.any(AbortSignal),
    );
  });

  it('throws the stream error when iteration ended normally after a failure', async () => {
    const failure = Object.assign(new Error('quota'), { retryable: false });
    const { sdk, streams } = fakeSdk([], failure);
    const tts = wrapSdkTts(sdk as SdkTts, log);
    await expect(collect(tts.synthesize('hi', new AbortController().signal))).rejects.toBe(failure);
    expect(streams[0].close).toHaveBeenCalled();
  });

  it('throws after the frames were yielded when the stream ended with an error', async () => {
    const failure = new Error('mid-stream');
    const { sdk } = fakeSdk([2, 3], failure);
    const got: TtsAudio[] = [];
    await expect(
      (async () => {
        for await (const chunk of wrapSdkTts(sdk as SdkTts, log).synthesize('hi', new AbortController().signal)) {
          got.push(chunk);
        }
      })(),
    ).rejects.toBe(failure);
    expect(got.map((a) => a.pcm.length)).toEqual([2, 3]);
  });

  it('throws a retryable no-audio error when the stream ended empty', async () => {
    const { sdk } = fakeSdk([], undefined);
    sdk.synthesize.mockImplementationOnce(() => ({
      error: undefined,
      close: vi.fn(),
      async *[Symbol.asyncIterator]() {},
    }));
    await expect(
      collect(wrapSdkTts(sdk as SdkTts, log).synthesize('hi', new AbortController().signal)),
    ).rejects.toMatchObject({ message: 'no audio', retryable: true });
  });

  it('closes the stream when the consumer stops early', async () => {
    const { sdk, streams } = fakeSdk([1, 1, 1]);
    for await (const _ of wrapSdkTts(sdk as SdkTts, log).synthesize('hi', new AbortController().signal)) break;
    expect(streams[0].close).toHaveBeenCalled();
  });

  it('closes the stream when the signal aborts, and ends without an error', async () => {
    const { sdk, streams } = fakeSdk([]);
    const abort = new AbortController();
    const done = collect(wrapSdkTts(sdk as SdkTts, log).synthesize('hi', abort.signal));
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    abort.abort();
    await expect(done).resolves.toEqual([]);
    expect(streams[0].close).toHaveBeenCalled();
  });

  it('closes the SDK TTS with the instance', async () => {
    const { sdk } = fakeSdk([1]);
    await wrapSdkTts(sdk as SdkTts, log).close();
    expect(sdk.close).toHaveBeenCalledTimes(1);
  });
});

describe('TTS choices', () => {
  it('fills a saved choice from the provider defaults, and an unsaved one from the registry default', () => {
    expect(effectiveTts(null)).toEqual(TTS_DEFAULT_CHOICE);
    expect(effectiveTts({ provider: null, model: null, voice: null })).toEqual(TTS_DEFAULT_CHOICE);
    expect(effectiveTts({ provider: 'gemini', model: null, voice: 'en-us-techagent-4' })).toEqual({
      provider: 'gemini',
      model: 'gemini-3.8-flash-tts',
      voice: 'en-us-techagent-4',
    });
    expect(effectiveTts({ provider: 'elevenlabs', model: null, voice: null })).toEqual({
      provider: 'elevenlabs',
      model: 'eleven_turbo_v2_5',
      voice: 'bIHbv24MWmeRgasZH58o',
    });
    expect(effectiveTts({ provider: 'elevenlabs', model: 'gemini-3.8-flash-tts', voice: 'Alnilam' })).toEqual(
      effectiveTts({ provider: 'elevenlabs', model: null, voice: null }),
    );
  });

  it('reads a requested choice and names the first invalid field', () => {
    expect(readTtsChoice({ provider: 'elevenlabs', voice: 'bIHbv24MWmeRgasZH58o' })).toEqual({
      choice: { provider: 'elevenlabs', model: 'eleven_turbo_v2_5', voice: 'bIHbv24MWmeRgasZH58o' },
    });
    expect(readTtsChoice({ provider: 'gemini', model: 'gemini-3.8-flash-lite-tts', voice: 'achernar' })).toEqual({
      choice: { provider: 'gemini', model: 'gemini-3.8-flash-lite-tts', voice: 'achernar' },
    });
    expect(readTtsChoice({ provider: 'openai' })).toEqual({ invalid: 'provider' });
    expect(readTtsChoice({ provider: 'toString' })).toEqual({ invalid: 'provider' });
    expect(readTtsChoice(['gemini'])).toEqual({ invalid: 'provider' });
    expect(readTtsChoice({ provider: 'elevenlabs', model: 'eleven_v3' })).toEqual({ invalid: 'model' });
    expect(readTtsChoice({ provider: 'gemini', model: 7 })).toEqual({ invalid: 'model' });
    expect(readTtsChoice({ provider: 'gemini', voice: 'a b' })).toEqual({ invalid: 'voice' });
    expect(readTtsChoice({ provider: 'elevenlabs', voice: 'short' })).toEqual({ invalid: 'voice' });
  });

  it('falls back to the lite Gemini model before audio, and nowhere within ElevenLabs', () => {
    expect(TTS_REGISTRY.gemini.fallback(TTS_DEFAULT_CHOICE)).toEqual({
      ...TTS_DEFAULT_CHOICE,
      model: 'gemini-3.8-flash-lite-tts',
    });
    expect(TTS_REGISTRY.gemini.fallback({ ...TTS_DEFAULT_CHOICE, model: 'gemini-3.8-flash-lite-tts' })).toBeNull();
    expect(
      TTS_REGISTRY.elevenlabs.fallback(effectiveTts({ provider: 'elevenlabs', model: null, voice: null })),
    ).toBeNull();
    expect(TTS_REGISTRY.gemini.filters.notch).toBe(true);
    expect(TTS_REGISTRY.elevenlabs.filters.notch).toBe(false);
  });

  it('matches the provider list the fixtures publish', () => {
    const fixtures = JSON.parse(
      readFileSync(new URL('./channels/voice-mode-tts.fixtures.json', import.meta.url), 'utf8'),
    ) as { ttsView: { providers: { id: string; name: string; models: string[]; default: unknown }[] } };
    expect(
      Object.values(TTS_REGISTRY).map((e) => ({ id: e.id, name: e.name, models: e.models, default: e.defaults })),
    ).toEqual(fixtures.ttsView.providers.map(({ id, name, models, default: d }) => ({ id, name, models, default: d })));
  });
});
