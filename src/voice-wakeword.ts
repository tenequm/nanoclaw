/**
 * Acoustic wake word spotting for voice calls: livekit-wakeword's inference pipeline
 * (https://github.com/livekit/livekit-wakeword, Apache-2.0) on onnxruntime-node, run in a worker
 * thread so it never blocks the call's event loop.
 *
 * The pipeline is the reference's `WakeWordModel.predict` on a 2 s window of 16 kHz mono audio:
 * the frozen mel model (x/10 + 2), the speech embedding on 76-frame mel windows every 8 frames, and
 * the classifier on the last 16 embeddings. Like the reference listener, a window is scored every
 * 80 ms of new audio.
 *
 * Imports nothing local: the worker thread loads this same file, as `.js` from the build and as
 * `.ts` (type-stripped by Node) under the tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

import * as ort from 'onnxruntime-node';

export const WAKE_SAMPLE_RATE = 16_000;
/** The audio one score looks at: 2 s, which yields exactly the classifier's 16 embeddings. */
export const WAKE_WINDOW_SAMPLES = 32_000;
/** New audio between scores: 80 ms, the reference listener's frame. */
export const WAKE_HOP_SAMPLES = 1_280;
export const WAKE_DEBOUNCE_MS = 2_000;
/** livekit-wakeword's documented optimal threshold for its conv-attention `hey_livekit` model. */
export const DEFAULT_WAKE_THRESHOLD = 0.68;
/** The reference listener's default, for a classifier with no documented threshold. */
export const CUSTOM_WAKE_THRESHOLD = 0.5;

const MEL_BINS = 32;
const EMBEDDING_WINDOW = 76;
const EMBEDDING_STRIDE = 8;
const EMBEDDINGS = 16;
const EMBEDDING_DIM = 96;

/** The bundled models: the two frozen feature models and the `hey_livekit` classifier. */
export const WAKE_MODEL_DIR = fileURLToPath(new URL('../assets/voice-wakeword/', import.meta.url));
export const DEFAULT_WAKE_MODEL = path.join(WAKE_MODEL_DIR, 'hey_livekit.onnx');

