/**
 * Acoustic wake word spotting for voice calls: livekit-wakeword's inference pipeline
 * (https://github.com/livekit/livekit-wakeword, Apache-2.0) on onnxruntime-node, run in a worker
 * thread so it never blocks the call's event loop.
 *
 * The pipeline is the reference's `WakeWordModel.predict` on a 2 s window of 16 kHz mono audio:
 * the frozen mel model (x/10 + 2), the speech embedding on 76-frame mel windows every 8 frames, and
 * the classifier on the last 16 embeddings (or as many as its input takes, with a longer window:
 * openWakeWord classifiers load too). Like the reference listener, a window is scored every
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
/** The audio one score looks at for a 16-embedding classifier: 2 s, as the reference listener's. */
export const WAKE_WINDOW_SAMPLES = 32_000;
/** New audio between scores: 80 ms, the reference listener's frame. */
export const WAKE_HOP_SAMPLES = 1_280;
const WAKE_DEBOUNCE_MS = 2_000;
/** Windows that may wait for the thread; more means it is slower than real time. */
const WAKE_MAX_QUEUED = 8;
/** How long a closing thread may take to finish its score and release the models. */
const WAKE_STOP_MS = 3_000;
/** livekit-wakeword's documented optimal threshold for its conv-attention `hey_livekit` model. */
export const DEFAULT_WAKE_THRESHOLD = 0.68;
/** The reference listener's default, for a classifier with no documented threshold. */
export const CUSTOM_WAKE_THRESHOLD = 0.5;

const MEL_BINS = 32;
const EMBEDDING_WINDOW = 76;
const EMBEDDING_STRIDE = 8;
/** The classifier input's length when its model does not say. */
const DEFAULT_EMBEDDINGS = 16;
const EMBEDDING_DIM = 96;

/** The audio a classifier of `embeddings` timesteps scores: 2 s for 16, and 80 ms more per extra one. */
const windowSamples = (embeddings: number): number =>
  WAKE_WINDOW_SAMPLES + (embeddings - DEFAULT_EMBEDDINGS) * EMBEDDING_STRIDE * (WAKE_SAMPLE_RATE / 100);

