/**
 * `/meet <link> jev`'s transcript: each participant's own audio from Recall (recall.ts) through a VAD
 * and a Gemini Live transcription of its own, driven as `/voice jev`'s worker drives its one caller's
 * (`JevLoop` in src/voice-mode-worker.ts): the VAD's start of speech opens an activity with the pre-roll
 * and warms the next socket, the activity's partials and its final go out under one uttId, between
 * that speaker's `speech` marks. One pipeline per speaking participant, the bot never among them,
 * opened at a participant's first audible frame and closed when they leave, after PARTICIPANT_IDLE_MS
 * without speech, or with the call.
 *
 * Recall sends nothing for a muted participant (and may send empty packets for a silent one), so a gap
 * in the frames while the VAD hears speech is fed to it as silence: otherwise its end of speech never
 * comes. Times: speech marks at their audio's place on Recall's clock (the frame's `at`), never later
 * than now; partials and finals when they arrive, as the worker stamps them.
 */
import { GeminiLiveTranscriber, turnText, type TranscriberOptions } from '../../../voice-mode-gemini-live.js';
import type { CallEvent, Speaker } from '../core/types.js';

export const SAMPLE_RATE = 16_000;
/** Google Meet streams the 16 loudest participants (how-to-get-separate-audio-per-participant-realtime). */
export const MAX_PARTICIPANT_PIPELINES = 16;
/** A participant's pipeline closes after this long without speech; their next audible frame opens a new one. */
export const PARTICIPANT_IDLE_MS = 120_000;
/** No frame for this long while the VAD hears speech: the gap is fed to it as silence. */
export const AUDIO_GAP_MS = 300;
const GAP_CHECK_MS = 100;
/** The most silence one gap check feeds; Silero's end of speech needs 550 ms of it. */
const MAX_GAP_FILL_MS = 2_000;
/** As the worker's PRE_ROLL_MS: the activity starts this far before the VAD's start of speech. */
const PRE_ROLL_MS = 500;
const RING_MS = 10_000;
/** Each participant's frame cadence goes to the debug log this often, for the live test. */
export const CADENCE_LOG_MS = 5_000;

const samplesOf = (ms: number): number => Math.round((ms * SAMPLE_RATE) / 1000);
const msOf = (samples: number): number => (samples * 1000) / SAMPLE_RATE;

/** One participant's VAD: `position` counts the samples pushed into it. */
export interface SpeechDetector {
  push(pcm: Int16Array): void;
  close(): void;
}
export type SpeechDetectorFactory = (events: {
  onSpeech(speaking: boolean, position: number): void;
  onError(err: unknown): void;
}) => SpeechDetector;

export type MeetingTranscription = Pick<GeminiLiveTranscriber, 'prepare' | 'begin' | 'push' | 'end' | 'close'>;

/** The transcription settings, as the call's job gives them to the worker. */
export interface MeetingSpeech {
  apiKey: string;
  model: string;
  vocabulary: readonly string[];
  languageCodes: readonly string[];
}

export interface MeetingAudioOptions {
  speech: MeetingSpeech;
  /** The VAD factory, null until it loaded (frames before then are dropped). */
  detector(): SpeechDetectorFactory | null;
  transcriber?: (options: TranscriberOptions) => MeetingTranscription;
  onEvent(event: CallEvent): void;
  /** A participant's partial carried words: the worker reflex's text confirmation. */
  onWords(): void;
  log: Pick<Console, 'info' | 'warn'> & { debug?(message: string, fields?: unknown): void };
  now?: () => number;
  idleMs?: number;
  maxPipelines?: number;
}

export interface MeetingAudio {
  /** One frame of a participant's audio; `at` is the host ms of its first sample. */
  audio(speaker: Speaker, pcm: Int16Array, at: number): void;
  /** The participant left: speech under way ends there, and its final still goes out. */
  left(speaker: Speaker, at: number): void;
  /** The call ended: every pipeline closes, and nothing more is emitted. */
  close(): void;
  readonly pipelines: number;
}

/** The last RING_MS of a participant's audio, by sample position. */
class Ring {
  private chunks: Array<{ from: number; pcm: Int16Array }> = [];
  private end = 0;