/** The phrase a classifier listens for, from its file name: `hey_livekit.onnx` is "hey livekit". */
export function wakePhraseOf(modelPath: string): string {
  return path
    .basename(modelPath)
    .replace(/(\.int8)?\.onnx$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

const sessionOptions: ort.InferenceSession.SessionOptions = {
  executionProviders: ['cpu'],
  // One core per model: the call's own work (VAD, audio, transcription) needs the rest.
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
  // onnxruntime's KleidiAI kernels on arm64 return wrong batch-1 convolutions in some versions
  // (livekit-wakeword #91); versions without the setting ignore it.
  extra: { 'mlas.disable_kleidiai': '1' },
};

/** The reference pipeline in this thread; the spotter runs it in a worker thread instead. */
export class WakeWordPipeline {
  // No parameter properties here or below: Node's type stripping runs this file as `.ts` in tests.
  private readonly mel: ort.InferenceSession;
  private readonly embedding: ort.InferenceSession;
  private readonly classifier: ort.InferenceSession;

  private constructor(mel: ort.InferenceSession, embedding: ort.InferenceSession, classifier: ort.InferenceSession) {
    this.mel = mel;
    this.embedding = embedding;
    this.classifier = classifier;
  }

  static async load(classifier: string, featureDir = WAKE_MODEL_DIR): Promise<WakeWordPipeline> {
    for (const file of [classifier, path.join(featureDir, 'melspectrogram.onnx')]) {
      if (!fs.existsSync(file)) throw new Error(`wake word model not found: ${file}`);
    }
    const [mel, embedding, head] = await Promise.all([
      ort.InferenceSession.create(path.join(featureDir, 'melspectrogram.onnx'), sessionOptions),
      ort.InferenceSession.create(path.join(featureDir, 'embedding_model.onnx'), sessionOptions),
      ort.InferenceSession.create(classifier, sessionOptions),
    ]);
    return new WakeWordPipeline(mel, embedding, head);
  }

  /** The last window scored, to reuse the embeddings of mel windows it shares with the next. */
  private last?: { end: number; mel: Float32Array; embeddings: Float32Array };

  /**
   * The classifier's score (0-1) for 16 kHz mono audio in [-1, 1]; 0 when it is too short for 16
   * embeddings. `end`, the stream position of the window's last sample, lets consecutive windows
   * share work: an embedding is reused only when its 76 mel frames are bit-for-bit the ones it was
   * computed from (the mel model clips to 80 dB under each window's own peak, so a window whose peak
   * moved recomputes), so the score is the reference's.
   */
  async score(audio: Float32Array, end?: number): Promise<number> {
    const melOut = await this.mel.run({
      [this.mel.inputNames[0]]: new ort.Tensor('float32', audio, [1, audio.length]),
    });
    const melTensor = melOut[this.mel.outputNames[0]];
    // (1, 1, frames, 32) in dB.
    const frames = melTensor.dims[melTensor.dims.length - 2];
    const melDb = melTensor.data as Float32Array;
    const windows = frames < EMBEDDING_WINDOW ? 0 : Math.floor((frames - EMBEDDING_WINDOW) / EMBEDDING_STRIDE) + 1;
    if (windows < EMBEDDINGS) {
      this.last = undefined;
      return 0;
    }
    const first = windows - EMBEDDINGS;
    const perWindow = EMBEDDING_WINDOW * MEL_BINS;
    const mel = new Float32Array(EMBEDDINGS * perWindow);
    for (let w = 0; w < EMBEDDINGS; w++) {
      const from = (first + w) * EMBEDDING_STRIDE * MEL_BINS;
      // Scaled as openWakeWord's melspec_transform does.
      for (let i = 0; i < perWindow; i++) mel[w * perWindow + i] = melDb[from + i] / 10 + 2;
    }
    const embeddings = new Float32Array(EMBEDDINGS * EMBEDDING_DIM);
    const last = this.last;
    const hop = EMBEDDING_STRIDE * (WAKE_SAMPLE_RATE / 100);
    const shift = last && end !== undefined && (end - last.end) % hop === 0 ? (end - last.end) / hop : 0;
    const missing: number[] = [];
    for (let w = 0; w < EMBEDDINGS; w++) {
      const from = w + shift;
      if (last && shift > 0 && from < EMBEDDINGS && sameBlock(mel, w, last.mel, from, perWindow)) {
        embeddings.set(last.embeddings.subarray(from * EMBEDDING_DIM, (from + 1) * EMBEDDING_DIM), w * EMBEDDING_DIM);
      } else missing.push(w);
    }
    if (missing.length > 0) {
      const batch = new Float32Array(missing.length * perWindow);
      missing.forEach((w, i) => batch.set(mel.subarray(w * perWindow, (w + 1) * perWindow), i * perWindow));
      const embOut = await this.embedding.run({
        [this.embedding.inputNames[0]]: new ort.Tensor('float32', batch, [
          missing.length,
          EMBEDDING_WINDOW,
          MEL_BINS,
          1,
        ]),
      });
      const computed = embOut[this.embedding.outputNames[0]].data as Float32Array;
      missing.forEach((w, i) =>
        embeddings.set(computed.subarray(i * EMBEDDING_DIM, (i + 1) * EMBEDDING_DIM), w * EMBEDDING_DIM),
      );
    }
    this.last = end === undefined ? undefined : { end, mel, embeddings };
    this.embedded += missing.length;
    const scoreOut = await this.classifier.run({
      [this.classifier.inputNames[0]]: new ort.Tensor('float32', embeddings, [1, EMBEDDINGS, EMBEDDING_DIM]),
    });
    return (scoreOut[this.classifier.outputNames[0]].data as Float32Array)[0];
  }

  /** Mel windows run through the embedding model so far: 16 per score without reuse. */
  embedded = 0;

  async release(): Promise<void> {
    await Promise.all([this.mel.release(), this.embedding.release(), this.classifier.release()]);
  }
}

function sameBlock(a: Float32Array, aw: number, b: Float32Array, bw: number, size: number): boolean {
  const ao = aw * size;
  const bo = bw * size;
  for (let i = 0; i < size; i++) if (a[ao + i] !== b[bo + i]) return false;
  return true;
}

/** int16 PCM as the reference reads it: x / 32768. */
export function pcmToFloat(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

interface ThreadInit {
  wakeWordThread: true;
  classifier: string;
  featureDir: string;
}
type ThreadReply = { ready: true } | { error: string } | { id: number; score: number; ms: number };

if (!isMainThread && (workerData as ThreadInit | undefined)?.wakeWordThread) {
  const init = workerData as ThreadInit;
  const port = parentPort!;
  WakeWordPipeline.load(init.classifier, init.featureDir).then(
    (pipeline) => {
      port.on('message', (msg: { id: number; audio: Float32Array; end: number }) => {
        const started = performance.now();
        pipeline.score(msg.audio, msg.end).then(
          (score) => port.postMessage({ id: msg.id, score, ms: performance.now() - started } satisfies ThreadReply),
          (err: unknown) => port.postMessage({ error: String(err) } satisfies ThreadReply),
        );
      });
      port.postMessage({ ready: true } satisfies ThreadReply);
    },
    (err: unknown) =>
      port.postMessage({ error: err instanceof Error ? err.message : String(err) } satisfies ThreadReply),
  );
}

export interface WakeWordOptions {
  /** The classifier .onnx; the feature models come from `featureDir`. */
  classifier: string;
  featureDir?: string;
  threshold: number;
  debounceMs?: number;
  onDetect(score: number): void;
  /** The thread failed after it loaded: no more detections. */
  onError?(err: string): void;
  now?: () => number;
}

/** What scoring cost so far, for the call's log. */
export interface WakeWordStats {
  scored: number;
  /** Hops skipped because the previous score was still running: slower than real time. */
  skipped: number;
  meanMs: number;
  maxMs: number;
  detections: number;
  maxScore: number;
}

/**
 * Spots the wake word in a call's 16 kHz mono audio. `push` keeps the last 2 s; while `listen` is on,
 * every 80 ms of new audio scores that window in the worker thread, at most one at a time (a hop that
 * comes while one runs is skipped, never queued). A score at or over the threshold is a detection,
 * at most one per `debounceMs`; the audio before it is forgotten, so it cannot fire twice.
 */
export class WakeWordSpotter {
  readonly phrase: string;
  readonly threshold: number;
  /** Resolves once the models are loaded, rejects when they cannot be. */
  readonly ready: Promise<void>;
  private readonly thread: Worker;
  private readonly ring = new Float32Array(WAKE_WINDOW_SAMPLES);
  private write = 0;
  private filled = 0;
  /** Samples pushed so far: where the window just taken ends, for the thread to reuse work. */
  private position = 0;
  private sinceScore = 0;
  private listening = false;
  private loaded = false;
  private closed = false;
  private inflight = false;
  private nextId = 0;
  /** Scores of windows taken before this id are stale (the audio was forgotten). */
  private validFrom = 0;
  private lastDetection = -Infinity;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly stats = { scored: 0, skipped: 0, totalMs: 0, maxMs: 0, detections: 0, maxScore: 0 };
  private readonly options: WakeWordOptions;

  constructor(options: WakeWordOptions) {
    this.options = options;
    this.phrase = wakePhraseOf(options.classifier);
    this.threshold = options.threshold;
    this.now = options.now ?? (() => Date.now());
    this.debounceMs = options.debounceMs ?? WAKE_DEBOUNCE_MS;
    this.thread = new Worker(new URL(import.meta.url), {
      workerData: {
        wakeWordThread: true,
        classifier: options.classifier,
        featureDir: options.featureDir ?? WAKE_MODEL_DIR,
      } satisfies ThreadInit,
    });
    this.thread.unref();
    this.ready = new Promise<void>((resolve, reject) => {
      this.thread.on('message', (msg: ThreadReply) => {
        if ('ready' in msg) {
          this.loaded = true;
          return resolve();
        }
        if ('error' in msg) {
          if (!this.loaded) return reject(new Error(msg.error));
          return this.fail(msg.error);
        }
        this.onScore(msg.id, msg.score, msg.ms);
      });
      this.thread.on('error', (err) => (this.loaded ? this.fail(err.message) : reject(err)));
      this.thread.on('exit', (code) => {
        if (!this.loaded) reject(new Error(`wake word thread exited (${code})`));
        else if (!this.closed) this.fail(`wake word thread exited (${code})`);
      });
    });
    // A failed load is the caller's to handle through `ready`; never an unhandled rejection.
    this.ready.catch(() => undefined);
  }

  /** Score windows (on) or only keep the audio (off). */
  listen(on: boolean): void {
    if (on === this.listening) return;
    this.listening = on;
    this.sinceScore = 0;
  }

  /** 16 kHz mono audio, in order. */
  push(pcm: Int16Array): void {
    if (this.closed) return;
    for (let i = 0; i < pcm.length; i++) {
      this.ring[this.write] = pcm[i] / 32768;
      this.write = (this.write + 1) % WAKE_WINDOW_SAMPLES;
    }
    this.filled = Math.min(WAKE_WINDOW_SAMPLES, this.filled + pcm.length);
    this.position += pcm.length;
    if (!this.listening || !this.loaded) return;
    this.sinceScore += pcm.length;
    // Like the reference listener: a full 2 s window, then one score per 80 ms.
    if (this.filled < WAKE_WINDOW_SAMPLES || this.sinceScore < WAKE_HOP_SAMPLES) return;
    this.sinceScore %= WAKE_HOP_SAMPLES;
    if (this.inflight) {
      this.stats.skipped++;
      return;
    }
    const audio = new Float32Array(WAKE_WINDOW_SAMPLES);
    audio.set(this.ring.subarray(this.write));
    audio.set(this.ring.subarray(0, this.write), WAKE_WINDOW_SAMPLES - this.write);
    this.inflight = true;
    this.thread.postMessage({ id: this.nextId++, audio, end: this.position }, [audio.buffer]);
  }

  get summary(): WakeWordStats {
    const { scored, skipped, totalMs, maxMs, detections, maxScore } = this.stats;
    return {
      scored,
      skipped,
      meanMs: scored ? Math.round((totalMs / scored) * 10) / 10 : 0,
      maxMs: Math.round(maxMs * 10) / 10,
      detections,
      maxScore: Math.round(maxScore * 1000) / 1000,
    };
  }

  /** The thread's share of one core since it started (0-1). */
  get utilization(): number {
    return this.thread.performance.eventLoopUtilization().utilization;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.listening = false;
    await this.thread.terminate();
  }

  private onScore(id: number, score: number, ms: number): void {
    this.inflight = false;
    this.stats.scored++;
    this.stats.totalMs += ms;
    this.stats.maxMs = Math.max(this.stats.maxMs, ms);
    this.stats.maxScore = Math.max(this.stats.maxScore, score);
    if (id < this.validFrom || !this.listening || this.closed || score < this.threshold) return;
    const now = this.now();
    if (now - this.lastDetection < this.debounceMs) return;
    this.lastDetection = now;
    this.stats.detections++;
    // The phrase is in the window just scored: forget it, as the reference listener clears its buffer.
    this.filled = 0;
    this.sinceScore = 0;
    this.validFrom = this.nextId;
    this.options.onDetect(score);
  }

  private fail(err: string): void {
    if (this.closed) return;
    this.closed = true;
    this.listening = false;
    void this.thread.terminate();
    this.options.onError?.(err);
  }
}
