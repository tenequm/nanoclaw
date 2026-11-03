import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Worker } from 'node:worker_threads';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { log } from './log.js';
import {
  DEFAULT_WAKE_HOP_MS,
  DEFAULT_WAKE_MODEL,
  DEFAULT_WAKE_THRESHOLD,
  WAKE_HOP_SAMPLES,
  WAKE_HOPS_MS,
  WAKE_SAMPLE_RATE,
  WAKE_WINDOW_SAMPLES,
  type WakeHopMs,
  WakeWordPipeline,
  WakeWordSpotter,
  wakeHopFromEnv,
  wakeHopMs,
} from './voice-mode-wakeword.js';

/** int16 PCM as the reference reads it: x / 32768. */
const pcmToFloat = (pcm: Int16Array): Float32Array => Float32Array.from(pcm, (x) => x / 32768);

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

  it('reuses embeddings per grid: two 80 ms grids 40 ms apart score as the reference, one cache across them reuses none', async () => {
    const padded = concat(silence(1), readWav(path.join(FIXTURES, 'positive.wav')), silence(1));
    const ends: number[] = [];
    for (let end = WAKE_WINDOW_SAMPLES; end <= padded.length; end += WAKE_HOP_SAMPLES / 2) ends.push(end);
    const window = (end: number) => pcmToFloat(padded.subarray(end - WAKE_WINDOW_SAMPLES, end));

    let before = pipeline.embedded;
    const interleaved: number[] = [];
    for (const [k, end] of ends.entries()) interleaved.push(await pipeline.score(window(end), end, k % 2));
    const reusedRun = pipeline.embedded - before;

    before = pipeline.embedded;
    const shared: number[] = [];
    for (const end of ends) shared.push(await pipeline.score(window(end), end));
    // Neighbours 40 ms apart share no mel window: one cache across both grids recomputes every embedding.
    expect(pipeline.embedded - before).toBe(ends.length * pipeline.embeddings);
    expect(reusedRun).toBeLessThan((ends.length * pipeline.embeddings) / 2);
    // Reused or not, every window's score is the same; grid 0's are the reference listener's windows.
    interleaved.forEach((score, k) => expect(Math.abs(score - shared[k])).toBeLessThan(1e-5));
    const grid0 = interleaved.filter((_, k) => k % 2 === 0);
    expect(grid0).toHaveLength(REFERENCE.positive.stream.length);
    grid0.forEach((score, i) => expect(Math.abs(score - REFERENCE.positive.stream[i])).toBeLessThan(1e-4));
  }, 60_000);

  it('scores audio too short for 16 embeddings as 0', async () => {
    expect(await pipeline.score(new Float32Array(16_000))).toBe(0);
  });
});

