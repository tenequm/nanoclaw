/**
 * Acoustic wake word spotting for voice calls: livekit-wakeword's inference pipeline
 * (https://github.com/livekit/livekit-wakeword, Apache-2.0) on onnxruntime-node, run in a worker
 * thread so it never blocks the call's event loop.
 *
 * The pipeline is the reference's `WakeWordModel.predict` on a 2 s window of 16 kHz mono audio:
 * the frozen mel model (x/10 + 2), the speech embedding on 76-frame mel windows every 8 frames, and
 * the classifiers on the last 16 embeddings (or as many as each one's input takes, with a longer
 * window: openWakeWord classifiers load too). Several classifiers share the mel and embedding work,
 * as the reference's `WakeWordModel` with several models does. Like the reference listener, a window
 * is scored every 80 ms of new audio.
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
/** livekit-wakeword's documented optimal threshold for its conv-attention `hey_livekit` model. */
export const DEFAULT_WAKE_THRESHOLD = 0.68;
/** The reference listener's default, for a classifier with no documented threshold. */
export const CUSTOM_WAKE_THRESHOLD = 0.5;
/** Thresholds picked for known classifiers, by file name. */
const KNOWN_THRESHOLDS: Record<string, number> = {
  hey_livekit: DEFAULT_WAKE_THRESHOLD,
  // This fork's own model (assets/voice-commands/, see its NOTICE): its evaluation's operating point.
  hey_dan: 0.76,
  scratch_that: 0.35,
};

/** The threshold a classifier gets unless the settings say otherwise. */
export const defaultThreshold = (modelPath: string): number =>
  KNOWN_THRESHOLDS[path.basename(modelPath).replace(/(\.int8)?\.onnx$/i, '')] ?? CUSTOM_WAKE_THRESHOLD;

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
const WAKE_MODEL_DIR = fileURLToPath(new URL('../assets/voice-wakeword/', import.meta.url));
export const DEFAULT_WAKE_MODEL = path.join(WAKE_MODEL_DIR, 'hey_livekit.onnx');

