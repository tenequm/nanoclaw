/**
 * The LiveKit Agents worker for the voice channel's LiveKit path, where the caller takes
 * turns talking to the line's real NanoClaw agent.
 *
 * A separate process (`pnpm run voice-worker`), because agents-js runs every
 * job in a forked child process of its worker and owns that process's signals
 * and logging; the host dispatches it to each call's room (explicit dispatch
 * by agent name) and the two talk over the host's webhook server, see
 * `src/channels/voice-livekit-protocol.ts` for the protocol. The host's address and the
 * call's secret come from the worker's own settings, never from the dispatch.
 *
 * Per job: join the room, wait for the caller named in the metadata, tell the host (which starts
 * the clock), then run the call's own pipeline (no agents-js AgentSession):
 *  - the caller's microphone at 16 kHz goes to Silero VAD, the wake word spotter and `CallTurns`,
 *    the one turn state machine: a turn is one Gemini Live activity (`GeminiLiveTranscriber`,
 *    manual activity), opened at the caller's speech (or the wake word) with a short pre-roll and
 *    closed by the closing silence (`silenceMs`), a spoken command or the review controls, so a
 *    turn with thinking pauses is transcribed as one piece;
 *  - each finished turn goes to the host, which hands it to the agent as a spoken message;
 *  - each complete agent reply from the host's event stream is spoken once the caller is not
 *    mid-turn, in full (cut at a sentence end only when VOICE_MAX_SPOKEN_CHARS sets a cap),
 *    uninterruptible: while it plays the caller is not transcribed (no barge-in). Gemini TTS
 *    streams the whole reply from one request into the call's speech track, and a second model
 *    speaks while the first fails.
 * The worker publishes the captions, `lk.agent.state` and its own attributes the page reads.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  AutoSubscribe,
  type APIConnectOptions,
  cli,
  defineAgent,
  InferenceRunner,
  log as agentsLog,
  ServerOptions,
  VADEventType,
  type JobContext,
  type JobProcess,
  type VAD,
} from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import * as silero from '@livekit/agents-plugin-silero';
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type Room,
} from '@livekit/rtc-node';

import {
  wakePhrase,
  DEFAULT_LIVEKIT_AGENT_NAME,
  HOST_SILENCE_MS,
  LIVEKIT_PROTOCOL_VERSION,
  liveKitCallSecret,
  liveKitHostUrl,
  CALL_COMMANDS_ATTRIBUTE,
  CALL_COMMANDS_VERSION,
  CALL_CUE_TRACK,
  CALL_PENDING_ATTRIBUTE,
  CALL_REPLY_TOPIC,
  CALL_REVIEW_ATTRIBUTE,
  CALL_REVIEW_TOPIC,
  CALL_THINKING_ATTRIBUTE,
  CALL_TURN_TOPIC,
  CALL_UPDATING_ATTRIBUTE,
  MAX_TURN_TEXT_BYTES,
  REVIEW_RPC,
  WORKER_REQUEST_TIMEOUT_MS,
  type CallDraft,
  type CallDroppedSpeech,
  type CallReviewState,
  type CallUnheardSpeech,
  type CallWakeState,
  type LiveKitHostEvent,
  type LiveKitJobMetadata,
  type CallReplyInfo,
  type CallTurnStatus,
  type ReviewOp,
  type ReviewReply,
  type ReviewRequest,
  type TurnMode,
} from './channels/voice-livekit-protocol.js';
import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { GeminiLiveTranscriber, type Heard, type TranscriberOptions } from './voice-gemini-live.js';
import {
  CUSTOM_WAKE_THRESHOLD,
  DEFAULT_WAKE_MODEL,
  DEFAULT_WAKE_THRESHOLD,
  WakeWordSpotter,
  type WakeWordStats,
} from './voice-wakeword.js';

/** The worker's duration cap outlasts the host's by this; it only fires when the host is gone. */
const WORKER_DEADLINE_GRACE_MS = 30_000;
/** Silero, the wake word, the transcription and the recordings all take 16 kHz mono. */
const INPUT_SAMPLE_RATE = 16_000;
/** Language hints for the transcription; the call's language for the worker's own lines. */
const STT_LANGUAGE_CODES = ['uk-UA', 'en-US'] as const;
/** One typing tick from the host keeps "thinking" up this long; the host re-fires every 4 s. */
const THINKING_HOLD_MS = 10_000;
/** After a turn went out, "thinking" holds this long without a reply or a typing tick. */
export const AWAIT_REPLY_MS = 20_000;
/** After the caller stops, their turn can still be committed up to silenceMs plus this. */
export const TURN_SETTLE_MS = 3_000;
/** A reply waits at most silenceMs plus this for a caller who keeps talking, then takes the channel. */
export const MAX_IDLE_WAIT_MS = 10_000;
/** How long "working" outlasts the start of a reply's speech, so the page has the speaking state first. */
const REPLY_HOLD_MS = 500;
/** Shorter untranscribed speech is a cough or a noise, not a lost turn, unless the STT failed. */
export const MIN_LOST_SPEECH_MS = 800;
/** Longest wait for the next TTS audio: Gemini 3.8 TTS takes seconds to first audio. */
const TTS_IDLE_TIMEOUT_MS = 60_000;
/** A speech model that failed is tried again on the first line after this long. */
export const TTS_RECOVERY_DELAY_MS = 30_000;
/** A worker on another protocol version waits this long for the caller, then this long for their page to see why. */
const MISMATCH_JOIN_WAIT_MS = 30_000;
const MISMATCH_NOTICE_MS = 3_000;
/** A turn recording keeps this much audio after the last speech. */
const RECORDING_PAD_MS = 300;
/** Longest turn recording; audio past it is not kept. */
const MAX_RECORDED_TURN_MS = 120_000;
/** A turn whose POST failed in transit is sent once more, under the same turn key, after this long. */
const TURN_RETRY_DELAY_MS = 500;
/** Timed-out turns kept for a late `turn-stored`; the host remembers no more turn keys than this either. */
const MAX_UNCONFIRMED_TURNS = 32;
/** A manual recording's text freezes at most this long after done. */
const FINISH_TIMEOUT_MS = 4_000;
/** A turn's audio starts this long before the speech that opened it: manual activity has no padding. */
export const PRE_ROLL_MS = 500;
/** Recent caller audio kept for that pre-roll, and for a turn that goes on after a command that was not one. */
const RING_MS = 10_000;
/** After a spoken line, the your-turn cue waits this long for the next one to start. */
export const TURN_CUE_DELAY_MS = 600;
/** A your-turn cue this soon after the last one is the same hand-over, and stays silent. */
const TURN_CUE_REPEAT_MS = 3_000;
/** The listening cue waits this long for the page's settings (`?cues=0` turns cues off), then plays. */
export const READY_CUE_WAIT_MS = 2_000;
/** Waits on the global timers (which tests can fake). */
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** VOICE_MAX_SPOKEN_CHARS when unset: 0, no cap; a reply is spoken in full however long it runs. */
export const DEFAULT_MAX_SPOKEN_CHARS = 0;
const DAY_MS = 86_400_000;

const samplesOf = (ms: number): number => Math.round((ms * INPUT_SAMPLE_RATE) / 1000);
const msOf = (samples: number): number => (samples * 1000) / INPUT_SAMPLE_RATE;
/** The worker's HTTP client for the host's /webhook/voice/livekit/agent routes. */
export class HostLink {
  constructor(
    private readonly link: { hostUrl: string; secret: string; callId: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string): string {
    return `${this.link.hostUrl}/webhook/voice/livekit/agent/${path}`;
  }

  post(path: 'joined' | 'utterance' | 'ended', body: Record<string, unknown> = {}): Promise<Response> {
    return this.fetchImpl(this.url(path), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.link.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId: this.link.callId, ...body }),
      signal: AbortSignal.timeout(WORKER_REQUEST_TIMEOUT_MS),
    });
  }

  /** Read the host's event stream until it ends; rejects when it fails or goes silent. */
  async events(onEvent: (event: LiveKitHostEvent) => void, signal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    let silence = setTimeout(abort, HOST_SILENCE_MS);
    try {
      const res = await this.fetchImpl(`${this.url('events')}?call=${encodeURIComponent(this.link.callId)}`, {
        headers: { Authorization: `Bearer ${this.link.secret}` },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`host event stream refused: ${res.status}`);
      const decoder = new TextDecoder();
      let buffered = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        clearTimeout(silence);
        silence = setTimeout(abort, HOST_SILENCE_MS);
        buffered += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, nl).trim();
          buffered = buffered.slice(nl + 1);
          if (line) onEvent(JSON.parse(line) as LiveKitHostEvent);
        }
      }
    } finally {
      clearTimeout(silence);
      signal.removeEventListener('abort', abort);
    }
  }
}

/**
 * An agent message as words to say: markdown, links, code and markup removed, every line a
 * sentence. The agent is asked for plain spoken text; this covers the times it is not.
 */
export function speakableText(message: string): string {
  const lines = message
    .replace(/```[\s\S]*?(```|$)/g, '\n')
    // Tags only: a comparison like "x < 5 and y > 3" is words.
    .replace(/<\/?[A-Za-z][\w:-]*(?:\s[^<>\n]*)?\/?>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .split(/\r?\n/);
  const out: string[] = [];
  for (const raw of lines) {
    if (/^\s*([-*_=]\s*){3,}$/.test(raw) || /^\s*\|?\s*:?-{2,}/.test(raw)) continue;
    let line = raw
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*>+\s?/, '')
      .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '')
      .replace(/\*\*(.+?)\*\*|__(.+?)__/g, '$1$2')
      .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=$|[\s).,!?:;])/g, '$1$2')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/\s*\|\s*/g, ', ')
      .replace(/^[,\s]+|[,\s]+$/g, '')
      .replace(/\s+/g, ' ')
      .replace(/ ([.,!?;:])/g, '$1')
      .trim();
    if (!line) continue;
    if (!/[.!?…:;]$/.test(line)) line += '.';
    out.push(line);
  }
  return out.join(' ');
}

export type CallLanguage = 'uk' | 'en';
/** Until the caller says something, the worker's own lines use the first transcription language. */
const DEFAULT_CALL_LANGUAGE: CallLanguage = 'uk';

/**
 * What the worker says itself when the exchange breaks, in the call's language: a turn it did not
 * hear (`turn`), a turn the host refused or did not confirm (by `hostLossReason`; a turn that timed
 * out may still reach the agent, so it is never "repeat"), and a reply it could not synthesize.
 */
export const FAILURE_LINES: Record<FailureKind, Record<CallLanguage, string>> = {
  turn: { uk: 'Не розчув, повтори, будь ласка.', en: "Sorry, I didn't catch that." },
  rejected: { uk: 'Не вдалося це передати.', en: "That didn't go through." },
  rate_limited: { uk: 'Забагато реплік, зачекай трохи.', en: 'Too many turns - give it a moment.' },
  timeout: { uk: 'Не впевнений, що це дійшло - перевір чат.', en: 'Not sure that got through - check the chat.' },
  timeout_no_chat: { uk: 'Не впевнений, що це дійшло.', en: 'Not sure that got through.' },
  reply: { uk: 'Не вийшло озвучити відповідь, вона є на екрані.', en: "Sorry, I couldn't read that reply out." },
};
export type FailureKind = 'turn' | 'rejected' | 'rate_limited' | 'timeout' | 'timeout_no_chat' | 'reply';

/** Said after a message cut for speech: the full text is in the chat, or, on a call with no chat, nowhere to point at. */
export const CUT_LINES: Record<'chat' | 'no_chat', Record<CallLanguage, string>> = {
  chat: { uk: 'Решта - у чаті.', en: 'The rest is in the chat.' },
  no_chat: { uk: 'Скорочую.', en: "I've cut it short." },
};

/** A sentence end earlier than this share of the cap wastes the budget: the cut goes to a word instead. */
const MIN_SENTENCE_CUT = 0.6;

/** VOICE_MAX_SPOKEN_CHARS: a whole number of characters, 0 for no cap; anything else is the default (no cap). */
export function maxSpokenChars(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_MAX_SPOKEN_CHARS;
  const chars = Number(value);
  return Number.isInteger(chars) && chars >= 0 ? chars : DEFAULT_MAX_SPOKEN_CHARS;
}

/**
 * Speakable text cut to `max` characters for a call: up to the last sentence end within the cap when
 * that keeps most of it, else the last whole word, then a closing line (CUT_LINES; "the rest is in the
 * chat" only when `inChat`). Unchanged when it fits or `max` is 0.
 */
export function capSpokenText(text: string, max: number, language: CallLanguage, inChat: boolean): string {
  if (max <= 0 || text.length <= max) return text;
  const closing = CUT_LINES[inChat ? 'chat' : 'no_chat'][language];
  // One character past the cap shows whether the text breaks right at it.
  const span = text.slice(0, max + 1);
  let cut = 0;
  for (const m of span.matchAll(/[.!?…]+["'»”)\]]*(?=\s)/g)) {
    const end = m.index + m[0].length;
    if (end <= max) cut = end;
  }
  if (cut < max * MIN_SENTENCE_CUT) cut = 0;
  let head = text.slice(0, cut).trim();
  if (!head) {
    const space = span.search(/\s\S*$/);
    head = space > 0 ? `${text.slice(0, space).replace(/[\s,;:–—-]+$/, '')}…` : '';
  }
  return head ? `${head} ${closing}` : closing;
}

/** The language a transcript is in, by its script; undefined when it has no letters. */
export function languageOf(text: string): CallLanguage | undefined {
  if (/\p{Script=Cyrillic}/u.test(text)) return 'uk';
  if (/[A-Za-z]/.test(text)) return 'en';
  return undefined;
}
/** The speech models' audio: 24 kHz mono 16-bit PCM. */
export const TTS_SAMPLE_RATE = 24_000;
/** Emoji and their joiners are no words to say (agents-js's filter_emoji pattern). */
const EMOJI =
  /[\u{1f000}-\u{1fbff}]|[\u{2600}-\u{26ff}]|[\u{2700}-\u{27bf}]|[\u{2b00}-\u{2bff}]|[\u{fe00}-\u{fe0f}]|\u{200d}|\u{20e3}+/gu;
/** A transient failure before any audio is tried once more after this long. */
const TTS_RETRY_DELAY_MS = 1_000;

/** A speech model as GeminiSpeech uses it: the google plugin's TTS, or a test's. */
export interface SpeechModel {
  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): AsyncIterable<{ frame: AudioFrame }> & { readonly error?: Error; close?(): void };
  on(event: 'error', listener: (ev: unknown) => void): unknown;
}

export interface SpeechOptions {
  apiKey: string;
  model: string;
  /** Speaks while `model` fails; empty for none. */
  fallbackModel: string;
  voice: string;
  log: Pick<Console, 'info' | 'warn'>;
  /** The speech models by name; the google plugin's TTS by default. */
  create?(model: string): SpeechModel;
  now?: () => number;
}

/**
 * Gemini TTS through the google plugin's TTS, used standalone: each line goes to the model whole, in
 * one request, so it is voiced with one intonation, and its audio streams back as it is made. A
 * transient failure before any audio is tried once more; then the fallback model speaks, and the
 * first model is skipped for TTS_RECOVERY_DELAY_MS and tried again on the next line after that.
 * A failure after audio started ends the line: its start would be said twice.
 */
export class GeminiSpeech {
  private downUntil = 0;
  private readonly now: () => number;
  private readonly models = new Map<string, SpeechModel>();
  /** The model the last line's audio came from. */
  spokenBy = '';

  constructor(private readonly opts: SpeechOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** The line's audio as it is made (24 kHz mono); throws when no model could say all of it. */
  async *speak(text: string, signal: AbortSignal): AsyncGenerator<Int16Array> {
    const line = text.replace(EMOJI, '').trim();
    if (!line) return;
    const { model, fallbackModel } = this.opts;
    const fallback = fallbackModel && fallbackModel !== model ? fallbackModel : '';
    const order = !fallback ? [model] : this.now() < this.downUntil ? [fallback, model] : [model, fallback];
    let lastError: unknown = new Error('no speech model');
    for (const name of order) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal.aborted) return;
        let spoke = false;
        let error: Error | undefined;
        // Each request has its own abort: the call's signal is forwarded and let go after it, so no
        // finished request stays referenced from the call-long signal.
        const request = new AbortController();
        const forward = () => request.abort();
        signal.addEventListener('abort', forward, { once: true });
        const stream = this.model(name).synthesize(
          line,
          { maxRetry: 0, retryIntervalMs: 0, timeoutMs: TTS_IDLE_TIMEOUT_MS },
          request.signal,
        );
        try {
          for await (const audio of withIdleTimeout(stream, TTS_IDLE_TIMEOUT_MS)) {
            spoke = true;
            this.spokenBy = name;
            yield audio.frame.data;
          }
          error = stream.error ?? (spoke ? undefined : new Error(`speech model ${name} sent no audio`));
        } catch (err) {
          // A stall (or a throwing stream) is a failure like any other: before audio the next model speaks.
          error = err instanceof Error ? err : new Error(String(err));
        } finally {
          signal.removeEventListener('abort', forward);
          request.abort();
          stream.close?.();
        }
        if (signal.aborted) return;
        if (!error) {
          this.markUp(name);
          return;
        }
        lastError = error;
        this.opts.log.warn(`voice worker: speech model ${name} failed`, { err: error.message, partial: spoke });
        if (spoke) throw error;
        if (attempt > 0 || (error as { retryable?: boolean }).retryable !== true) break;
        await pause(TTS_RETRY_DELAY_MS);
      }
      this.markDown(name);
    }
    throw lastError;
  }

  private model(name: string): SpeechModel {
    let speech = this.models.get(name);
    if (!speech) {
      speech =
        this.opts.create?.(name) ??
        (new google.beta.TTS({
          apiKey: this.opts.apiKey,
          model: name,
          voiceName: this.opts.voice,
          instructions: '',
        }) as unknown as SpeechModel);
      // The TTS reports a failed request as an event too; with no listener an EventEmitter would throw it.
      speech.on('error', () => undefined);
      this.models.set(name, speech);
    }
    return speech;
  }

  private markDown(model: string): void {
    if (model !== this.opts.model || !this.opts.fallbackModel) return;
    this.downUntil = this.now() + TTS_RECOVERY_DELAY_MS;
  }

  private markUp(model: string): void {
    if (model !== this.opts.model || this.downUntil === 0) return;
    this.downUntil = 0;
    this.opts.log.info(`voice worker: speech model ${model} is back`);
  }
}

