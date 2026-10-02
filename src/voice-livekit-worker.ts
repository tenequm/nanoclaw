/**
 * The LiveKit Agents worker for the voice channel's LiveKit path: walkie-talkie
 * mode, where the caller talks to the line's real NanoClaw agent.
 *
 * A separate process (`pnpm run voice-worker`), because agents-js runs every
 * job in a forked child process of its worker and owns that process's signals
 * and logging; the host dispatches it to each call's room (explicit dispatch
 * by agent name) and the two talk over the host's webhook server, see
 * `src/channels/voice-livekit-protocol.ts` for the protocol. The host's address and the
 * call's secret come from the worker's own settings, never from the dispatch.
 *
 * Per job: join the room, wait for the caller named in the metadata, tell the
 * host (which starts the clock), then run a LiveKit `AgentSession` with no LLM:
 *  - Silero VAD ends the caller's turn after `silenceMs` of silence (VAD-only
 *    turn detection: LiveKit's turn detector models have no Ukrainian);
 *  - Gemini transcribe-live streams the transcript while the caller talks;
 *    LiveKit's STT FallbackAdapter moves to the unary Gemini transcribe model
 *    while it fails, and back once it works again;
 *  - each finished turn goes to the host, which hands it to the agent as a
 *    spoken message; nothing in the session answers it;
 *  - each complete agent reply from the host's event stream is spoken with
 *    `session.say()` once the caller is not mid-turn, cut to
 *    WALKIE_MAX_SPOKEN_CHARS at a sentence end, uninterruptible: while
 *    it plays, the caller's audio is not transcribed (no barge-in); Gemini
 *    TTS synthesizes the whole reply in one streamed request, through
 *    LiveKit's TTS FallbackAdapter onto a second model.
 * The session owns the audio, captions and `lk.agent.state`; "thinking" goes
 * on a separate attribute, since a session without an LLM never thinks.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ReadableStream, TransformStream } from 'node:stream/web';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  APIConnectionError,
  APIStatusError,
  AutoSubscribe,
  cli,
  defineAgent,
  log as agentsLog,
  mergeFrames,
  normalizeLanguage,
  ServerOptions,
  stt,
  tokenize,
  tts,
  voice,
  type APIConnectOptions,
  type AudioBuffer,
  type JobContext,
  type JobProcess,
  type llm,
  type VAD,
} from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import * as silero from '@livekit/agents-plugin-silero';
import { AudioFrame, RoomEvent } from '@livekit/rtc-node';

import {
  DEFAULT_LIVEKIT_AGENT_NAME,
  HOST_SILENCE_MS,
  LIVEKIT_PROTOCOL_VERSION,
  liveKitCallSecret,
  liveKitHostUrl,
  WALKIE_PENDING_ATTRIBUTE,
  WALKIE_REPLY_TOPIC,
  WALKIE_THINKING_ATTRIBUTE,
  WALKIE_TURN_TOPIC,
  WALKIE_UPDATING_ATTRIBUTE,
  WORKER_REQUEST_TIMEOUT_MS,
  type LiveKitHostEvent,
  type LiveKitJobMetadata,
  type WalkieReplyInfo,
  type WalkieTurnStatus,
} from './channels/voice-livekit-protocol.js';
import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';

/** The worker's duration cap outlasts the host's by this; it only fires when the host is gone. */
const WORKER_DEADLINE_GRACE_MS = 30_000;
/** Silero and the transcription both run at 16 kHz. */
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
/** Speech that produced no transcript within this long after it ended is a lost turn. */
const TRANSCRIPTION_TIMEOUT_MS = 5_000;
/** Shorter untranscribed speech is a cough or a noise, not a lost turn, unless the STT failed. */
const MIN_LOST_SPEECH_MS = 800;
/** Longest wait for the next TTS frame: Gemini 3.8 TTS takes seconds to first audio, and a failover adds a try. */
const TTS_IDLE_TIMEOUT_MS = 60_000;
/** While a speech model is down, it is tried again this often; every try spends its quota. */
const TTS_RECOVERY_DELAY_MS = 30_000;
const UNARY_STT_TIMEOUT_MS = 30_000;
/** The fallback transcription cuts speech at pauses this long, and skips sounds shorter than the other: fewer requests on a small quota. */
const FALLBACK_MIN_SILENCE_MS = 1_000;
const FALLBACK_MIN_SPEECH_MS = 300;
/** After the fallback transcription is rate limited, it sends nothing for this long. */
const UNARY_STT_BACKOFF_MS = 60_000;
/** While the fallback transcribes, the streaming model is tried again this often, at a pause. */
const HAND_BACK_RETRY_MS = 60_000;
/** While the fallback transcribes, whether to hand back is checked this often. */
const HAND_BACK_CHECK_MS = 10_000;
/** Silero's default: its end-of-speech comes this long after the speech stopped. */
const VAD_SILENCE_MS = 550;
/** A worker on another protocol version waits this long for the caller, then this long for their page to see why. */
const MISMATCH_JOIN_WAIT_MS = 30_000;
const MISMATCH_NOTICE_MS = 3_000;
/** A turn recording keeps this much audio from before the caller's first speech, and after the last. */
const RECORDING_PAD_MS = 300;
/** Longest turn recording; audio past it is not kept. */
const MAX_RECORDED_TURN_MS = 120_000;
/** A turn whose POST failed in transit is sent once more, under the same turn key, after this long. */
const TURN_RETRY_DELAY_MS = 500;
/** Timed-out turns kept for a late `turn-stored`; the host remembers no more turn keys than this either. */
const MAX_UNCONFIRMED_TURNS = 32;
/** WALKIE_MAX_SPOKEN_CHARS when unset: the longest message spoken in full. */
export const DEFAULT_MAX_SPOKEN_CHARS = 800;
const DAY_MS = 86_400_000;

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