  push(pcm: Int16Array): void {
    this.chunks.push({ from: this.end, pcm: pcm.slice() });
    this.end += pcm.length;
    while (this.chunks.length > 1 && this.chunks[1].from <= this.end - samplesOf(RING_MS)) this.chunks.shift();
  }

  since(from: number): Int16Array {
    const start = Math.max(0, from);
    const parts = this.chunks
      .filter((c) => c.from + c.pcm.length > start)
      .map((c) => c.pcm.subarray(Math.max(0, start - c.from)));
    const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

const audible = (pcm: Int16Array): boolean => pcm.some((v) => v !== 0);

/** Frames as they arrived, never their audio: counts, sizes and the gaps between arrivals. */
interface Counts {
  frames: number;
  bytes: number;
  empty: number;
  audioMs: number;
  /** Arrival gaps over AUDIO_GAP_MS, and the longest one. */
  gaps: number;
  maxGapMs: number;
}
const noCounts = (): Counts => ({ frames: 0, bytes: 0, empty: 0, audioMs: 0, gaps: 0, maxGapMs: 0 });

class Cadence {
  private last?: number;
  /** Since the last debug line. */
  window = noCounts();
  /** Since the participant's pipeline opened (or their first frame). */
  total = noCounts();

  add(samples: number, arrival: number): void {
    const gap = this.last === undefined ? 0 : arrival - this.last;
    this.last = arrival;
    for (const c of [this.window, this.total]) {
      c.frames++;
      c.bytes += samples * 2;
      if (!samples) c.empty++;
      c.audioMs += msOf(samples);
      if (gap > AUDIO_GAP_MS) c.gaps++;
      c.maxGapMs = Math.max(c.maxGapMs, gap);
    }
  }
}

const rounded = (c: Counts): Counts => ({ ...c, audioMs: Math.round(c.audioMs) });

class Pipeline {
  private readonly ring = new Ring();
  private position = 0;
  /** The host ms of the sample at `position`, the end of what was pushed. */
  private clockAt = 0;
  private lastFrameAt: number;
  private speaking = false;
  private utterance?: { uttId: string; text: string };
  private gapTimer?: ReturnType<typeof setInterval>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private readonly vad: SpeechDetector;
  private readonly stt: MeetingTranscription;
  /** No more events: the call ended, or the pipeline closed without a leave. */
  private silenced = false;
  closed = false;

  constructor(
    private readonly speaker: Speaker,
    detector: SpeechDetectorFactory,
    private readonly opts: MeetingAudioOptions & { now: () => number; idleMs: number },
    private readonly nextUttId: () => string,
    private readonly onDone: (why: string) => void,
  ) {
    this.lastFrameAt = opts.now();
    this.vad = detector({
      onSpeech: (speaking, position) => this.onSpeech(speaking, position),
      onError: (err) => {
        opts.log.warn('meet-jev audio: a participant VAD failed; their pipeline closes', { speaker: speaker.id, err });
        this.onDone('vad failed');
      },
    });
    const { speech } = opts;
    this.stt = (opts.transcriber ?? ((o) => new GeminiLiveTranscriber(o)))({
      apiKey: speech.apiKey,
      model: speech.model,
      vocabulary: [...new Set(speech.vocabulary)],
      languageCodes: speech.languageCodes,
      sampleRate: SAMPLE_RATE,
      onInterim: (text) => this.onInterim(text),
      log: opts.log,
    });
    void this.stt.prepare();
    this.armIdle();
  }

  frame(pcm: Int16Array, at: number): void {
    if (this.closed) return;
    this.lastFrameAt = this.opts.now();
    this.push(pcm, at);
  }

  /** The participant left: speech under way ends at `at`, its final goes out, then the pipeline closes. */
  leave(at: number): void {
    if (this.closed) return;
    const ending = this.speaking ? this.endSpeech(at) : undefined;
    this.shutdown();
    void ending?.finally(() => this.stt.close());
    if (!ending) this.stt.close();
  }

  /** Closes with no more events. */
  close(): void {
    if (this.closed) return;
    this.silenced = true;
    this.shutdown();
    this.stt.close();
  }

  private shutdown(): void {
    this.closed = true;
    clearInterval(this.gapTimer);
    clearTimeout(this.idleTimer);
    this.vad.close();
  }

  private push(pcm: Int16Array, at: number): void {
    this.ring.push(pcm);
    this.position += pcm.length;
    this.clockAt = at + msOf(pcm.length);
    if (this.utterance) this.stt.push(pcm);
    this.vad.push(pcm);
  }

  private atOf(position: number): number {
    return Math.min(this.opts.now(), Math.round(this.clockAt - msOf(this.position - position)));
  }

  private emit(event: CallEvent): void {
    if (!this.silenced) this.opts.onEvent(event);
  }

  private onSpeech(speaking: boolean, position: number): void {
    if (this.closed || speaking === this.speaking) return;
    if (!speaking) {
      void this.endSpeech(this.atOf(position));
      this.armIdle();
      return;
    }
    this.speaking = true;
    clearTimeout(this.idleTimer);
    this.emit({ kind: 'speech', speaker: this.speaker, on: true, at: this.atOf(position) });
    this.utterance = { uttId: this.nextUttId(), text: '' };
    this.stt.begin(this.ring.since(position - samplesOf(PRE_ROLL_MS)));
    // The next activity's socket, set up while this one runs: no connect latency at the next speech.
    void this.stt.prepare();
    this.gapTimer = setInterval(() => this.fillGap(), GAP_CHECK_MS);
    this.gapTimer.unref?.();
  }

  /** The speech mark, then the activity's final once it settles; resolves when that went out. */
  private endSpeech(at: number): Promise<void> {
    this.speaking = false;
    clearInterval(this.gapTimer);
    this.emit({ kind: 'speech', speaker: this.speaker, on: false, at });
    const utterance = this.utterance;
    this.utterance = undefined;
    if (!utterance) return Promise.resolve();
    return this.stt.end().then(
      (heard) => {
        const { text } = turnText(heard);
        // Nothing heard and nothing shown: a noise, which the loop never hears of.
        if (!text && !utterance.text) return;
        this.emit({
          kind: 'utterance',
          speaker: this.speaker,
          uttId: utterance.uttId,
          text,
          final: true,
          at: this.opts.now(),
        });
      },
      (err: unknown) =>
        this.opts.log.warn('meet-jev audio: an utterance has no final', { speaker: this.speaker.id, err }),
    );
  }

  private onInterim(text: string): void {
    const utterance = this.utterance;
    if (this.closed || !utterance || text === utterance.text) return;
    utterance.text = text;
    this.emit({
      kind: 'utterance',
      speaker: this.speaker,
      uttId: utterance.uttId,
      text,
      final: false,
      at: this.opts.now(),
    });
    if (text.trim() && !this.silenced) this.opts.onWords();
  }

  private fillGap(): void {
    const gap = this.opts.now() - this.lastFrameAt;
    if (this.closed || !this.speaking || gap < AUDIO_GAP_MS) return;
    this.lastFrameAt = this.opts.now();
    this.push(new Int16Array(samplesOf(Math.min(gap, MAX_GAP_FILL_MS))), this.clockAt);
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.speaking && !this.closed) this.onDone('idle');
    }, this.opts.idleMs);
    this.idleTimer.unref?.();
  }
}