/** The stream's items until it ends, or until none came for `ms` (then it stops, as a stall). */
async function* withIdleTimeout<T>(stream: AsyncIterable<T>, ms: number): AsyncGenerator<T> {
  const it = stream[Symbol.asyncIterator]();
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<'stalled'>((resolve) => (timer = setTimeout(() => resolve('stalled'), ms)));
    const next = await Promise.race([it.next(), stalled]).finally(() => clearTimeout(timer));
    if (next === 'stalled') throw new Error(`speech stalled: no audio for ${ms} ms`);
    if (next.done) return;
    yield next.value;
  }
}

/** One caller turn's audio as the transcription heard it: 16 kHz mono PCM. */
export interface TurnAudio {
  pcm: Int16Array;
  sampleRate: number;
  startedAt: number;
  endedAt: number;
  speechMs: number;
  truncated: boolean;
}

/** The caller's last RING_MS of audio by stream position (16 kHz samples since the call's first frame). */
export class AudioRing {
  private readonly buffer = new Int16Array(samplesOf(RING_MS));
  /** Samples taken so far. */
  position = 0;

  push(pcm: Int16Array): void {
    const size = this.buffer.length;
    const data = pcm.length > size ? pcm.subarray(pcm.length - size) : pcm;
    const at = (this.position + pcm.length - data.length) % size;
    const first = Math.min(data.length, size - at);
    this.buffer.set(data.subarray(0, first), at);
    this.buffer.set(data.subarray(first), 0);
    this.position += pcm.length;
  }

  /** The audio from stream position `from` to now; what is older than the ring is gone. */
  since(from: number): Int16Array {
    const size = this.buffer.length;
    const start = Math.max(from, this.position - size, 0);
    const out = new Int16Array(Math.max(0, this.position - start));
    for (let i = 0; i < out.length; i++) out[i] = this.buffer[(start + i) % size];
    return out;
  }
}

/** Keeps one turn's audio for its recording: from its pre-roll to its end, capped at MAX_RECORDED_TURN_MS. */
export class TurnCapture {
  private chunks: Int16Array[] = [];
  private samples = 0;
  private startedAt = 0;
  private truncated = false;
  private open = false;

  constructor(private readonly now: () => number = () => Date.now()) {}

  start(preRoll: Int16Array): void {
    this.open = true;
    this.chunks = [];
    this.samples = 0;
    this.truncated = false;
    this.startedAt = this.now() - msOf(preRoll.length);
    this.push(preRoll);
  }

  push(pcm: Int16Array): void {
    if (!this.open || !pcm.length) return;
    if (this.samples >= samplesOf(MAX_RECORDED_TURN_MS)) {
      this.truncated = true;
      return;
    }
    this.chunks.push(pcm.slice());
    this.samples += pcm.length;
  }

  /** The turn's audio up to `keep` samples (its last speech plus a pad); the capture stops. */
  take(speechMs: number, keep = Infinity): TurnAudio | undefined {
    if (!this.open) return undefined;
    this.open = false;
    const length = Math.min(this.samples, keep);
    const pcm = new Int16Array(length);
    let offset = 0;
    for (const chunk of this.chunks) {
      if (offset >= length) break;
      const part = chunk.subarray(0, length - offset);
      pcm.set(part, offset);
      offset += part.length;
    }
    this.chunks = [];
    return {
      pcm,
      sampleRate: INPUT_SAMPLE_RATE,
      startedAt: this.startedAt,
      endedAt: this.startedAt + msOf(length),
      speechMs: Math.round(speechMs),
      truncated: this.truncated,
    };
  }
}

/**
 * The page's send cue: while a stretch of caller speech waits out the closing silence that sends
 * it, the `nanoclaw.voice.pending` attribute says how far into that silence it is; it clears
 * when the caller speaks again, the turn goes out or is dropped, the agent speaks, or the turn
 * is overdue (a transcript of only whitespace commits nothing and times nothing out).
 */
export class SendCountdown {
  private waits = 0;
  private shown = false;
  private expiry?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly publish: (value: string) => void,
    private readonly silenceMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The caller's speech ended at `speechEndedAt`; the turn goes out `silenceMs` after that. */
  stopped(speechEndedAt: number): void {
    const elapsed = Math.round(Math.max(0, Math.min(this.silenceMs, this.now() - speechEndedAt)));
    this.shown = true;
    this.publish(`${++this.waits}:${elapsed}:${this.silenceMs}`);
    clearTimeout(this.expiry);
    this.expiry = setTimeout(() => this.clear(), this.silenceMs - elapsed + TURN_SETTLE_MS);
    this.expiry.unref();
  }

  clear(): void {
    clearTimeout(this.expiry);
    if (!this.shown) return;
    this.shown = false;
    this.publish('');
  }
}