/** WALKIE_MAX_SPOKEN_CHARS: a whole number of characters, 0 for no cap; anything else is the default. */
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

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** The text of an Interactions API answer: every text part of every step. */
export function interactionText(body: unknown): string {
  const steps = (body as { steps?: Array<{ content?: Array<{ type?: string; text?: string }> }> } | null)?.steps;
  return (steps ?? [])
    .flatMap((step) => step.content ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join(' ')
    .trim();
}

/**
 * Gemini's unary transcription (`gemini-3.5-transcribe` over the Interactions API), verbatim,
 * one request per stretch of speech. The google plugin has no non-streaming Gemini STT. Only a
 * fallback: the model's quota is small (on some tiers 10 requests a minute, 100 a day), so it
 * sends nothing unless `shouldServe` says the streaming transcription is down.
 */
export class GeminiTranscribeSTT extends stt.STT {
  label = 'walkie.GeminiTranscribe';
  private blockedUntil = 0;

  constructor(
    private readonly opts: {
      apiKey: string;
      model: string;
      vocabulary: readonly string[];
      shouldServe: () => boolean;
      onRequest?: () => void;
      fetchImpl?: typeof fetch;
    },
  ) {
    super({ streaming: false, interimResults: false });
  }

  get model(): string {
    return this.opts.model;
  }

  get provider(): string {
    return 'google';
  }

  protected async _recognize(buffer: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    // An empty result, not an error: the adapter's recovery probe then idles quietly.
    if (!this.opts.shouldServe() || Date.now() < this.blockedUntil) return this.final('');
    const frame = mergeFrames(buffer);
    this.opts.onRequest?.();
    const body = {
      model: this.opts.model,
      input: [
        { type: 'audio', data: pcmToWav(frame.data, frame.sampleRate).toString('base64'), mime_type: 'audio/wav' },
      ],
      generation_config: {
        transcription_config: {
          language_codes: [...STT_LANGUAGE_CODES],
          ...(this.opts.vocabulary.length > 0 ? { custom_vocabulary: [...this.opts.vocabulary] } : {}),
          mode: 'verbatim',
        },
      },
    };
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(`${GEMINI_API_BASE}/interactions`, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.opts.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([...(abortSignal ? [abortSignal] : []), AbortSignal.timeout(UNARY_STT_TIMEOUT_MS)]),
      });
    } catch (err) {
      throw new APIConnectionError({
        message: `Gemini transcribe request failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 429) this.blockedUntil = Date.now() + UNARY_STT_BACKOFF_MS;
      const message = (json as { error?: { message?: string } } | null)?.error?.message ?? '';
      throw new APIStatusError({
        message: `Gemini transcribe: ${res.status} ${message.slice(0, 200)}`.trim(),
        options: { statusCode: res.status, body: null },
      });
    }
    return this.final(interactionText(json));
  }

  private final(text: string): stt.SpeechEvent {
    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text,
          language: normalizeLanguage(languageOf(text) ?? DEFAULT_CALL_LANGUAGE),
          confidence: 1,
          startTime: 0,
          endTime: 0,
        },
      ],
    };
  }

  stream(): stt.SpeechStream {
    throw new Error('GeminiTranscribeSTT is not streaming; wrap it in a stt.StreamAdapter');
  }
}

/**
 * The fallback transcription as a stream for LiveKit's `stt.FallbackAdapter`: unary requests cut
 * at its own VAD's pauses. `handBack()` ends its streams, which the adapter takes as a failure
 * and moves the session back to the first available instance, the recovered streaming one.
 */
class FallbackTranscription extends stt.StreamAdapter {
  private readonly streams = new Set<stt.SpeechStream>();

  constructor(
    private readonly unary: GeminiTranscribeSTT,
    vad: VAD,
  ) {
    super(unary, vad);
  }

  override get model(): string {
    return this.unary.model;
  }

  override get provider(): string {
    return this.unary.provider;
  }

  override stream(options?: { connOptions?: APIConnectOptions }): stt.StreamAdapterWrapper {
    const stream = super.stream(options);
    this.streams.add(stream);
    return stream;
  }

  handBack(): void {
    for (const stream of this.streams) stream.close();
    this.streams.clear();
  }
}

/**
 * The session's TTS: each reply goes to the speech model whole, in one request, so it is voiced
 * with one intonation; Gemini streams the audio back as it is made, so speech still starts within
 * seconds. The tokenizer never emits before the reply's text ends.
 */
export function wholeReplySpeech(speech: tts.TTS): tts.StreamAdapter {
  return new tts.StreamAdapter(
    speech,
    new tokenize.basic.SentenceTokenizer({ minTokenLength: Number.POSITIVE_INFINITY }),
  );
}

/**
 * LiveKit's TTS FallbackAdapter without its probe leak: a request that skips a down model starts
 * another recovery probe even while the last one waits to retry, and each such chain probes for
 * the rest of the process. One chain per model is enough.
 */
export class TtsFallback extends tts.FallbackAdapter {
  override markUnAvailable(index: number): void {
    if ((this as unknown as { _recoveryTimeouts: Map<number, unknown> })._recoveryTimeouts.has(index)) return;
    super.markUnAvailable(index);
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

const samplesOf = (ms: number): number => Math.round((ms * INPUT_SAMPLE_RATE) / 1000);

/**
 * Keeps the current caller turn's audio, for recordings: from just before the first speech
 * (the session's user state turning to speaking) until the turn is taken at its end. Only the
 * open turn is held, capped at MAX_RECORDED_TURN_MS.
 */
export class TurnCapture {
  private preRoll: Int16Array[] = [];
  private preRollSamples = 0;
  private chunks: Int16Array[] = [];
  private samples = 0;
  private inTurn = false;
  private speaking = false;
  private startedAt = 0;
  private speechFrom = 0;
  private speechSamples = 0;
  private lastSpeechEnd = 0;
  private truncated = false;

  constructor(private readonly now: () => number = () => Date.now()) {}

  push(frame: AudioFrame): void {
    // The session's room input is 16 kHz mono.
    if (frame.sampleRate === INPUT_SAMPLE_RATE) this.append(frame.data);
  }

  onSpeaking(speaking: boolean): void {
    if (speaking && !this.inTurn) {
      this.inTurn = true;
      this.chunks = this.preRoll;
      this.samples = this.preRollSamples;
      this.preRoll = [];
      this.preRollSamples = 0;
      this.startedAt = this.now() - (this.samples * 1000) / INPUT_SAMPLE_RATE;
    }
    if (speaking && !this.speaking) this.speechFrom = this.samples;
    if (!speaking && this.speaking) this.closeSpeech();
    this.speaking = speaking;
  }

  /** The open turn's audio, trimmed shortly after its last speech; the capture starts over. */
  take(): TurnAudio | undefined {
    if (!this.inTurn) return undefined;
    if (this.speaking) this.closeSpeech(true);
    const length = Math.min(this.samples, this.lastSpeechEnd + samplesOf(RECORDING_PAD_MS));
    const pcm = new Int16Array(length);
    let offset = 0;
    for (const chunk of this.chunks) {
      if (offset >= length) break;
      const part = chunk.subarray(0, length - offset);
      pcm.set(part, offset);
      offset += part.length;
    }
    const audio: TurnAudio = {
      pcm,
      sampleRate: INPUT_SAMPLE_RATE,
      startedAt: this.startedAt,
      endedAt: this.startedAt + (length * 1000) / INPUT_SAMPLE_RATE,
      speechMs: Math.round((this.speechSamples * 1000) / INPUT_SAMPLE_RATE),
      truncated: this.truncated,
    };
    const speaking = this.speaking;
    this.inTurn = false;
    this.speaking = false;
    this.chunks = [];
    this.samples = 0;
    this.speechSamples = 0;
    this.lastSpeechEnd = 0;
    this.truncated = false;
    // Speech already under way belongs to the next turn.
    if (speaking) this.onSpeaking(true);
    return audio;
  }

  /** Speech ends where the VAD's closing silence began; while still speaking, it ends now. */
  private closeSpeech(stillSpeaking = false): void {
    const end = stillSpeaking ? this.samples : Math.max(this.speechFrom, this.samples - samplesOf(VAD_SILENCE_MS));
    this.speechSamples += end - this.speechFrom;
    this.lastSpeechEnd = end;
  }

  private append(pcm: Int16Array): void {
    if (!this.inTurn) {
      this.preRoll.push(pcm);
      this.preRollSamples += pcm.length;
      while (this.preRoll.length > 1 && this.preRollSamples - this.preRoll[0].length >= samplesOf(RECORDING_PAD_MS)) {
        this.preRollSamples -= this.preRoll.shift()!.length;
      }
      return;
    }
    if (this.samples >= samplesOf(MAX_RECORDED_TURN_MS)) {
      this.truncated = true;
      return;
    }
    this.chunks.push(pcm.slice());
    this.samples += pcm.length;
  }
}

/**
 * The page's send cue: while a stretch of caller speech waits out the closing silence that sends
 * it, the `nanoclaw.walkie.pending` attribute says how far into that silence it is; it clears
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

/** WALKIE_RECORDINGS_DAYS: 0 (the default) records nothing. */
export function recordingDays(raw: string | undefined): number {
  const days = Number(raw?.trim() || 0);
  return Number.isInteger(days) && days > 0 ? days : 0;
}

/** The call's voice: what the walkie needs from the session in the room. Faked in tests. */
export interface CallVoice {
  /** Speak a line, uninterruptible; resolves after playout with whether all of it was synthesized. */
  say(text: string): Promise<boolean>;
  /** The `nanoclaw.walkie.thinking` attribute. */
  setThinking(thinking: boolean): void;
  /** One message on the `nanoclaw.walkie.turn` topic. */
  publishTurn(status: WalkieTurnStatus): void;
  /** One message on the `nanoclaw.walkie.reply` topic, sent right before the line it describes is spoken. */
  publishReply(info: WalkieReplyInfo): void;
  close(): Promise<void>;
}

/** What the session reports back. `audio` is the turn's recording, when recordings are on. */
export interface CallVoiceEvents {
  onTurn(text: string, turn: TurnTake): void;
  onCallerSpeaking(speaking: boolean): void;
  /** The caller spoke but no transcript came of it: the transcription failed, or heard no words. */
  onTurnLost(reason: 'stt' | 'empty', fields: Record<string, unknown>, turn: TurnTake): void;
  /** Speech too short to count as a turn, with nothing transcribed (a cough, a noise). */
  onTurnDropped(turn: TurnTake): void;
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

export interface WalkieDeps {
  send(text: string): Promise<SendResult>;
  say(text: string): Promise<boolean>;
  setThinking(thinking: boolean): void;
  /** What the line about to be spoken is, for the page's caption labels. */
  announce?(info: WalkieReplyInfo): void;
  log: Pick<Console, 'info' | 'warn'>;
  now?: () => number;
}

/**
 * The walkie-talkie rules on top of the session: turns out in order, replies in when the caller
 * is not mid-turn, "thinking" while the agent works, and a spoken line when something is lost.
 */
export class Walkie {
  private readonly now: () => number;
  private callerSpeaking = false;
  /** Until then, the caller's last speech may still be committed as a turn. */
  private turnOpenUntil = 0;
  private sends: Promise<void> = Promise.resolve();
  private speech: Promise<void> = Promise.resolve();
  private readonly wakers = new Set<() => void>();
  private thinkingUntil = 0;
  private thinking?: boolean;
  private statusTimer?: ReturnType<typeof setTimeout>;
  private feedbackQueued = false;
  private closed = false;
  /** Spoken lines queued or playing, so a line can say another one follows it. */
  private queued = 0;
  private replies = 0;
  private readonly partsByTurn = new Map<number, number>();
  /** Whether the call talks in a chat (the host's `chat` event), so its lines can point there. */
  private inChat = false;

  constructor(
    private readonly deps: WalkieDeps,
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

  /** A finished caller turn; sent to the host in order, without holding up the session. */
  onTurn(text: string, onSent?: (result: SendResult) => void): void {
    if (this.closed) return;
    this.turnOpenUntil = 0;
    this.options.language = languageOf(text) ?? this.options.language;
    this.wake();
    this.sends = this.sends
      .then(() => this.sendTurn(text, onSent))
      .catch((err: unknown) => this.deps.log.warn('walkie: sending a turn failed', { err }));
  }

  onTurnLost(reason: 'stt' | 'empty', fields: Record<string, unknown> = {}): void {
    if (this.closed) return;
    this.deps.log.warn(`walkie: a turn was lost (${reason})`, fields);
    this.feedback('turn');
  }

  /**
   * A complete agent message from the host. `turn` is the caller turn it answers, null when it
   * answers none of this call's turns, undefined when that is not known.
   */
  onReply(text: string, turn?: number | null): void {
    if (this.closed) return;
    this.thinkingUntil = 0;
    this.refresh();
    const full = speakableText(text);
    if (!full) return;
    const max = this.options.maxSpokenChars ?? DEFAULT_MAX_SPOKEN_CHARS;
    if (max > 0 && full.length > max) {
      this.deps.log.info('walkie: a long message is cut for speech', { chars: full.length, max });
    }
    this.enqueue(async () => {
      // Cut when spoken, so the closing line is in the language of the caller's latest turn.
      const spoken = capSpokenText(full, max, this.options.language, this.inChat);
      if (typeof turn === 'number') {
        const part = (this.partsByTurn.get(turn) ?? 0) + 1;
        this.partsByTurn.set(turn, part);
        this.announce({ turn, part });
      } else {
        this.announce(turn === null ? { unprompted: true } : {});
      }
      if (!(await this.deps.say(spoken)) && !this.closed) {
        this.deps.log.warn('walkie: a reply could not be synthesized');
        this.feedback('reply');
      }
    });
  }

  /** The host's `chat` event: the call now talks in a chat, or on the voice line. */
  onChat(inChat: boolean): void {
    this.inChat = inChat;
  }

  /** The agent is still working (the host's typing refresh). */
  onThinking(): void {
    if (this.closed) return;
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
      this.deps.log.warn('walkie: could not hand the turn to the host', { err });
      return { accepted: false, error: err instanceof Error ? err.message : String(err) };
    });
    onSent?.(result);
    if (this.closed) return;
    if (!result.accepted) return this.feedback(hostLossReason(result));
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
      await this.deps.say(FAILURE_LINES[line][this.options.language]);
    });
  }

  private announce(info: Omit<WalkieReplyInfo, 'reply' | 'more'>): void {
    this.deps.announce?.({ reply: ++this.replies, ...info, ...(this.queued > 1 ? { more: true } : {}) });
  }

  private enqueue(job: () => Promise<void>): void {
    this.queued++;
    this.speech = this.speech
      .then(async () => {
        await this.callerIdle();
        if (!this.closed) await job();
      })
      .catch((err: unknown) => this.deps.log.warn('walkie: speaking failed', { err }))
      .finally(() => this.queued--);
  }

  /** Resolves when the caller is neither talking nor about to have a turn committed, or after a cap. */
  private async callerIdle(): Promise<void> {
    const deadline = this.now() + this.options.silenceMs + MAX_IDLE_WAIT_MS;
    while (!this.closed) {
      const t = this.now();
      if (!this.callerSpeaking && t >= this.turnOpenUntil) return;
      if (t >= deadline) {
        this.deps.log.info('walkie: the caller is still talking; the reply takes the channel');
        return;
      }
      const until = this.callerSpeaking ? deadline : Math.min(deadline, this.turnOpenUntil);
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

  private refresh(): void {
    if (this.closed) return;
    const t = this.now();
    const next = t < this.thinkingUntil;
    clearTimeout(this.statusTimer);
    if (next) {
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
    throw new Error('voice worker: job metadata is not a NanoClaw walkie-talkie call of this version');
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

/** What a call's session needs besides the job metadata. */
export interface VoiceSettings {
  geminiKey: string;
  record: boolean;
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
  /** Where turn recordings are written; NanoClaw's data directory by default. */
  recordingsRoot?: string;
  /** Tell the caller's page this worker cannot serve the host's protocol version. */
  markUpdating(ctx: CallJob): Promise<void>;
  log: Pick<Console, 'info' | 'warn'>;
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
  fallbackVad?: VAD;
}

const loadVad = (): Promise<VAD> => silero.VAD.load({ sampleRate: INPUT_SAMPLE_RATE });
const loadFallbackVad = (): Promise<VAD> =>
  silero.VAD.load({
    sampleRate: INPUT_SAMPLE_RATE,
    minSilenceDuration: FALLBACK_MIN_SILENCE_MS,
    minSpeechDuration: FALLBACK_MIN_SPEECH_MS,
  });

class WalkieAgent extends voice.Agent {
  constructor(
    private readonly onTurn: (text: string) => void,
    private readonly tap?: (frame: AudioFrame) => void,
  ) {
    super({ instructions: '' });
  }

  /** With no LLM in the session, nothing answers after this; the host's agent does, later. */
  override async onUserTurnCompleted(_chatCtx: llm.ChatContext, message: llm.ChatMessage): Promise<void> {
    this.onTurn(message.textContent?.trim() ?? '');
  }

  /** The audio the transcription gets (silence while the agent speaks), copied for recordings. */
  override async sttNode(
    audio: ReadableStream<AudioFrame> | AsyncIterable<AudioFrame>,
    modelSettings: voice.ModelSettings,
  ): Promise<ReadableStream<stt.SpeechEvent | string> | null> {
    const tap = this.tap;
    if (!tap) return super.sttNode(audio, modelSettings);
    const source = audio instanceof ReadableStream ? audio : ReadableStream.from(audio);
    const copied = source.pipeThrough(
      new TransformStream<AudioFrame, AudioFrame>({
        transform(frame, controller) {
          tap(frame);
          controller.enqueue(frame);
        },
      }),
    );
    return super.sttNode(copied, modelSettings);
  }
}

const setAttribute = async (ctx: CallJob, key: string, value: string): Promise<void> => {
  await ctx.room.localParticipant?.setAttributes({ [key]: value });
};

type WorkerLog = Pick<Console, 'info' | 'warn' | 'error'>;

/** The agents-js logger as `(message, fields)`, the shape the walkie code logs in. */
const workerLog = (logger: ReturnType<typeof agentsLog>): WorkerLog => ({
  info: (msg: string, fields?: unknown) => logger.info(fields ?? {}, msg),
  warn: (msg: string, fields?: unknown) => logger.warn(fields ?? {}, msg),
  error: (msg: string, fields?: unknown) => logger.error(fields ?? {}, msg),
});

/**
 * The call's AgentSession: VAD turns, streaming STT, Gemini TTS, no LLM, wired to `events`. Not
 * started; `sessionVoice` starts it in the room.
 */
export function walkieSession(
  meta: LiveKitJobMetadata,
  settings: VoiceSettings,
  vads: { vad: VAD; fallbackVad?: VAD },
  events: CallVoiceEvents,
  log: WorkerLog,
  publishPending: (value: string) => void = () => undefined,
): { session: voice.AgentSession; agent: voice.Agent; say(text: string): Promise<boolean> } {
  const apiKey = settings.geminiKey;
  const countdown = new SendCountdown(publishPending, meta.silenceMs);
  const capture = settings.record ? new TurnCapture() : undefined;
  // The host already trimmed, deduplicated and capped it.
  const vocabulary = meta.vocabulary ?? [];
  const streaming = new google.beta.GeminiSTT({
    apiKey,
    model: meta.sttModel,
    languageCodes: [...STT_LANGUAGE_CODES],
    customVocabulary: vocabulary,
    sampleRate: INPUT_SAMPLE_RATE,
  });

  // The fallback transcribes only while it is the adapter's elected stream. The session goes back
  // to the streaming model once that recovers, or every HAND_BACK_RETRY_MS, always at a pause, so
  // a turn is never split between the two.
  let fallback: FallbackTranscription | undefined;
  let adapter: stt.FallbackAdapter | undefined;
  let transcription: stt.STT = streaming;
  let turnOpen = false;
  let speakingSince = 0;
  let turnSpeechMs = 0;
  let fallbackSince = 0;
  let streamingRecovered = false;
  const fallbackModel = meta.sttFallbackModel;
  const fallbackServing = (): boolean => fallback !== undefined && adapter?._served?.stt === fallback;
  if (fallbackModel && vads.fallbackVad) {
    fallback = new FallbackTranscription(
      new GeminiTranscribeSTT({
        apiKey,
        model: fallbackModel,
        vocabulary,
        shouldServe: fallbackServing,
        onRequest: () => log.warn(`voice worker: speech sent to the fallback transcription ${fallbackModel}`),
      }),
      vads.fallbackVad,
    );
    adapter = new stt.FallbackAdapter({ sttInstances: [streaming, fallback] });
    (adapter as unknown as NodeJS.EventEmitter).on('stt_availability_changed', (ev: stt.AvailabilityChangedEvent) => {
      if (ev.stt !== streaming) return;
      if (ev.available) {
        streamingRecovered = true;
        log.info(`voice worker: ${meta.sttModel} recovered; the transcription goes back to it at the next pause`);
        handBack();
      } else {
        log.error(
          `voice worker: the streaming transcription ${meta.sttModel} failed; ${fallbackModel} transcribes ` +
            'until it is back (its quota is small: requests a minute and a day are limited)',
        );
      }
    });
    transcription = adapter;
  }
  const handBack = () => {
    if (!fallbackServing()) {
      fallbackSince = 0;
      return;
    }
    const now = Date.now();
    fallbackSince ||= now;
    if (turnOpen || (!streamingRecovered && now - fallbackSince < HAND_BACK_RETRY_MS)) return;
    log.info(`voice worker: handing the transcription back to ${meta.sttModel}`);
    streamingRecovered = false;
    fallbackSince = 0;
    fallback?.handBack();
  };
  const handBackTimer = fallback ? setInterval(handBack, HAND_BACK_CHECK_MS) : undefined;
  handBackTimer?.unref();
  const heardBy = new Set<string>();
  const take = (): TurnTake => {
    const models = [...heardBy];
    heardBy.clear();
    turnOpen = false;
    turnSpeechMs = 0;
    const turn = { audio: capture?.take(), sttModel: models.length > 0 ? models.join('+') : transcription.model };
    countdown.clear();
    handBack();
    return turn;
  };

  const primaryTts = new google.beta.TTS({ apiKey, model: meta.ttsModel, voiceName: meta.ttsVoice, instructions: '' });
  let speech: tts.TTS = primaryTts;
  let ttsAdapter: tts.FallbackAdapter | undefined;
  if (meta.ttsFallbackModel) {
    ttsAdapter = new TtsFallback({
      ttsInstances: [
        primaryTts,
        new google.beta.TTS({ apiKey, model: meta.ttsFallbackModel, voiceName: meta.ttsVoice, instructions: '' }),
      ],
      maxRetryPerTTS: 1,
      recoveryDelayMs: TTS_RECOVERY_DELAY_MS,
    });
    (ttsAdapter as unknown as NodeJS.EventEmitter).on(
      'tts_availability_changed',
      (ev: tts.AvailabilityChangedEvent) => {
        const model = ev.tts === primaryTts ? meta.ttsModel : meta.ttsFallbackModel;
        if (ev.available) log.info(`voice worker: speech model ${model} is back`);
        else log.warn(`voice worker: speech model ${model} failed; the next one speaks`);
      },
    );
    speech = ttsAdapter;
  }

  const session = new voice.AgentSession({
    vad: vads.vad,
    stt: transcription,
    tts: wholeReplySpeech(speech),
    turnHandling: {
      // The turn detector models have no Ukrainian; the default would build one anyway.
      turnDetection: 'vad',
      // maxDelay is a turn detector's, and there is none.
      endpointing: { mode: 'fixed', minDelay: meta.silenceMs, maxDelay: meta.silenceMs },
      interruption: { enabled: false, mode: 'vad', discardAudioIfUninterruptible: true },
      preemptiveGeneration: { enabled: false },
    },
    userAwayTimeout: null,
    transcriptionTimeout: TRANSCRIPTION_TIMEOUT_MS,
    ttsReadIdleTimeout: TTS_IDLE_TIMEOUT_MS,
    forwardAudioIdleTimeout: TTS_IDLE_TIMEOUT_MS,
    // speakableText already made the reply plain.
    ttsTextTransforms: ['filter_emoji'],
    connOptions: {
      // The defaults close the session on the 4th STT or TTS failure, however long the call.
      maxUnrecoverableErrors: 50,
      // A fallback adapter retries each model itself. Its STT stream cannot be retried in place
      // (the first attempt closes its input, so a retry ends silently and the session stops
      // transcribing): a failure must end it, and the session then opens a new one.
      sttConnOptions: { maxRetry: adapter ? 0 : 3 },
      ttsConnOptions: { maxRetry: ttsAdapter ? 0 : 3 },
    },
  });

  let agentSpeaking = false;
  let agentSpokeAt = 0;
  let sttFailedAt = 0;
  let ttsFailures = 0;
  session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
    const speaking = ev.newState === 'speaking';
    if (speaking) {
      turnOpen = true;
      speakingSince = Date.now();
      countdown.clear();
    } else if (ev.oldState === 'speaking') {
      turnSpeechMs += Math.max(0, Date.now() - speakingSince - VAD_SILENCE_MS);
      // Speech heard under the agent's is not transcribed, so it sends nothing to count down to.
      if (turnOpen && !agentSpeaking && agentSpokeAt < speakingSince) countdown.stopped(ev.createdAt - VAD_SILENCE_MS);
    }
    capture?.onSpeaking(speaking);
    events.onCallerSpeaking(speaking);
  });
  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
    if (ev.isFinal && ev.transcript.trim()) heardBy.add(transcription.model);
  });
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
    agentSpeaking = ev.newState === 'speaking';
    if (ev.oldState === 'speaking' || agentSpeaking) agentSpokeAt = Date.now();
    if (agentSpeaking) countdown.clear();
  });
  session.on(voice.AgentSessionEventTypes.Error, (ev) => {
    const err = ev.error;
    if (err.recoverable) return;
    if (err.type === 'stt_error') sttFailedAt = Date.now();
    if (err.type === 'tts_error') ttsFailures++;
  });
  session.on(voice.AgentSessionEventTypes.UserTranscriptionTimeout, (ev) => {
    // Silero reports no speech length at its end of speech, so the session counts it.
    const spokeMs = turnSpeechMs;
    const turn = take();
    // While the agent speaks the transcription hears silence on purpose: the caller is not heard.
    if (agentSpeaking || agentSpokeAt >= ev.vadSpeechStartedAt) return;
    const sttFailed = sttFailedAt >= ev.vadSpeechStartedAt;
    if (spokeMs < MIN_LOST_SPEECH_MS && !sttFailed) return events.onTurnDropped(turn);
    events.onTurnLost(sttFailed ? 'stt' : 'empty', { speechMs: spokeMs }, turn);
  });
  session.on(voice.AgentSessionEventTypes.Close, (ev) => {
    clearInterval(handBackTimer);
    countdown.clear();
    // The session closes neither; their recovery probes would run on.
    void adapter?.close().catch(() => undefined);
    void ttsAdapter?.close().catch(() => undefined);
    events.onClosed(`session closed: ${ev.reason}`);
  });

  return {
    session,
    agent: new WalkieAgent(
      (text) => {
        const turn = take();
        if (text) events.onTurn(text, turn);
      },
      capture && ((frame) => capture.push(frame)),
    ),
    async say(text) {
      // Replies are spoken one at a time, so a failure counted meanwhile is this one's.
      const failures = ttsFailures;
      await session.say(text, { allowInterruptions: false, addToChatCtx: false }).waitForPlayout();
      return ttsFailures === failures;
    },
  };
}

/** The real room: the call's session on the caller's microphone and the agent's published track. */
async function sessionVoice(
  ctx: JobContext,
  meta: LiveKitJobMetadata,
  settings: VoiceSettings,
  events: CallVoiceEvents,
): Promise<CallVoice> {
  const log = workerLog(agentsLog().child({ callId: meta.callId }));
  const userData = ctx.proc.userData as WorkerUserData;
  userData.vad ??= await loadVad();
  if (meta.sttFallbackModel) userData.fallbackVad ??= await loadFallbackVad();
  const { session, agent, say } = walkieSession(
    meta,
    settings,
    { vad: userData.vad, fallbackVad: userData.fallbackVad },
    events,
    log,
    (value) => void setAttribute(ctx, WALKIE_PENDING_ATTRIBUTE, value).catch(() => undefined),
  );
  await session.start({
    agent,
    room: ctx.room,
    // 16 kHz in: what Silero, the transcription and the recordings all take.
    inputOptions: {
      participantIdentity: meta.callerIdentity,
      textEnabled: false,
      audioSampleRate: INPUT_SAMPLE_RATE,
    },
    record: false,
  });
  return {
    say,
    setThinking(thinking) {
      void setAttribute(ctx, WALKIE_THINKING_ATTRIBUTE, thinking ? '1' : '').catch(() => undefined);
    },
    publishTurn(status) {
      void ctx.room.localParticipant
        ?.sendText(JSON.stringify(status), { topic: WALKIE_TURN_TOPIC })
        .catch((err: unknown) => log.warn('voice worker: could not publish a turn status', { err }));
    },
    publishReply(info) {
      void ctx.room.localParticipant
        ?.sendText(JSON.stringify(info), { topic: WALKIE_REPLY_TOPIC })
        .catch((err: unknown) => log.warn('voice worker: could not publish a reply label', { err }));
    },
    async close() {
      await session.close().catch(() => undefined);
    },
  };
}

function defaultDeps(): RunCallDeps {
  return {
    env: workerEnv([
      'GEMINI_API_KEY',
      'LIVEKIT_API_SECRET',
      'LIVEKIT_HOST_URL',
      'WALKIE_RECORDINGS_DAYS',
      'WALKIE_MAX_SPOKEN_CHARS',
    ]),
    createVoice: (ctx, meta, settings, events) => sessionVoice(ctx as JobContext, meta, settings, events),
    markUpdating: (ctx) => setAttribute(ctx, WALKIE_UPDATING_ATTRIBUTE, '1'),
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
  const record = recordingDays(deps.env.WALKIE_RECORDINGS_DAYS) > 0;

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
  const walkie = new Walkie(
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
      say: (text) => callVoice?.say(text) ?? Promise.resolve(false),
      setThinking: (thinking) => callVoice?.setThinking(thinking),
      announce: (info) => callVoice?.publishReply(info),
      log: callLog,
    },
    {
      silenceMs: meta.silenceMs,
      language: DEFAULT_CALL_LANGUAGE,
      maxSpokenChars: maxSpokenChars(deps.env.WALKIE_MAX_SPOKEN_CHARS),
    },
  );
  /** `restart`: the worker is shutting down, so the caller's page says the service restarted. */
  const end = async (reason: string, tellHost: boolean, restart = false) => {
    if (ending) return;
    ending = true;
    walkie.close();
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
  /** The host's utterance id of each sent turn to its number here, to tell the page what a reply answers. */
  const turnsByHostId = new Map<string, number>();
  /** Turns the host did not confirm, by turn key, until its `turn-stored` says the agent has one after all. */
  const unconfirmed = new Map<string, { turn: number; text: string }>();
  const publish = (status: WalkieTurnStatus) => callVoice?.publishTurn(status);
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
  try {
    callVoice = await deps.createVoice(
      ctx,
      meta,
      { geminiKey, record },
      {
        onTurn: (text, take) => {
          const turn = ++turns;
          walkie.onTurn(text, (host) => {
            if (host.accepted && host.id) turnsByHostId.set(host.id, turn);
            if (!host.accepted && host.turnKey && hostLossReason(host) === 'timeout') {
              unconfirmed.set(host.turnKey, { turn, text });
              for (const key of unconfirmed.keys()) {
                if (unconfirmed.size <= MAX_UNCONFIRMED_TURNS) break;
                unconfirmed.delete(key);
              }
            }
            publish(
              host.accepted
                ? { turn, status: 'sent', text }
                : { turn, status: 'lost', reason: hostLossReason(host), text },
            );
            saveTurn(turn, take, text, { host });
          });
        },
        onCallerSpeaking: (speaking) => walkie.onCallerSpeaking(speaking),
        onTurnLost: (reason, fields, take) => {
          if (ending) return;
          const turn = ++turns;
          walkie.onTurnLost(reason, fields);
          publish({ turn, status: 'lost', reason });
          saveTurn(turn, take, '', { reason });
        },
        onTurnDropped: (take) => {
          if (!ending) saveTurn(++turns, take, '', { reason: 'noise' });
        },
        onClosed: (reason) => void end(reason, true),
      },
    );
  } catch (err) {
    walkie.close();
    return abandon('could not set up the call audio', { err });
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
      else if (event.type === 'reply')
        // A host that sends no turn at all predates reply labels: not known, so no label.
        walkie.onReply(event.text, typeof event.turn === 'string' ? turnsByHostId.get(event.turn) : event.turn);
      else if (event.type === 'thinking') walkie.onThinking();
      else if (event.type === 'chat') walkie.onChat(event.chat);
      else if (event.type === 'turn-stored') {
        const late = unconfirmed.get(event.turnKey);
        if (!late) return;
        unconfirmed.delete(event.turnKey);
        turnsByHostId.set(event.id, late.turn);
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

export default defineAgent({
  // Loaded once per idle job process, before a call is assigned to it.
  prewarm: async (proc: JobProcess) => {
    const userData = proc.userData as WorkerUserData;
    userData.vad = await loadVad();
    userData.fallbackVad = await loadFallbackVad();
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
    'WALKIE_RECORDINGS_DAYS',
    'WALKIE_MAX_SPOKEN_CHARS',
  ]);
  // agents-js initializes its logger once the CLI runs a command; console until then.
  console.info(
    `voice worker: protocol v${LIVEKIT_PROTOCOL_VERSION}, host URL ${liveKitHostUrl(env)} (LIVEKIT_HOST_URL)`,
  );
  const keepDays = recordingDays(env.WALKIE_RECORDINGS_DAYS);
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
      // them; a call can run up to GPT_LIVE_MAX_CALL_SECONDS, so a restart cuts longer ones short.
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
