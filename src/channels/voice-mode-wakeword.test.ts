import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_WAKE_MODEL,
  DEFAULT_WAKE_THRESHOLD,
  WAKE_HOP_SAMPLES,
  WAKE_SAMPLE_RATE,
  WAKE_WINDOW_SAMPLES,
  WakeWordPipeline,
  WakeWordSpotter,
  pcmToFloat,
} from './voice-mode-wakeword.js';

const FIXTURES = fileURLToPath(new URL('./voice-mode-wakeword-fixtures/', import.meta.url));

/** A 16 kHz mono 16-bit PCM wav's samples. */
function readWav(file: string): Int16Array {
  const buf = fs.readFileSync(file);
  const data = buf.indexOf('data', 12);
  const bytes = buf.readUInt32LE(data + 4);
  return new Int16Array(buf.buffer.slice(buf.byteOffset + data + 8, buf.byteOffset + data + 8 + bytes));
}

const concat = (...parts: Int16Array[]): Int16Array => {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const silence = (seconds: number) => new Int16Array(Math.round(seconds * 16_000));

/**
 * livekit-wakeword 0.2 (`fb92cb3`), Python, onnxruntime 1.27: `WakeWordModel(["hey_livekit.onnx"]).predict`
 * on each 2 s clip, and on every 2 s window, 80 ms apart, of the clip with 1 s of silence on each side.
 */
const REFERENCE = {
  positive: {
    clip: 0.9805617332458496,
    stream: [
      0.0047, 0.0047, 0.0047, 0.0047, 0.003404, 0.003966, 0.004469, 0.007073, 0.018158, 0.042048, 0.083265, 0.457305,
      0.976601, 0.986281, 0.987005, 0.983187, 0.978763, 0.962129, 0.88326, 0.670902, 0.112928, 0.042722, 0.069481,
      0.122216, 0.093737, 0.09082,
    ],
  },
  negative: {
    clip: 0.004212319850921631,
    // The clip's opening, after silence, scores high: a known trait of the model, not of this port.
    stream: [
      0.37075, 0.785168, 0.879894, 0.726418, 0.631152, 0.325546, 0.164625, 0.102109, 0.03209, 0.010002, 0.005977,
      0.004158, 0.003585, 0.004945, 0.003673, 0.003033, 0.003222, 0.003478, 0.003115, 0.003285, 0.006716, 0.007389,
      0.003807, 0.002942, 0.00735, 0.005952,
    ],
  },
};

describe('wake word pipeline parity with livekit-wakeword', () => {
  let pipeline: WakeWordPipeline;
  beforeAll(async () => {
    pipeline = await WakeWordPipeline.load(DEFAULT_WAKE_MODEL);
  });
  afterAll(() => pipeline.release());

  for (const name of ['positive', 'negative'] as const) {
    it(`scores ${name}.wav as the reference does, whole and window by window`, async () => {
      const clip = readWav(path.join(FIXTURES, `${name}.wav`));
      expect(clip.length).toBe(WAKE_WINDOW_SAMPLES);
      expect(await pipeline.score(pcmToFloat(clip))).toBeCloseTo(REFERENCE[name].clip, 5);

      const padded = concat(silence(1), clip, silence(1));
      const before = pipeline.embedded;
      const stream: number[] = [];
      for (let end = WAKE_WINDOW_SAMPLES; end <= padded.length; end += WAKE_HOP_SAMPLES) {
        stream.push(await pipeline.score(pcmToFloat(padded.subarray(end - WAKE_WINDOW_SAMPLES, end)), end));
      }
      expect(stream).toHaveLength(REFERENCE[name].stream.length);
      stream.forEach((score, i) => expect(Math.abs(score - REFERENCE[name].stream[i])).toBeLessThan(1e-4));
      // Consecutive windows share embeddings, but recompute the ones whose mel frames changed.
      expect(pipeline.embedded - before).toBeLessThan(stream.length * 16);
    });
  }

  it('scores audio too short for 16 embeddings as 0', async () => {
    expect(await pipeline.score(new Float32Array(16_000))).toBe(0);
  });
});

describe('WakeWordSpotter', () => {
  const positive = () => readWav(path.join(FIXTURES, 'positive.wav'));

  /** Real-time order without real time: each 80 ms is pushed once the score it started came back. */
  async function feed(spotter: WakeWordSpotter, audio: Int16Array, beforeHop?: (at: number) => void) {
    const scoring = () => (spotter as unknown as { inflight: boolean }).inflight;
    for (let at = 0; at < audio.length; at += WAKE_HOP_SAMPLES) {
      beforeHop?.(at);
      spotter.push(audio.subarray(at, at + WAKE_HOP_SAMPLES));
      while (scoring()) await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  const spotters: WakeWordSpotter[] = [];
  afterAll(async () => {
    await Promise.all(spotters.map((s) => s.close()));
  });
  const make = (now?: () => number) => {
    const detections: number[] = [];
    const windows: Array<{ start: number; end: number }> = [];
    const spotter = new WakeWordSpotter({
      classifier: DEFAULT_WAKE_MODEL,
      phrase: 'hey livekit',
      threshold: DEFAULT_WAKE_THRESHOLD,
      onDetect: (score, window) => {
        detections.push(score);
        windows.push(window);
      },
      now,
    });
    spotters.push(spotter);
    return { spotter, detections, windows };
  };

  it('closes with a window in flight by letting the thread finish it, never terminating it mid-inference', async () => {
    const { spotter } = make();
    await spotter.ready;
    const thread = (spotter as unknown as { thread: import('node:worker_threads').Worker }).thread;
    const codes: number[] = [];
    thread.once('exit', (code) => codes.push(code));
    spotter.listen(true);
    spotter.push(positive());
    expect((spotter as unknown as { inflight: boolean }).inflight).toBe(true);
    await spotter.close();
    // terminate() exits 1; a thread that stopped on its own exits 0.
    expect(codes).toEqual([0]);
  });

  it('spots the wake word once in a worker thread, and only while listening', async () => {
    const { spotter, detections, windows } = make();
    await spotter.ready;
    expect(spotter.phrase).toBe('hey livekit');
    await feed(spotter, concat(silence(1), positive(), silence(1)));
    expect(detections).toEqual([]);
    expect(spotter.summary.scored).toBe(0);

    spotter.listen(true);
    const clip = concat(silence(1), positive(), silence(1));
    await feed(spotter, clip);
    expect(detections).toHaveLength(1);
    expect(detections[0]).toBeGreaterThan(0.9);
    // The window that had the phrase, as positions in all the audio pushed: 2 s of the second clip,
    // ending past its leading second of silence.
    expect(windows[0].end - windows[0].start).toBe(WAKE_WINDOW_SAMPLES);
    expect(windows[0].start).toBeGreaterThanOrEqual(clip.length - WAKE_WINDOW_SAMPLES);
    expect(windows[0].end).toBeGreaterThan(clip.length + WAKE_SAMPLE_RATE);
    expect(windows[0].end).toBeLessThanOrEqual(2 * clip.length);
    expect(spotter.summary).toMatchObject({ detections: 1, skipped: 0 });
    expect(spotter.summary.scored).toBeGreaterThan(10);
  });

  it('turned on, scores only audio that came after: a phrase said while off never opens a turn', async () => {
    const { spotter, detections } = make();
    await spotter.ready;
    // The phrase ends right before listening turns on, so it is all in the 2 s ring.
    await feed(spotter, concat(silence(1), positive()));
    spotter.listen(true);
    await feed(spotter, silence(1.9));
    expect(spotter.summary.scored).toBe(0);
    await feed(spotter, silence(1));
    expect(spotter.summary.scored).toBeGreaterThan(0);
    expect(detections).toEqual([]);
  });

  it('scores the window at every 80 ms boundary, whatever the frame size, also when audio comes in a burst', async () => {
    const { spotter, detections } = make();
    await spotter.ready;
    spotter.listen(true);
    // In 30 ms frames: the 2 s fill, then 0.64 s at once (8 windows wait their turn), then the rest.
    const audio = concat(silence(1), positive());
    const idle = () => vi.waitFor(() => expect((spotter as unknown as { inflight: boolean }).inflight).toBe(false));
    const pushFrames = (from: number, to: number) => {
      for (let at = from; at < to; at += 480) spotter.push(audio.subarray(at, Math.min(at + 480, to)));
    };
    pushFrames(0, 32_000);
    await idle();
    pushFrames(32_000, 42_240);
    await idle();
    pushFrames(42_240, audio.length);
    await idle();
    expect(spotter.summary).toMatchObject({ scored: 13, skipped: 0, detections: 1 });
    expect(detections).toHaveLength(1);
  });

  it('debounces: a second wake word within 2 s of the first is not a detection', async () => {
    const run = async (gapMs: number) => {
      let clock = 0;
      const { spotter, detections } = make(() => clock);
      await spotter.ready;
      spotter.listen(true);
      const first = concat(silence(1), positive());
      // The audio after a detection refills for 2 s before anything scores, so the clock decides.
      await feed(spotter, concat(first, silence(0.5), positive(), silence(1)), (at) => {
        if (at === first.length - (first.length % WAKE_HOP_SAMPLES)) clock += gapMs;
      });
      return detections.length;
    };
    expect(await run(1_000)).toBe(1);
    expect(await run(2_500)).toBe(2);
  });

  it('rejects ready when the classifier is missing', async () => {
    const spotter = new WakeWordSpotter({
      classifier: '/nonexistent/hey_nobody.onnx',
      phrase: 'hey nobody',
      threshold: 0.5,
      onDetect: () => undefined,
    });
    spotters.push(spotter);
    await expect(spotter.ready).rejects.toThrow(/not found/);
  });
});