/** The phrase a classifier listens for, from its file name: `hey_livekit.onnx` and `hey_jarvis_v0.1.onnx` say it. */
export function wakePhraseOf(modelPath: string): string {
  return path
    .basename(modelPath)
    .replace(/(\.int8)?\.onnx$/i, '')
    .replace(/[_-]v\d+(\.\d+)*$/i, '')
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

/** Embedding timesteps a classifier takes, from its input: 16 for livekit-wakeword's, other openWakeWord models differ. */
function inputSteps(classifier: ort.InferenceSession): number {
  // Bound by position, not name: openWakeWord's classifiers call them `x.1` and `53`.
  const input = classifier.inputMetadata[0];
  const steps = input?.isTensor ? input.shape[1] : undefined;
  return typeof steps === 'number' && steps > 0 ? steps : DEFAULT_EMBEDDINGS;
}

/** The reference pipeline in this thread; the spotter runs it in a worker thread instead. */
export class WakeWordPipeline {
  // No parameter properties here or below: Node's type stripping runs this file as `.ts` in tests.
  private readonly mel: ort.InferenceSession;
  private readonly embedding: ort.InferenceSession;
  /** In the order they were given; one that failed to load is missing and scores 0. */
  private readonly classifiers: Array<{ session: ort.InferenceSession; steps: number } | undefined>;
  /** Why a classifier failed to load, by its index. */
  readonly failed: Record<number, string>;
  /** Embedding timesteps the longest classifier takes: the window holds that many. */
  readonly embeddings: number;
  /** Mel windows run through the embedding model so far: `embeddings` per score without reuse. */
  embedded = 0;
  /** The last window scored, to reuse the embeddings of mel windows it shares with the next. */
  private last?: { end: number; mel: Float32Array; embeddings: Float32Array };

  private constructor(
    mel: ort.InferenceSession,
    embedding: ort.InferenceSession,
    classifiers: Array<ort.InferenceSession | undefined>,
    failed: Record<number, string>,
  ) {
    this.mel = mel;
    this.embedding = embedding;
    this.classifiers = classifiers.map((session) => session && { session, steps: inputSteps(session) });
    this.failed = failed;
    this.embeddings = Math.max(...this.classifiers.map((c) => c?.steps ?? 0));
  }

  /** The feature models and the classifiers; one classifier may fail to load (see `failed`), not all. */
  static async load(classifiers: readonly string[], featureDir = WAKE_MODEL_DIR): Promise<WakeWordPipeline> {
    const melFile = path.join(featureDir, 'melspectrogram.onnx');
    if (!fs.existsSync(melFile)) throw new Error(`wake word model not found: ${melFile}`);
    const [mel, embedding, ...heads] = await Promise.all([
      ort.InferenceSession.create(melFile, sessionOptions),
      ort.InferenceSession.create(path.join(featureDir, 'embedding_model.onnx'), sessionOptions),
      ...classifiers.map((file) =>
        fs.existsSync(file)
          ? ort.InferenceSession.create(file, sessionOptions).catch((err: unknown) =>
              err instanceof Error ? err : new Error(String(err)),
            )
          : new Error(`wake word model not found: ${file}`),
      ),
    ]);
    const failed: Record<number, string> = {};
    heads.forEach((head, i) => {
      if (head instanceof Error) failed[i] = head.message;
    });
    if (Object.keys(failed).length === heads.length) {
      await Promise.all([mel.release(), embedding.release()]);
      throw new Error(Object.values(failed).join('; ') || 'no wake word classifier');
    }
    return new WakeWordPipeline(
      mel,
      embedding,
      heads.map((head) => (head instanceof Error ? undefined : (head as ort.InferenceSession))),
      failed,
    );
  }

  /**
   * Each classifier's score (0-1) for 16 kHz mono audio in [-1, 1]; 0 when it is too short for the
   * classifiers' embeddings, and for a classifier not in `active` (all by default). `end`, the stream
   * position of the window's last sample, lets consecutive windows share work: an embedding is reused
   * only when its 76 mel frames are bit-for-bit the ones it was computed from (the mel model clips to
   * 80 dB under each window's own peak, so a window whose peak moved recomputes), so the score is the
   * reference's.
   */
  async score(audio: Float32Array, end?: number, active?: readonly number[]): Promise<number[]> {
    const scores = this.classifiers.map(() => 0);
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
      return scores;
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
    for (const [i, classifier] of this.classifiers.entries()) {
      if (!classifier || (active && !active.includes(i))) continue;
      // Each takes the last embeddings its input holds, as the reference gives every model the last 16.
      const input = embeddings.subarray((this.embeddings - classifier.steps) * EMBEDDING_DIM);
      const out = await classifier.session.run({
        [classifier.session.inputNames[0]]: new ort.Tensor('float32', input, [1, classifier.steps, EMBEDDING_DIM]),
      });
      scores[i] = (out[classifier.session.outputNames[0]].data as Float32Array)[0];
    }
    return scores;
  }

  async release(): Promise<void> {
    await Promise.all([
      this.mel.release(),
      this.embedding.release(),
      ...this.classifiers.map((c) => c?.session.release()),
    ]);
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
  classifiers: string[];
  featureDir: string;
}
type ThreadReply =
  | { ready: true; embeddings: number; failed: Record<number, string> }
  | { error: string }
  | { id: number; scores: number[]; ms: number };

if (!isMainThread && (workerData as ThreadInit | undefined)?.wakeWordThread) {
  const init = workerData as ThreadInit;
  const port = parentPort!;
  WakeWordPipeline.load(init.classifiers, init.featureDir).then(
    (pipeline) => {
      port.on('message', (msg: { id: number; audio: Float32Array; end: number; active: number[] }) => {
        const started = performance.now();
        pipeline.score(msg.audio, msg.end, msg.active).then(
          (scores) => port.postMessage({ id: msg.id, scores, ms: performance.now() - started } satisfies ThreadReply),
          (err: unknown) => port.postMessage({ error: String(err) } satisfies ThreadReply),
        );
      });
      port.postMessage({
        ready: true,
        embeddings: pipeline.embeddings,
        failed: pipeline.failed,
      } satisfies ThreadReply);
    },
    (err: unknown) =>
      port.postMessage({ error: err instanceof Error ? err.message : String(err) } satisfies ThreadReply),
  );
}

/** One phrase to spot: a classifier .onnx in livekit-wakeword's format and the score that counts. */
export interface SpotterClassifier<Name extends string = string> {
  name: Name;
  model: string;
  threshold: number;
}

export interface WakeWordOptions<Name extends string = string> {
  /** At least one; they share the feature models from `featureDir`. */
  classifiers: ReadonlyArray<SpotterClassifier<Name>>;
  featureDir?: string;
  debounceMs?: number;
  /**
   * A detection: which classifier, its score, and how much audio (samples) came in after the window
   * that had the phrase, by the time it was scored: the caller's words after the phrase start that far back.
   */
  onDetect(name: Name, score: number, after: number): void;
  /** The thread failed after it loaded: no more detections. */
  onError?(err: string): void;
  now?: () => number;
}

/** What scoring cost so far, for the call's log; detections and the highest score per classifier. */
export interface WakeWordStats {
  scored: number;
  /** Windows dropped because scoring fell behind by more than WAKE_MAX_QUEUED: slower than real time. */
  skipped: number;
  meanMs: number;
  maxMs: number;
  detections: Record<string, number>;
  maxScore: Record<string, number>;
}

interface Window {
  id: number;
  audio: Float32Array<ArrayBuffer>;
  end: number;
  active: number[];
}

/**
 * Spots phrases in a call's 16 kHz mono audio, one classifier per phrase on shared features. `push`
 * keeps the last 2 s; while `listen` names some classifiers, the window ending at every 80 ms of new
 * audio is scored by those in the worker thread, one window at a time, in order (audio arrives in
 * bursts, so a few wait; past WAKE_MAX_QUEUED the oldest is dropped). A score at or over its
 * classifier's threshold is a detection, at most one per classifier per `debounceMs`; the audio
 * before it is forgotten, so it cannot fire twice.
 */
export class WakeWordSpotter<Name extends string = string> {
  /** Each classifier's phrase, by name; once `ready`, only those that loaded. */
  phrases: Partial<Record<Name, string>>;
  readonly thresholds: Partial<Record<Name, number>>;
  /** Why a classifier did not load, by name; the others spot. */
  readonly failed: Partial<Record<Name, string>> = {};
  /** Resolves once the models are loaded, rejects when none can be. */
  readonly ready: Promise<void>;
  private readonly thread: Worker;
  /** The last window's audio: its length is the longest classifier's (2 s for 16 embeddings). */
  private ring = new Float32Array(WAKE_WINDOW_SAMPLES);
  private write = 0;
  private filled = 0;
  /** Samples pushed so far: where the window just taken ends, for the thread to reuse work. */
  private position = 0;
  private sinceScore = 0;
  /** The classifiers scored, by index. */
  private listening: number[] = [];
  private loaded = false;
  private closed = false;
  private inflight = false;
  /** Where the window being scored ends in the stream. */
  private inflightEnd = 0;
  /** Windows taken while one was being scored. */
  private queued: Window[] = [];
  private nextId = 0;
  /** Scores of windows taken before this id are stale (the audio was forgotten). */
  private validFrom = 0;
  private readonly lastDetection: number[];
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly stats: { scored: number; skipped: number; totalMs: number; maxMs: number };
  private readonly detections: number[];
  private readonly maxScores: number[];
  private readonly options: WakeWordOptions<Name>;

  constructor(options: WakeWordOptions<Name>) {
    this.options = options;
    const { classifiers } = options;
    this.phrases = Object.fromEntries(classifiers.map((c) => [c.name, wakePhraseOf(c.model)])) as Partial<
      Record<Name, string>
    >;
    this.thresholds = Object.fromEntries(classifiers.map((c) => [c.name, c.threshold])) as Partial<
      Record<Name, number>
    >;
    this.lastDetection = classifiers.map(() => -Infinity);
    this.detections = classifiers.map(() => 0);
    this.maxScores = classifiers.map(() => 0);
    this.stats = { scored: 0, skipped: 0, totalMs: 0, maxMs: 0 };
    this.now = options.now ?? (() => Date.now());
    this.debounceMs = options.debounceMs ?? WAKE_DEBOUNCE_MS;
    this.thread = new Worker(new URL(import.meta.url), {
      workerData: {
        wakeWordThread: true,
        classifiers: classifiers.map((c) => c.model),
        featureDir: options.featureDir ?? WAKE_MODEL_DIR,
      } satisfies ThreadInit,
    });
    this.thread.unref();
    this.ready = new Promise<void>((resolve, reject) => {
      this.thread.on('message', (msg: ThreadReply) => {
        if ('ready' in msg) {
          const size = windowSamples(msg.embeddings);
          if (size !== this.ring.length) {
            this.ring = new Float32Array(size);
            this.write = 0;
            this.filled = 0;
          }
          for (const [i, err] of Object.entries(msg.failed)) {
            const name = classifiers[Number(i)].name;
            this.failed[name] = err;
            delete this.phrases[name];
          }
          this.listening = this.listening.filter((i) => !(i in msg.failed));
          this.loaded = true;
          return resolve();
        }
        if ('error' in msg) {
          if (!this.loaded) return reject(new Error(msg.error));
          return this.fail(msg.error);
        }
        this.onScore(msg.id, msg.scores, msg.ms);
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
   * Score windows with these classifiers, or none: then only keep the audio. A classifier that starts
   * listening scores only new audio: what was said while it was off (a phrase while the turn was
   * open, the end of a review recording) never triggers it.
   */
  listen(names: readonly Name[]): void {
    const listening = this.options.classifiers.flatMap((c, i) =>
      names.includes(c.name) && !(c.name in this.failed) ? [i] : [],
    );
    if (listening.length === this.listening.length && listening.every((i, k) => this.listening[k] === i)) return;
    const added = listening.some((i) => !this.listening.includes(i));
    this.listening = listening;
    this.sinceScore = 0;
    this.queued = [];
    if (added) this.filled = 0;
  }

  /** 16 kHz mono audio, in order. */
  push(pcm: Int16Array): void {
    if (this.closed) return;
    const size = this.ring.length;
    const scoring = this.listening.length > 0 && this.loaded;
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
    const window = { id: this.nextId++, audio, end: this.position, active: this.listening };
    if (!this.inflight) return this.send(window);
    this.queued.push(window);
    if (this.queued.length > WAKE_MAX_QUEUED) {
      this.queued.shift();
      this.stats.skipped++;
    }
  }

  private send(window: Window): void {
    this.inflight = true;
    this.inflightEnd = window.end;
    this.thread.postMessage(window, [window.audio.buffer]);
  }

  get summary(): WakeWordStats {
    const { scored, skipped, totalMs, maxMs } = this.stats;
    const byName = (values: number[], round: (v: number) => number) =>
      Object.fromEntries(this.options.classifiers.map((c, i) => [c.name, round(values[i])]));
    return {
      scored,
      skipped,
      meanMs: scored ? Math.round((totalMs / scored) * 10) / 10 : 0,
      maxMs: Math.round(maxMs * 10) / 10,
      detections: byName(this.detections, (v) => v),
      maxScore: byName(this.maxScores, (v) => Math.round(v * 1000) / 1000),
    };
  }

  /** The thread's share of one core since it started (0-1). */
  get utilization(): number {
    return this.thread.performance.eventLoopUtilization().utilization;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.listening = [];
    await this.thread.terminate();
  }

  private onScore(id: number, scores: number[], ms: number): void {
    this.inflight = false;
    this.stats.scored++;
    this.stats.totalMs += ms;
    this.stats.maxMs = Math.max(this.stats.maxMs, ms);
    scores.forEach((score, i) => (this.maxScores[i] = Math.max(this.maxScores[i], score)));
    const detected = this.detects(id, scores);
    if (detected !== undefined) {
      // The phrase is in the window just scored: forget it, as the reference listener clears its buffer.
      this.filled = 0;
      this.sinceScore = 0;
      this.queued = [];
      this.validFrom = this.nextId;
      this.options.onDetect(
        this.options.classifiers[detected].name,
        scores[detected],
        this.position - this.inflightEnd,
      );
    }
    const next = this.queued.shift();
    if (next && !this.closed) this.send(next);
  }

  /** The classifier this window is a detection of, the highest score over its threshold, if any. */
  private detects(id: number, scores: number[]): number | undefined {
    if (id < this.validFrom || this.closed) return undefined;
    const now = this.now();
    let best: number | undefined;
    for (const i of this.listening) {
      if (scores[i] < this.options.classifiers[i].threshold) continue;
      if (now - this.lastDetection[i] < this.debounceMs) continue;
      if (best === undefined || scores[i] > scores[best]) best = i;
    }
    if (best === undefined) return undefined;
    this.lastDetection[best] = now;
    this.detections[best]++;
    return best;
  }

  private fail(err: string): void {
    if (this.closed) return;
    this.closed = true;
    this.listening = [];
    void this.thread.terminate();
    this.options.onError?.(err);
  }
}