export function createMeetingAudio(options: MeetingAudioOptions): MeetingAudio {
  const opts = { ...options, now: options.now ?? (() => Date.now()), idleMs: options.idleMs ?? PARTICIPANT_IDLE_MS };
  const maxPipelines = options.maxPipelines ?? MAX_PARTICIPANT_PIPELINES;
  const pipelines = new Map<string, Pipeline>();
  /** Utterances so far per participant, across their pipelines, so an uttId is never reused. */
  const uttSeq = new Map<string, number>();
  /** Participants already told about once: no VAD yet, or over the cap. */
  const refused = new Set<string>();
  const cadence = new Map<string, Cadence>();
  let closed = false;

  const cadenceLog = setInterval(() => {
    for (const [id, c] of cadence) {
      if (!c.window.frames) continue;
      options.log.debug?.('meet-jev audio: frame cadence', { speaker: id, ms: CADENCE_LOG_MS, ...rounded(c.window) });
      c.window = noCounts();
    }
  }, CADENCE_LOG_MS);
  cadenceLog.unref?.();

  /** The pipeline's close line, with the frames since it opened. */
  const closedLine = (id: string, why: string): void => {
    const c = cadence.get(id);
    options.log.info('meet-jev audio: a participant pipeline closed', {
      speaker: id,
      why,
      open: pipelines.size,
      ...(c ? { frames: rounded(c.total) } : {}),
    });
    if (c) c.total = noCounts();
  };

  const drop = (id: string, why: string): void => {
    const pipeline = pipelines.get(id);
    if (!pipeline) return;
    pipelines.delete(id);
    pipeline.close();
    closedLine(id, why);
  };

  const open = (speaker: Speaker): Pipeline | null => {
    const detector = options.detector();
    const why = !detector ? 'the VAD is still loading' : pipelines.size >= maxPipelines ? 'too many speakers' : null;
    if (why || !detector) {
      if (!refused.has(speaker.id)) {
        refused.add(speaker.id);
        options.log.warn("meet-jev audio: a participant's audio is not transcribed", { speaker: speaker.id, why });
      }
      return null;
    }
    refused.delete(speaker.id);
    const pipeline = new Pipeline(
      speaker,
      detector,
      opts,
      () => {
        const n = uttSeq.get(speaker.id) ?? 0;
        uttSeq.set(speaker.id, n + 1);
        return `${speaker.id}-${n}`;
      },
      (why) => drop(speaker.id, why),
    );
    pipelines.set(speaker.id, pipeline);
    options.log.info('meet-jev audio: a participant pipeline opened', { speaker: speaker.id, open: pipelines.size });
    return pipeline;
  };

  return {
    audio(speaker, pcm, at) {
      if (closed) return;
      let c = cadence.get(speaker.id);
      if (!c) cadence.set(speaker.id, (c = new Cadence()));
      c.add(pcm.length, opts.now());
      if (!pcm.length) return;
      let pipeline = pipelines.get(speaker.id);
      if (!pipeline) {
        if (!audible(pcm)) return;
        pipeline = open(speaker) ?? undefined;
        if (!pipeline) return;
      }
      pipeline.frame(pcm, at);
    },
    left(speaker, at) {
      const pipeline = pipelines.get(speaker.id);
      if (closed || !pipeline) return;
      pipelines.delete(speaker.id);
      pipeline.leave(at);
      closedLine(speaker.id, 'left');
    },
    close() {
      closed = true;
      clearInterval(cadenceLog);
      for (const id of [...pipelines.keys()]) drop(id, 'call ended');
    },
    get pipelines() {
      return pipelines.size;
    },
  };
}