describe('wake scoring hop (VOICE_MODE_WAKE_HOP_MS)', () => {
  it('is 40 ms unless set to 80', () => {
    const warn = vi.fn();
    expect(DEFAULT_WAKE_HOP_MS).toBe(40);
    expect(wakeHopMs(undefined, warn)).toBe(40);
    expect(wakeHopMs('  ', warn)).toBe(40);
    expect(wakeHopMs('40', warn)).toBe(40);
    expect(wakeHopMs(' 80 ', warn)).toBe(80);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs any other value and uses the default', () => {
    for (const raw of ['20', '160', '0', '-40', '40ms', 'fast']) {
      const warn = vi.fn();
      expect(wakeHopMs(raw, warn)).toBe(40);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        'voice-mode: VOICE_MODE_WAKE_HOP_MS must be one of 40, 80; using 40',
        {
          value: raw,
          hopMs: 40,
        },
      );
    }
  });

  it("logs through the host's logger by default", async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      expect(wakeHopMs('120')).toBe(40);
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('VOICE_MODE_WAKE_HOP_MS'), {
          value: '120',
          hopMs: 40,
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("reads the working directory's .env", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-hop-'));
    try {
      expect(wakeHopFromEnv(root)).toBe(40);
      fs.writeFileSync(path.join(root, '.env'), 'VOICE_MODE_WAKE_MODEL=off\nVOICE_MODE_WAKE_HOP_MS="80"\n');
      expect(wakeHopFromEnv(root)).toBe(80);
      fs.writeFileSync(path.join(root, '.env'), 'VOICE_MODE_WAKE_HOP_MS=33\n');
      const warn = vi.fn();
      expect(wakeHopFromEnv(root, warn)).toBe(40);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('WakeWordSpotter', () => {
  const positive = () => readWav(path.join(FIXTURES, 'positive.wav'));
  const internals = (spotter: WakeWordSpotter) => spotter as unknown as { inflight: boolean; thread: Worker };

  /** Real-time order without real time: each 80 ms is pushed once the scores it started came back. */
  async function feed(spotter: WakeWordSpotter, audio: Int16Array, beforeHop?: (at: number) => void) {
    for (let at = 0; at < audio.length; at += WAKE_HOP_SAMPLES) {
      beforeHop?.(at);
      spotter.push(audio.subarray(at, at + WAKE_HOP_SAMPLES));
      while (internals(spotter).inflight) await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  const spotters: WakeWordSpotter[] = [];
  afterAll(async () => {
    await Promise.all(spotters.map((s) => s.close()));
  });
  const make = ({ hopMs = DEFAULT_WAKE_HOP_MS, now }: { hopMs?: WakeHopMs; now?: () => number } = {}) => {
    const detections: number[] = [];
    const windows: Array<{ start: number; end: number }> = [];
    const spotter = new WakeWordSpotter({
      classifier: DEFAULT_WAKE_MODEL,
      phrase: 'hey livekit',
      threshold: DEFAULT_WAKE_THRESHOLD,
      hopMs,
      onDetect: (score, window) => {
        detections.push(score);
        windows.push(window);
      },
      onError: () => undefined,
      now,
    });
    spotters.push(spotter);
    return { spotter, detections, windows };
  };

  it('closes with a window in flight by letting the thread finish it, never terminating it mid-inference', async () => {
    const { spotter } = make();
    await spotter.ready;
    const codes: number[] = [];
    internals(spotter).thread.once('exit', (code) => codes.push(code));
    spotter.listen(true);
    spotter.push(positive());
    expect(internals(spotter).inflight).toBe(true);
    await spotter.close();
    // terminate() exits 1; a thread that stopped on its own exits 0.
    expect(codes).toEqual([0]);
  });

  it('at 40 ms, takes windows on two 80 ms grids in turn, and listen(true) restarts both', async () => {
    const { spotter } = make({ hopMs: 40 });
    await spotter.ready;
    const thread = internals(spotter).thread;
    const sent: Array<{ end: number; grid: number }> = [];
    const post = thread.postMessage.bind(thread);
    vi.spyOn(thread, 'postMessage').mockImplementation((msg: { end?: number; grid?: number }, transfer) => {
      if (msg.end !== undefined && msg.grid !== undefined) sent.push({ end: msg.end, grid: msg.grid });
      post(msg, transfer);
    });
    const hop = WAKE_HOP_SAMPLES / 2;
    const tenWindows = (from: number) =>
      Array.from({ length: 10 }, (_, k) => ({ end: from + (k + 1) * hop, grid: k % 2 }));

    spotter.listen(true);
    await feed(spotter, silence(0.4));
    expect(sent).toEqual(tenWindows(0));
    expect(spotter.summary).toMatchObject({ hopMs: 40, scored: 10, skipped: 0 });

    // Off the 40 ms boundary while not listening: turned on again, both grids start over from there.
    spotter.listen(false);
    spotter.push(silence(0.03));
    spotter.listen(true);
    await feed(spotter, silence(0.4));
    expect(sent.slice(10)).toEqual(tenWindows(10 * hop + 480));
  });

  for (const hopMs of WAKE_HOPS_MS) {
    // Scoring real audio window by window: far over the default timeout on a loaded machine.
    describe(`at a ${hopMs} ms hop`, { timeout: 60_000 }, () => {
      const hopSamples = (hopMs * WAKE_SAMPLE_RATE) / 1000;

      it('spots the wake word once in a worker thread, and only while listening', async () => {
        const { spotter, detections, windows } = make({ hopMs });
        await spotter.ready;
        expect(spotter.phrase).toBe('hey livekit');
        expect(spotter.hopMs).toBe(hopMs);
        await feed(spotter, concat(silence(1), positive(), silence(1)));
        expect(detections).toEqual([]);
        expect(spotter.summary.scored).toBe(0);

        spotter.listen(true);
        const clip = concat(silence(1), positive(), silence(1));
        await feed(spotter, clip);
        expect(detections).toHaveLength(1);
        // At 40 ms the first window over the threshold is one between two 80 ms ones (0.46, then 0.98).
        expect(detections[0]).toBeGreaterThan(hopMs === 80 ? 0.9 : DEFAULT_WAKE_THRESHOLD);
        // The window that had the phrase, as positions in all the audio pushed: 2 s of the second clip,
        // ending past its leading second of silence.
        expect(windows[0].end - windows[0].start).toBe(WAKE_WINDOW_SAMPLES);
        expect(windows[0].start).toBeGreaterThanOrEqual(clip.length - WAKE_WINDOW_SAMPLES);
        expect(windows[0].end).toBeGreaterThan(clip.length + WAKE_SAMPLE_RATE);
        expect(windows[0].end).toBeLessThanOrEqual(2 * clip.length);
        expect(windows[0].end % hopSamples).toBe(0);
        expect(spotter.summary).toMatchObject({ hopMs, detections: 1, skipped: 0 });
        expect(spotter.summary.scored).toBeGreaterThan(10);
      });

      it('one phrase is one detection whichever grid scores it, with no debounce in the way', async () => {
        let clock = 0;
        const { spotter, detections } = make({ hopMs, now: () => (clock += 10_000) });
        await spotter.ready;
        spotter.listen(true);
        await feed(spotter, concat(silence(1), positive(), silence(1)));
        expect(detections).toHaveLength(1);
        expect(spotter.summary.detections).toBe(1);
      });

      it('turned on, scores only audio that came after: a phrase said while off never opens a turn', async () => {
        const { spotter, detections } = make({ hopMs });
        await spotter.ready;
        // The phrase ends right before listening turns on, so it is all in the 2 s ring.
        await feed(spotter, concat(silence(1), positive()));
        spotter.listen(true);
        // The first score one hop on, both grids' within the first 80 ms.
        await feed(spotter, silence(0.08));
        expect(spotter.summary.scored).toBe(WAKE_HOP_SAMPLES / hopSamples);
        await feed(spotter, silence(2.9));
        expect(spotter.summary.scored).toBeGreaterThan(30);
        expect(spotter.summary.maxScore).toBeLessThan(0.1);
        expect(detections).toEqual([]);
      });

      it('turned on, hears a phrase said right away: no 2 s wait for a full window', async () => {
        const { spotter, detections, windows } = make({ hopMs });
        await spotter.ready;
        await feed(spotter, silence(3));
        spotter.listen(true);
        // positive.wav is silent until 1.2 s: 1.3 s of audio in all, the phrase ending 0.9 s after listening began.
        await feed(spotter, concat(positive().subarray(17_600), silence(0.4)));
        expect(detections).toHaveLength(1);
        expect(detections[0]).toBeGreaterThan(0.9);
        expect(windows[0].end - silence(3).length).toBeLessThan(WAKE_WINDOW_SAMPLES);
      });

      it('scores the window at every hop boundary, whatever the frame size, also when audio comes in a burst', async () => {
        const { spotter, detections, windows } = make({ hopMs });
        await spotter.ready;
        spotter.listen(true);
        // In 30 ms frames, 0.64 s at once (one window scoring, the rest waiting their turn).
        const audio = concat(silence(1), positive());
        const idle = () =>
          vi.waitFor(() => expect(internals(spotter).inflight).toBe(false), { timeout: 30_000, interval: 5 });
        const burst = 8 * WAKE_HOP_SAMPLES;
        for (let from = 0; from < audio.length; from += burst) {
          const to = Math.min(from + burst, audio.length);
          for (let at = from; at < to; at += 480) spotter.push(audio.subarray(at, Math.min(at + 480, to)));
          await idle();
        }
        expect(spotter.summary).toMatchObject({ skipped: 0, detections: 1 });
        expect(spotter.summary.scored).toBeGreaterThan(30);
        expect(detections).toHaveLength(1);
        expect(windows[0].end % hopSamples).toBe(0);
      });

      it('debounces: a second wake word within 2 s of the first is not a detection', async () => {
        const run = async (gapMs: number) => {
          let clock = 0;
          const { spotter, detections } = make({ hopMs, now: () => clock });
          await spotter.ready;
          spotter.listen(true);
          const first = concat(silence(1), positive());
          // Scoring goes on right after a detection, over silence in place of the phrase: the clock decides.
          await feed(spotter, concat(first, silence(0.5), positive(), silence(1)), (at) => {
            if (at === first.length - (first.length % WAKE_HOP_SAMPLES)) clock += gapMs;
          });
          return detections.length;
        };
        expect(await run(1_000)).toBe(1);
        expect(await run(2_500)).toBe(2);
      });
    });
  }

  it('rejects ready when the classifier is missing', async () => {
    const spotter = new WakeWordSpotter({
      classifier: '/nonexistent/hey_nobody.onnx',
      phrase: 'hey nobody',
      threshold: 0.5,
      onDetect: () => undefined,
      onError: () => undefined,
    });
    spotters.push(spotter);
    // No hop given: the working directory's .env decides.
    expect(spotter.hopMs).toBe(wakeHopFromEnv());
    await expect(spotter.ready).rejects.toThrow(/not found/);
  });
});