/** The bundled models: the two frozen feature models and the `hey_livekit` classifier. */
const WAKE_MODEL_DIR = fileURLToPath(new URL('../assets/voice-mode-wakeword/', import.meta.url));
export const DEFAULT_WAKE_MODEL = path.join(WAKE_MODEL_DIR, 'hey_livekit.onnx');

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
  /** Embedding timesteps the classifier takes: 16 for livekit-wakeword's, other openWakeWord models differ. */
  readonly embeddings: number;
  /** Mel windows run through the embedding model so far: `embeddings` per score without reuse. */
  embedded = 0;
  /** The last window scored, to reuse the embeddings of mel windows it shares with the next. */
  private last?: { end: number; mel: Float32Array; embeddings: Float32Array };

  private constructor(mel: ort.InferenceSession, embedding: ort.InferenceSession, classifier: ort.InferenceSession) {
    this.mel = mel;
    this.embedding = embedding;
    this.classifier = classifier;
    // Bound by position, not name: openWakeWord's classifiers call them `x.1` and `53`.
    const input = classifier.inputMetadata[0];
    const steps = input?.isTensor ? input.shape[1] : undefined;
    this.embeddings = typeof steps === 'number' && steps > 0 ? steps : DEFAULT_EMBEDDINGS;
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

  /**
   * The classifier's score (0-1) for 16 kHz mono audio in [-1, 1]; 0 when it is too short for the
   * classifier's embeddings. `end`, the stream position of the window's last sample, lets consecutive windows
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
    if (windows < this.embeddings) {
      this.last = undefined;
      return 0;
    }
    const first = windows - this.embeddings;
    const perWindow = EMBEDDING_WINDOW * MEL_BINS;
    const mel = new Float32Array(this.embeddings * perWindow);
    for (let w = 0; w < this.embeddings; w++) {
      const from = (first + w) * EMBEDDING_STRIDE * MEL_BINS;
      // Scaled as openWakeWord's melspec_transform does.
      for (let i = 0; i < perWindow; i++) mel[w * perWindow + i] = melDb[from + i] / 10 + 2;
    }
    const embeddings = new Float32Array(this.embeddings * EMBEDDING_DIM);
    const last = this.last;
    const hop = EMBEDDING_STRIDE * (WAKE_SAMPLE_RATE / 100);
    const shift = last && end !== undefined && (end - last.end) % hop === 0 ? (end - last.end) / hop : 0;
    const missing: number[] = [];
    for (let w = 0; w < this.embeddings; w++) {
      const from = w + shift;
      if (last && shift > 0 && from < this.embeddings && sameBlock(mel, w, last.mel, from, perWindow)) {
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
      [this.classifier.inputNames[0]]: new ort.Tensor('float32', embeddings, [1, this.embeddings, EMBEDDING_DIM]),
    });
    return (scoreOut[this.classifier.outputNames[0]].data as Float32Array)[0];
  }

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
type ThreadReply = { ready: true; embeddings: number } | { error: string } | { id: number; score: number; ms: number };

if (!isMainThread && (workerData as ThreadInit | undefined)?.wakeWordThread) {
  const init = workerData as ThreadInit;
  const port = parentPort!;
  WakeWordPipeline.load(init.classifier, init.featureDir).then(
    (pipeline) => {
      let scoring: Promise<unknown> = Promise.resolve();
      port.on('message', (msg: { id: number; audio: Float32Array; end: number } | { stop: true }) => {
        if ('stop' in msg) {
          // Out of native code before the thread goes: terminated mid-inference, onnxruntime's
          // pending Napi::Error aborts the whole process.
          void scoring
            .then(() => pipeline.release())
            .catch(() => undefined)
            .finally(() => process.exit(0));
          return;
        }
        const started = performance.now();
        scoring = pipeline.score(msg.audio, msg.end).then(
          (score) => port.postMessage({ id: msg.id, score, ms: performance.now() - started } satisfies ThreadReply),
          (err: unknown) => port.postMessage({ error: String(err) } satisfies ThreadReply),
        );
      });
      port.postMessage({ ready: true, embeddings: pipeline.embeddings } satisfies ThreadReply);
    },
    (err: unknown) =>
      port.postMessage({ error: err instanceof Error ? err.message : String(err) } satisfies ThreadReply),
  );
}

export interface WakeWordOptions {
  /** The classifier .onnx; the feature models come from `featureDir`. */
  classifier: string;
  /** What the classifier listens for, as the page names it (VOICE_MODE_WAKE_PHRASE). */
  phrase: string;
  featureDir?: string;
  threshold: number;
  debounceMs?: number;
  /**
   * A detection: its score, and the window that had the phrase, as positions in the audio pushed so
   * far (samples; `end` exclusive). Its end is where scoring stopped, not where the phrase did: the
   * caller's next words may already be in it.
   */
  onDetect(score: number, window: { start: number; end: number }): void;
  /** The thread failed after it loaded: no more detections. */
  onError?(err: string): void;
  now?: () => number;
}

/** What scoring cost so far, for the call's log. */
export interface WakeWordStats {
  scored: number;
  /** Windows dropped because scoring fell behind by more than WAKE_MAX_QUEUED: slower than real time. */
  skipped: number;
  meanMs: number;
  maxMs: number;
  detections: number;
  maxScore: number;
}

/**
 * Spots the wake word in a call's 16 kHz mono audio. `push` keeps the last 2 s; while `listen` is on,
 * the window ending at every 80 ms of new audio is scored in the worker thread, one at a time, in
 * order (audio arrives in bursts, so a few wait; past WAKE_MAX_QUEUED the oldest is dropped). A score
 * at or over the threshold is a detection, at most one per `debounceMs`; the audio before it is
 * forgotten, so it cannot fire twice.
 */