let silero: Promise<SpeechDetectorFactory> | undefined;

/**
 * Silero's VAD (the worker's `@livekit/agents-plugin-silero`) as a SpeechDetectorFactory: the model is
 * loaded once per host process, on first use, with the agents logger it needs; each participant gets
 * a stream of its own. Positions as the worker's CallerInput takes them.
 */
export function sileroDetectors(): Promise<SpeechDetectorFactory> {
  silero ??= (async (): Promise<SpeechDetectorFactory> => {
    const [agents, plugin, rtc] = await Promise.all([
      import('@livekit/agents'),
      import('@livekit/agents-plugin-silero'),
      import('@livekit/rtc-node'),
    ]);
    if (!agents.loggerOptions()) agents.initializeLogger({ pretty: false, level: 'warn' });
    const vad = await plugin.VAD.load({ sampleRate: SAMPLE_RATE });
    return (events) => {
      const stream = vad.stream();
      let closed = false;
      void (async () => {
        for await (const ev of stream) {
          if (closed) break;
          if (ev.type === agents.VADEventType.START_OF_SPEECH) {
            events.onSpeech(true, ev.samplesIndex - samplesOf(ev.speechDuration));
          } else if (ev.type === agents.VADEventType.END_OF_SPEECH) {
            events.onSpeech(false, ev.samplesIndex - samplesOf(ev.silenceDuration));
          }
        }
      })().catch((err: unknown) => {
        if (!closed) events.onError(err);
      });
      return {
        push(pcm) {
          if (!closed) stream.pushFrame(new rtc.AudioFrame(pcm, SAMPLE_RATE, 1, pcm.length));
        },
        close() {
          if (closed) return;
          closed = true;
          stream.close();
        },
      };
    };
  })().catch((err: unknown) => {
    silero = undefined;
    throw err;
  });
  return silero;
}