function pcmToWav(pcm: Int16Array, sampleRate: number): Buffer {
  const data = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) data.writeInt16LE(pcm[i], i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** What a turn recording's sidecar JSON says about it. */
export interface TurnRecord {
  callId: string;
  lineId: string;
  agent: string;
  turn: number;
  startedAt: string;
  endedAt: string;
  speechMs: number;
  truncated: boolean;
  /** The model that transcribed the turn: the streaming one, the fallback, or both joined by '+'. */
  sttModel: string;
  /** The text handed to the host; empty when the turn was dropped or lost, with `reason`. */
  transcript: string;
  reason?: string;
  host?: SendResult;
}

/** Where turn recordings go: NanoClaw's data directory, which git ignores. */
export const recordingsRoot = (): string => path.join(DATA_DIR, 'voice-recordings');

export const pathSegment = (name: string): string =>
  name
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'unnamed';

/** Writes `<root>/<agent>/<YYYY-MM-DD>/<callId>-<turn>.wav` and `.json`, owner-only. */
/** A recording's peak and RMS, in dBFS. */
export function audioLevels(pcm: Int16Array): { peakDb: number; rmsDb: number } {
  let peak = 0;
  let sum = 0;
  for (const v of pcm) {
    peak = Math.max(peak, Math.abs(v));
    sum += v * v;
  }
  const db = (x: number) => (x > 0 ? Math.round(20 * Math.log10(x / 32768) * 10) / 10 : -Infinity);
  return { peakDb: db(peak), rmsDb: db(Math.sqrt(sum / Math.max(1, pcm.length))) };
}

/**
 * Writes a spoken reply's audio, exactly as it went to the speech track (24 kHz mono), as
 * `<root>/<agent>/<YYYY-MM-DD>/<callId>-reply-<n>.wav`, next to the call's turn recordings, owner-only.
 */
export async function writeReplyRecording(
  root: string,
  call: { agent: string; callId: string },
  reply: number,
  pcm: Int16Array,
  at = Date.now(),
): Promise<string> {
  const dir = path.join(root, pathSegment(call.agent), new Date(at).toISOString().slice(0, 10));
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${pathSegment(call.callId)}-reply-${reply}.wav`);
  await fs.promises.writeFile(file, pcmToWav(pcm, TTS_SAMPLE_RATE), { mode: 0o600 });
  return file;
}

export async function writeTurnRecording(root: string, record: TurnRecord, audio: TurnAudio): Promise<string> {
  const dir = path.join(root, pathSegment(record.agent), record.startedAt.slice(0, 10));
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const base = path.join(dir, `${pathSegment(record.callId)}-${record.turn}`);
  await fs.promises.writeFile(`${base}.wav`, pcmToWav(audio.pcm, audio.sampleRate), { mode: 0o600 });
  await fs.promises.writeFile(`${base}.json`, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return base;
}

/** Deletes recordings older than `days`, and the directories that leaves empty; returns how many files went. */
export async function pruneRecordings(root: string, days: number, now = Date.now()): Promise<number> {
  const cutoff = now - days * DAY_MS;
  let removed = 0;
  const walk = async (dir: string): Promise<boolean> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let left = entries.length;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (await walk(full)) {
          await fs.promises.rmdir(full).catch(() => undefined);
          left--;
        }
      } else if (entry.isFile()) {
        // One file that cannot go must not stop the rest from going.
        const gone = await fs.promises
          .stat(full)
          .then(async (stat) => stat.mtimeMs < cutoff && (await fs.promises.unlink(full), true))
          .catch(() => false);
        if (gone) {
          removed++;
          left--;
        }
      }
    }
    return left === 0;
  };
  await walk(root);
  return removed;
}

/** VOICE_RECORDINGS_DAYS: 0 (the default) records nothing. */
export function recordingDays(raw: string | undefined): number {
  const days = Number(raw?.trim() || 0);
  return Number.isInteger(days) && days > 0 ? days : 0;
}

/** The call's room: what the turn logic needs from the audio, tracks and data channels. Faked in tests. */
export interface CallVoice {
  /** Speak a line, uninterruptible; resolves after playout with whether it was heard (all of it synthesized). */
  say(text: string): Promise<boolean>;
  /** The `nanoclaw.voice.thinking` attribute. */
  setThinking(thinking: boolean): void;
  /** One message on the `nanoclaw.voice.turn` topic. */
  publishTurn(status: CallTurnStatus): void;
  /** One message on the `nanoclaw.voice.reply` topic, sent right before the line it describes is spoken. */
  publishReply(info: CallReplyInfo): void;
  /** Words that will never be sent, on the `nanoclaw.voice.turn` topic. */
  publishDropped?(dropped: CallDroppedSpeech): void;
  /** On the `nanoclaw.voice.turn` topic: the caller spoke under the agent's line, unheard. */
  publishUnheard?(): void;
  /** The page's send countdown (the `nanoclaw.voice.pending` attribute); '' clears it. */
  setPending?(value: string): void;
  /** The caller's caption for turn `segment`: interim text as it grows, then its final text. */
  caption?(segment: number, text: string, final: boolean): void;
  /** Review mode's controls; absent where the room cannot run it. */
  review?: ReviewSession;
  /** Play a sound cue on the call's cue track; resolves once the track took all of it (heard about 0.1 s later). */
  playCue?(kind: CueKind): Promise<void>;
  close(): Promise<void>;
}

/** Review mode's page side: its state topic and its RPCs. */
export interface ReviewSession {
  /** One message on the `nanoclaw.voice.review` topic. */
  publishReview(state: CallReviewState): void;
  /**
   * Answer the page's review and settings RPCs with `handle`, and tell the page review mode and
   * spoken commands are on offer.
   */
  serve(handle: (op: ReviewOp, payload: string, callerIdentity: string) => Promise<string>): void;
}

/** What the room reports back. */
export interface CallVoiceEvents {
  /** The caller's audio: 16 kHz mono, every frame since the first, so stream positions line up. */
  onAudio(pcm: Int16Array): void;
  /** The VAD: the caller's speech started or ended at stream position `at` (16 kHz samples). */
  onSpeech(speaking: boolean, at: number): void;
  /** The agent's audio started or stopped playing. */
  onAgentSpeaking?(speaking: boolean): void;
  onClosed(reason: string): void;
}

/** A finished turn's recording, if turns are recorded, and which transcription model heard it. */
export interface TurnTake {
  audio?: TurnAudio;
  sttModel: string;
}

/** What became of a turn handed to the host. */
export interface SendResult {
  accepted: boolean;
  /** The host's id for an accepted turn. */
  id?: string;
  status?: number;
  error?: string;
  /** The key the turn went out under, for the host's `turn-stored` when it stores a timed-out turn after all. */
  turnKey?: string;
}
export interface TurnTakingDeps {
  send(text: string): Promise<SendResult>;
  say(text: string): Promise<boolean>;
  setThinking(thinking: boolean): void;
  /** What the line about to be spoken is, for the page's caption labels. */
  announce?(info: CallReplyInfo): void;
  /** Right before a line is spoken: review mode stops a recording the line takes the channel from. */
  beforeSpeak?(): void;
  /**
   * The queued lines are done and no other one is queued: over to the caller. `spoken`: whether
   * any of them was heard; when the speech model failed on all of them, the caller heard nothing.
   */
  spokenAll?(spoken: boolean): void;
  log: Pick<Console, 'info' | 'warn'>;
  now?: () => number;
}

/**
 * The turn-taking rules on top of the session: turns out in order, replies in when the caller
 * is not mid-turn, "thinking" while the agent works, and a spoken line when something is lost.
 */
export class TurnTaking {
  private readonly now: () => number;
  private callerSpeaking = false;
  /** Like a caller mid-turn, these hold replies for a while: an open review recording, and an open auto turn. */
  private readonly holds = new Set<'review' | 'turn'>();
  /** Until then, the caller's last speech may still be committed as a turn. */
  private turnOpenUntil = 0;
  private sends: Promise<void> = Promise.resolve();
  private speech: Promise<void> = Promise.resolve();
  private readonly wakers = new Set<() => void>();
  private thinkingUntil = 0;
  /** A turn the host took has had no reply yet: the agent's typing means it works on it. */
  private awaitingReply = false;
  /** A reply arrived and its line has not ended: the page keeps "working" until its audio plays. */
  private replyComing = false;
  private thinking?: boolean;
  private statusTimer?: ReturnType<typeof setTimeout>;
  private feedbackQueued = false;
  private closed = false;
  /** Spoken lines queued or playing, so a line can say another one follows it. */
  private queued = 0;
  /** Whether a line was heard since the queue last ran dry. */
  private spokeSinceIdle = false;
  /** The label of the line being spoken, until it is done. */
  private speakingLine?: CallReplyInfo;
  private replies = 0;
  private readonly partsByTurn = new Map<number, number>();
  /** Whether the call talks in a chat (the host's `chat` event), so its lines can point there. */
  private inChat = false;

  constructor(
    private readonly deps: TurnTakingDeps,
    private readonly options: { silenceMs: number; language: CallLanguage; maxSpokenChars?: number },
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.refresh();
  }

  onCallerSpeaking(speaking: boolean): void {
    this.callerSpeaking = speaking;
    if (!speaking) this.turnOpenUntil = this.now() + this.options.silenceMs + TURN_SETTLE_MS;
    this.wake();
  }

  /** Review mode opened or closed a recording, or an auto turn for the agent opened or ended. */
  setCaptureOpen(open: boolean, by: 'review' | 'turn' = 'review'): void {
    if (open) this.holds.add(by);
    else this.holds.delete(by);
    this.wake();
  }

  /** A line is queued or playing. */
  get speaking(): boolean {
    return this.queued > 0;
  }

  /** The agent works on a turn (the "thinking" the page shows). */
  get working(): boolean {
    return this.thinking === true;
  }

  /**
   * The caller's last speech ended without a turn (noise, words before the wake phrase, a discard):
   * a reply need not wait out the settle time for a turn that will not come.
   */
  releaseTurn(): void {
    if (this.turnOpenUntil === 0) return;
    this.turnOpenUntil = 0;
    this.wake();
  }

  /** Review mode took over: no pause will commit the auto mode's open turn. */
  resetCaller(): void {
    this.callerSpeaking = false;
    this.turnOpenUntil = 0;
    this.wake();
  }

  /** A finished caller turn; sent to the host in order, without holding up the session. */
  onTurn(text: string, onSent?: (result: SendResult) => void): void {
    if (this.closed) return;
    this.turnOpenUntil = 0;
    this.options.language = languageOf(text) ?? this.options.language;
    this.wake();
    this.sends = this.sends
      .then(() => this.sendTurn(text, onSent))
      .catch((err: unknown) => this.deps.log.warn('voice worker: sending a turn failed', { err }));
  }

  onTurnLost(reason: 'stt' | 'empty', fields: Record<string, unknown> = {}): void {
    if (this.closed) return;
    this.deps.log.warn(`voice worker: a turn was lost (${reason})`, fields);
    this.feedback('turn');
  }

  /**
   * A complete agent message from the host. `turn` is the caller turn it answers, null when it
   * answers none of this call's turns, undefined when that is not known.
   */
  onReply(text: string, turn?: number | null): void {
    if (this.closed) return;
    this.thinkingUntil = 0;
    this.awaitingReply = false;
    const full = speakableText(text);
    // Working until the line is heard: its speech takes a moment to synthesize.
    this.replyComing = !!full;
    this.refresh();
    if (!full) return;
    const max = this.options.maxSpokenChars ?? DEFAULT_MAX_SPOKEN_CHARS;
    if (max > 0 && full.length > max) {
      this.deps.log.info('voice worker: a long message is cut for speech', { chars: full.length, max });
    }
    this.enqueue(async () => {
      // Cut when spoken, so the closing line is in the language of the caller's latest turn.
      const spoken = capSpokenText(full, max, this.options.language, this.inChat);
      let about: Omit<CallReplyInfo, 'reply' | 'more'>;
      if (typeof turn === 'number') {
        const part = (this.partsByTurn.get(turn) ?? 0) + 1;
        this.partsByTurn.set(turn, part);
        about = { turn, part };
      } else {
        about = turn === null ? { unprompted: true } : {};
      }
      const reply = this.announce(about);
      const heard = await this.say(spoken).finally(() => this.replyHeard());
      if (heard) return;
      if (this.closed) return;
      this.deps.log.warn('voice worker: a reply could not be synthesized');
      // Nothing was heard: the page shows the words instead.
      this.deps.announce?.({ reply, ...about, unspoken: true, text: spoken });
      this.feedback('reply');
    });
  }

  /** The host's `chat` event: the call now talks in a chat, or on the voice line. */
  onChat(inChat: boolean): void {
    this.inChat = inChat;
  }

  /**
   * The agent is working: it picked up new work (`pickup`, the host's `working`), or it types on a
   * turn the host took and has not answered yet. Typing after its reply (its own follow-up work)
   * says nothing to the caller, who would otherwise see "working" with nothing coming.
   */
  onThinking(pickup = false): void {
    if (this.closed || (!pickup && !this.awaitingReply)) return;
    this.thinkingUntil = Math.max(this.thinkingUntil, this.now() + THINKING_HOLD_MS);
    this.refresh();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.statusTimer);
    this.wake();
  }

  /** Settles once every queued line was spoken or dropped; for tests. */
  async idle(): Promise<void> {
    let settled: Promise<void>;
    do {
      settled = this.speech;
      await this.sends;
      await settled;
    } while (settled !== this.speech);
  }

  private async sendTurn(text: string, onSent?: (result: SendResult) => void): Promise<void> {
    const result = await this.deps.send(text).catch((err: unknown): SendResult => {
      this.deps.log.warn('voice worker: sending a turn threw', { err });
      return { accepted: false, error: err instanceof Error ? err.message : String(err) };
    });
    onSent?.(result);
    if (this.closed) return;
    if (!result.accepted) return this.feedback(hostLossReason(result));
    this.awaitingReply = true;
    this.thinkingUntil = Math.max(this.thinkingUntil, this.now() + AWAIT_REPLY_MS);
    this.refresh();
  }

  private feedback(kind: FailureKind): void {
    if (this.closed || this.feedbackQueued) return;
    this.feedbackQueued = true;
    this.enqueue(async () => {
      this.feedbackQueued = false;
      this.announce({ notice: true });
      const line = kind === 'timeout' && !this.inChat ? 'timeout_no_chat' : kind;
      await this.say(FAILURE_LINES[line][this.options.language]);
    });
  }

  private async say(text: string): Promise<boolean> {
    try {
      const spoken = await this.deps.say(text);
      if (spoken) this.spokeSinceIdle = true;
      return spoken;
    } finally {
      this.speakingLine = undefined;
    }
  }

  /** Labels the next line; returns its number. */
  private announce(info: Omit<CallReplyInfo, 'reply' | 'more'>): number {
    const reply = ++this.replies;
    this.speakingLine = { reply, ...info, ...(this.queued > 1 ? { more: true } : {}) };
    this.deps.announce?.(this.speakingLine);
    return reply;
  }

  private enqueue(job: () => Promise<void>): void {
    // A line queued while another plays: that one's label says another follows after all, so the
    // page holds "speaking" across the gap while this one is synthesized.
    const playing = this.speakingLine;
    if (playing && !playing.more) {
      this.speakingLine = { ...playing, more: true };
      this.deps.announce?.(this.speakingLine);
    }
    this.queued++;
    this.speech = this.speech
      .then(async () => {
        await this.callerIdle();
        if (this.closed) return;
        this.deps.beforeSpeak?.();
        await job();
      })
      .catch((err: unknown) => this.deps.log.warn('voice worker: speaking failed', { err }))
      .finally(() => {
        if (--this.queued > 0 || this.closed) return;
        const spoken = this.spokeSinceIdle;
        this.spokeSinceIdle = false;
        this.deps.spokenAll?.(spoken);
      });
  }

  /** Resolves when the caller is neither talking nor about to have a turn committed, or after a cap. */
  private async callerIdle(): Promise<void> {
    const deadline = this.now() + this.options.silenceMs + MAX_IDLE_WAIT_MS;
    while (!this.closed) {
      const t = this.now();
      const busy = this.callerSpeaking || this.holds.size > 0;
      if (!busy && t >= this.turnOpenUntil) return;
      if (t >= deadline) {
        this.deps.log.info('voice worker: the caller is still talking; the reply takes the channel');
        return;
      }
      const until = busy ? deadline : Math.min(deadline, this.turnOpenUntil);
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.wakers.delete(done);
          resolve();
        };
        const timer = setTimeout(done, until - t);
        this.wakers.add(done);
      });
    }
  }

  private wake(): void {
    for (const wake of [...this.wakers]) wake();
  }

  /** A turn the host took still awaits its reply: the agent's typing means it works on it. */
  expectReply(): void {
    this.awaitingReply = true;
  }

  /**
   * The reply's line ended (heard or not): it no longer holds "working". While it plays the page shows
   * the agent speaking anyway, so the hold spans the gap before its audio, whichever signal comes first.
   */
  replyHeard(): void {
    if (!this.replyComing) return;
    this.replyComing = false;
    this.refresh();
  }

  private refresh(): void {
    if (this.closed) return;
    const t = this.now();
    const next = t < this.thinkingUntil || this.replyComing;
    clearTimeout(this.statusTimer);
    // Only the hold expires on its own; a reply still coming lets go through replyHeard.
    if (t < this.thinkingUntil) {
      this.statusTimer = setTimeout(() => this.refresh(), this.thinkingUntil - t + 1);
      this.statusTimer.unref?.();
    }
    if (next !== this.thinking) {
      this.thinking = next;
      this.deps.setThinking(next);
    }
  }
}

/** Why the host did not take a turn, as the page's turn status says it. */
export function hostLossReason(result: SendResult): 'rate_limited' | 'rejected' | 'timeout' {
  if (result.status === 429) return 'rate_limited';
  // 504: the host could not get the turn into the agent's session in time.
  return result.status !== undefined && result.status !== 504 ? 'rejected' : 'timeout';
}

/**
 * The call's sound cues, played by the worker on its own track (CALL_CUE_TRACK): `listening` once the
 * call is ready (and when a review recording opens), `wake` on the wake phrase, `sent` as a turn goes
 * out, `discard` on a spoken discard, `turn` once the agent is done and nothing else is queued, `nope`
 * for a command with nothing to act on, `draft` when a review draft is ready to read, `sleep` when a
 * turn the wake phrase opened heard nothing for too long and waits for the phrase again. Nothing
 * plays while the agent works or speaks.
 */
export type CueKind = 'listening' | 'wake' | 'sent' | 'discard' | 'turn' | 'nope' | 'draft' | 'sleep';

/** A cue note's amplitude (of full scale): a sine about 6 dB under the agent's speech on the wire. */
const CUE_LEVEL = 0.15;
/**
 * Each cue's notes as [Hz, start s, length s], and their level (of full scale). Every note holds
 * its level, so a cue is 150-250 ms of tone that a phone speaker carries, about 6 dB under speech.
 */
const CUES: Record<CueKind, { notes: ReadonlyArray<readonly [hz: number, at: number, len: number]>; level: number }> = {
  // A rising fifth: the line is open.
  listening: {
    notes: [
      [784, 0, 0.11],
      [1175, 0.11, 0.13],
    ],
    level: CUE_LEVEL,
  },
  // Higher and quicker than listening: heard, go on.
  wake: {
    notes: [
      [1175, 0, 0.08],
      [1568, 0.08, 0.11],
    ],
    level: CUE_LEVEL,
  },
  // One high note: the turn is on its way.
  sent: { notes: [[1760, 0, 0.15]], level: CUE_LEVEL },
  // A falling fifth, lower than the rest: dropped.
  discard: {
    notes: [
      [784, 0, 0.09],
      [523, 0.09, 0.14],
    ],
    level: CUE_LEVEL,
  },
  // A falling third, like a doorbell: over to the caller.
  turn: {
    notes: [
      [1319, 0, 0.1],
      [1047, 0.1, 0.14],
    ],
    level: CUE_LEVEL,
  },
  // One low note: nothing to do.
  nope: { notes: [[370, 0, 0.18]], level: CUE_LEVEL },
  // Two soft low notes, quieter than the rest: words to read, nothing sent.
  draft: {
    notes: [
      [523, 0, 0.1],
      [659, 0.1, 0.12],
    ],
    level: CUE_LEVEL * 0.7,
  },
  // A soft falling fourth, quietest of all: nothing more was said, back to waiting.
  sleep: {
    notes: [
      [659, 0, 0.1],
      [494, 0.1, 0.14],
    ],
    level: CUE_LEVEL * 0.6,
  },
};
/** The cue track's audio: 48 kHz mono in 20 ms frames. */
const CUE_SAMPLE_RATE = 48_000;
const CUE_FRAME_MS = 20;
const CUE_FRAME = (CUE_SAMPLE_RATE * CUE_FRAME_MS) / 1000;
/** The source's queue: a cue's latency, and how long an event-loop stall it rides out. */
const CUE_QUEUE_MS = 80;
const cueAudio = new Map<CueKind, AudioFrame[]>();

/**
 * A cue as 48 kHz mono frames: each note rises in 6 ms, holds its level and falls in 30 ms (no
 * clicks, and no decay that leaves only a click audible). Notes under 600 Hz get their octave too,
 * which a phone speaker plays where it cannot play the note.
 */
export function cueFrames(kind: CueKind): AudioFrame[] {
  const cached = cueAudio.get(kind);
  if (cached) return cached;
  const { notes, level } = CUES[kind];
  const end = Math.max(...notes.map(([, at, len]) => at + len));
  const frames = Math.ceil((end * CUE_SAMPLE_RATE) / CUE_FRAME);
  const pcm = new Float32Array(frames * CUE_FRAME);
  const attack = 0.006 * CUE_SAMPLE_RATE;
  const release = 0.03 * CUE_SAMPLE_RATE;
  for (const [hz, at, len] of notes) {
    const from = Math.round(at * CUE_SAMPLE_RATE);
    const count = Math.round(len * CUE_SAMPLE_RATE);
    const octave = hz < 600 ? 0.35 : 0;
    for (let i = 0; i < count; i++) {
      const rise = Math.min(1, i / attack);
      const fall = Math.min(1, (count - i) / release);
      // Raised-cosine edges.
      const gain = level * (0.5 - 0.5 * Math.cos(Math.PI * Math.min(rise, fall)));
      const t = i / CUE_SAMPLE_RATE;
      const wave = Math.sin(2 * Math.PI * hz * t) + octave * Math.sin(4 * Math.PI * hz * t);
      pcm[from + i] += (gain * wave) / (1 + octave);
    }
  }
  const out: AudioFrame[] = [];
  for (let f = 0; f < frames; f++) {
    const block = new Int16Array(CUE_FRAME);
    for (let i = 0; i < CUE_FRAME; i++) {
      block[i] = Math.round(Math.max(-1, Math.min(1, pcm[f * CUE_FRAME + i])) * 32767);
    }
    out.push(new AudioFrame(block, CUE_SAMPLE_RATE, 1, CUE_FRAME));
  }
  cueAudio.set(kind, out);
  return out;
}

/** A few frames of faint noise (about -84 dBFS): never digital silence, which an encoder may stop sending. */
const NOISE_FLOOR: AudioFrame[] = Array.from({ length: 8 }, () => {
  const block = new Int16Array(CUE_FRAME);
  for (let i = 0; i < CUE_FRAME; i++) block[i] = Math.round((Math.random() - 0.5) * 4);
  return new AudioFrame(block, CUE_SAMPLE_RATE, 1, CUE_FRAME);
});

/** Where the cue track's frames go: the room's audio source, or a test's. */
export interface CueSink {
  captureFrame(frame: AudioFrame): Promise<void>;
}

/**
 * The cue track's feed: one frame at a time into a short source queue, a cue's frames when one is
 * queued and the noise floor otherwise, so a cue starts at most a queue's length (CUE_QUEUE_MS)
 * after it is asked for. agents-js's BackgroundAudioPlayer buffered 400 ms and decayed into
 * digital silence.
 */
export class CueFeed {
  private readonly cues: Array<{ frames: AudioFrame[]; done: () => void }> = [];
  private stopped = false;
  private noise = 0;
  readonly running: Promise<void>;

  constructor(
    private readonly sink: CueSink,
    onError: (err: unknown) => void = () => undefined,
  ) {
    // A source that fails ends the feed; the cues asked for resolve, so nothing waits on them.
    this.running = this.run().catch((err: unknown) => {
      this.stop();
      onError(err);
    });
  }

  /** Resolves once the sink took the cue's last frame. */
  play(frames: AudioFrame[]): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((done) => this.cues.push({ frames: [...frames], done }));
  }

  stop(): void {
    this.stopped = true;
    for (const cue of this.cues.splice(0)) cue.done();
  }

  private async run(): Promise<void> {
    // The source paces the feed by holding a capture while its queue is full; this clock keeps the
    // feed to real time as well, so a source that does not hold can never make it spin.
    let clock = performance.now();
    while (!this.stopped) {
      const cue = this.cues[0];
      const frame = cue?.frames.shift() ?? NOISE_FLOOR[this.noise++ % NOISE_FLOOR.length];
      await this.sink.captureFrame(frame);
      if (cue && cue.frames.length === 0) {
        this.cues.shift();
        cue.done();
      }
      const now = performance.now();
      // Behind after a stall: no burst to catch up, the source queue rides it out.
      clock = Math.max(clock, now - CUE_QUEUE_MS) + CUE_FRAME_MS;
      if (clock - now > CUE_QUEUE_MS) await pause(clock - now - CUE_QUEUE_MS);
    }
  }
}

/**
 * Publish the cue track (CALL_CUE_TRACK) on its own source. DTX off: the track never goes quiet on
 * the wire, so the first milliseconds of a cue are never spent waking it up.
 */
async function publishCueTrack(room: Room, log: WorkerLog): Promise<{ feed: CueFeed; close(): Promise<void> }> {
  const source = new AudioSource(CUE_SAMPLE_RATE, 1, CUE_QUEUE_MS);
  const track = LocalAudioTrack.createAudioTrack(CALL_CUE_TRACK, source);
  const local = room.localParticipant;
  if (!local) throw new Error('no local participant');
  const publication = await local.publishTrack(track, new TrackPublishOptions({ dtx: false }));
  const feed = new CueFeed(source, (err) => log.warn('voice worker: the cue track stopped', { err }));
  return {
    feed,
    async close() {
      feed.stop();
      await feed.running;
      if (publication.sid) await local.unpublishTrack(publication.sid).catch(() => undefined);
      await track.close().catch(() => undefined);
      await source.close().catch(() => undefined);
    },
  };
}

/** Cyrillic letters as Latin sounds, so a name matches in either script (`Енді` and `Andy`). */
const CYRILLIC_LATIN: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'h',
  ґ: 'g',
  д: 'd',
  е: 'e',
  є: 'ye',
  ё: 'yo',
  ж: 'zh',
  з: 'z',
  и: 'y',
  і: 'i',
  ї: 'yi',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ь: '',
  ъ: '',
  ы: 'y',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/** A spoken word, normalised: lower case, Latin letters without accents, `kh` as `h`. */
function spokenWord(raw: string): string {
  const lower = raw.normalize('NFKC').toLowerCase();
  let out = '';
  for (const ch of lower) out += CYRILLIC_LATIN[ch] ?? ch;
  return out.normalize('NFD').replace(/\p{M}/gu, '').replace(/kh/g, 'h');
}

/** The words of a transcript with where each sits in it, and whether it was written in Cyrillic; punctuation is not a word. */
function spokenWords(text: string): Array<{ word: string; start: number; end: number; cyrillic: boolean }> {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
    word: spokenWord(m[0]),
    start: m.index,
    end: m.index + m[0].length,
    cyrillic: /\p{Script=Cyrillic}/u.test(m[0]),
  }));
}

/** Vowels as one mark and doubled letters as one: `Andy`, `Endy` and `Енді` sound alike, `and` and `Andy` do not. */
const nameSkeleton = (word: string): string => word.replace(/[aeiouy]/g, '*').replace(/([^*])\1+/g, '$1');

/** `hey` or `hi`, as the transcription writes it in either script (`гей`, `хей`, `эй`, `хай`). */
const WAKE_WORDS = new Set(['hey', 'hei', 'hej', 'ey', 'ei', 'hi', 'hai', 'hay']);
/** Leads a transcription glues to the name (`Heyben`); not `hi`, or `hidden` would be `hi Den`. */
const GLUED_WAKE_WORDS = ['hey', 'hei', 'hai'];

/**
 * Whether a said word is the name's word: the same, or the same skeleton, and in Cyrillic also
 * without a Ukrainian vocative ending (`Бене`, `Семе` for Ben, Sam).
 */
function sameNameWord(said: { word: string; cyrillic: boolean }, name: { word: string; skeleton?: string }): boolean {
  const { word } = said;
  if (word === name.word) return true;
  if (!name.skeleton) return false;
  if (nameSkeleton(word) === name.skeleton) return true;
  return said.cyrillic && word.length >= 4 && /[eu]$/.test(word) && nameSkeleton(word.slice(0, -1)) === name.skeleton;
}

/** A name's spoken words, each with its skeleton; a word shorter than 3 letters has none ("Al" is not "all"). */
export type WakeName = Array<{ word: string; skeleton?: string }>;

/** The names `hey <agent>` takes, as their spoken words. */
export function wakeNameWords(names: readonly string[]): WakeName[] {
  return names
    .map((name) =>
      spokenWords(name).map(({ word }) => ({ word, ...(word.length >= 3 ? { skeleton: nameSkeleton(word) } : {}) })),
    )
    .filter((words) => words.length > 0);
}

/** Where the first `hey <agent>` in a final transcript starts (its `hey`) and ends, or null; `Heyben` counts too. */
export function matchWake(text: string, names: readonly WakeName[]): { start: number; end: number } | null {
  const words = spokenWords(text);
  for (let i = 0; i < words.length; i++) {
    const { word } = words[i];
    const after = words.slice(i + 1);
    // The words that may be the name: those after a `hey`, or the rest of a word glued to one.
    const starts: Array<typeof words> = WAKE_WORDS.has(word) ? [after] : [];
    for (const lead of GLUED_WAKE_WORDS) {
      if (word.length > lead.length + 1 && word.startsWith(lead)) {
        starts.push([{ ...words[i], word: word.slice(lead.length) }, ...after]);
      }
    }
    for (const said of starts) {
      for (const name of names) {
        if (said.length < name.length) continue;
        if (name.every((part, j) => sameNameWord(said[j], part))) {
          return { start: words[i].start, end: said[name.length - 1].end };
        }
      }
    }
  }
  return null;
}

export type SpokenCommand = 'send' | 'discard';
/**
 * The commands, longest first, as the words that end an utterance (Cyrillic already read as Latin:
 * `сенд іт` is `send it`). `send it` as the transcription hears it from a Ukrainian speaker
 * (`сендіт`, `сендит`, `сендип`, `sent it`, `send eat`, or cut to a final `send`), and the Ukrainian `прийом`.
 */
const COMMANDS: ReadonlyArray<readonly [SpokenCommand, readonly string[]]> = [
  ['discard', ['discard', 'this', 'turn']],
  ['discard', ['discard', 'turn']],
  ['discard', ['scratch', 'that']],
  ['send', ['send', 'it']],
  ['send', ['sent', 'it']],
  ['send', ['send', 'eat']],
  ['send', ['sendit']],
  ['send', ['sendyt']],
  ['send', ['sendyp']],
  ['send', ['sendip']],
  ['send', ['send']],
  ['send', ['pryyom']],
];

/**
 * The command a final transcript ends with, and what was said before it, or null. Only the end
 * counts: `send it to Anna` is words, while a sentence that really ends in `send it` sends; one
 * that ends in it as a question (`Send it or not send it?`) is words too.
 */
export function matchCommand(text: string): { command: SpokenCommand; rest: string } | null {
  const words = spokenWords(text);
  for (const [command, phrase] of COMMANDS) {
    if (words.length < phrase.length) continue;
    const tail = words.slice(words.length - phrase.length);
    if (!tail.every((w, i) => w.word === phrase[i])) continue;
    if (text.slice(tail[tail.length - 1].end).includes('?')) return null;
    return {
      command,
      rest: text
        .slice(0, tail[0].start)
        .replace(/[\s,;:–—-]+$/u, '')
        .trim(),
    };
  }
  return null;
}

/** How long an open turn waits for speech before it goes back to waiting for the wake phrase; 0 never. */
export interface AwakeLimits {
  /** After the wake phrase, with nothing said since. */
  startMs: number;
  /** After the caller's last speech, with words held. */
  idleMs: number;
}
const DEFAULT_AWAKE_LIMITS: AwakeLimits = { startMs: 8_000, idleMs: 20_000 };

/**
 * VOICE_WAKE_START_SECONDS (8) and VOICE_WAKE_IDLE_SECONDS (20): how long a turn the wake phrase
 * opened waits for speech, first and then after the last words, before it goes back to waiting; 0 never.
 */
export function awakeLimits(env: Record<string, string | undefined>): AwakeLimits {
  const seconds = (raw: string | undefined, fallback: number) => {
    const n = Number(raw?.trim() || NaN);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : fallback;
  };
  return {
    startMs: seconds(env.VOICE_WAKE_START_SECONDS, DEFAULT_AWAKE_LIMITS.startMs),
    idleMs: seconds(env.VOICE_WAKE_IDLE_SECONDS, DEFAULT_AWAKE_LIMITS.idleMs),
  };
}

/** What CallTurns needs of the transcription (GeminiLiveTranscriber; faked in tests). */
export interface Transcription {
  /** Set a socket up ahead of the next activity; resolves whether it is ready. */
  prepare(): Promise<boolean>;
  /** Open an activity, starting with `preRoll`. */
  begin(preRoll: Int16Array): void;
  /** Audio for the open activity. */
  push(pcm: Int16Array): void;
  /** Close the open activity; resolves with what it heard. */
  end(): Promise<Heard>;
  close(): void;
}

const wordCount = (text: string): number => (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
/** A final this short may be only the turn's last phrase: a manual activity's final can collapse to it after a pause. */
const COLLAPSED_FINAL_WORDS = 3;

/** Where a turn's text came from, logged with every turn. */
export type TextSource = 'final' | 'collapse_interim' | 'no_final_interim' | 'none';

/**
 * A turn's text: the final transcript, unless it collapsed (COLLAPSED_FINAL_WORDS or fewer while
 * the last interim text of the activity had more) or never came, then the last interim text.
 */
export function turnText(heard: Pick<Heard, 'final' | 'interim'>): { text: string; source: TextSource } {
  const final = heard.final?.trim() ?? '';
  const interim = heard.interim.trim();
  if (!final) return interim ? { text: interim, source: 'no_final_interim' } : { text: '', source: 'none' };
  const finalWords = wordCount(final);
  if (finalWords <= COLLAPSED_FINAL_WORDS && wordCount(interim) > finalWords) {
    return { text: interim, source: 'collapse_interim' };
  }
  return { text: final, source: 'final' };
}

/** A word's sound, roughly: Latin letters, vowel runs as one mark, doubled letters as one (`проєктом` = `proektom`). */
const wordSound = (word: string): string =>
  spokenWord(word)
    .replace(/[aeiouy]+/g, '*')
    .replace(/([^*])\1+/g, '$1');

/**
 * Whether `final` ends where `rest` (the interim text before a command) does: its last two words
 * are among the last four of `rest`, by sound. The final can leave a trailing command out (seen
 * with `прийом`, and with a command said in another voice or language); then the interim text's
 * command stands.
 */
export function endsLike(final: string, rest: string): boolean {
  const said = (final.match(/[\p{L}\p{N}]+/gu) ?? []).slice(-2).map(wordSound);
  const before = new Set((rest.match(/[\p{L}\p{N}]+/gu) ?? []).slice(-4).map(wordSound));
  return said.length === 2 && said.every((w) => before.has(w));
}

const joinText = (...parts: string[]): string =>
  parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' ');

/** Text without the punctuation and spaces a cut left at its edges. */
const trimCut = (text: string): string => text.replace(/^[\s,.;:!?–—-]+|[\s,;:–—-]+$/gu, '');

/** A command acts once this many interims in a row ended with it, and the caller is silent. */
const STABLE_COMMAND_INTERIMS = 2;

/** Why a turn's activity ended. */
type TurnEnd = 'pause' | 'send' | 'discard' | 'agent' | 'asleep' | 'unaddressed' | 'switch' | 'review' | 'dropped';

interface OpenTurn {
  kind: 'auto' | 'review';
  /** Its caption line on the page. */
  segment: number;
  /** For the agent: hands-free, past the wake phrase, or a review recording. */
  addressed: boolean;
  /** Waits for `hey <agent>` in its own transcript; the turn is the words after it. */
  textWake: boolean;
  /** Text of an earlier activity of this turn (a command that turned out to be words). */
  carry: string;
  /** The activity's whole text so far. */
  heard: string;
  /** The command the last interims ended with, and in how many in a row. */
  candidate?: { command: SpokenCommand; count: number };
  speechMs: number;
  /** Stream position of its last speech end, for the recording's trim. */
  lastSpeechEnd: number;
  /** Where its audio starts in the stream. */
  from: number;
  /**
   * Set while it finalizes: the caller spoke again after its command, so the next activity carries its
   * text (`handOff`, which that activity awaits as `before`), or a switch to review took it (its draft).
   */
  handOff?: (said: string) => void;
  before?: Promise<string>;
  switched?: (recording: Recording) => void;
}

export interface CallTurnsDeps {
  transcriber: Transcription;
  /** A finished auto turn to the host. */
  send(text: string, take: TurnTake): void;
  /** Speech that came to no text: the transcription failed (`stt`) or heard no words (`empty`). */
  lost(reason: 'stt' | 'empty', fields: Record<string, unknown>, take: TurnTake): void;
  /** Speech too short to be a turn, with nothing transcribed (a cough, a noise). */
  noise(take: TurnTake): void;
  /** Words that will never be sent, for the page's captions. */
  drop(reason: CallDroppedSpeech['dropped'], text: string): void;
  cue(kind: CueKind): void;
  /** The caller's caption for one turn. */
  caption(segment: number, text: string, final: boolean): void;
  /** The page's send countdown: the speech ended at `at` (wall clock), or it is cleared. */
  countdown: { stopped(at: number): void; clear(): void };
  /** The wake state changed. */
  changed(): void;
  /** An auto turn for the agent is open (true) or over: replies wait for it. */
  hold(open: boolean): void;
  /** The caller's speech came to no turn: a reply need not wait for one. */
  noTurn(): void;
  /** The caller spoke while the agent's line played. */
  unheard(): void;
  log: Pick<Console, 'info' | 'warn'>;
}

export interface CallTurnsOptions {
  silenceMs: number;
  /** The names `hey <agent>` takes: the agent's and its wake names. */
  names: readonly string[];
  limits?: AwakeLimits;
  /** Record turns (TurnTake.audio). */
  record?: boolean;
  sttModel: string;
  now?: () => number;
}

/** A finished review recording. */
export interface Recording {
  text: string;
  /** The transcription failed and nothing was heard. */
  failed: boolean;
  take: TurnTake;
}

/**
 * The call's turns: one state machine over the caller's audio, the VAD, the wake word and the
 * transcription, for every mode. A turn is one transcription activity, so its text is transcribed
 * as one piece however long its pauses (under the closing silence) run.
 *
 * Auto mode, hands-free: the caller's speech opens a turn (with a pre-roll from just before it) and
 * the closing silence (`silenceMs` from the end of their speech, with the page's countdown) sends
 * it; speech before then keeps the same turn going. With the wake switch on nothing is transcribed
 * until the wake word spotter hears the phrase; the turn opens right after it (where the wake cue
 * plays), and only a spoken send sends it (or the pause too, with
 * `pauseSends`); it goes back to waiting with no speech for a while (AwakeLimits). Without a
 * spotter the transcript's `hey <agent>` opens it instead.
 *
 * Spoken commands are nominated by the interim text: `send it` (or `прийом`) or a discard phrase at
 * its end in STABLE_COMMAND_INTERIMS interims in a row, with the caller silent, ends the activity,
 * and the final text decides (turnText): a command it still ends with acts, one it does not was
 * words, and the turn goes on in a new activity carrying the text so far. A pause or sleep that
 * ends a turn applies a command its text ends with the same way.
 *
 * Review mode (manual): `record` opens a turn, `stopRecording` closes it into a draft, and the auto
 * rules stand aside. Speech while the agent's line is due or plays is noted (`unheard`), never transcribed.
 */
export class CallTurns {
  /** On until the page's settings say otherwise: a first call never sends before its wake phrase. */
  private wake = true;
  private pauseSends = false;
  /** The acoustic wake word's phrase: when set, it opens the turn and the transcript's `hey <agent>` does not. */
  private wakeWord?: string;
  /** The phrase of a wake word whose model still loads: the page names it from the start. */
  private loadingPhrase?: string;
  private reviewing = false;
  private turn?: OpenTurn;
  /** An auto turn finalizing after a command: speech now continues it. */
  /** An auto turn for the agent whose activity ended and whose text is not acted on yet; `command`: a spoken one ended it. */
  private finalizing?: { turn: OpenTurn; endedAt: number; command: boolean };
  /** What `hold` last said. */
  private holding = false;
  private speaking = false;
  private speechFrom = 0;
  private agentSpeaking = false;
  /** Detections from windows that ended before this position are stale: the wait they belonged to is over. */
  private waitingSince = 0;
  private readonly ring = new AudioRing();
  private readonly capture?: TurnCapture;
  private segments = 0;
  private wakes = 0;
  private slept = 0;
  /** The last wake was the acoustic one: the turn started after the phrase, so no caption of it has the phrase. */
  private cut = false;
  private pauseTimer?: ReturnType<typeof setTimeout>;
  private awakeTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly names: WakeName[];
  private readonly limits: AwakeLimits;
  private readonly now: () => number;

  constructor(
    private readonly deps: CallTurnsDeps,
    private readonly options: CallTurnsOptions,
  ) {
    this.names = wakeNameWords(options.names);
    this.limits = options.limits ?? DEFAULT_AWAKE_LIMITS;
    this.now = options.now ?? (() => Date.now());
    if (options.record) this.capture = new TurnCapture(this.now);
  }

  get state(): CallWakeState {
    const phrase = this.wakeWord ?? this.loadingPhrase;
    return {
      on: this.wake,
      pauseSends: this.pauseSends,
      waiting: this.waiting,
      ...(phrase ? { phrase } : {}),
      ...(this.wakes ? { heard: this.wakes } : {}),
      ...(this.slept ? { slept: this.slept } : {}),
      ...(this.cut ? { cut: true } : {}),
    };
  }

  /** Nothing is kept until the wake phrase. */
  get waiting(): boolean {
    return this.wake && !this.turnOpen;
  }

  /** Waiting for an acoustic wake word: the audio is worth scoring. */
  get spotting(): boolean {
    return this.waiting && !!this.wakeWord && !this.reviewing && !this.turn && !this.agentSpeaking;
  }

  /** The closing silence sends an open turn (the page's countdown). */
  get pausesSend(): boolean {
    return !this.reviewing && (!this.wake || this.pauseSends);
  }

  /** The caller's audio taken so far: 16 kHz samples since the call's first frame. */
  get position(): number {
    return this.ring.position;
  }

  /** An auto turn for the agent is open or still finalizing: a switch to review makes it a draft. */
  get turnOpen(): boolean {
    return (this.turn?.kind === 'auto' && this.turn.addressed) || !!this.finalizing;
  }

  /** A wake word model loads for this phrase (`useWakeWord` once it is in use, or with none if it fails). */
  loadWakeWord(phrase: string): void {
    this.loadingPhrase = phrase;
    this.deps.changed();
  }

  /** The acoustic wake word is in use (its phrase), or not, and `hey <agent>` in the transcript opens the turn. */
  useWakeWord(phrase: string | undefined): void {
    this.loadingPhrase = undefined;
    this.wakeWord = phrase;
    this.waitingSince = this.ring.position;
    this.deps.changed();
  }

  configure(wake: boolean, pauseSends: boolean): void {
    if (wake === this.wake && pauseSends === this.pauseSends) return;
    const turn = this.turn;
    if (wake !== this.wake && turn?.kind === 'auto') {
      // Switched on, the open words were never addressed; switched off, words before a wake phrase never were.
      if (wake || !turn.addressed) void this.finish('unaddressed');
    }
    this.wake = wake;
    this.pauseSends = pauseSends;
    this.cut = false;
    this.waitingSince = this.ring.position;
    if (this.turn && !this.speaking) this.armPause();
    this.arm();
    this.deps.changed();
  }

  /** The caller's audio, every frame: kept for pre-rolls, and the open turn's while no agent line is due. */
  audio(pcm: Int16Array): void {
    // Speech under the agent's line is not transcribed: the ring and the turn hear silence instead.
    const heard = this.agentSpeaking ? new Int16Array(pcm.length) : pcm;
    this.ring.push(heard);
    if (!this.turn) return;
    this.deps.transcriber.push(heard);
    this.capture?.push(heard);
  }

  /** The VAD: speech started or ended at stream position `at`. */
  onSpeech(speaking: boolean, at: number): void {
    if (this.closed || speaking === this.speaking) return;
    this.speaking = speaking;
    if (speaking) {
      this.speechFrom = at;
      clearTimeout(this.pauseTimer);
      this.deps.countdown.clear();
      this.disarm();
      if (this.agentSpeaking) return this.deps.unheard();
      if (this.turn?.candidate) this.turn.candidate = undefined;
      if (this.turn || this.reviewing) return;
      const finalizing = this.finalizing;
      if (finalizing?.command) {
        // The caller went on after a command: it was words, and this speech continues the turn. The
        // new activity waits for the earlier one's text before it acts, so the words stay in order.
        this.finalizing = undefined;
        const before = new Promise<string>((resolve) => (finalizing.turn.handOff = resolve));
        this.open('auto', Math.max(finalizing.endedAt, at - samplesOf(PRE_ROLL_MS)), true);
        const successor = this.turn as OpenTurn | undefined;
        if (successor) successor.before = before;
        return;
      }
      if (!this.wake || !this.wakeWord) this.open('auto', at - samplesOf(PRE_ROLL_MS), !this.wake);
      return;
    }
    const turn = this.turn;
    if (!turn || this.agentSpeaking) return;
    turn.speechMs += msOf(Math.max(0, at - Math.max(this.speechFrom, turn.from)));
    turn.lastSpeechEnd = at;
    if (turn.kind !== 'auto') return;
    if (this.command()) return;
    this.armPause();
    this.arm();
  }

  /**
   * The acoustic wake word: the window scored up to stream position `at` had the phrase. The turn
   * opens right there, where the wake cue plays: the model is end-aligned and spots the phrase as it
   * ends, so the turn's audio, and its text, start after it.
   */
  onWake(at: number): void {
    if (this.closed || !this.spotting) return;
    if (at <= this.waitingSince) {
      this.deps.log.info('voice worker: a wake word from an earlier wait is ignored');
      return;
    }
    if (at < this.ring.position - samplesOf(RING_MS)) {
      this.deps.log.warn('voice worker: the wake word window is older than the kept audio; no turn opens');
      return;
    }
    this.open('auto', at, true);
    this.cut = true;
    this.woke();
  }

  /** The open turn's whole text so far (the transcription's interim text). */
  onInterim(text: string): void {
    const turn = this.turn;
    if (!turn) return;
    turn.heard = text;
    this.deps.caption(turn.segment, joinText(turn.carry, text), false);
    if (turn.kind !== 'auto') return;
    if (!turn.addressed) {
      const found = matchWake(text, this.names);
      if (!found) return;
      const before = trimCut(text.slice(0, found.start));
      if (before) this.deps.drop('unaddressed', before);
      turn.addressed = true;
      this.cut = false;
      this.woke();
      if (!this.speaking) this.armPause();
    }
    const match = matchCommand(this.spoken(turn, text));
    if (!match) turn.candidate = undefined;
    else if (turn.candidate?.command === match.command) turn.candidate.count++;
    else turn.candidate = { command: match.command, count: 1 };
    this.command();
    this.arm();
  }

  /** An agent line is due (true, from before its speech is made) or done: the caller is not transcribed meanwhile. */
  onAgentSpeaking(speaking: boolean): void {
    if (speaking === this.agentSpeaking) return;
    this.agentSpeaking = speaking;
    if (!speaking) {
      this.waitingSince = this.ring.position;
      if (this.turn && !this.speaking) this.armPause();
      return this.arm();
    }
    this.deps.countdown.clear();
    clearTimeout(this.pauseTimer);
    this.disarm();
    const turn = this.turn;
    if (turn) turn.candidate = undefined;
    // A reply that waited its longest takes the channel: an open turn goes out as it is, while the
    // closing silence would have sent it; one only a spoken send sends stays open, hearing silence.
    if (turn?.kind === 'auto' && (!turn.addressed || this.pausesSend))
      void this.finish(turn.addressed ? 'agent' : 'unaddressed');
  }

  /** Review mode on or off. Going on, an auto turn for the agent becomes its draft: its recording, or null. */
  async setReviewing(on: boolean): Promise<Recording | null> {
    if (on === this.reviewing) return null;
    this.reviewing = on;
    this.waitingSince = this.ring.position;
    if (!on) return null;
    this.deps.countdown.clear();
    clearTimeout(this.pauseTimer);
    this.disarm();
    // The words not acted on yet, in order: a turn still finalizing, then the open one.
    const parts: Array<Promise<Recording | null>> = [];
    const finalizing = this.finalizing;
    if (finalizing) {
      this.finalizing = undefined;
      parts.push(new Promise((resolve) => (finalizing.turn.switched = resolve)));
    }
    const turn = this.turn;
    if (turn?.kind === 'auto' && !turn.addressed) void this.finish('unaddressed');
    else if (turn?.kind === 'auto') parts.push(this.finish('switch'));
    this.deps.changed();
    if (!parts.length) return null;
    const recordings = (await Promise.all(parts)).filter((r): r is Recording => !!r);
    if (!recordings.length) return null;
    return {
      text: joinText(...recordings.map((r) => r.text)),
      failed: recordings.every((r) => r.failed),
      take: recordings[0].take,
    };
  }

  /** Review: set the transcription up for a recording; resolves whether it can take one. */
  prepare(): Promise<boolean> {
    return this.deps.transcriber.prepare();
  }

  /** Review: open a recording from now. */
  record(): void {
    if (this.turn || this.closed) return;
    this.open('review', this.ring.position, true);
  }

  /** Review: close the recording and freeze its text. */
  stopRecording(): Promise<Recording | null> {
    return this.turn?.kind === 'review' ? this.finish('review') : Promise.resolve(null);
  }

  /** Review: drop the open recording, if any. */
  dropRecording(): void {
    if (this.turn?.kind === 'review') void this.finish('dropped');
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.pauseTimer);
    this.disarm();
    this.turn = undefined;
    this.finalizing = undefined;
  }

  /** Replies wait while an auto turn for the agent is open or finalizing. */
  private syncHold(): void {
    const open = this.turnOpen;
    if (open === this.holding) return;
    this.holding = open;
    this.deps.hold(open);
  }

  private open(kind: OpenTurn['kind'], from: number, addressed: boolean): void {
    const start = Math.max(0, from);
    const preRoll = this.ring.since(start);
    this.turn = {
      kind,
      segment: ++this.segments,
      addressed,
      textWake: kind === 'auto' && this.wake && !addressed,
      carry: '',
      heard: '',
      speechMs: 0,
      lastSpeechEnd: start,
      from: start,
    };
    this.deps.transcriber.begin(preRoll);
    this.capture?.start(preRoll);
    this.syncHold();
  }

  /** The wake phrase opened the turn. */
  private woke(): void {
    this.wakes++;
    this.syncHold();
    this.deps.cue('wake');
    this.deps.changed();
    this.arm();
  }

  /** A stable command at the end of what the caller said, once they are silent: the turn ends to confirm it. */
  private command(): boolean {
    const turn = this.turn;
    if (!turn || turn.kind !== 'auto' || !turn.addressed || this.speaking || this.agentSpeaking) return false;
    const candidate = turn.candidate;
    if (!candidate || candidate.count < STABLE_COMMAND_INTERIMS) return false;
    void this.finish(candidate.command);
    return true;
  }

  /** The turn's own words in `text`: after `hey <agent>` when the transcript opened it. */
  private spoken(turn: OpenTurn, text: string): string {
    if (turn.textWake) {
      const found = matchWake(text, this.names);
      return found ? trimCut(text.slice(found.end)) : text;
    }
    return text;
  }

  /** The closing silence after the caller's speech, counted from where it ended. */
  private armPause(): void {
    clearTimeout(this.pauseTimer);
    const turn = this.turn;
    if (!turn || turn.kind !== 'auto' || this.speaking || this.agentSpeaking) return;
    if (turn.addressed && !this.pausesSend) return;
    const sinceEnd = msOf(this.ring.position - Math.max(turn.lastSpeechEnd, turn.from));
    const left = Math.max(0, this.options.silenceMs - sinceEnd);
    if (turn.addressed) this.deps.countdown.stopped(this.now() - sinceEnd);
    this.pauseTimer = setTimeout(() => void this.finish(turn.addressed ? 'pause' : 'unaddressed'), left);
    this.pauseTimer.unref?.();
  }

  /**
   * While a turn the wake phrase opened is open and the caller silent, the clock to going back to
   * waiting runs: from the wake while nothing of the turn was said, from the last speech once words are held.
   */
  private arm(): void {
    this.disarm();
    const turn = this.turn;
    if (!this.wake || !turn || turn.kind !== 'auto' || !turn.addressed || this.speaking || this.agentSpeaking) return;
    const said = turn.carry || this.spoken(turn, turn.heard);
    const ms = said ? this.limits.idleMs : this.limits.startMs;
    if (!(ms > 0)) return;
    this.awakeTimer = setTimeout(() => void this.finish('asleep'), ms);
    this.awakeTimer.unref?.();
  }

  private disarm(): void {
    clearTimeout(this.awakeTimer);
    this.awakeTimer = undefined;
  }

  /** End the open turn's activity and act on what it heard. */
  private async finish(why: TurnEnd): Promise<Recording | null> {
    const turn = this.turn;
    if (!turn) return null;
    this.turn = undefined;
    clearTimeout(this.pauseTimer);
    this.disarm();
    this.deps.countdown.clear();
    const endedAt = this.ring.position;
    if (turn.kind === 'auto' && turn.addressed && why !== 'switch') {
      this.finalizing = { turn, endedAt, command: why === 'send' || why === 'discard' };
    }
    // The recording ends a pad after the last speech, not with the closing silence.
    const keep = turn.lastSpeechEnd - turn.from + samplesOf(RECORDING_PAD_MS);
    const take: TurnTake = {
      audio: this.capture?.take(turn.speechMs, Math.max(keep, 0)),
      sttModel: this.options.sttModel,
    };
    // A turn that went on after a command that was words, and heard nothing since, has no final to wait for.
    const silent = !!turn.carry && !turn.heard && turn.speechMs === 0;
    const ending = this.deps.transcriber.end();
    const heard = silent ? { interim: '', finals: 0, failed: false, finalizeMs: 0 } : await ending;
    // Words of an earlier activity of this turn, still finalizing when the caller went on, lead it.
    if (turn.before) turn.carry = joinText(await turn.before, turn.carry);
    if (this.finalizing?.turn === turn) this.finalizing = undefined;
    const chosen = turnText(heard);
    const said = joinText(turn.carry, chosen.text);
    this.deps.log.info('voice worker: turn text', {
      segment: turn.segment,
      why,
      source: chosen.source,
      finals: heard.finals,
      finalizeMs: heard.finalizeMs,
      ...(heard.failed ? { audioLost: true } : {}),
    });
    if (said) this.deps.caption(turn.segment, said, true);
    if (this.closed) return null;
    this.syncHold();
    const recording: Recording = { text: said, failed: heard.failed && !said, take };
    if (why === 'review' || why === 'switch') return recording;
    if (turn.switched) {
      turn.switched(recording);
      return null;
    }
    if (turn.handOff) {
      turn.handOff(said);
      return null;
    }
    if (why === 'dropped') return null;
    if (why === 'unaddressed') {
      if (said) this.deps.drop('unaddressed', said);
      this.deps.noTurn();
      return null;
    }
    const text = this.spoken(turn, said);
    let match = matchCommand(text);
    const nominated = turn.kind === 'auto' ? matchCommand(this.spoken(turn, turn.heard)) : null;
    // A final that ends in the command's words as a question asked it: the interim text cannot overrule that.
    const asked = !match && !!matchCommand(text.replace(/[?\s]+$/u, ''));
    if (!match && !asked && nominated && endsLike(text, nominated.rest)) {
      // The final left out the command the interim text ended with: the command stands, and the
      // final is the turn's text.
      match = { command: nominated.command, rest: trimCut(text) };
    }
    // A command the final does not end with was words: the turn goes on.
    if ((why === 'send' || why === 'discard') && match?.command !== why) {
      this.goOn(said, endedAt);
      return null;
    }
    if (match?.command === 'discard') {
      // A discard with nothing said takes a wake back; in hands-free it has nothing to act on.
      if (!match.rest && !this.wake) this.nope(text);
      else this.discarded(text);
      return null;
    }
    if (match?.command === 'send' && !match.rest) {
      this.nope(text);
      return null;
    }
    const body = match ? match.rest : text;
    if (why === 'asleep' && !match) {
      if (body) this.deps.drop('asleep', body);
      this.slept++;
      this.waitingSince = this.ring.position;
      this.deps.cue('sleep');
      this.deps.noTurn();
      this.deps.changed();
      return null;
    }
    if (this.wake) {
      this.waitingSince = this.ring.position;
      this.deps.changed();
    }
    if (body) {
      this.deps.send(body, take);
      return null;
    }
    this.deps.noTurn();
    const fields = { speechMs: Math.round(turn.speechMs) };
    if (heard.failed) this.deps.lost('stt', fields, take);
    else if (turn.speechMs < MIN_LOST_SPEECH_MS) this.deps.noise(take);
    else this.deps.lost('empty', fields, take);
    return null;
  }

  /** The turn goes on after a command that was words: the text so far leads its next activity. */
  private goOn(said: string, endedAt: number): void {
    const next = this.turn;
    if (next?.kind === 'auto') {
      // The caller already went on: that activity carries these words.
      next.carry = joinText(said, next.carry);
      this.deps.caption(next.segment, joinText(next.carry, next.heard), false);
      return;
    }
    if (next || this.reviewing) {
      if (said) this.deps.drop('unaddressed', said);
      return;
    }
    this.open('auto', endedAt, true);
    const reopened = this.turn as OpenTurn | undefined;
    if (!reopened) return;
    reopened.carry = said;
    this.deps.caption(reopened.segment, said, false);
    if (!this.speaking) this.armPause();
    this.arm();
  }

  private discarded(text: string): void {
    this.deps.drop('discarded', text);
    this.deps.cue('discard');
    this.deps.noTurn();
    if (this.wake) {
      this.waitingSince = this.ring.position;
      this.deps.changed();
    }
  }

  /** A command with nothing to act on. */
  private nope(text: string): void {
    this.deps.drop('command', text);
    this.deps.countdown.clear();
    this.deps.cue('nope');
    this.deps.noTurn();
    if (this.wake) this.deps.changed();
  }
}

/** What review mode needs of the call's turns (CallTurns) and the page. */
export interface ReviewVoice {
  /** An auto turn for the agent is open: a switch to review makes it a draft. */
  readonly turnOpen: boolean;
  /** Review on or off; going on, an open auto turn comes back as its recording. */
  setReviewing(on: boolean): Promise<Recording | null>;
  /** Set the transcription up for a recording; resolves whether it can take one. */
  prepare(): Promise<boolean>;
  /** Open a recording: from here the caller's audio is transcribed. */
  record(): void;
  /** Close the recording; resolves with its frozen text. */
  stopRecording(): Promise<Recording | null>;
  /** Drop the open recording. */
  dropRecording(): void;
  /** One message on the `nanoclaw.voice.review` topic. */
  publishReview(state: CallReviewState): void;
}

export interface ReviewDeps {
  voice: ReviewVoice;
  /** Hand a sent draft's text to the host the way a finished auto turn goes; returns its turn number. */
  post(text: string, draft: number, take: TurnTake): number;
  /** The newest turn number handed to the host. */
  lastPosted(): number;
  /** A review recording holds replies like a caller mid-turn (TurnTaking.setCaptureOpen). */
  setCaptureOpen(open: boolean): void;
  /** Entering review: the auto mode's open turn is not waited for any more (TurnTaking.resetCaller). */
  resetCaller(): void;
  /** The `settings` RPC: auto mode's wake switch and the sound cues. */
  configure?(req: ReviewRequest): void;
  /** Auto mode's wake state, sent with every review state. */
  wakeState?(): CallWakeState;
  cue?(kind: CueKind): void;
  /** The model a draft's take names when it has none. */
  sttModel: string;
  log: Pick<Console, 'info' | 'warn'>;
}

/**
 * Review mode on the worker: the caller's talk, done, send and discard, and switching between auto
 * and review mid-call. One operation runs at a time, each for the draft it names, so a late or
 * repeated one is refused as stale. Every change goes to the page as a `CallReviewState`.
 *
 * A recording is one transcription activity of the call's turns (CallTurns.record), set up before
 * talk answers so the caller never speaks into a socket still connecting: done ends it, and its text
 * (turnText: the final, or the last interim when the final collapsed or never came) freezes into the
 * draft within FINISH_TIMEOUT_MS. Commands in it are words; nothing posts until send.
 */
export class ReviewControl {
  private mode: TurnMode = 'auto';
  private draft: CallDraft | null = null;
  /** The frozen draft's recording, saved with its turn if it is sent. */
  private take?: TurnTake;
  private seq = 0;
  private drafts = 0;
  private ops: Promise<unknown> = Promise.resolve();
  private agentSpeaking = false;
  /** Talk waits for the transcription's setup: the page keeps talk off meanwhile. */
  private preparing = false;
  private closed = false;

  constructor(private readonly deps: ReviewDeps) {}

  get reviewing(): boolean {
    return this.mode === 'review';
  }

  /** One page operation, run after the ones before it. */
  handle(op: ReviewOp, req: ReviewRequest): Promise<ReviewReply> {
    const run = this.ops.then(() => this.run(op, req));
    this.ops = run.catch(() => undefined);
    return run;
  }

  onAgentSpeaking(speaking: boolean): void {
    this.agentSpeaking = speaking;
    if (speaking) this.beforeAgentSpeaks();
  }

  /** A reply takes the channel: a recording stops there and becomes a draft; it never resumes by itself. */
  beforeAgentSpeaks(): void {
    if (this.draft?.state === 'recording') this.finish(this.draft, 'agent');
  }

  close(): void {
    this.closed = true;
  }

  /** Something the state carries besides review changed (the wake state): the page hears it. */
  republish(): void {
    this.publish();
  }

  private async run(op: ReviewOp, req: ReviewRequest): Promise<ReviewReply> {
    const reply = (fields: Partial<ReviewReply> = {}): ReviewReply => ({
      gen: req.gen,
      ok: !fields.error,
      seq: this.seq,
      ...fields,
    });
    if (this.closed) return reply({ error: 'closed' });
    const draft = this.draft;
    const busy = draft
      ? draft.state === 'recording'
        ? 'recording'
        : draft.state === 'finishing'
          ? 'finishing'
          : 'draft_open'
      : undefined;
    switch (op) {
      case 'settings': {
        this.deps.configure?.(req);
        this.publish();
        return reply();
      }
      case 'mode': {
        if (req.mode === undefined || req.mode === this.mode) {
          // Nothing to change: the page re-reads the state, after a reconnect say.
          this.publish();
          return reply();
        }
        if (req.mode === 'auto') {
          if (busy) return reply({ error: busy });
          this.mode = 'auto';
          await this.deps.voice.setReviewing(false);
          this.publish();
          return reply();
        }
        return this.enterReview(req, reply);
      }
      case 'talk': {
        if (this.mode !== 'review') return reply({ error: 'not_review' });
        // An empty draft gives way to a new recording; any other one has to be sent or discarded.
        if (busy && draft?.state !== 'empty') return reply({ error: busy });
        if (this.agentSpeaking) return reply({ error: 'agent_speaking' });
        // The caller's microphone opens on this reply: the transcription is set up first.
        this.preparing = true;
        this.publish();
        const ready = await this.deps.voice.prepare();
        this.preparing = false;
        if (this.closed) return reply({ error: 'closed' });
        if (!ready) {
          this.deps.log.warn('voice worker: the transcription could not be set up for a recording');
          this.publish();
          return reply({ error: 'closed' });
        }
        if (this.agentSpeaking) {
          this.publish();
          return reply({ error: 'agent_speaking' });
        }
        this.take = undefined;
        this.draft = { id: ++this.drafts, state: 'recording', text: '' };
        this.deps.setCaptureOpen(true);
        this.deps.voice.record();
        this.publish();
        this.deps.cue?.('listening');
        return reply({ draft: this.draft.id });
      }
      case 'done': {
        if (!draft || draft.id !== req.draft) return reply({ error: 'stale' });
        // Already stopped (a reply took the channel): done asks for nothing more.
        if (draft.state === 'recording') this.finish(draft);
        return reply();
      }
      case 'send': {
        if (!draft || draft.id !== req.draft) return reply({ error: 'stale' });
        if (draft.state !== 'ready' || draft.tooLong) return reply({ error: 'unsendable' });
        const take = this.take ?? { sttModel: this.deps.sttModel };
        this.draft = null;
        this.take = undefined;
        const turn = this.deps.post(draft.text, draft.id, take);
        this.publish();
        return reply({ turn });
      }
      case 'discard': {
        if (!draft || draft.id !== req.draft) return reply({ error: 'stale' });
        this.draft = null;
        this.take = undefined;
        if (draft.state === 'recording') {
          this.deps.setCaptureOpen(false);
          this.deps.voice.dropRecording();
        }
        this.publish();
        return reply();
      }
    }
  }

  private async enterReview(
    req: ReviewRequest,
    reply: (fields?: Partial<ReviewReply>) => ReviewReply,
  ): Promise<ReviewReply> {
    const posted = this.deps.lastPosted();
    const submitted = typeof req.afterTurn === 'number' && posted > req.afterTurn ? posted : undefined;
    this.mode = 'review';
    this.deps.resetCaller();
    const open = this.deps.voice.turnOpen;
    const recording = this.deps.voice.setReviewing(true);
    if (open) {
      // The caller's unsent words become a draft; never sent by the switch itself.
      this.draft = { id: ++this.drafts, state: 'finishing', text: '', reason: 'switch' };
      this.publish();
      this.freezeSafely(this.draft, recording);
    } else {
      await recording;
      this.publish();
    }
    return reply(submitted !== undefined ? { submitted } : {});
  }

  /** Stop the recording and freeze its text. */
  private finish(draft: CallDraft, reason?: CallDraft['reason']): void {
    this.draft = { ...draft, state: 'finishing', ...(reason ? { reason } : {}) };
    this.deps.setCaptureOpen(false);
    this.publish();
    // The recording freezes within FINISH_TIMEOUT_MS, whatever the transcription does.
    const stopped = this.deps.voice.stopRecording();
    const late = pause(FINISH_TIMEOUT_MS).then(() => {
      throw new Error('the transcription did not finish the recording in time');
    });
    this.freezeSafely(this.draft, Promise.race([stopped, late]));
  }

  /** A freeze that fails leaves the draft failed, never stuck finishing. */
  private freezeSafely(draft: CallDraft, recording: Promise<Recording | null>): void {
    this.freeze(draft, recording).catch((err: unknown) => {
      this.deps.log.warn('voice worker: finishing a review draft failed', { err });
      if (this.draft?.id !== draft.id) return;
      this.draft = { ...draft, state: 'failed', text: this.draft.text };
      this.publish();
    });
  }

  private async freeze(draft: CallDraft, recording: Promise<Recording | null>): Promise<void> {
    const heard = await recording;
    // Discarded meanwhile, or the call ended: its words go nowhere.
    if (this.closed || this.draft?.id !== draft.id) return;
    const text = heard?.text ?? '';
    this.take = heard?.take;
    // A switch with nothing heard leaves no draft behind.
    if (draft.reason === 'switch' && !text && !heard?.failed) {
      this.draft = null;
      this.take = undefined;
    } else {
      const state = text ? 'ready' : heard?.failed ? 'failed' : 'empty';
      this.draft = {
        ...draft,
        state,
        text,
        ...(Buffer.byteLength(text) > MAX_TURN_TEXT_BYTES ? { tooLong: true } : {}),
      };
      if (state === 'ready' && !this.draft.tooLong) this.deps.cue?.('draft');
    }
    this.publish();
  }

  private publish(): void {
    if (this.closed) return;
    this.deps.voice.publishReview({
      seq: ++this.seq,
      mode: this.mode,
      draft: this.draft,
      ...(this.preparing ? { preparing: true } : {}),
      ...(this.deps.wakeState ? { wake: this.deps.wakeState() } : {}),
    });
  }
}

/** A review RPC's payload, or null when it is not one. */
export function readReviewRequest(payload: string): ReviewRequest | null {
  try {
    const req = JSON.parse(payload) as Partial<ReviewRequest> | null;
    if (!req || typeof req.gen !== 'number') return null;
    return {
      gen: req.gen,
      ...(typeof req.draft === 'number' ? { draft: req.draft } : {}),
      ...(req.mode === 'auto' || req.mode === 'review' ? { mode: req.mode } : {}),
      ...(typeof req.afterTurn === 'number' ? { afterTurn: req.afterTurn } : {}),
      ...(typeof req.wake === 'boolean' ? { wake: req.wake } : {}),
      ...(typeof req.pauseSends === 'boolean' ? { pauseSends: req.pauseSends } : {}),
      ...(typeof req.cues === 'boolean' ? { cues: req.cues } : {}),
    };
  } catch {
    return null;
  }
}

/** The fields every job carries whatever its version, enough to answer a mismatched one. */
export function readJobHeader(raw: string): { v: unknown; callId: string; callerIdentity: string; agentName?: string } {
  const meta = JSON.parse(raw) as Record<string, unknown> | null;
  if (!meta || typeof meta.callId !== 'string' || !meta.callId || typeof meta.callerIdentity !== 'string') {
    throw new Error('voice worker: job metadata is not a NanoClaw voice call');
  }
  return {
    v: meta.v,
    callId: meta.callId,
    callerIdentity: meta.callerIdentity,
    agentName: typeof meta.agentName === 'string' && meta.agentName ? meta.agentName : undefined,
  };
}

export function parseJobMetadata(raw: string): LiveKitJobMetadata {
  const meta = JSON.parse(raw) as LiveKitJobMetadata;
  if (meta?.v !== LIVEKIT_PROTOCOL_VERSION || !meta.callId || !meta.callerIdentity || !meta.agentName) {
    throw new Error('voice worker: job metadata is not a NanoClaw voice call of this version');
  }
  return meta;
}

const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
/** The slice of JobContext runCall uses. */
export type CallJob = Pick<
  JobContext,
  'job' | 'room' | 'connect' | 'waitForParticipant' | 'deleteRoom' | 'shutdown' | 'addShutdownCallback'
>;

/** What a call's room needs besides the job metadata. */
export interface VoiceSettings {
  geminiKey: string;
  /** With recordings on: each spoken line's audio as sent to the speech track, and the model that made it. */
  recordReply?(pcm: Int16Array, model: string): void;
}

export interface RunCallDeps {
  /** The worker's settings; read from .env in the job process, so secrets stay out of argv and process.env. */
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  createVoice(
    ctx: CallJob,
    meta: LiveKitJobMetadata,
    settings: VoiceSettings,
    events: CallVoiceEvents,
  ): Promise<CallVoice>;
  /** The call's transcription; Gemini Live by default. */
  transcriber?(options: TranscriberOptions): Transcription;
  /** Where turn recordings are written; NanoClaw's data directory by default. */
  recordingsRoot?: string;
  /** Tell the caller's page this worker cannot serve the host's protocol version. */
  markUpdating(ctx: CallJob): Promise<void>;
  /** The call's acoustic wake word spotter, or none: then `hey <agent>` in the transcript opens a turn. */
  wakeWord?(events: WakeWordEvents): WakeWord | undefined;
  log: Pick<Console, 'info' | 'warn'>;
}

/** What a call needs of a wake word spotter (`WakeWordSpotter`); faked in tests. */
export interface WakeWord {
  readonly phrase: string;
  readonly threshold: number;
  /** Resolves once it can spot, rejects when its models cannot load. */
  readonly ready: Promise<void>;
  /** Score the audio (on) or only keep it (off). */
  listen(on: boolean): void;
  /** 16 kHz mono audio. */
  push(pcm: Int16Array): void;
  readonly summary: WakeWordStats;
  /** Its thread's share of one core. */
  readonly utilization: number;
  close(): Promise<void>;
}

export interface WakeWordEvents {
  /** The window that had the phrase, as positions (16 kHz samples) in the audio pushed to the spotter. */
  onDetect(score: number, window: { start: number; end: number }): void;
  /** It stopped for good after it loaded. */
  onError(err: string): void;
}

/** The command phrases, as spelling hints for the transcription: they must be in its vocabulary to be heard. */
export const COMMAND_VOCABULARY = ['send it', 'прийом', 'scratch that', 'discard turn', 'discard this turn'] as const;
/**
 * VOICE_WAKE_MODEL (a classifier .onnx; the bundled `hey_livekit` by default, `off` for none),
 * VOICE_WAKE_THRESHOLD (0-1; the bundled model's documented 0.68 by default, 0.5 for another model)
 * and VOICE_WAKE_PHRASE (what the model listens for, as the page names it; see wakePhrase).
 */
export function wakeWordSettings(
  env: Record<string, string | undefined>,
): { classifier: string; threshold: number; phrase: string } | null {
  const phrase = wakePhrase(env);
  if (phrase === null) return null;
  const model = env.VOICE_WAKE_MODEL?.trim();
  const threshold = Number(env.VOICE_WAKE_THRESHOLD?.trim() || NaN);
  return {
    classifier: model ? path.resolve(model) : DEFAULT_WAKE_MODEL,
    phrase,
    threshold: threshold > 0 && threshold < 1 ? threshold : model ? CUSTOM_WAKE_THRESHOLD : DEFAULT_WAKE_THRESHOLD,
  };
}

/** Settings from the working directory's .env; WEBHOOK_PORT from the environment wins, as on the host. */
function workerEnv(keys: string[]): Record<string, string | undefined> {
  return {
    ...readEnvFile([...keys, 'WEBHOOK_PORT']),
    ...(process.env.WEBHOOK_PORT ? { WEBHOOK_PORT: process.env.WEBHOOK_PORT } : {}),
  };
}

interface WorkerUserData {
  vad?: VAD;
}

const loadVad = (): Promise<VAD> => silero.VAD.load({ sampleRate: INPUT_SAMPLE_RATE });
const setAttribute = async (ctx: CallJob, key: string, value: string): Promise<void> => {
  await ctx.room.localParticipant?.setAttributes({ [key]: value });
};

type WorkerLog = Pick<Console, 'info' | 'warn' | 'error'>;

/** The agents-js logger as `(message, fields)`, the shape the turn-taking code logs in. */
const workerLog = (logger: ReturnType<typeof agentsLog>): WorkerLog => ({
  info: (msg: string, fields?: unknown) => logger.info(fields ?? {}, msg),
  warn: (msg: string, fields?: unknown) => logger.warn(fields ?? {}, msg),
  error: (msg: string, fields?: unknown) => logger.error(fields ?? {}, msg),
});

/** The agent's speech track, named as agents-js named it; a page plays any other track than the cues' as the agent. */
const SPEECH_TRACK = 'roomio_audio';
/** The speech track's audio goes out in 20 ms frames. */
const SPEECH_FRAME = TTS_SAMPLE_RATE / 50;
/** What the page reads, in the shapes agents-js's AgentSession published them. */
const AGENT_STATE_ATTRIBUTE = 'lk.agent.state';
const TRANSCRIPTION_TOPIC = 'lk.transcription';
const SEGMENT_ID = 'lk.segment_id';
const TRANSCRIPTION_FINAL = 'lk.transcription_final';
const TRANSCRIBED_TRACK = 'lk.transcribed_track_id';

/** A publication to the room that takes longer than this is stuck: the call ends. */
const OUTBOX_DEADLINE_MS = 5_000;
/** At most this many publications wait; more means the room stopped taking them. */
const OUTBOX_MAX = 64;

/**
 * The page's data and attributes, published one at a time in order. A queued update with the same
 * key (an interim caption of one turn, one attribute) is replaced by the newer one; finals, labels and
 * statuses keep their place. A publication that takes over OUTBOX_DEADLINE_MS, or a queue over
 * OUTBOX_MAX, is room I/O that stopped: `onStuck` ends the call rather than holding every update behind it.
 */
export class Outbox {
  private readonly queue: Array<{ what: string; key?: string; run: () => Promise<unknown> }> = [];
  private busy = false;
  private stuck = false;

  constructor(
    private readonly onStuck: (what: string) => void,
    private readonly log: Pick<Console, 'warn' | 'error'>,
    private readonly deadlineMs = OUTBOX_DEADLINE_MS,
    private readonly max = OUTBOX_MAX,
  ) {}

  post(what: string, run: () => Promise<unknown>, key?: string): void {
    if (this.stuck) return;
    const queued = key ? this.queue.find((job) => job.key === key) : undefined;
    if (queued) {
      queued.run = run;
      return;
    }
    if (this.queue.length >= this.max) return this.fail(what);
    this.queue.push({ what, key, run });
    void this.next();
  }

  private async next(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length && !this.stuck) {
      const job = this.queue.shift()!;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<'late'>((resolve) => (timer = setTimeout(() => resolve('late'), this.deadlineMs)));
      try {
        const result = await Promise.race([job.run(), late]);
        if (result === 'late') this.fail(job.what);
      } catch (err) {
        this.log.warn(`voice worker: could not publish ${job.what}`, { err });
      } finally {
        clearTimeout(timer);
      }
    }
    this.busy = false;
  }

  private fail(what: string): void {
    this.stuck = true;
    this.queue.length = 0;
    this.log.error(`voice worker: the room stopped taking updates (${what})`);
    this.onStuck(what);
  }
}

/** A VAD stream as CallerInput uses it: Silero's, or a test's. */
export interface VadStream extends AsyncIterable<{
  type: VADEventType;
  samplesIndex: number;
  speechDuration: number;
  silenceDuration: number;
}> {
  pushFrame(frame: AudioFrame): void;
  close(): void;
}

/**
 * The caller's microphone into the VAD and the call: every frame counted once, so the VAD's speech
 * positions and the turns' audio positions line up across tracks. When the microphone's track ends
 * (unpublished, unsubscribed, replaced), speech under way ends there, and the next track starts a
 * fresh VAD: an old VAD's events are ignored.
 */
export class CallerInput {
  private position = 0;
  private vad?: { stream: VadStream; from: number; speaking: boolean; closed: boolean };

  constructor(
    private readonly newVad: () => VadStream,
    private readonly events: Pick<CallVoiceEvents, 'onAudio' | 'onSpeech' | 'onClosed'>,
    private readonly log: Pick<Console, 'error'>,
  ) {}

  frame(frame: AudioFrame): void {
    const vad = this.vad ?? this.start();
    vad.stream.pushFrame(frame);
    this.position += frame.samplesPerChannel;
    this.events.onAudio(frame.data);
  }

  /** The microphone's track ended. */
  ended(): void {
    const vad = this.vad;
    if (!vad) return;
    this.vad = undefined;
    vad.closed = true;
    vad.stream.close();
    if (vad.speaking) this.events.onSpeech(false, this.position);
  }

  close(): void {
    const vad = this.vad;
    this.vad = undefined;
    if (!vad) return;
    vad.closed = true;
    vad.stream.close();
  }

  private start() {
    const vad = { stream: this.newVad(), from: this.position, speaking: false, closed: false };
    this.vad = vad;
    void (async () => {
      for await (const ev of vad.stream) {
        if (vad.closed) break;
        if (ev.type === VADEventType.START_OF_SPEECH) {
          vad.speaking = true;
          this.events.onSpeech(true, vad.from + ev.samplesIndex - samplesOf(ev.speechDuration));
        } else if (ev.type === VADEventType.END_OF_SPEECH) {
          vad.speaking = false;
          this.events.onSpeech(false, vad.from + ev.samplesIndex - samplesOf(ev.silenceDuration));
        }
      }
    })().catch((err: unknown) => {
      if (vad.closed) return;
      this.log.error('voice worker: the VAD stopped', { err });
      this.events.onClosed('vad failed');
    });
    return vad;
  }
}

/**
 * The real room: the caller's microphone at 16 kHz into Silero and the call's turns, the agent's
 * speech track fed by Gemini TTS, the cue track, and what the page reads (captions, attributes,
 * topics, RPCs).
 */
async function roomVoice(
  ctx: JobContext,
  meta: LiveKitJobMetadata,
  settings: VoiceSettings,
  events: CallVoiceEvents,
): Promise<CallVoice> {
  const log = workerLog(agentsLog().child({ callId: meta.callId }));
  const userData = ctx.proc.userData as WorkerUserData;
  userData.vad ??= await loadVad();
  const room = ctx.room;
  const local = room.localParticipant;
  if (!local) throw new Error('no local participant');
  let closed = false;
  const speech = new GeminiSpeech({
    apiKey: settings.geminiKey,
    model: meta.ttsModel,
    fallbackModel: meta.ttsFallbackModel,
    voice: meta.ttsVoice,
    log,
  });
  const speechSource = new AudioSource(TTS_SAMPLE_RATE, 1);
  const speechTrack = LocalAudioTrack.createAudioTrack(SPEECH_TRACK, speechSource);
  const speechPublication = await local.publishTrack(
    speechTrack,
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
  );
  // The cues' own track: never the speech track, so a cue is never the agent speaking. Without it
  // the call runs silent of cues.
  const cueTrack = await publishCueTrack(room, log).catch((err: unknown) => {
    log.warn('voice worker: could not publish the cue track', { err });
    return undefined;
  });

  const outbox = new Outbox((what) => events.onClosed(`room output stuck (${what})`), log);
  const post = (what: string, job: () => Promise<unknown>, key?: string) => outbox.post(what, job, key);
  const sendJson = (topic: string, value: unknown, what: string) =>
    post(what, () => local.sendText(JSON.stringify(value), { topic }));
  const setAttr = (key: string, value: string, what: string) =>
    post(what, () => local.setAttributes({ [key]: value }), `attribute ${key}`);

  // The caller's microphone, from its first frame: the VAD and the turns count the same samples.
  const vads = userData.vad;
  const input = new CallerInput(() => vads.stream() as unknown as VadStream, events, log);
  let callerTrack: string | undefined;
  let callerAudio: ReadableStreamDefaultReader<AudioFrame> | undefined;
  /** The caller's track ended or was replaced: its reader stops, and speech under way ends. */
  const stopListening = () => {
    void callerAudio?.cancel().catch(() => undefined);
    callerAudio = undefined;
    callerTrack = undefined;
    input.ended();
  };
  const listen = (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
    if (closed || participant.identity !== meta.callerIdentity || track.kind !== TrackKind.KIND_AUDIO) return;
    if (publication.sid === callerTrack && callerAudio) return;
    stopListening();
    callerTrack = publication.sid;
    const reader = new AudioStream(track, { sampleRate: INPUT_SAMPLE_RATE, numChannels: 1 }).getReader();
    callerAudio = reader;
    void (async () => {
      for (;;) {
        const { done, value: frame } = await reader.read();
        if (closed || callerAudio !== reader) return;
        if (done) return stopListening();
        input.frame(frame);
      }
    })().catch((err: unknown) => {
      log.warn('voice worker: the caller audio stopped', { err });
      if (callerAudio === reader) stopListening();
    });
  };
  const unlisten = (_track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
    if (participant.identity === meta.callerIdentity && publication.sid === callerTrack) stopListening();
  };
  room.on(RoomEvent.TrackSubscribed, listen);
  room.on(RoomEvent.TrackUnsubscribed, unlisten);
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      if (publication.track) listen(publication.track as RemoteTrack, publication, participant);
    }
  }

  const sayAbort = new AbortController();
  /** One line into the speech track: streamed as it is synthesized, resolved once it has played. */
  const say = async (text: string): Promise<boolean> => {
    let heard = false;
    let rest: Int16Array | undefined;
    /** The frames sent to the speech track, for the reply's recording. */
    const sent: Int16Array[] = [];
    const capture = async (frame: Int16Array) => {
      if (settings.recordReply) sent.push(frame);
      await speechSource.captureFrame(new AudioFrame(frame, TTS_SAMPLE_RATE, 1, SPEECH_FRAME));
    };
    const play = async (pcm: Int16Array) => {
      let data = pcm;
      if (rest) {
        data = new Int16Array(rest.length + pcm.length);
        data.set(rest);
        data.set(pcm, rest.length);
      }
      let at = 0;
      for (; at + SPEECH_FRAME <= data.length; at += SPEECH_FRAME) await capture(data.slice(at, at + SPEECH_FRAME));
      rest = at < data.length ? data.slice(at) : undefined;
    };
    try {
      for await (const pcm of speech.speak(text, sayAbort.signal)) {
        if (closed) break;
        if (!heard) {
          heard = true;
          setAttr(AGENT_STATE_ATTRIBUTE, 'speaking', 'the agent state');
          events.onAgentSpeaking?.(true);
          // The line's caption, on the agent's speech track, as its audio starts.
          post('a caption', () =>
            local.sendText(text, {
              topic: TRANSCRIPTION_TOPIC,
              attributes: {
                [SEGMENT_ID]: `SG_${randomUUID()}`,
                [TRANSCRIPTION_FINAL]: 'true',
                ...(speechPublication.sid ? { [TRANSCRIBED_TRACK]: speechPublication.sid } : {}),
              },
            }),
          );
        }
        await play(pcm);
      }
      if (rest) {
        const tail = new Int16Array(SPEECH_FRAME);
        tail.set(rest);
        rest = undefined;
        await capture(tail);
      }
      if (heard) await speechSource.waitForPlayout();
      return heard && !closed;
    } catch (err) {
      log.warn('voice worker: a line could not be synthesized', { err: err instanceof Error ? err.message : err });
      if (heard) await speechSource.waitForPlayout().catch(() => undefined);
      return false;
    } finally {
      if (heard && !closed) {
        setAttr(AGENT_STATE_ATTRIBUTE, 'listening', 'the agent state');
        events.onAgentSpeaking?.(false);
      }
      if (sent.length) {
        const pcm = new Int16Array(sent.length * SPEECH_FRAME);
        sent.forEach((frame, i) => pcm.set(frame, i * SPEECH_FRAME));
        settings.recordReply?.(pcm, speech.spokenBy);
      }
    }
  };

  setAttr(AGENT_STATE_ATTRIBUTE, 'listening', 'the agent state');
  return {
    say,
    setThinking: (thinking) => setAttr(CALL_THINKING_ATTRIBUTE, thinking ? '1' : '', 'the thinking state'),
    publishTurn: (status) => sendJson(CALL_TURN_TOPIC, status, 'a turn status'),
    publishDropped: (dropped) => sendJson(CALL_TURN_TOPIC, dropped, 'dropped words'),
    publishUnheard: () =>
      sendJson(CALL_TURN_TOPIC, { unheard: 'agent_speaking' } satisfies CallUnheardSpeech, 'unheard speech'),
    setPending: (value) => setAttr(CALL_PENDING_ATTRIBUTE, value, 'the countdown'),
    caption: (segment, text, final) =>
      post(
        'a caption',
        () =>
          local.sendText(text, {
            topic: TRANSCRIPTION_TOPIC,
            attributes: {
              [SEGMENT_ID]: `SG_turn_${segment}`,
              [TRANSCRIPTION_FINAL]: final ? 'true' : 'false',
              ...(callerTrack ? { [TRANSCRIBED_TRACK]: callerTrack } : {}),
            },
          }),
        // A newer interim of the turn replaces one still waiting; its final keeps its place.
        final ? undefined : `caption ${segment}`,
      ),
    async playCue(kind) {
      await cueTrack?.feed.play(cueFrames(kind));
    },
    publishReply: (info) => sendJson(CALL_REPLY_TOPIC, info, 'a reply label'),
    review: {
      publishReview: (state) => sendJson(CALL_REVIEW_TOPIC, state, 'the review state'),
      serve(handle) {
        for (const op of Object.keys(REVIEW_RPC) as ReviewOp[]) {
          local.registerRpcMethod(REVIEW_RPC[op], (data) => handle(op, data.payload, data.callerIdentity));
        }
        post('the review attributes', () =>
          local.setAttributes({ [CALL_REVIEW_ATTRIBUTE]: '1', [CALL_COMMANDS_ATTRIBUTE]: CALL_COMMANDS_VERSION }),
        );
      },
    },
    async close() {
      closed = true;
      sayAbort.abort();
      room.off(RoomEvent.TrackSubscribed, listen);
      room.off(RoomEvent.TrackUnsubscribed, unlisten);
      await callerAudio?.cancel().catch(() => undefined);
      input.close();
      await cueTrack?.close().catch(() => undefined);
      if (speechPublication.sid) await local.unpublishTrack(speechPublication.sid).catch(() => undefined);
      await speechTrack.close().catch(() => undefined);
      await speechSource.close().catch(() => undefined);
    },
  };
}

function defaultDeps(): RunCallDeps {
  const env = workerEnv([
    'GEMINI_API_KEY',
    'LIVEKIT_API_SECRET',
    'LIVEKIT_HOST_URL',
    'VOICE_RECORDINGS_DAYS',
    'VOICE_MAX_SPOKEN_CHARS',
    'VOICE_WAKE_MODEL',
    'VOICE_WAKE_THRESHOLD',
    'VOICE_WAKE_PHRASE',
    'VOICE_WAKE_START_SECONDS',
    'VOICE_WAKE_IDLE_SECONDS',
  ]);
  const wake = wakeWordSettings(env);
  return {
    env,
    createVoice: (ctx, meta, settings, events) => roomVoice(ctx as JobContext, meta, settings, events),
    transcriber: (options) => new GeminiLiveTranscriber(options),
    markUpdating: (ctx) => setAttribute(ctx, CALL_UPDATING_ATTRIBUTE, '1'),
    wakeWord: (events) => (wake ? new WakeWordSpotter({ ...wake, ...events }) : undefined),
    log: workerLog(agentsLog()),
  };
}

export async function runCall(ctx: CallJob, deps: RunCallDeps = defaultDeps()): Promise<void> {
  const { log } = deps;
  const header = readJobHeader(ctx.job.metadata);
  const callFields = { callId: header.callId };
  const hostUrl = liveKitHostUrl(deps.env);
  const host = new HostLink(
    {
      hostUrl,
      secret: liveKitCallSecret(deps.env.LIVEKIT_API_SECRET ?? '', header.callId),
      callId: header.callId,
    },
    deps.fetchImpl,
  );
  const abandon = async (reason: string, fields: Record<string, unknown> = {}) => {
    log.warn('voice worker: ending the call', { ...callFields, ...fields, reason });
    await host
      .post('ended', { reason })
      .then((res) => res.body?.cancel())
      .catch(() => undefined);
    await ctx.deleteRoom().catch(() => undefined);
    ctx.shutdown(reason);
  };
  if (!deps.env.LIVEKIT_API_SECRET) return abandon('LIVEKIT_API_SECRET is not set for the worker');

  if (header.v !== LIVEKIT_PROTOCOL_VERSION) {
    // Host and worker were not restarted together. Tell the caller's page, then let the host end it.
    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
    await deps.markUpdating(ctx).catch(() => undefined);
    await withTimeout(
      ctx.waitForParticipant(header.callerIdentity),
      MISMATCH_JOIN_WAIT_MS,
      'caller never joined',
    ).catch(() => undefined);
    await sleep(MISMATCH_NOTICE_MS);
    return abandon(`protocol mismatch: host sent v${String(header.v)}, worker speaks v${LIVEKIT_PROTOCOL_VERSION}`);
  }
  let meta: LiveKitJobMetadata;
  try {
    meta = parseJobMetadata(ctx.job.metadata);
  } catch (err) {
    return abandon((err as Error).message);
  }
  const geminiKey = deps.env.GEMINI_API_KEY;
  if (!geminiKey) return abandon('GEMINI_API_KEY is not set for the worker');
  const record = recordingDays(deps.env.VOICE_RECORDINGS_DAYS) > 0;
  /** Spoken lines recorded so far, for their file names. */
  let replies = 0;
  if (meta.sttFallbackModel) {
    log.warn('voice worker: VOICE_STT_FALLBACK_MODEL is ignored: turns are transcribed by the Live model only', {
      ...callFields,
      model: meta.sttFallbackModel,
    });
  }

  await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
  try {
    await withTimeout(ctx.waitForParticipant(meta.callerIdentity), meta.joinTimeoutMs, 'caller never joined');
  } catch (err) {
    return abandon((err as Error).message);
  }
  const joined = await host.post('joined').catch(() => null);
  void joined?.body?.cancel().catch(() => {});
  // The host starts billing here; without its yes, nothing is published or transcribed.
  if (!joined?.ok) return abandon(`host refused the call (${joined?.status ?? 'unreachable'})`, { hostUrl });

  const hostLink = new AbortController();
  let ending = false;
  let callVoice: CallVoice | undefined;
  const callLog = {
    info: (msg: string, fields?: unknown) => log.info(msg, { ...callFields, ...(fields as object) }),
    warn: (msg: string, fields?: unknown) => log.warn(msg, { ...callFields, ...(fields as object) }),
  } as Pick<Console, 'info' | 'warn'>;
  /** The page's `?cues=0` turns the cues off, through the `settings` RPC. */
  let cuesOn = true;
  let agentSpeaking = false;
  let callerSpeaking = false;
  let cues: Promise<void> = Promise.resolve();
  /** Cues play one after another, none over the agent's speech and none once the call ends. */
  const cue = (kind: CueKind) => {
    cues = cues
      .then(async () => {
        if (ending || !cuesOn || agentSpeaking) return;
        await callVoice?.playCue?.(kind);
      })
      .catch((err: unknown) => callLog.warn('voice worker: a cue did not play', { err, kind }));
  };
  let readyCued = false;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  /** The listening cue, once: when the page has said whether it wants cues, or after a wait for that. */
  const readyCue = () => {
    clearTimeout(readyTimer);
    if (readyCued) return;
    readyCued = true;
    cue('listening');
  };
  let turnCueTimer: ReturnType<typeof setTimeout> | undefined;
  let turnCuedAt = 0;
  let replyHoldTimer: ReturnType<typeof setTimeout> | undefined;
  const turnTaking = new TurnTaking(
    {
      send: async (text) => {
        // The host answers a turn key once, so a retry after a dropped connection cannot reach the agent twice.
        const turnKey = randomUUID();
        let res: Response;
        try {
          res = await host.post('utterance', { text, turnKey }).catch(async (err: unknown) => {
            if ((err as Error | null)?.name === 'TimeoutError') throw err;
            callLog.warn('voice worker: posting a turn failed; trying once more', { err });
            await sleep(TURN_RETRY_DELAY_MS);
            return host.post('utterance', { text, turnKey });
          });
        } catch (err) {
          // Unanswered, not refused: the host may still store it and say so with `turn-stored`.
          callLog.warn('voice worker: could not hand the turn to the host', { err });
          return { accepted: false, turnKey, error: err instanceof Error ? err.message : String(err) };
        }
        if (res.status === 202) {
          const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
          return { accepted: true, status: 202, turnKey, id: typeof body?.id === 'string' ? body.id : undefined };
        }
        void res.body?.cancel().catch(() => {});
        callLog.warn('voice worker: the host refused a turn', { status: res.status });
        return { accepted: false, status: res.status, turnKey };
      },
      // From before the line is made until it has played, the caller is not transcribed.
      say: async (text) => {
        callTurns.onAgentSpeaking(true);
        try {
          return (await callVoice?.say(text)) ?? false;
        } finally {
          callTurns.onAgentSpeaking(false);
        }
      },
      setThinking: (thinking) => callVoice?.setThinking(thinking),
      announce: (info) => callVoice?.publishReply(info),
      beforeSpeak: () => review?.beforeAgentSpeaks(),
      // Over to the caller, unless another line starts, the agent still works or the caller already talks.
      // A reply the speech model failed on was never heard: no cue says it is the caller's turn.
      spokenAll: (spoken) => {
        clearTimeout(turnCueTimer);
        if (!spoken) return;
        turnCueTimer = setTimeout(() => {
          // Lines that end close together are one hand-over: one cue.
          if (
            turnTaking.speaking ||
            turnTaking.working ||
            callerSpeaking ||
            Date.now() - turnCuedAt < TURN_CUE_REPEAT_MS
          )
            return;
          turnCuedAt = Date.now();
          cue('turn');
        }, TURN_CUE_DELAY_MS);
        turnCueTimer.unref?.();
      },
      log: callLog,
    },
    {
      silenceMs: meta.silenceMs,
      language: DEFAULT_CALL_LANGUAGE,
      maxSpokenChars: maxSpokenChars(deps.env.VOICE_MAX_SPOKEN_CHARS),
    },
  );
  let review: ReviewControl | undefined;
  /** The call's wake word spotter, and once its models loaded, the one in use. */
  let spotter: WakeWord | undefined;
  /** Where the spotter's audio starts in the call's. */
  let spotterFrom = 0;
  let wakeWord: WakeWord | undefined;
  /** `restart`: the worker is shutting down, so the caller's page says the service restarted. */
  const end = async (reason: string, tellHost: boolean, restart = false) => {
    if (ending) return;
    ending = true;
    clearTimeout(readyTimer);
    clearTimeout(turnCueTimer);
    clearTimeout(replyHoldTimer);
    turnTaking.close();
    review?.close();
    callTurns.close();
    transcriber.close();
    if (wakeWord) {
      callLog.info('voice worker: wake word use', {
        ...wakeWord.summary,
        cpu: Math.round(wakeWord.utilization * 1000) / 1000,
      });
    }
    void spotter?.close().catch(() => undefined);
    // A job process serves one call: its heap now is what the call grew it to (long calls show
    // 100-150 ms GC pauses).
    const mem = process.memoryUsage();
    const mb = (bytes: number) => Math.round(bytes / 1_048_576);
    callLog.info('voice worker: call memory', {
      heapUsedMB: mb(mem.heapUsed),
      heapTotalMB: mb(mem.heapTotal),
      externalMB: mb(mem.external),
      rssMB: mb(mem.rss),
    });
    // The host link stays open until the host answered: closed first, it ends the call on its own
    // and answers this at once, before the room carries why the call ended.
    await Promise.all([
      tellHost &&
        host
          .post('ended', restart ? { reason, restart } : { reason })
          .then((res) => res.body?.cancel())
          .catch(() => undefined),
      callVoice?.close().catch(() => undefined),
    ]);
    hostLink.abort();
    await ctx.deleteRoom().catch(() => undefined);
    ctx.shutdown(reason);
  };
  // Every caller turn gets a number. The page hears what became of it; a recording, when they are
  // on, is written once the turn is settled, off the path to the host.
  let turns = 0;
  /** The newest turn handed to the host. */
  let lastPosted = 0;
  /** The newest turn the host answered, the newest it took, and the newest the agent picked up or answered. */
  let lastSettled = 0;
  let lastAccepted = 0;
  let pickedUp = 0;
  /** The host's utterance id of each sent turn to its number here, to tell the page what a reply answers. */
  const turnsByHostId = new Map<string, number>();
  /** Turns the host did not confirm, by turn key, until its `turn-stored` says the agent has one after all. */
  const unconfirmed = new Map<string, { turn: number; text: string }>();
  const publish = (status: CallTurnStatus) => callVoice?.publishTurn(status);
  const saveTurn = (
    index: number,
    { audio, sttModel }: TurnTake,
    transcript: string,
    outcome: { reason?: string; host?: SendResult },
  ) => {
    if (!audio) return;
    const record: TurnRecord = {
      callId: meta.callId,
      lineId: meta.lineId,
      agent: meta.agentName,
      turn: index,
      startedAt: new Date(audio.startedAt).toISOString(),
      endedAt: new Date(audio.endedAt).toISOString(),
      speechMs: audio.speechMs,
      truncated: audio.truncated,
      sttModel,
      transcript,
      ...outcome,
    };
    void writeTurnRecording(deps.recordingsRoot ?? recordingsRoot(), record, audio).catch((err: unknown) =>
      callLog.warn('voice worker: could not save a turn recording', { err, turn: index }),
    );
  };
  /** A finished turn to the host: an auto turn, or a review draft (`draft`) the caller sent. */
  const sendTurn = (text: string, take: TurnTake, draft?: number): number => {
    const turn = ++turns;
    lastPosted = turn;
    // The turn closed, before the host has answered: the page's mark, and the sent cue.
    if (!ending) publish(draft === undefined ? { turn, status: 'sending' } : { turn, status: 'sending', text, draft });
    cue('sent');
    turnTaking.onTurn(text, (host) => {
      if (host.accepted && host.id) turnsByHostId.set(host.id, turn);
      lastSettled = Math.max(lastSettled, turn);
      if (host.accepted) lastAccepted = Math.max(lastAccepted, turn);
      if (!host.accepted && host.turnKey && hostLossReason(host) === 'timeout') {
        unconfirmed.set(host.turnKey, { turn, text });
        for (const key of unconfirmed.keys()) {
          if (unconfirmed.size <= MAX_UNCONFIRMED_TURNS) break;
          unconfirmed.delete(key);
        }
      }
      publish(
        host.accepted ? { turn, status: 'sent', text } : { turn, status: 'lost', reason: hostLossReason(host), text },
      );
      saveTurn(turn, take, text, { host });
    });
    return turn;
  };
  const transcriber = (deps.transcriber ?? ((options) => new GeminiLiveTranscriber(options)))({
    apiKey: geminiKey,
    model: meta.sttModel,
    // The names (the host trimmed, deduplicated and capped them) and the commands, which the
    // transcription does not hear reliably unless they are in its vocabulary.
    vocabulary: [...new Set([...(meta.vocabulary ?? []), ...COMMAND_VOCABULARY])],
    languageCodes: STT_LANGUAGE_CODES,
    sampleRate: INPUT_SAMPLE_RATE,
    onInterim: (text) => callTurns.onInterim(text),
    log: callLog,
  });
  const callTurns: CallTurns = new CallTurns(
    {
      transcriber,
      send: (text, take) => {
        if (!ending) sendTurn(text, take);
      },
      lost: (reason, fields, take) => {
        if (ending) return;
        const turn = ++turns;
        turnTaking.onTurnLost(reason, fields);
        publish({ turn, status: 'lost', reason });
        saveTurn(turn, take, '', { reason });
      },
      noise: (take) => {
        if (!ending) saveTurn(++turns, take, '', { reason: 'noise' });
      },
      drop: (dropped, text) => {
        if (!ending) callVoice?.publishDropped?.({ dropped, text });
      },
      cue,
      caption: (segment, text, final) => {
        if (!ending) callVoice?.caption?.(segment, text, final);
      },
      countdown: new SendCountdown((value) => callVoice?.setPending?.(value), meta.silenceMs),
      changed: () => review?.republish(),
      hold: (open) => turnTaking.setCaptureOpen(open, 'turn'),
      noTurn: () => turnTaking.releaseTurn(),
      unheard: () => {
        if (!ending && !review?.reviewing) callVoice?.publishUnheard?.();
      },
      log: callLog,
    },
    {
      silenceMs: meta.silenceMs,
      names: [meta.agentName, ...(meta.wakeNames ?? [])],
      limits: awakeLimits(deps.env),
      record,
      sttModel: meta.sttModel,
    },
  );
  try {
    callVoice = await deps.createVoice(
      ctx,
      meta,
      {
        geminiKey,
        ...(record
          ? {
              recordReply: (pcm: Int16Array, model: string) => {
                const reply = ++replies;
                const fields = {
                  reply,
                  durationMs: Math.round((pcm.length * 1000) / TTS_SAMPLE_RATE),
                  model,
                  ...audioLevels(pcm),
                };
                void writeReplyRecording(
                  deps.recordingsRoot ?? recordingsRoot(),
                  { agent: meta.agentName, callId: meta.callId },
                  reply,
                  pcm,
                ).then(
                  () => callLog.info('voice worker: saved a reply recording', fields),
                  (err: unknown) => callLog.warn('voice worker: could not save a reply recording', { err, reply }),
                );
              },
            }
          : {}),
      },
      {
        onAudio: (pcm) => {
          // Scored only while it can open a turn: waiting in auto, and not while an agent line is due or plays.
          wakeWord?.listen(callTurns.spotting);
          spotter?.push(pcm);
          callTurns.audio(pcm);
        },
        onSpeech: (speaking, at) => {
          callerSpeaking = speaking;
          callTurns.onSpeech(speaking, at);
          if (review?.reviewing) return;
          turnTaking.onCallerSpeaking(speaking);
          // Speech that opened no turn for the agent (before the wake phrase, under a reply) holds no reply.
          if (!speaking && !callTurns.turnOpen) turnTaking.releaseTurn();
        },
        onAgentSpeaking: (speaking) => {
          agentSpeaking = speaking;
          // The speaking state reaches the page first, then "working" lets go: no flash of listening
          // before the reply's audio, nor of working after a short line. A line that ended sooner lets
          // its successor's hold be.
          clearTimeout(replyHoldTimer);
          if (speaking) {
            replyHoldTimer = setTimeout(() => turnTaking.replyHeard(), REPLY_HOLD_MS);
            replyHoldTimer.unref?.();
          }
          review?.onAgentSpeaking(speaking);
        },
        onClosed: (reason) => void end(reason, true),
      },
    );
  } catch (err) {
    turnTaking.close();
    callTurns.close();
    transcriber.close();
    return abandon('could not set up the call audio', { err });
  }
  if (!ending) {
    try {
      // The spotter counts the audio it was pushed, from now on; the turns count it from the call's start.
      spotterFrom = callTurns.position;
      spotter = deps.wakeWord?.({
        onDetect: (score, window) => {
          const end = window.end + spotterFrom;
          callLog.info('voice worker: wake word spotted', {
            score: Math.round(score * 1000) / 1000,
            scoredMsAgo: Math.round(msOf(callTurns.position - end)),
          });
          if (ending || review?.reviewing) return;
          callTurns.onWake(end);
        },
        onError: (err) => {
          callLog.warn('voice worker: the wake word spotter stopped; "hey <agent>" in the transcript opens a turn', {
            err,
          });
          wakeWord = undefined;
          callTurns.useWakeWord(undefined);
        },
      });
    } catch (err) {
      callLog.warn('voice worker: could not start the wake word spotter', { err });
    }
    const loading = spotter;
    if (loading) callTurns.loadWakeWord(loading.phrase);
    loading?.ready.then(
      () => {
        if (ending) return;
        wakeWord = loading;
        callTurns.useWakeWord(loading.phrase);
        callLog.info('voice worker: wake word ready', { phrase: loading.phrase, threshold: loading.threshold });
      },
      (err: unknown) => {
        // A call that ended while the models loaded closed the spotter: nothing failed.
        if (ending) return;
        callTurns.useWakeWord(undefined);
        callLog.warn('voice worker: no wake word model; "hey <agent>" in the transcript opens a turn', {
          err: err instanceof Error ? err.message : String(err),
        });
      },
    );
  }
  const reviewSession = callVoice.review;
  // A call that ended while its audio was set up gets no review controls.
  if (reviewSession && !ending) {
    const control = new ReviewControl({
      voice: {
        get turnOpen() {
          return callTurns.turnOpen;
        },
        setReviewing: (on) => callTurns.setReviewing(on),
        prepare: () => callTurns.prepare(),
        record: () => callTurns.record(),
        stopRecording: () => callTurns.stopRecording(),
        dropRecording: () => callTurns.dropRecording(),
        publishReview: (state) => reviewSession.publishReview(state),
      },
      post: (text, draft, take) => sendTurn(text, take, draft),
      lastPosted: () => lastPosted,
      setCaptureOpen: (open) => turnTaking.setCaptureOpen(open),
      resetCaller: () => turnTaking.resetCaller(),
      configure: (req) => {
        if (req.cues !== undefined) cuesOn = req.cues;
        callTurns.configure(req.wake ?? callTurns.state.on, req.pauseSends ?? callTurns.state.pauseSends);
        readyCue();
      },
      wakeState: () => callTurns.state,
      cue,
      sttModel: meta.sttModel,
      log: callLog,
    });
    review = control;
    reviewSession.serve(async (op, payload, callerIdentity) => {
      const req = callerIdentity === meta.callerIdentity ? readReviewRequest(payload) : null;
      // Only the caller drives the call; anything else is not an operation at all.
      if (!req) throw new Error('not a review request from the caller');
      return JSON.stringify(await control.handle(op, req));
    });
  }
  // A page says whether it wants cues first; a call with no page to ask gets them after a moment.
  if (!ending) {
    readyTimer = setTimeout(readyCue, READY_CUE_WAIT_MS);
    readyTimer.unref?.();
  }
  // Defense in depth: the host ends the call on time; this stops a worker that lost the host.
  const deadline = setTimeout(
    () => void end('duration limit (worker)', true),
    meta.maxDurationMs + WORKER_DEADLINE_GRACE_MS,
  );
  deadline.unref?.();
  ctx.addShutdownCallback(async () => {
    clearTimeout(deadline);
    await end('job shutdown', true, true);
  });
  ctx.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    if (participant.identity === meta.callerIdentity) void end('caller left', true);
  });
  // The caller may have left while the call was being set up.
  if (!ctx.room.remoteParticipants.has(meta.callerIdentity)) void end('caller left', true);

  host
    .events((event) => {
      if (event.type === 'end') void end(`host: ${event.reason}`, false);
      else if (event.type === 'reply') {
        // A host that sends no turn at all predates reply labels: not known, so no label.
        const turn = typeof event.turn === 'string' ? turnsByHostId.get(event.turn) : event.turn;
        // Any agent message after the turns the host took answers the "did it get it" question.
        pickedUp = Math.max(pickedUp, lastAccepted, typeof turn === 'number' ? turn : 0);
        turnTaking.onReply(event.text, turn);
        // A reply to an earlier turn: a newer one the host took still awaits its own.
        if (typeof turn === 'number' && turn < lastAccepted) turnTaking.expectReply();
      } else if (event.type === 'thinking') turnTaking.onThinking();
      else if (event.type === 'working') {
        turnTaking.onThinking(true);
        // The runner works on what reached it after the newest turn the host took: the page's
        // working status, once per turn. While a newer turn awaits the host's answer the pickup could
        // be read as that one's, so it waits for the next tick.
        if (lastAccepted > pickedUp && lastSettled === lastPosted) {
          pickedUp = lastAccepted;
          publish({ turn: lastAccepted, status: 'working' });
        }
      } else if (event.type === 'chat') turnTaking.onChat(event.chat);
      else if (event.type === 'turn-stored') {
        const late = unconfirmed.get(event.turnKey);
        if (!late) return;
        unconfirmed.delete(event.turnKey);
        turnsByHostId.set(event.id, late.turn);
        lastAccepted = Math.max(lastAccepted, late.turn);
        if (late.turn > pickedUp) turnTaking.expectReply();
        callLog.info('voice worker: a timed-out turn reached the agent after all', { turn: late.turn });
        // The page's mark for this turn goes from "not confirmed" to "sent".
        publish({ turn: late.turn, status: 'sent', text: late.text });
      }
    }, hostLink.signal)
    .then(
      () => end('host link closed', true),
      (err: unknown) => {
        if (!ending) log.warn('voice worker: host link failed', { ...callFields, err });
        return end('host link failed', true);
      },
    )
    .catch(() => undefined);
}

// agents-js's EOT_INFERENCE_METHOD (inference/eot/runner.ts), which it does not export.
const LOCAL_EOT_INFERENCE_METHOD = 'lk_eot_audio';

/**
 * Keeps agents-js from forking its shared inference process. AgentServer's constructor registers the
 * local end-of-turn model runner whenever the native binding loads, and a registered runner forks a
 * process that loads the model (~330 MB RSS) for good. Calls end turns on VAD and pauses, never on
 * that model. A non-enumerable entry under the runner's method makes the registration a no-op while
 * the executor, which counts enumerable keys, sees no runner and forks nothing.
 */
export function skipLocalTurnDetectorProcess(): void {
  Object.defineProperty(InferenceRunner.registeredRunners, LOCAL_EOT_INFERENCE_METHOD, {
    value: 'disabled',
    enumerable: false,
    configurable: true,
  });
}

export default defineAgent({
  // Loaded once per idle job process, before a call is assigned to it.
  prewarm: async (proc: JobProcess) => {
    const userData = proc.userData as WorkerUserData;
    userData.vad = await loadVad();
  },
  entry: (ctx) => runCall(ctx),
});

// Imported by the job processes and by tests too; only the worker's own entrypoint runs the CLI.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = workerEnv([
    'LIVEKIT_URL',
    'LIVEKIT_WORKER_URL',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'LIVEKIT_AGENT_NAME',
    'LIVEKIT_HOST_URL',
    'VOICE_WORKER_HEALTH_PORT',
    'VOICE_RECORDINGS_DAYS',
    'VOICE_MAX_SPOKEN_CHARS',
  ]);
  // agents-js initializes its logger once the CLI runs a command; console until then.
  console.info(
    `voice worker: protocol v${LIVEKIT_PROTOCOL_VERSION}, host URL ${liveKitHostUrl(env)} (LIVEKIT_HOST_URL)`,
  );
  // agents-js's default ("adaptive") enables the debugger domain on a job's first loop stall to
  // sample stacks: that blocks the loop another ~250 ms mid-call and slows the call's JS by ~15%
  // from then on. Set the variable to sample anyway; the job processes inherit it.
  process.env.LIVEKIT_AGENTS_LOOP_BLOCK_STACKS ??= 'never';
  const keepDays = recordingDays(env.VOICE_RECORDINGS_DAYS);
  if (keepDays > 0) {
    const prune = () =>
      void pruneRecordings(recordingsRoot(), keepDays).then(
        (removed) => removed > 0 && console.info(`voice worker: pruned ${removed} turn recording files`),
        (err: unknown) => console.warn('voice worker: pruning turn recordings failed', err),
      );
    console.info(`voice worker: recording caller turns to ${recordingsRoot()}, kept ${keepDays} days`);
    prune();
    setInterval(prune, DAY_MS).unref();
  }
  skipLocalTurnDetectorProcess();
  cli.runApp(
    new ServerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: env.LIVEKIT_AGENT_NAME || DEFAULT_LIVEKIT_AGENT_NAME,
      wsURL: env.LIVEKIT_WORKER_URL || env.LIVEKIT_URL,
      apiKey: env.LIVEKIT_API_KEY,
      apiSecret: env.LIVEKIT_API_SECRET,
      // Health endpoint on loopback only, off agents-js's default 8081.
      host: '127.0.0.1',
      port: Number(env.VOICE_WORKER_HEALTH_PORT || 8089),
      numIdleProcesses: 1,
      // On SIGTERM the worker takes no new calls and gives running ones this long before closing
      // them; a call can run up to VOICE_MAX_CALL_SECONDS, so a restart cuts longer ones short.
      drainTimeout: 60_000,
      // Never throws and always answers: agents-js logs the whole job, metadata included, when a
      // request function fails or leaves the request unanswered. A job of another protocol version
      // is taken too, to tell the caller's page the service is updating.
      requestFunc: async (req) => {
        let name: string;
        try {
          name = readJobHeader(req.job.metadata).agentName ?? DEFAULT_LIVEKIT_AGENT_NAME;
        } catch {
          return req.reject();
        }
        await req.accept(name).catch(() => req.reject().catch(() => undefined));
      },
    }),
  );
}
