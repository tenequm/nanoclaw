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
 *    `session.say()` once the caller is not mid-turn, in full (cut at a
 *    sentence end only when VOICE_MAX_SPOKEN_CHARS sets a cap), uninterruptible: while
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
import { AudioFrame, AudioSource, LocalAudioTrack, RoomEvent, TrackPublishOptions, type Room } from '@livekit/rtc-node';

import {
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
import {
  DEFAULT_WAKE_MODEL,
  WAKE_SAMPLE_RATE,
  WakeWordSpotter,
  defaultThreshold,
  type SpotterClassifier,
  type WakeWordStats,
} from './voice-wakeword.js';

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
/**
 * A speech model that failed in an earlier call is skipped this long at the start of the next one
 * (out of its daily quota, every call's first reply would pay for finding that out again); the
 * fallback adapter's recovery probe brings it back as soon as it answers.
 */
export const TTS_DOWN_MEMORY_MS = 10 * 60_000;
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
/** After done, silence goes to the transcription at least this long, so it finalizes the last words. */
const FLUSH_MIN_MS = 700;
/** The unary fallback closes speech at its own 1 s pause and then makes a request: a longer flush. */
const FLUSH_FALLBACK_MIN_MS = 2_500;
/** The flush ends once no interim text waits for its final and nothing was heard for this long... */
export const FLUSH_QUIET_MS = 400;
/** ...or after this long, with what is still interim text left unverified. */
export const FLUSH_TIMEOUT_MS = 4_000;
const FLUSH_POLL_MS = 50;
/** The flush's silence goes to the transcription in chunks this long. */
const FLUSH_CHUNK_MS = 100;
/**
 * Clearing the session's turn restarts its transcription. A discard holds the next operation this
 * long, and for up to STALE_STREAM_MS words from a stream older than the restart are dropped.
 */
export const CLEAR_SETTLE_MS = 300;
const STALE_STREAM_MS = 2_000;
/**
 * The restarted transcription takes no audio until its Gemini session is set up; talk waits for
 * that, and for no longer than this, so a session that never reports it cannot hold talk shut.
 */
export const STT_READY_TIMEOUT_MS = 3_000;
/** agents-js's session control topic (its TOPIC_SESSION_MESSAGES), served to the caller unless closed. */
const SESSION_CONTROL_TOPIC = 'lk.agent.session';
/** After a spoken line, the your-turn cue waits this long for the next one to start. */
export const TURN_CUE_DELAY_MS = 600;
/** A your-turn cue this soon after the last one is the same hand-over, and stays silent. */
const TURN_CUE_REPEAT_MS = 3_000;
/** The listening cue waits this long for the page's settings (`?cues=0` turns cues off), then plays. */
export const READY_CUE_WAIT_MS = 2_000;
/** Review mode's waits, on the global timers (which tests can fake). */
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** VOICE_MAX_SPOKEN_CHARS when unset: 0, no cap; a reply is spoken in full however long it runs. */
export const DEFAULT_MAX_SPOKEN_CHARS = 0;
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
  label = 'voice.GeminiTranscribe';
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
 * The streaming transcription, saying when each stream it opens starts taking audio. Gemini's
 * stream reads its input only once `live.connect` has resolved, which @google/genai holds until the
 * server's setupComplete; audio pushed before that waits in the stream's queue and reaches the model
 * late, in a burst. Review talk waits for this so the caller never speaks into a stream still
 * connecting. `onReading` gets the stream's number (1, 2, ... in opening order) the first time it reads.
 */
export class ReadyingGeminiSTT extends google.beta.GeminiSTT {
  private opened = 0;

  constructor(
    opts: ConstructorParameters<typeof google.beta.GeminiSTT>[0],
    private readonly onReading: (stream: number) => void,
  ) {
    super(opts);
  }

  /** Streams opened so far. */
  get streamsOpened(): number {
    return this.opened;
  }

  override stream(options?: Parameters<google.beta.GeminiSTT['stream']>[0]): stt.SpeechStream {
    const stream = super.stream(options);
    const number = ++this.opened;
    // The input queue is the stream's own (protected in agents-js); only its send loop reads it.
    const input = (stream as unknown as { input?: { next?: (...args: unknown[]) => unknown } }).input;
    const next = input?.next;
    if (!input || typeof next !== 'function') {
      this.onReading(number);
      return stream;
    }
    let told = false;
    input.next = (...args: unknown[]) => {
      if (!told) {
        told = true;
        this.onReading(number);
      }
      return next.apply(input, args);
    };
    return stream;
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

/** When `model` was last seen failing, per the state file, if within TTS_DOWN_MEMORY_MS; else null. */
export function ttsDownSince(file: string, model: string, now = Date.now()): number | null {
  try {
    const at = (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>)[model];
    return typeof at === 'number' && now - at < TTS_DOWN_MEMORY_MS ? at : null;
  } catch {
    return null;
  }
}

/** Record that `model` failed (or is back), for the next calls. Best effort: a call never fails on it. */
export function setTtsDown(file: string, model: string, down: boolean, now = Date.now()): void {
  try {
    let state: Record<string, unknown> = {};
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      // No state yet.
    }
    if (down) state[model] = now;
    else delete state[model];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
  } catch {
    // Only a lost shortcut.
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

/** The call's voice: what turn-taking needs from the session in the room. Faked in tests. */
export interface CallVoice {
  /** Speak a line, uninterruptible; resolves after playout with whether all of it was synthesized. */
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
  /** Clear the page's send countdown (the `nanoclaw.voice.pending` attribute). */
  clearPending?(): void;
  /** Review mode's controls on the session; absent where the session cannot run it. */
  review?: ReviewSession;
  /** Play a sound cue on the call's cue track; resolves once the track took all of it (heard about 0.1 s later). */
  playCue?(kind: CueKind): Promise<void>;
  close(): Promise<void>;
}

/** What review mode needs from the session in the room. */
export interface ReviewVoice {
  /** Manual turn detection: no pause ends a turn. */
  setManualTurns(manual: boolean): void;
  /** Whether the caller's audio reaches the session at all (VAD and transcription). */
  setInput(enabled: boolean): void;
  /** Feed silence to the transcription, so it finalizes what it has heard. */
  setFlushing(on: boolean): void;
  /**
   * Drop the session's own open turn; its transcription restarts. Returns the restarted stream's
   * number, and when that stream takes audio (resolved at once when nothing restarts).
   */
  clearTurn(): { stream: number; ready: Promise<void> };
  /** How long a flush runs at least. */
  flushMinMs(): number;
  /** The open turn's recording, taken once its text is frozen. */
  takeTurn(): TurnTake;
  /** One message on the `nanoclaw.voice.review` topic. */
  publishReview(state: CallReviewState): void;
}

export interface ReviewSession extends ReviewVoice {
  /**
   * Answer the page's review and settings RPCs with `handle`, and tell the page review mode and
   * spoken commands are on offer.
   */
  serve(handle: (op: ReviewOp, payload: string, callerIdentity: string) => Promise<string>): void;
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
  /** True while review mode runs: pauses end no turn, and the auto turn rules stand aside. */
  reviewing?(): boolean;
  /** Whether the closing silence sends the open turn (the page's countdown); by default, outside review. */
  pausesSend?(): boolean;
  /** A transcript from the session's transcription stream number `stream` (it restarts with a new number). */
  onTranscript?(text: string, final: boolean, stream: number): void;
  /** The transcription failed for good on a stretch of speech. */
  onSttError?(): void;
  /** The agent's audio started or stopped playing. */
  onAgentSpeaking?(speaking: boolean): void;
  /** The caller started speaking while the agent's line played: none of it is transcribed. */
  onUnheardSpeech?(): void;
  /** The caller's audio as the transcription gets it: 16 kHz mono frames. */
  onAudio?(frame: AudioFrame): void;
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
  /**
   * Like a caller mid-turn, these hold replies for a while: an open review recording, and a turn
   * after the wake phrase, which only `send it` sends.
   */
  private readonly holds = new Set<'review' | 'wake'>();
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

  /** Review mode opened or closed a recording, or the wake phrase opened or closed a turn. */
  setCaptureOpen(open: boolean, by: 'review' | 'wake' = 'review'): void {
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
    this.refresh();
    const full = speakableText(text);
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
      if (await this.say(spoken)) return;
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
      this.deps.log.warn('voice worker: sending a turn threw', { err });
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

/**
 * The call's sound cues, played by the worker on its own track (CALL_CUE_TRACK): `listening` once the
 * call is ready (and when a review recording opens), `wake` on the wake phrase, `sent` as a turn goes
 * out, `discard` on a spoken discard, `turn` once the agent is done and nothing else is queued, `nope`
 * for a command with nothing to act on, `draft` when a review draft is ready to read. Nothing plays
 * while the agent works or speaks.
 */
export type CueKind = 'listening' | 'wake' | 'sent' | 'discard' | 'turn' | 'nope' | 'draft';

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

/** How long after a spotted wake word its phrase is looked for in the transcript, and in how many finals. */
const WAKE_TEXT_WINDOW_MS = 10_000;
const WAKE_TEXT_FINALS = 2;
/** A final dropped this shortly before a spotted wake word may have carried it. */
const WAKE_LATE_FINAL_MS = 3_000;

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

/** A word's consonants, voicing and doubling ignored: `livekit`, `live kit`, `lifekit` and `Лайвкіт` read alike. */
const consonantSkeleton = (word: string): string =>
  word
    .replace(/[aeiouy]/g, '')
    .replace(/[fw]/g, 'v')
    .replace(/d/g, 't')
    .replace(/g/g, 'k')
    .replace(/b/g, 'p')
    .replace(/z/g, 's')
    .replace(/(.)\1+/g, '$1');

/** Edits between two strings (Levenshtein). */
function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}

/**
 * Where an acoustic wake phrase (`hey livekit`) sits in a transcript, however the transcription
 * spelled its name: the name's consonants in one to three words, with a `hey` before it. Only used
 * right after the audio said the phrase was spoken, so it can be lenient: a text that opens with
 * `hey` loses it and the one to three words after it when their consonants are near the name's and
 * end as its do (`Hey, little kid`, `Hey, you've got`). `lenient: false` takes only the name's own
 * consonants, for a final that already went by before the audio spotted the phrase.
 */
export function matchWakeText(text: string, phrase: string, lenient = true): { start: number; end: number } | null {
  const phraseWords = spokenWords(phrase).map((w) => w.word);
  const nameWords = WAKE_WORDS.has(phraseWords[0]) && phraseWords.length > 1 ? phraseWords.slice(1) : phraseWords;
  const name = nameWords.join('');
  const skeleton = consonantSkeleton(name);
  const fuzzy = skeleton.length >= 3;
  // A short name by its letters with any vowels: `Den` and `Ден` are `dan`.
  const vowelBlind = name.length >= 3 ? nameSkeleton(name) : undefined;
  const words = spokenWords(text);
  for (let i = 0; i < words.length; i++) {
    let joined = '';
    for (let k = i; k < Math.min(words.length, i + 3); k++) {
      joined += words[k].word;
      const same = joined === name || (vowelBlind !== undefined && nameSkeleton(joined) === vowelBlind);
      if (!same && (!fuzzy || consonantSkeleton(joined) !== skeleton)) continue;
      const lead = i > 0 && WAKE_WORDS.has(words[i - 1].word);
      return { start: words[lead ? i - 1 : i].start, end: words[k].end };
    }
  }
  if (!lenient || !fuzzy || words.length < 2 || !WAKE_WORDS.has(words[0].word)) return null;
  const allowed = Math.floor(skeleton.length / 2);
  let best: { end: number; distance: number } | null = null;
  let joined = '';
  for (let k = 1; k < Math.min(words.length, 4); k++) {
    joined += words[k].word;
    const said = consonantSkeleton(joined);
    // Near, and ending as the name does: `what` is not `livekit`, `you've got` may be.
    if (!said.endsWith(skeleton.slice(-2))) continue;
    const distance = editDistance(said, skeleton);
    if (distance <= allowed && (!best || distance < best.distance)) best = { end: words[k].end, distance };
  }
  return best && { start: words[0].start, end: best.end };
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
 * counts: `send it to Anna` is words, while a sentence that really ends in `send it` sends.
 */
export function matchCommand(text: string): { command: SpokenCommand; rest: string } | null {
  const words = spokenWords(text);
  for (const [command, phrase] of COMMANDS) {
    if (words.length < phrase.length) continue;
    const tail = words.slice(words.length - phrase.length);
    if (!tail.every((w, i) => w.word === phrase[i])) continue;
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

/** What was said before a command, without the punctuation that led into it. */
const trimCommandRest = (text: string): string => text.replace(/[\s,;:–—-]+$/u, '').trim();

/** How long a command the audio spotted waits for the final that ends its utterance. */
const SPOTTED_COMMAND_WAIT_MS = 3_000;
/** A final taken this shortly before a spotted command may have carried it. */
const SPOTTED_COMMAND_LATE_MS = 1_500;

/**
 * Where the words of a command the audio spotted (`send it`) sit in a transcript, however the
 * transcription heard them (`sent in`, `sandy`, `scratched at`): one to three words whose consonants
 * are within a third of the phrase's (a short phrase's first one the same). At the end of the text
 * first (`last`: nothing is said after them), else the nearest anywhere.
 */
export function matchSpottedCommand(text: string, phrase: string): { start: number; last: boolean } | null {
  const target = consonantSkeleton(
    spokenWords(phrase)
      .map((w) => w.word)
      .join(''),
  );
  if (!target) return null;
  const allowed = Math.max(1, Math.floor(target.length / 3));
  const words = spokenWords(text);
  const distance = (from: number, to: number): number => {
    const said = consonantSkeleton(
      words
        .slice(from, to + 1)
        .map((w) => w.word)
        .join(''),
    );
    if (!said || (target.length < 5 && said[0] !== target[0])) return Infinity;
    return editDistance(said, target);
  };
  let best: { start: number; last: boolean; distance: number } | null = null;
  const consider = (from: number, to: number) => {
    const d = distance(from, to);
    if (d <= allowed && (!best || d < best.distance)) {
      best = { start: words[from].start, last: to === words.length - 1, distance: d };
    }
  };
  const end = words.length - 1;
  for (let from = Math.max(0, end - 2); from <= end; from++) consider(from, end);
  if (best) return best;
  for (let from = 0; from < words.length; from++) {
    for (let to = from; to < Math.min(words.length, from + 3); to++) consider(from, to);
  }
  return best;
}

export interface SpokenCommandDeps {
  /** Send these words as a turn now. */
  send(text: string): void;
  cue(kind: CueKind): void;
  /** Words that will never be sent, for the page's captions. */
  drop(reason: CallDroppedSpeech['dropped'], text: string): void;
  /** What the open turn holds so far, as the session's transcription events would say it. */
  heard(text: string, final: boolean): void;
  /** The open turn ended here (a send, a discard, the wake phrase): what it held is gone. */
  cut(): void;
  /** The wake state changed. */
  changed(): void;
  /** The caller's speech came to nothing to send (unaddressed, discarded, a command alone). */
  noTurn?(): void;
}

/**
 * Auto mode's spoken commands on the final transcripts: `send it` at the end of an utterance sends the
 * turn now, a discard phrase there drops it, and with the wake switch on nothing is kept until
 * `hey <agent>`. Transport-agnostic: it sees text and the caller's speech state, and says what to
 * send, drop and cue.
 *
 * A command counts at the end of an utterance: a final transcript that ends with it, and then a
 * pause. A final that arrives while the caller still speaks holds its command until they stop; new
 * words before that make it plain words. The session still decides turns by its own pause: what it
 * commits is the session's text while no command cut the turn since its last commit (auto mode
 * exactly as before), and otherwise the words heard since the cut.
 */
export class SpokenCommands {
  private wake = false;
  private pauseSends = false;
  private awake = false;
  private heardWords: string[] = [];
  /** A command cut the turn since the session's last commit: its text is no longer the turn. */
  private cutSinceCommit = false;
  private callerSpeaking = false;
  private pending?: { command: SpokenCommand; rest: string; words: string };
  private readonly names: WakeName[];
  /** The acoustic wake word's phrase: when set, it opens the turn and the transcript's `hey <agent>` does not. */
  private wakeWord?: string;
  /** After a spotted wake word: the finals that may still carry its phrase, to strip it from. */
  private strip?: { until: number; finals: number; keepBefore: boolean };
  /**
   * The last final dropped while waiting, not reported yet: a wake word spotted just after it may
   * have been in it, and then its words after the phrase are the turn, never "ignored" on the page.
   */
  private lastUnaddressed?: { text: string; at: number; timer: ReturnType<typeof setTimeout> };
  /** How many times the wake phrase opened a turn this call. */
  private wakes = 0;
  /** A command the audio spotted in the open turn, waiting for the final that ends its utterance. */
  private spotted?: { command: SpokenCommand; phrase: string; timer: ReturnType<typeof setTimeout> };
  /** The open turn's last final, as taken: a command spotted just after it may have been in it. */
  private lastTaken?: { text: string; at: number };

  constructor(
    names: readonly string[],
    private readonly deps: SpokenCommandDeps,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.names = wakeNameWords(names);
  }

  get state(): CallWakeState {
    return {
      on: this.wake,
      pauseSends: this.pauseSends,
      waiting: this.waiting,
      ...(this.wakeWord ? { phrase: this.wakeWord } : {}),
      ...(this.wakes ? { heard: this.wakes } : {}),
    };
  }

  /** Waiting for an acoustic wake word: the audio is worth scoring. */
  get spotting(): boolean {
    return this.waiting && this.wakeWord !== undefined;
  }

  /** The acoustic wake word is in use (its phrase), or not, and `hey <agent>` in the transcript opens the turn. */
  useWakeWord(phrase: string | undefined): void {
    if (phrase === this.wakeWord) return;
    this.wakeWord = phrase;
    this.strip = undefined;
    this.reportUnaddressed();
    this.deps.changed();
  }

  /**
   * The audio had the wake word: open the turn, as `hey <agent>` in a transcript does. Its words
   * arrive later, so the next finals are searched for the phrase and lose it (and, when it opened
   * the turn, what came before it). A final dropped just before may have held it after all.
   */
  onWakeWord(): void {
    if (!this.wake || !this.wakeWord) return;
    const now = this.now();
    const keepBefore = !this.waiting;
    this.strip = { until: now + WAKE_TEXT_WINDOW_MS, finals: WAKE_TEXT_FINALS, keepBefore };
    if (keepBefore) return;
    this.open();
    const late = this.lastUnaddressed;
    if (!late) return;
    this.lastUnaddressed = undefined;
    clearTimeout(late.timer);
    // Only the name's own spelling: a final that is already gone is not taken on a near miss.
    const found = now - late.at <= WAKE_LATE_FINAL_MS ? matchWakeText(late.text, this.wakeWord, false) : null;
    if (!found) return this.deps.drop('unaddressed', late.text);
    this.strip = undefined;
    const before = late.text
      .slice(0, found.start)
      .replace(/[\s,;:–—-]+$/u, '')
      .trim();
    if (before) this.deps.drop('unaddressed', before);
    const said = late.text.slice(found.end).replace(/^[\s,.;:!?–—-]+/u, '');
    if (said) this.take(said);
  }

  /**
   * The audio had a command phrase (`send it`, `scratch that`) while the turn was open. Its words
   * arrive later: a final that ends in them however they were heard acts on it, and one that goes on
   * past them makes it words. A final just before may have been the one. No final in time and the
   * caller silent: it acts on what the turn holds.
   */
  onCommandWord(command: SpokenCommand, phrase: string): void {
    if (!this.awake || this.pending || this.spotted) return;
    const late = this.lastTaken;
    if (late && this.now() - late.at <= SPOTTED_COMMAND_LATE_MS && this.heardWords.at(-1) === late.text) {
      const found = matchSpottedCommand(late.text, phrase);
      if (found?.last) {
        this.heardWords.pop();
        return this.hold({ command, rest: trimCommandRest(late.text.slice(0, found.start)), words: late.text });
      }
    }
    const timer = setTimeout(() => {
      this.spotted = undefined;
      if (!this.awake || this.callerSpeaking) return;
      this.hold({ command, rest: '', words: phrase });
    }, SPOTTED_COMMAND_WAIT_MS);
    timer.unref?.();
    this.spotted = { command, phrase, timer };
  }

  /** The open turn may take a spotted command (`send it`): the audio is worth scoring for one. */
  get listensForCommands(): boolean {
    return this.awake;
  }

  /** Nothing is kept until the wake phrase. */
  get waiting(): boolean {
    return this.wake && !this.awake;
  }

  /** Whether the session's closing silence sends the open turn (the page's countdown). */
  get pausesSend(): boolean {
    return !this.wake || (this.awake && this.pauseSends);
  }

  /** After the wake phrase only `send it` sends: a reply waits for it like for a review recording. */
  get holdsReplies(): boolean {
    return this.awake && !this.pauseSends;
  }

  configure(wake: boolean, pauseSends: boolean): void {
    if (wake === this.wake && pauseSends === this.pauseSends) return;
    if (wake !== this.wake) {
      this.awake = false;
      this.pending = undefined;
      this.dropSpotted();
      this.strip = undefined;
      this.reportUnaddressed();
      // From here the open turn is these words: none when the gate closes, since none were addressed.
      this.cutSinceCommit = true;
      if (wake) {
        this.heardWords = [];
        this.deps.cut();
      }
    }
    this.wake = wake;
    this.pauseSends = pauseSends;
    this.deps.changed();
  }

  /** Review took over: what auto held is the review draft now, and the gate waits again. */
  reset(): void {
    this.heardWords = [];
    this.pending = undefined;
    this.dropSpotted();
    this.strip = undefined;
    this.reportUnaddressed();
    this.cutSinceCommit = true;
    if (this.awake) {
      this.awake = false;
      this.deps.changed();
    }
  }

  onCallerSpeaking(speaking: boolean): void {
    this.callerSpeaking = speaking;
    if (!speaking) this.settle();
  }

  onTranscript(text: string, final: boolean): void {
    const words = text.trim();
    if (!final) {
      // New words after a final that ended in a command: it was mid-utterance after all.
      if (words && this.pending) this.unhold();
      if (!this.waiting) this.deps.heard(this.stripWakeWord(words, false) ?? words, false);
      return;
    }
    if (!words) {
      // An empty final still ends the interim text before it.
      if (!this.waiting) this.deps.heard('', true);
      return;
    }
    if (this.pending) this.unhold();
    let said = words;
    if (this.waiting && this.wakeWord) {
      this.reportUnaddressed();
      if (this.loneCommand(said)) return;
      this.holdUnaddressed(said);
      return this.deps.noTurn?.();
    }
    if (this.waiting) {
      const found = matchWake(said, this.names);
      if (!found) {
        if (this.loneCommand(said)) return;
        this.deps.drop('unaddressed', said);
        return this.deps.noTurn?.();
      }
      // Words before the phrase in the same final were not for the agent: the page marks them so.
      const before = said
        .slice(0, found.start)
        .replace(/[\s,;:–—-]+$/u, '')
        .trim();
      if (before) this.deps.drop('unaddressed', before);
      this.open();
      said = said.slice(found.end).replace(/^[\s,.;:!?–—-]+/u, '');
      if (!said) return;
    }
    const stripped = this.stripWakeWord(said, true);
    if (stripped !== null) {
      said = stripped;
      // The phrase alone: nothing to keep, but the interim text that showed it ends here.
      if (!said) return this.deps.heard('', true);
    }
    this.take(said);
  }

  /** Hold a final dropped while waiting for WAKE_LATE_FINAL_MS, then report it as unaddressed. */
  private holdUnaddressed(text: string): void {
    const timer = setTimeout(() => this.reportUnaddressed(), WAKE_LATE_FINAL_MS);
    timer.unref?.();
    this.lastUnaddressed = { text, at: this.now(), timer };
  }

  /** The held final can no longer carry a wake word: the page marks it ignored now. */
  private reportUnaddressed(): void {
    const late = this.lastUnaddressed;
    if (!late) return;
    this.lastUnaddressed = undefined;
    clearTimeout(late.timer);
    this.deps.drop('unaddressed', late.text);
  }

  /** A final's words, after any wake phrase: kept, or held when they end in a command. */
  private take(said: string): void {
    const match = matchCommand(said) ?? this.spottedIn(said);
    if (!match) {
      this.heardWords.push(said);
      this.lastTaken = { text: said, at: this.now() };
      this.deps.heard(said, true);
      return;
    }
    this.dropSpotted();
    this.hold({ ...match, words: said });
  }

  private hold(pending: { command: SpokenCommand; rest: string; words: string }): void {
    this.pending = pending;
    if (!this.callerSpeaking) this.settle();
  }

  /** The spotted command when this final ends in its words; a final that goes on past them makes it words. */
  private spottedIn(said: string): { command: SpokenCommand; rest: string } | null {
    const spotted = this.spotted;
    if (!spotted) return null;
    const found = matchSpottedCommand(said, spotted.phrase);
    if (!found) return null;
    this.dropSpotted();
    return found.last ? { command: spotted.command, rest: trimCommandRest(said.slice(0, found.start)) } : null;
  }

  private dropSpotted(): void {
    clearTimeout(this.spotted?.timer);
    this.spotted = undefined;
  }

  /**
   * The session committed a turn after its closing silence: the text to send now, or null. Its own
   * text while nothing cut the turn since its last commit, else the words heard since the cut.
   */
  onPause(sessionText: string): string | null {
    this.settle();
    const cut = this.cutSinceCommit;
    this.cutSinceCommit = false;
    if (this.wake && !this.pausesSend) return null;
    const text = cut || this.wake ? this.heardWords.join(' ') : sessionText;
    this.heardWords = [];
    if (!text) return null;
    if (this.wake) this.sleep();
    return text;
  }

  /** The wake phrase opened the turn: what came before it is gone. */
  private open(): void {
    this.awake = true;
    this.wakes++;
    this.heardWords = [];
    this.cutSinceCommit = true;
    this.deps.cut();
    this.deps.cue('wake');
    this.deps.changed();
  }

  /**
   * Text with a spotted wake word's phrase taken out, or null when no phrase is expected or found.
   * A final that has it ends the search; a turn the phrase opened loses the words before it.
   */
  private stripWakeWord(text: string, final: boolean): string | null {
    const strip = this.strip;
    if (!strip || !this.wakeWord) return null;
    if (this.now() > strip.until) {
      this.strip = undefined;
      return null;
    }
    const found = matchWakeText(text, this.wakeWord);
    if (!found) {
      if (final && --strip.finals <= 0) this.strip = undefined;
      return null;
    }
    const before = text
      .slice(0, found.start)
      .replace(/[\s,;:–—-]+$/u, '')
      .trim();
    const after = text.slice(found.end).replace(/^[\s,.;:!?–—-]+/u, '');
    if (!final) return strip.keepBefore ? [before, after].filter(Boolean).join(' ') : after;
    this.strip = undefined;
    if (strip.keepBefore) return [before, after].filter(Boolean).join(' ');
    if (before) this.deps.drop('unaddressed', before);
    return after;
  }

  /** A held command's utterance is over: act on it. */
  private settle(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    const open = [...this.heardWords, pending.rest].filter(Boolean).join(' ');
    if (pending.command === 'send') {
      if (!open) return this.nope(pending.words);
      this.cutTurn();
      this.deps.send(open);
      return;
    }
    // A discard right after the wake phrase takes the wake back.
    if (!open && !this.awake) return this.nope(pending.words);
    this.deps.drop('discarded', [...this.heardWords, pending.words].join(' '));
    this.cutTurn();
    this.deps.cue('discard');
    this.deps.noTurn?.();
  }

  /** Nothing to act on: the command alone is no turn either, so the pause after it sends nothing. */
  private nope(words: string): void {
    this.deps.drop('command', words);
    this.cutSinceCommit = true;
    this.deps.cut();
    this.deps.cue('nope');
    this.deps.noTurn?.();
  }

  /** While waiting for the wake phrase, a command alone (`send it`) has nothing to act on: say so. */
  private loneCommand(said: string): boolean {
    const match = matchCommand(said);
    if (!match || match.rest) return false;
    this.nope(said);
    return true;
  }

  /** The held command was words after all. */
  private unhold(): void {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return;
    this.heardWords.push(pending.words);
    this.deps.heard(pending.words, true);
  }

  private cutTurn(): void {
    this.heardWords = [];
    this.cutSinceCommit = true;
    this.deps.cut();
    if (this.wake) this.sleep();
  }

  /** Back to waiting for the wake phrase. */
  private sleep(): void {
    this.dropSpotted();
    this.lastTaken = undefined;
    if (!this.awake) return;
    this.awake = false;
    this.deps.changed();
  }
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
  log: Pick<Console, 'info' | 'warn'>;
}

/**
 * Review mode on the worker: the caller's talk, done, send and discard, and switching between auto
 * and review mid-call. One operation runs at a time, each for the draft it names, so a late or
 * repeated one is refused as stale. Every change goes to the page as a `CallReviewState`.
 *
 * In review the session's turn detection is manual and its input is off between recordings. The
 * draft's text is built here from the transcription's final transcripts, not from the session's
 * committed turn: agents-js `commitUserTurn()` takes no STT flush, returns no text, and its turn can
 * land after a switch back to auto. After done the transcription gets silence until it has
 * finalized everything it heard (or FLUSH_TIMEOUT_MS passes, leaving the rest unverified); then the
 * session's own turn is cleared, so nothing of it is ever committed.
 */
export class ReviewControl {
  private mode: TurnMode = 'auto';
  private draft: CallDraft | null = null;
  /** The frozen draft's recording, saved with its turn if it is sent. */
  private take?: TurnTake;
  private seq = 0;
  private drafts = 0;
  private ops: Promise<unknown> = Promise.resolve();
  /** What the transcription heard since the last turn boundary: its finals, and the interim text after them. */
  private finals: string[] = [];
  private interim = '';
  private heardAt = 0;
  private minStream = 0;
  private clearedAt = 0;
  /** The restarted transcription does not take audio yet: talk waits for `sttReady`. */
  private preparing = false;
  private sttReady: Promise<void> = Promise.resolve();
  private clears = 0;
  private callerSpeaking = false;
  private agentSpeaking = false;
  private sttFailed = false;
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

  /** A stream from before the last clear can still deliver for a moment: its words were dropped. */
  stale(stream: number): boolean {
    return stream < this.minStream && Date.now() - this.clearedAt < STALE_STREAM_MS;
  }

  onTranscript(text: string, final: boolean, stream: number): void {
    if (this.stale(stream)) return;
    const state = this.draft?.state;
    if (this.mode === 'review' && state !== 'recording' && state !== 'finishing') return;
    this.heardAt = Date.now();
    const words = text.trim();
    if (!final) {
      this.interim = words;
      return;
    }
    if (words) this.finals.push(words);
    this.interim = '';
  }

  onSttError(): void {
    const state = this.draft?.state;
    if (state === 'recording' || state === 'finishing') this.sttFailed = true;
  }

  /** The VAD's view of the caller, for whether an auto turn is open when review is asked for. */
  onCallerSpeaking(speaking: boolean): void {
    this.callerSpeaking = speaking;
  }

  onAgentSpeaking(speaking: boolean): void {
    this.agentSpeaking = speaking;
    if (speaking) this.beforeAgentSpeaks();
  }

  /** A reply takes the channel: a recording stops there and becomes a draft; it never resumes by itself. */
  beforeAgentSpeaks(): void {
    if (this.draft?.state === 'recording') this.finish(this.draft, 'agent');
  }

  /** An auto turn was committed, lost or dropped: what was heard so far is no longer open. */
  onAutoTurnClosed(): void {
    this.resetHeard();
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
          this.resetHeard();
          this.deps.voice.setManualTurns(false);
          this.deps.voice.setInput(true);
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
        // Words spoken before the restarted transcription takes audio are lost: the caller's
        // microphone opens on this reply, so it comes once the transcription is ready.
        if (this.preparing) {
          await this.sttReady;
          if (this.closed) return reply({ error: 'closed' });
          if (this.agentSpeaking) return reply({ error: 'agent_speaking' });
        }
        this.resetHeard();
        this.sttFailed = false;
        this.take = undefined;
        this.draft = { id: ++this.drafts, state: 'recording', text: '' };
        this.deps.setCaptureOpen(true);
        this.deps.voice.setInput(true);
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
        const take = this.take ?? this.deps.voice.takeTurn();
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
        const open = draft.state === 'recording' || draft.state === 'finishing';
        if (draft.state === 'recording') {
          this.deps.setCaptureOpen(false);
          this.deps.voice.setInput(false);
        }
        // A frozen draft's turn was cleared when it froze; an open one's is cleared now.
        if (open) {
          this.deps.voice.takeTurn();
          this.clear();
        }
        this.publish();
        if (open) await pause(CLEAR_SETTLE_MS);
        return reply();
      }
    }
  }

  private enterReview(req: ReviewRequest, reply: (fields?: Partial<ReviewReply>) => ReviewReply): ReviewReply {
    const posted = this.deps.lastPosted();
    const submitted = typeof req.afterTurn === 'number' && posted > req.afterTurn ? posted : undefined;
    this.mode = 'review';
    // Manual turns first: that cancels an auto commit still waiting out its silence.
    this.deps.voice.setManualTurns(true);
    this.deps.voice.setInput(false);
    this.deps.resetCaller();
    const open = this.finals.length > 0 || this.interim !== '' || this.callerSpeaking;
    this.callerSpeaking = false;
    if (open) {
      // The caller's unsent words become a draft; never sent by the switch itself.
      this.draft = { id: ++this.drafts, state: 'finishing', text: '', reason: 'switch' };
      this.publish();
      this.finalizeSafely(this.draft);
    } else {
      this.resetHeard();
      this.publish();
    }
    return reply(submitted !== undefined ? { submitted } : {});
  }

  /** Stop the recording and freeze its text. */
  private finish(draft: CallDraft, reason?: CallDraft['reason']): void {
    this.draft = { ...draft, state: 'finishing', ...(reason ? { reason } : {}) };
    this.deps.setCaptureOpen(false);
    this.deps.voice.setInput(false);
    this.publish();
    this.finalizeSafely(this.draft);
  }

  /** A finalize that fails leaves the draft unverified, never stuck finishing. */
  private finalizeSafely(draft: CallDraft): void {
    this.finalize(draft).catch((err: unknown) => {
      this.deps.log.warn('voice worker: finishing a review draft failed', { err });
      if (this.draft?.id !== draft.id) return;
      this.draft = { ...draft, state: 'failed', text: this.draft.text };
      this.publish();
    });
  }

  private async finalize(draft: CallDraft): Promise<void> {
    const startedAt = Date.now();
    const minMs = this.deps.voice.flushMinMs();
    this.deps.voice.setFlushing(true);
    try {
      for (;;) {
        await pause(FLUSH_POLL_MS);
        // Discarded meanwhile, or the call ended: its words go nowhere.
        if (this.closed || this.draft?.id !== draft.id) return;
        const t = Date.now();
        if (t - startedAt >= minMs && !this.interim && t - this.heardAt >= FLUSH_QUIET_MS) break;
        if (t - startedAt >= FLUSH_TIMEOUT_MS) {
          this.deps.log.warn('voice worker: the transcription did not finish a review draft in time');
          break;
        }
      }
    } finally {
      this.deps.voice.setFlushing(false);
    }
    const unverified = this.interim !== '' || this.sttFailed;
    const text = [...this.finals, this.interim].join(' ').replace(/\s+/g, ' ').trim();
    this.take = this.deps.voice.takeTurn();
    this.clear();
    // A switch with nothing heard leaves no draft behind.
    if (draft.reason === 'switch' && !text && !unverified) {
      this.draft = null;
      this.take = undefined;
    } else {
      this.draft = {
        ...draft,
        state: unverified ? 'failed' : text ? 'ready' : 'empty',
        text,
        ...(Buffer.byteLength(text) > MAX_TURN_TEXT_BYTES ? { tooLong: true } : {}),
      };
      if (this.draft.state === 'ready' && !this.draft.tooLong) this.deps.cue?.('draft');
    }
    this.publish();
  }

  /** Forget what was heard and clear the session's own open turn, which restarts its transcription. */
  private clear(): void {
    this.resetHeard();
    const { stream, ready } = this.deps.voice.clearTurn();
    this.minStream = stream;
    this.clearedAt = Date.now();
    const clear = ++this.clears;
    this.preparing = true;
    this.sttReady = Promise.race([ready.then(() => true), pause(STT_READY_TIMEOUT_MS).then(() => false)]).then(
      (took) => {
        // A newer clear has its own wait.
        if (clear !== this.clears) return;
        if (!took) this.deps.log.warn('voice worker: the restarted transcription did not report ready in time');
        this.preparing = false;
        this.publish();
      },
    );
  }

  private resetHeard(): void {
    this.finals = [];
    this.interim = '';
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

/** What a call's session needs besides the job metadata. */
export interface VoiceSettings {
  geminiKey: string;
  record: boolean;
  /** Where calls remember a speech model that failed (ttsDownSince); none, and every call tries it first. */
  ttsStateFile?: string;
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
  /** The call's acoustic phrase spotter, or none: then the transcript alone opens, sends and discards turns. */
  wakeWord?(events: WakeWordEvents): WakeWord | undefined;
  log: Pick<Console, 'info' | 'warn'>;
}

/**
 * What a spotted phrase does: `wake` opens the turn, `send` sends it and `discard` drops it, as
 * `hey <agent>`, `send it` and `scratch that` in the transcript do.
 */
export type SpotterRole = 'wake' | SpokenCommand;

/** What a call needs of a phrase spotter (`WakeWordSpotter`); faked in tests. */
export interface WakeWord {
  /** The phrase of each role it spots; once ready, only those whose model loaded. */
  readonly phrases: Partial<Record<SpotterRole, string>>;
  readonly thresholds: Partial<Record<SpotterRole, number>>;
  /** Why a role's model did not load; the other roles spot. */
  readonly failed: Partial<Record<SpotterRole, string>>;
  /** Resolves once it can spot, rejects when none of its models can load. */
  readonly ready: Promise<void>;
  /** Score the audio for these roles, or none: then only keep it. */
  listen(roles: readonly SpotterRole[]): void;
  /** 16 kHz mono audio. */
  push(pcm: Int16Array): void;
  readonly summary: WakeWordStats;
  /** Its thread's share of one core. */
  readonly utilization: number;
  close(): Promise<void>;
}

export interface WakeWordEvents {
  onDetect(role: SpotterRole, score: number): void;
  /** It stopped for good after it loaded. */
  onError(err: string): void;
}

const SPOTTER_SETTINGS: ReadonlyArray<readonly [SpotterRole, string, string | undefined]> = [
  ['wake', 'VOICE_WAKE', DEFAULT_WAKE_MODEL],
  ['send', 'VOICE_SEND', undefined],
  ['discard', 'VOICE_DISCARD', undefined],
];
/** The settings keys `spotterSettings` reads. */
export const SPOTTER_KEYS = SPOTTER_SETTINGS.flatMap(([, prefix]) => [`${prefix}_MODEL`, `${prefix}_THRESHOLD`]);

/**
 * The phrases to spot, one classifier .onnx (livekit-wakeword's format) per role:
 * VOICE_WAKE_MODEL (the bundled `hey_livekit` by default), VOICE_SEND_MODEL and VOICE_DISCARD_MODEL
 * (none by default); `off` for none. A relative path is from the working directory. Each one's
 * VOICE_<ROLE>_THRESHOLD (0-1) defaults to the threshold known for its model (0.68 for the bundled
 * one), else 0.5. None at all: no spotter.
 */
export function spotterSettings(env: Record<string, string | undefined>): Array<SpotterClassifier<SpotterRole>> {
  return SPOTTER_SETTINGS.flatMap(([name, prefix, fallback]) => {
    const set = env[`${prefix}_MODEL`]?.trim();
    if (set && /^(off|none|0|false)$/i.test(set)) return [];
    const model = set ? path.resolve(set) : fallback;
    if (!model) return [];
    const threshold = Number(env[`${prefix}_THRESHOLD`]?.trim() || NaN);
    return [{ name, model, threshold: threshold > 0 && threshold < 1 ? threshold : defaultThreshold(model) }];
  });
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

const FLUSH_SILENCE = new AudioFrame(
  new Int16Array(samplesOf(FLUSH_CHUNK_MS)),
  INPUT_SAMPLE_RATE,
  1,
  samplesOf(FLUSH_CHUNK_MS),
);

class CallAgent extends voice.Agent {
  /** The session's transcription streams so far; it opens a new one on every restart. */
  streams = 0;
  private feed?: TransformStreamDefaultController<AudioFrame>;
  private flushTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly onTurn: (text: string) => void,
    private readonly tap?: (frame: AudioFrame) => void,
    private readonly onTranscript?: (text: string, final: boolean, stream: number) => void,
  ) {
    super({ instructions: '' });
  }

  /** With no LLM in the session, nothing answers after this; the host's agent does, later. */
  override async onUserTurnCompleted(_chatCtx: llm.ChatContext, message: llm.ChatMessage): Promise<void> {
    this.onTurn(message.textContent?.trim() ?? '');
  }

  /**
   * Silence straight into the transcription, past the session's input: with the caller's audio
   * off, it is what lets the streaming model finalize the last words it heard.
   */
  setFlushing(on: boolean): void {
    clearInterval(this.flushTimer);
    this.flushTimer = undefined;
    if (!on) return;
    const feed = () => {
      try {
        this.feed?.enqueue(FLUSH_SILENCE);
      } catch {
        // The stream closed; its successor gets the next chunk.
      }
    };
    feed();
    this.flushTimer = setInterval(feed, FLUSH_CHUNK_MS);
    this.flushTimer.unref?.();
  }

  /**
   * The audio the transcription gets (silence while the agent speaks), copied for recordings, with
   * a way in for the flush's silence; and what it transcribes, numbered by stream.
   */
  override async sttNode(
    audio: ReadableStream<AudioFrame> | AsyncIterable<AudioFrame>,
    modelSettings: voice.ModelSettings,
  ): Promise<ReadableStream<stt.SpeechEvent | string> | null> {
    const tap = this.tap;
    const stream = ++this.streams;
    const source = audio instanceof ReadableStream ? audio : ReadableStream.from(audio);
    const fed = source.pipeThrough(
      new TransformStream<AudioFrame, AudioFrame>({
        start: (controller) => {
          this.feed = controller;
        },
        transform(frame, controller) {
          tap?.(frame);
          controller.enqueue(frame);
        },
      }),
    );
    const events = await super.sttNode(fed, modelSettings);
    const heard = this.onTranscript;
    if (!events || !heard) return events;
    return events.pipeThrough(
      new TransformStream<stt.SpeechEvent | string, stt.SpeechEvent | string>({
        transform(ev, controller) {
          if (
            typeof ev !== 'string' &&
            (ev.type === stt.SpeechEventType.FINAL_TRANSCRIPT || ev.type === stt.SpeechEventType.INTERIM_TRANSCRIPT)
          ) {
            heard(ev.alternatives?.[0]?.text ?? '', ev.type === stt.SpeechEventType.FINAL_TRANSCRIPT, stream);
          }
          controller.enqueue(ev);
        },
      }),
    );
  }
}

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

/**
 * The call's AgentSession: VAD turns, streaming STT, Gemini TTS, no LLM, wired to `events`. Not
 * started; `sessionVoice` starts it in the room.
 */
export function callSession(
  meta: LiveKitJobMetadata,
  settings: VoiceSettings,
  vads: { vad: VAD; fallbackVad?: VAD },
  events: CallVoiceEvents,
  log: WorkerLog,
  publishPending: (value: string) => void = () => undefined,
): {
  session: voice.AgentSession;
  agent: voice.Agent;
  say(text: string): Promise<boolean>;
  clearPending(): void;
  review: Omit<ReviewVoice, 'publishReview'>;
} {
  const apiKey = settings.geminiKey;
  const countdown = new SendCountdown(publishPending, meta.silenceMs);
  const capture = settings.record ? new TurnCapture() : undefined;
  // The host already trimmed, deduplicated and capped it.
  const vocabulary = meta.vocabulary ?? [];
  /** Waits for a streaming transcription opened after a clear to take audio. */
  const readyWaits = new Set<{ after: number; resolve: () => void }>();
  const streaming = new ReadyingGeminiSTT(
    {
      apiKey,
      model: meta.sttModel,
      languageCodes: [...STT_LANGUAGE_CODES],
      customVocabulary: vocabulary,
      sampleRate: INPUT_SAMPLE_RATE,
    },
    (stream) => {
      for (const wait of readyWaits) {
        if (wait.after >= stream) continue;
        readyWaits.delete(wait);
        wait.resolve();
      }
    },
  );

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
    const stateFile = settings.ttsStateFile;
    // It failed in a call moments ago: this call starts on the next one, and probes it meanwhile.
    if (stateFile && ttsDownSince(stateFile, meta.ttsModel) !== null) {
      log.info(`voice worker: speech model ${meta.ttsModel} failed in a recent call; the next one speaks first`);
      ttsAdapter.markUnAvailable(0);
    }
    (ttsAdapter as unknown as NodeJS.EventEmitter).on(
      'tts_availability_changed',
      (ev: tts.AvailabilityChangedEvent) => {
        const model = ev.tts === primaryTts ? meta.ttsModel : meta.ttsFallbackModel;
        if (ev.available) log.info(`voice worker: speech model ${model} is back`);
        else log.warn(`voice worker: speech model ${model} failed; the next one speaks`);
        if (stateFile && ev.tts === primaryTts) setTtsDown(stateFile, model, !ev.available);
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
  const reviewing = () => events.reviewing?.() ?? false;
  session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
    const speaking = ev.newState === 'speaking';
    if (speaking && agentSpeaking) events.onUnheardSpeech?.();
    if (speaking) {
      turnOpen = true;
      speakingSince = Date.now();
      countdown.clear();
    } else if (ev.oldState === 'speaking') {
      turnSpeechMs += Math.max(0, Date.now() - speakingSince - VAD_SILENCE_MS);
      // Speech heard under the agent's is not transcribed, so it sends nothing to count down to;
      // in review no pause sends anything.
      if (turnOpen && !agentSpeaking && agentSpokeAt < speakingSince && (events.pausesSend?.() ?? !reviewing())) {
        countdown.stopped(ev.createdAt - VAD_SILENCE_MS);
      }
    }
    capture?.onSpeaking(speaking);
    events.onCallerSpeaking(speaking);
  });
  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
    if (ev.isFinal && ev.transcript.trim()) heardBy.add(transcription.model);
  });
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
    const was = agentSpeaking;
    agentSpeaking = ev.newState === 'speaking';
    if (ev.oldState === 'speaking' || agentSpeaking) agentSpokeAt = Date.now();
    if (agentSpeaking) countdown.clear();
    if (agentSpeaking !== was) events.onAgentSpeaking?.(agentSpeaking);
  });
  session.on(voice.AgentSessionEventTypes.Error, (ev) => {
    const err = ev.error;
    if (err.recoverable) return;
    if (err.type === 'stt_error') {
      sttFailedAt = Date.now();
      events.onSttError?.();
    }
    if (err.type === 'tts_error') ttsFailures++;
  });
  session.on(voice.AgentSessionEventTypes.UserTranscriptionTimeout, (ev) => {
    // Review turns end on done, never on a timeout; the review draft says what was heard.
    if (reviewing()) return;
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
    for (const wait of readyWaits) wait.resolve();
    readyWaits.clear();
    agent.setFlushing(false);
    countdown.clear();
    // The session closes neither; their recovery probes would run on.
    void adapter?.close().catch(() => undefined);
    void ttsAdapter?.close().catch(() => undefined);
    events.onClosed(`session closed: ${ev.reason}`);
  });

  const agent = new CallAgent(
    (text) => {
      const turn = take();
      if (text) events.onTurn(text, turn);
    },
    (frame) => {
      capture?.push(frame);
      events.onAudio?.(frame);
    },
    events.onTranscript?.bind(events),
  );
  return {
    session,
    agent,
    review: {
      setManualTurns(manual) {
        session.updateOptions({ turnHandling: { turnDetection: manual ? 'manual' : 'vad' } });
      },
      setInput(enabled) {
        session.input.setAudioEnabled(enabled);
      },
      setFlushing(on) {
        agent.setFlushing(on);
      },
      clearTurn() {
        const opened = streaming.streamsOpened;
        try {
          session.clearUserTurn();
        } catch (err) {
          // Nothing restarts: the stream that runs now stays the current one.
          log.warn('voice worker: could not clear the open turn', { err });
          return { stream: agent.streams, ready: Promise.resolve() };
        }
        // The fallback transcription takes audio as it comes; the streaming one has to connect first.
        const ready = fallbackServing()
          ? Promise.resolve()
          : new Promise<void>((resolve) => readyWaits.add({ after: opened, resolve }));
        return { stream: agent.streams + 1, ready };
      },
      flushMinMs: () => (fallbackServing() ? FLUSH_FALLBACK_MIN_MS : FLUSH_MIN_MS),
      takeTurn: take,
    },
    clearPending: () => countdown.clear(),
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
  const { session, agent, say, clearPending, review } = callSession(
    meta,
    settings,
    { vad: userData.vad, fallbackVad: userData.fallbackVad },
    events,
    log,
    (value) => void setAttribute(ctx, CALL_PENDING_ATTRIBUTE, value).catch(() => undefined),
  );
  /** One JSON message on a text stream topic; a failure is logged, never thrown. */
  const sendJson = (topic: string, value: unknown, what: string): void => {
    void ctx.room.localParticipant
      ?.sendText(JSON.stringify(value), { topic })
      .catch((err: unknown) => log.warn(`voice worker: could not publish ${what}`, { err }));
  };
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
  // The caller's token may publish data (review mode's RPCs). agents-js also serves remote control
  // of the session (input on/off, typed turns, forced interrupts) to the linked participant on this
  // topic; nothing here uses it, so the caller must not reach it.
  try {
    ctx.room.unregisterByteStreamHandler(SESSION_CONTROL_TOPIC);
  } catch (err) {
    log.warn('voice worker: could not close the session control topic', { err });
  }
  // The cues' own track: never the speech track, so a cue is never the agent speaking, and the
  // session's "caller unheard while the agent speaks" rule (an uninterruptible speech handle) never
  // covers it. Without it the call runs silent of cues.
  const cueTrack = await publishCueTrack(ctx.room, log).catch((err: unknown) => {
    log.warn('voice worker: could not publish the cue track', { err });
    return undefined;
  });
  return {
    say,
    setThinking(thinking) {
      void setAttribute(ctx, CALL_THINKING_ATTRIBUTE, thinking ? '1' : '').catch(() => undefined);
    },
    publishTurn: (status) => sendJson(CALL_TURN_TOPIC, status, 'a turn status'),
    publishDropped: (dropped) => sendJson(CALL_TURN_TOPIC, dropped, 'dropped words'),
    publishUnheard: () =>
      sendJson(CALL_TURN_TOPIC, { unheard: 'agent_speaking' } satisfies CallUnheardSpeech, 'unheard speech'),
    clearPending,
    async playCue(kind) {
      await cueTrack?.feed.play(cueFrames(kind));
    },
    publishReply: (info) => sendJson(CALL_REPLY_TOPIC, info, 'a reply label'),
    review: {
      ...review,
      publishReview: (state) => sendJson(CALL_REVIEW_TOPIC, state, 'the review state'),
      serve(handle) {
        const local = ctx.room.localParticipant;
        if (!local) return;
        for (const op of Object.keys(REVIEW_RPC) as ReviewOp[]) {
          local.registerRpcMethod(REVIEW_RPC[op], (data) => handle(op, data.payload, data.callerIdentity));
        }
        void ctx.room.localParticipant
          ?.setAttributes({ [CALL_REVIEW_ATTRIBUTE]: '1', [CALL_COMMANDS_ATTRIBUTE]: CALL_COMMANDS_VERSION })
          .catch(() => undefined);
      },
    },
    async close() {
      await session.close().catch(() => undefined);
      await cueTrack?.close().catch(() => undefined);
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
    ...SPOTTER_KEYS,
  ]);
  const classifiers = spotterSettings(env);
  return {
    env,
    createVoice: (ctx, meta, settings, events) => sessionVoice(ctx as JobContext, meta, settings, events),
    markUpdating: (ctx) => setAttribute(ctx, CALL_UPDATING_ATTRIBUTE, '1'),
    wakeWord: (events) =>
      classifiers.length > 0 ? new WakeWordSpotter<SpotterRole>({ classifiers, ...events }) : undefined,
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
      say: (text) => callVoice?.say(text) ?? Promise.resolve(false),
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
  let wakeWord: WakeWord | undefined;
  /** `restart`: the worker is shutting down, so the caller's page says the service restarted. */
  const end = async (reason: string, tellHost: boolean, restart = false) => {
    if (ending) return;
    ending = true;
    clearTimeout(readyTimer);
    clearTimeout(turnCueTimer);
    turnTaking.close();
    review?.close();
    if (wakeWord) {
      callLog.info('voice worker: wake word use', {
        ...wakeWord.summary,
        cpu: Math.round(wakeWord.utilization * 1000) / 1000,
      });
    }
    void spotter?.close().catch(() => undefined);
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
  /** The transcription stream auto mode's words come from, for review's view of the open turn. */
  let autoStream = 0;
  const commands = new SpokenCommands([meta.agentName, ...(meta.wakeNames ?? [])], {
    send: (text) => sendTurn(text, callVoice?.review?.takeTurn() ?? { sttModel: meta.sttModel }),
    cue,
    drop: (dropped, text) => {
      if (ending) return;
      callVoice?.publishDropped?.({ dropped, text });
      // A command alone sends nothing: no countdown runs toward a send.
      if (dropped === 'command') callVoice?.clearPending?.();
    },
    heard: (text, final) => review?.onTranscript(text, final, autoStream),
    // A settings change during a review recording must not touch the recording.
    cut: () => {
      if (!review?.reviewing) review?.onAutoTurnClosed();
    },
    changed: () => {
      turnTaking.setCaptureOpen(commands.holdsReplies, 'wake');
      review?.republish();
    },
    noTurn: () => turnTaking.releaseTurn(),
  });
  try {
    callVoice = await deps.createVoice(
      ctx,
      meta,
      { geminiKey, record, ttsStateFile: path.join(DATA_DIR, 'voice-tts-state.json') },
      {
        onTurn: (text, take) => {
          // An auto commit that lost the race to a switch: its words are already the review draft.
          if (review?.reviewing) return;
          // The pause may send the session's turn, the words since a spoken command, or nothing.
          const send = commands.onPause(text);
          if (send === null) return turnTaking.releaseTurn();
          review?.onAutoTurnClosed();
          sendTurn(send, take);
        },
        onCallerSpeaking: (speaking) => {
          callerSpeaking = speaking;
          // Speech before the wake phrase is no open turn for a switch to review to keep.
          review?.onCallerSpeaking(speaking && !commands.waiting);
          if (review?.reviewing) return;
          turnTaking.onCallerSpeaking(speaking);
          // After the turn-taking: a command this pause confirms sends a turn, which it must see last.
          commands.onCallerSpeaking(speaking);
        },
        onTurnLost: (reason, fields, take) => {
          if (ending || review?.reviewing) return;
          // Before the wake phrase speech is not for the agent: only a failed transcription is said.
          if (reason === 'empty' && commands.waiting) return;
          // After the wake phrase the turn stays open until `send it`: a lost stretch does not close it.
          if (!commands.holdsReplies) review?.onAutoTurnClosed();
          const turn = ++turns;
          turnTaking.onTurnLost(reason, fields);
          publish({ turn, status: 'lost', reason });
          saveTurn(turn, take, '', { reason });
        },
        onTurnDropped: (take) => {
          if (ending || review?.reviewing) return;
          turnTaking.releaseTurn();
          if (!commands.holdsReplies) review?.onAutoTurnClosed();
          saveTurn(++turns, take, '', { reason: 'noise' });
        },
        onClosed: (reason) => void end(reason, true),
        reviewing: () => review?.reviewing ?? false,
        pausesSend: () => !review?.reviewing && commands.pausesSend,
        onTranscript: (text, final, stream) => {
          if (review?.reviewing) return review.onTranscript(text, final, stream);
          if (review?.stale(stream)) return;
          autoStream = stream;
          commands.onTranscript(text, final);
        },
        onSttError: () => review?.onSttError(),
        onAgentSpeaking: (speaking) => {
          agentSpeaking = speaking;
          review?.onAgentSpeaking(speaking);
        },
        onUnheardSpeech: () => {
          if (!ending && !review?.reviewing) callVoice?.publishUnheard?.();
        },
        onAudio: (frame) => {
          if (!wakeWord || frame.sampleRate !== WAKE_SAMPLE_RATE || frame.channels !== 1) return;
          // Scored only while a phrase can act: the wake phrase while waiting in auto, the commands
          // while its turn is open, and never under the agent's speech (the transcription hears
          // silence then) or in review.
          const roles: SpotterRole[] = [];
          if (!agentSpeaking && !review?.reviewing) {
            if (commands.spotting) roles.push('wake');
            if (commands.listensForCommands) roles.push('send', 'discard');
          }
          wakeWord.listen(roles);
          wakeWord.push(frame.data);
        },
      },
    );
  } catch (err) {
    turnTaking.close();
    return abandon('could not set up the call audio', { err });
  }
  if (!ending) {
    try {
      spotter = deps.wakeWord?.({
        onDetect: (role, score) => {
          callLog.info('voice worker: phrase spotted', { role, score: Math.round(score * 1000) / 1000 });
          if (ending || review?.reviewing) return;
          if (role === 'wake') return commands.onWakeWord();
          const phrase = wakeWord?.phrases[role];
          if (phrase) commands.onCommandWord(role, phrase);
        },
        onError: (err) => {
          callLog.warn('voice worker: the wake word spotter stopped; "hey <agent>" in the transcript opens a turn', {
            err,
          });
          wakeWord = undefined;
          commands.useWakeWord(undefined);
        },
      });
    } catch (err) {
      callLog.warn('voice worker: could not start the wake word spotter', { err });
    }
    const loading = spotter;
    loading?.ready.then(
      () => {
        if (ending) return;
        wakeWord = loading;
        commands.useWakeWord(loading.phrases.wake);
        callLog.info('voice worker: wake word ready', {
          phrases: loading.phrases,
          thresholds: loading.thresholds,
          ...(Object.keys(loading.failed).length > 0 ? { failed: loading.failed } : {}),
        });
      },
      (err: unknown) => {
        // A call that ended while the models loaded closed the spotter: nothing failed.
        if (ending) return;
        callLog.warn('voice worker: no wake word model; "hey <agent>" in the transcript opens a turn', {
          err: err instanceof Error ? err.message : String(err),
        });
      },
    );
  }
  const reviewVoice = callVoice.review;
  // A call that ended while its audio was set up gets no review controls.
  if (reviewVoice && !ending) {
    const control = new ReviewControl({
      voice: reviewVoice,
      post: (text, draft, take) => sendTurn(text, take, draft),
      lastPosted: () => lastPosted,
      setCaptureOpen: (open) => turnTaking.setCaptureOpen(open),
      resetCaller: () => {
        turnTaking.resetCaller();
        commands.reset();
      },
      configure: (req) => {
        if (req.cues !== undefined) cuesOn = req.cues;
        commands.configure(req.wake ?? commands.state.on, req.pauseSends ?? commands.state.pauseSends);
        readyCue();
      },
      wakeState: () => commands.state,
      cue,
      log: callLog,
    });
    review = control;
    reviewVoice.serve(async (op, payload, callerIdentity) => {
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
      } else if (event.type === 'thinking') turnTaking.onThinking();
      else if (event.type === 'working') {
        turnTaking.onThinking();
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
    'VOICE_RECORDINGS_DAYS',
    'VOICE_MAX_SPOKEN_CHARS',
  ]);
  // agents-js initializes its logger once the CLI runs a command; console until then.
  console.info(
    `voice worker: protocol v${LIVEKIT_PROTOCOL_VERSION}, host URL ${liveKitHostUrl(env)} (LIVEKIT_HOST_URL)`,
  );
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
