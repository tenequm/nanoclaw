/** The meeting participants' pipelines over a fake VAD and transcription: routing, order, lifecycle, bounds. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Heard, TranscriberOptions } from '../../../voice-mode-gemini-live.js';
import type { CallEvent, Speaker } from '../core/types.js';
import {
  AUDIO_GAP_MS,
  createMeetingAudio,
  PARTICIPANT_IDLE_MS,
  sileroDetectors,
  type MeetingAudioOptions,
  type SpeechDetectorFactory,
} from './recall-audio.js';

const alex: Speaker = { id: '100', name: 'Alex' };
const bo: Speaker = { id: '200', name: 'Bo' };
const T0 = 1_800_000_000_000;

interface FakeVad {
  speaker: number;
  onSpeech(speaking: boolean, position: number): void;
  pushed: number[];
  closed: boolean;
}
interface FakeStt {
  options: TranscriberOptions;
  begins: number[];
  pushed: number;
  ended: number;
  closed: boolean;
  /** What the next end() resolves. */
  heard: Pick<Heard, 'final' | 'interim'>;
}

function harness(overrides: Partial<MeetingAudioOptions> = {}) {
  const vads: FakeVad[] = [];
  const stts: FakeStt[] = [];
  const events: CallEvent[] = [];
  const warnings: string[] = [];
  let words = 0;
  const clock = { now: T0 };
  const detector: SpeechDetectorFactory = (e) => {
    const vad: FakeVad = { speaker: vads.length, onSpeech: e.onSpeech, pushed: [], closed: false };
    vads.push(vad);
    return {
      push: (pcm) => void vad.pushed.push(pcm.length),
      close: () => void (vad.closed = true),
    };
  };
  const audio = createMeetingAudio({
    speech: {
      apiKey: 'k',
      model: 'gemini-3.5-transcribe-live',
      vocabulary: ['Dan', 'Dan'],
      languageCodes: ['uk-UA', 'en-US'],
    },
    detector: () => detector,
    transcriber: (options) => {
      const stt: FakeStt = { options, begins: [], pushed: 0, ended: 0, closed: false, heard: { interim: '' } };
      stts.push(stt);
      return {
        prepare: async () => true,
        begin: (preRoll) => void stt.begins.push(preRoll.length),
        push: (pcm) => void (stt.pushed += pcm.length),
        end: async () => {
          stt.ended++;
          return { finals: 1, failed: false, finalizeMs: 0, ...stt.heard };
        },
        close: () => void (stt.closed = true),
      };
    },
    onEvent: (event) => void events.push(event),
    onWords: () => void words++,
    log: { info: () => undefined, warn: (msg: string) => void warnings.push(msg) },
    now: () => clock.now,
    ...overrides,
  });
  /** A frame of `ms` audio (16 samples a ms), `loud` or silent, at `at`. */
  const frame = (who: Speaker, ms: number, at: number, loud = true) =>
    audio.audio(who, new Int16Array(ms * 16).fill(loud ? 1000 : 0), at);
  const summary = () =>
    events.map((e) =>
      e.kind === 'speech'
        ? `${e.speaker.id}:speech:${e.on ? 'on' : 'off'}`
        : e.kind === 'utterance'
          ? `${e.speaker.id}:${e.uttId}:${e.final ? 'final' : 'partial'}:${e.text}`
          : e.kind,
    );
  return { audio, vads, stts, events, warnings, clock, frame, summary, words: () => words };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('createMeetingAudio', () => {
  it('opens a pipeline at the first audible frame, with the call speech settings, and warms a socket', () => {
    const h = harness();
    h.frame(alex, 20, T0, false);
    expect(h.audio.pipelines).toBe(0);
    h.frame(alex, 20, T0 + 20);
    expect(h.audio.pipelines).toBe(1);
    expect(h.stts[0].options).toMatchObject({
      apiKey: 'k',
      model: 'gemini-3.5-transcribe-live',
      vocabulary: ['Dan'],
      languageCodes: ['uk-UA', 'en-US'],
      sampleRate: 16_000,
    });
    // Once open, silence is fed too: the VAD needs it to end speech.
    h.frame(alex, 20, T0 + 40, false);
    expect(h.vads[0].pushed).toEqual([320, 320]);
  });

  it('emits speech on, the partials and speech off, then the final, under one uttId per utterance', async () => {
    const h = harness();
    h.clock.now = T0 + 5_000;
    h.frame(alex, 1000, T0);
    // Speech from 0.75 s into the stream: its mark is at that place on the frame clock, and the activity
    // starts with the 500 ms before it (to the end of what was heard: 0.25 s to 1 s).
    h.vads[0].onSpeech(true, 12_000);
    expect(h.stts[0].begins).toEqual([12_000]);
    h.frame(alex, 100, T0 + 1000);
    expect(h.stts[0].pushed).toBe(1_600);
    h.stts[0].options.onInterim('Dan, what');
    h.stts[0].options.onInterim('Dan, what');
    h.stts[0].options.onInterim('Dan, what time');
    h.stts[0].heard = { final: 'Dan, what time is it?', interim: 'Dan, what time' };
    h.vads[0].onSpeech(false, 17_600);
    await flush();
    expect(h.summary()).toEqual([
      '100:speech:on',
      '100:100-0:partial:Dan, what',
      '100:100-0:partial:Dan, what time',
      '100:speech:off',
      '100:100-0:final:Dan, what time is it?',
    ]);
    expect(h.events[0]).toMatchObject({ speaker: alex, at: T0 + 750 });
    expect(h.events[3]).toMatchObject({ at: T0 + 1100 });
    expect(h.words()).toBe(2);
    // The next speech is a new utterance; one that heard nothing is marks only.
    h.vads[0].onSpeech(true, 20_000);
    h.stts[0].heard = { interim: '' };
    h.vads[0].onSpeech(false, 21_000);
    await flush();
    expect(h.summary().slice(5)).toEqual(['100:speech:on', '100:speech:off']);
  });

  it("keeps each participant's pipeline apart", async () => {
    const h = harness();
    h.frame(alex, 100, T0);
    h.frame(bo, 100, T0);
    expect(h.audio.pipelines).toBe(2);
    h.vads[0].onSpeech(true, 0);
    h.vads[1].onSpeech(true, 0);
    h.stts[1].options.onInterim('yes');
    h.stts[0].heard = { final: 'one', interim: '' };
    h.stts[1].heard = { final: 'yes', interim: 'yes' };
    h.vads[1].onSpeech(false, 1_600);
    h.vads[0].onSpeech(false, 1_600);
    await flush();
    expect(h.summary()).toEqual([
      '100:speech:on',
      '200:speech:on',
      '200:200-0:partial:yes',
      '200:speech:off',
      '100:speech:off',
      '200:200-0:final:yes',
      '100:100-0:final:one',
    ]);
  });

  it('a participant who leaves mid-speech: speech ends there, the final still goes out, then it closes', async () => {
    const h = harness();
    h.frame(alex, 100, T0);
    h.vads[0].onSpeech(true, 0);
    h.stts[0].options.onInterim('hold on');
    h.stts[0].heard = { final: 'Hold on.', interim: 'hold on' };
    h.audio.left(alex, T0 + 50);
    expect(h.audio.pipelines).toBe(0);
    expect(h.vads[0].closed).toBe(true);
    await flush();
    expect(h.summary()).toEqual([
      '100:speech:on',
      '100:100-0:partial:hold on',
      '100:speech:off',
      '100:100-0:final:Hold on.',
    ]);
    expect(h.events[2]).toMatchObject({ at: T0 + 50 });
    expect(h.stts[0].closed).toBe(true);
    // Back later: a new pipeline, and uttIds go on from where they were.
    h.frame(alex, 100, T0 + 5_000);
    h.vads[1].onSpeech(true, 0);
    h.stts[1].options.onInterim('back');
    expect(h.summary().at(-1)).toBe('100:100-1:partial:back');
  });

  it('the call ending closes every pipeline and nothing more comes out', async () => {
    const h = harness();
    h.frame(alex, 100, T0);
    h.frame(bo, 100, T0);
    h.vads[0].onSpeech(true, 0);
    h.stts[0].heard = { final: 'late', interim: '' };
    h.audio.close();
    expect(h.vads.every((v) => v.closed) && h.stts.every((s) => s.closed)).toBe(true);
    h.stts[0].options.onInterim('too late');
    h.frame(alex, 100, T0 + 100);
    await flush();
    expect(h.summary()).toEqual(['100:speech:on']);
    expect(h.audio.pipelines).toBe(0);
  });

  it('closes a pipeline after PARTICIPANT_IDLE_MS without speech, never during speech', () => {
    vi.useFakeTimers();
    const h = harness();
    h.frame(alex, 100, T0);
    h.frame(bo, 100, T0);
    h.vads[1].onSpeech(true, 0);
    vi.advanceTimersByTime(PARTICIPANT_IDLE_MS + 1);
    expect(h.audio.pipelines).toBe(1);
    expect(h.vads[0].closed).toBe(true);
    expect(h.vads[1].closed).toBe(false);
  });

  it('feeds a gap in the frames during speech to the VAD as silence', () => {
    vi.useFakeTimers();
    const h = harness();
    h.frame(alex, 100, T0);
    h.vads[0].onSpeech(true, 0);
    h.clock.now += AUDIO_GAP_MS + 200;
    vi.advanceTimersByTime(AUDIO_GAP_MS + 200);
    expect(h.vads[0].pushed.slice(1).reduce((n, v) => n + v, 0)).toBeGreaterThanOrEqual((AUDIO_GAP_MS * 16) | 0);
    // No gap while quiet: nothing is invented.
    h.vads[0].onSpeech(false, 10_000);
    const before = h.vads[0].pushed.length;
    h.clock.now += 2_000;
    vi.advanceTimersByTime(2_000);
    expect(h.vads[0].pushed).toHaveLength(before);
  });

  it('transcribes at most maxPipelines participants, and nobody before the VAD loaded, saying so once each', () => {
    const h = harness({ maxPipelines: 1 });
    h.frame(alex, 100, T0);
    h.frame(bo, 100, T0);
    h.frame(bo, 100, T0 + 100);
    expect(h.audio.pipelines).toBe(1);
    expect(h.warnings).toEqual(["meet-jev audio: a participant's audio is not transcribed"]);
    const unloaded = harness({ detector: () => null });
    unloaded.frame(alex, 100, T0);
    unloaded.frame(alex, 100, T0 + 100);
    expect(unloaded.audio.pipelines).toBe(0);
    expect(unloaded.warnings).toHaveLength(1);
  });

  it('closes the pipeline of a participant whose VAD failed', () => {
    let fail!: (err: unknown) => void;
    const h = harness({
      detector: () => (e) => {
        fail = e.onError;
        return { push: () => undefined, close: () => undefined };
      },
    });
    h.frame(alex, 100, T0);
    fail(new Error('onnx'));
    expect(h.audio.pipelines).toBe(0);
    expect(h.warnings).toContain('meet-jev audio: a participant VAD failed; their pipeline closes');
  });
});

describe('sileroDetectors', () => {
  it('loads the real Silero model once per process, with the agents logger it needs, and hears no speech in silence', async () => {
    const loading = sileroDetectors();
    expect(sileroDetectors()).toBe(loading);
    const factory = await loading;
    const onSpeech = vi.fn();
    const onError = vi.fn();
    const detector = factory({ onSpeech, onError });
    for (let i = 0; i < 10; i++) detector.push(new Int16Array(1_600));
    await new Promise((resolve) => setTimeout(resolve, 200));
    detector.close();
    detector.push(new Int16Array(1_600));
    expect(onSpeech).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  }, 20_000);
});