export class WakeWordSpotter {
  readonly phrase: string;
  readonly threshold: number;
  /** Resolves once the models are loaded, rejects when they cannot be. */
  readonly ready: Promise<void>;
  private readonly thread: Worker;
  private readonly exited: Promise<void>;
  /** The last window's audio: its length is the classifier's (2 s for 16 embeddings). */
  private ring = new Float32Array(WAKE_WINDOW_SAMPLES);
  private write = 0;
  private filled = 0;
  /** Samples pushed so far: where the window just taken ends, for the thread to reuse work. */
  private position = 0;
  private sinceScore = 0;
  private listening = false;
  private loaded = false;
  private closed = false;
  private inflight = false;
  /** Where the window being scored ends in the stream. */
  private inflightEnd = 0;
  /** Windows taken while one was being scored. */
  private queued: Array<{ id: number; audio: Float32Array<ArrayBuffer>; end: number }> = [];
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
    this.phrase = options.phrase;
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
    this.exited = new Promise((resolve) => this.thread.once('exit', () => resolve()));
    this.ready = new Promise<void>((resolve, reject) => {
      this.thread.on('message', (msg: ThreadReply) => {
        if ('ready' in msg) {
          const size = windowSamples(msg.embeddings);
          if (size !== this.ring.length) {
            this.ring = new Float32Array(size);
            this.write = 0;
            this.filled = 0;
          }
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

  /**
   * Score windows (on) or not (off). Turned on, the first window scored is all new audio: what was
   * said while it was off (a phrase while the turn was open, the end of a review recording) never opens a turn.
   */
  listen(on: boolean): void {
    if (on === this.listening) return;
    this.listening = on;
    this.sinceScore = 0;
    this.queued = [];
    if (on) this.filled = 0;
  }

  /** 16 kHz mono audio, in order. */
  push(pcm: Int16Array): void {
    if (this.closed) return;
    const size = this.ring.length;
    const scoring = this.listening && this.loaded;
    for (let i = 0; i < pcm.length; i++) {
      this.ring[this.write] = pcm[i] / 32768;
      this.write = (this.write + 1) % size;
      this.position++;
      if (this.filled < size) this.filled++;
      // Like the reference listener: a full window, then one every 80 ms, on the 80 ms boundary
      // whatever the frame size, so consecutive windows share their embeddings.
      if (!scoring || ++this.sinceScore < WAKE_HOP_SAMPLES) continue;
      this.sinceScore = 0;
      if (this.filled >= size) this.take();
    }
  }

  private take(): void {
    const size = this.ring.length;
    const audio = new Float32Array(size);
    audio.set(this.ring.subarray(this.write));
    audio.set(this.ring.subarray(0, this.write), size - this.write);
    const window = { id: this.nextId++, audio, end: this.position };
    if (!this.inflight) return this.send(window);
    this.queued.push(window);
    if (this.queued.length > WAKE_MAX_QUEUED) {
      this.queued.shift();
      this.stats.skipped++;
    }
  }

  private send(window: { id: number; audio: Float32Array<ArrayBuffer>; end: number }): void {
    this.inflight = true;
    this.inflightEnd = window.end;
    this.thread.postMessage(window, [window.audio.buffer]);
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
    await this.stop();
  }

  /**
   * The thread finishes the window it is scoring and exits on its own: terminating a thread inside
   * an onnxruntime call aborts the process (nodejs/node#34567). Terminated only when it hangs.
   */
  private async stop(): Promise<void> {
    this.thread.postMessage({ stop: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<'hung'>((resolve) => (timer = setTimeout(() => resolve('hung'), WAKE_STOP_MS)));
    const outcome = await Promise.race([this.exited, hung]);
    clearTimeout(timer);
    if (outcome === 'hung') await this.thread.terminate();
  }

  private onScore(id: number, score: number, ms: number): void {
    this.inflight = false;
    this.stats.scored++;
    this.stats.totalMs += ms;
    this.stats.maxMs = Math.max(this.stats.maxMs, ms);
    this.stats.maxScore = Math.max(this.stats.maxScore, score);
    if (this.detects(id, score)) {
      // The phrase is in the window just scored: forget it, as the reference listener clears its buffer.
      this.filled = 0;
      this.sinceScore = 0;
      this.queued = [];
      this.validFrom = this.nextId;
      this.options.onDetect(score, { start: Math.max(0, this.inflightEnd - this.ring.length), end: this.inflightEnd });
    }
    const next = this.queued.shift();
    if (next && !this.closed) this.send(next);
  }

  private detects(id: number, score: number): boolean {
    if (id < this.validFrom || !this.listening || this.closed || score < this.threshold) return false;
    const now = this.now();
    if (now - this.lastDetection < this.debounceMs) return false;
    this.lastDetection = now;
    this.stats.detections++;
    return true;
  }

  private fail(err: string): void {
    if (this.closed) return;
    this.closed = true;
    this.listening = false;
    void this.stop();
    this.options.onError?.(err);
  }
}
