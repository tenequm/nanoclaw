/**
 * The LiveKit Agents worker for the voice channel's LiveKit path: walkie-talkie
 * mode, where the caller talks to the line's real NanoClaw agent.
 *
 * A separate process (`pnpm run voice-worker`), because agents-js runs every
 * job in a forked child process of its worker and owns that process's signals
 * and logging; the host dispatches it to each call's room (explicit dispatch
 * by agent name) and the two talk over the host's webhook server, see
 * `src/channels/voice-livekit.ts` for the protocol. The host's address and the
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
 *    `session.say()` once the caller is not mid-turn, uninterruptible: while
 *    it plays, the caller's audio is not transcribed (no barge-in); Gemini
 *    TTS, through LiveKit's TTS FallbackAdapter onto a second model.
 * The session owns the audio, captions and `lk.agent.state`; "thinking" goes
 * on a separate attribute, since a session without an LLM never thinks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ReadableStream, TransformStream } from 'node:stream/web';
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
import { AudioFrame, AudioResampler, RoomEvent } from '@livekit/rtc-node';

import {
  DEFAULT_LIVEKIT_AGENT_NAME,
  HOST_SILENCE_MS,
  LIVEKIT_PROTOCOL_VERSION,
  liveKitCallSecret,
  liveKitHostUrl,
  WALKIE_STATUS_ATTRIBUTE,
  type LiveKitHostEvent,
  type LiveKitJobMetadata,
  type WalkieStatus,
} from './channels/voice-livekit-protocol.js';
import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';

/** The worker's duration cap outlasts the host's by this; it only fires when the host is gone. */
const WORKER_DEADLINE_GRACE_MS = 30_000;
/** Silero and the transcription both run at 16 kHz. */
export const INPUT_SAMPLE_RATE = 16_000;
/** Language hints for the transcription; the call's language for the worker's own lines. */
export const STT_LANGUAGE_CODES = ['uk-UA', 'en-US'] as const;
/** Gemini's custom vocabulary works best up to this many terms. */
export const MAX_VOCABULARY_TERMS = 100;
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
export const MIN_LOST_SPEECH_MS = 800;
/** Longest wait for the next TTS frame: Gemini 3.8 TTS takes seconds to first audio, and a failover adds a try. */
const TTS_IDLE_TIMEOUT_MS = 60_000;
const UNARY_STT_TIMEOUT_MS = 30_000;
/** The fallback transcription cuts speech at pauses this long: fewer, longer requests on a small quota. */
const FALLBACK_MIN_SILENCE_MS = 1_000;
/** While the fallback transcribes, the streaming model is tried again this often, at a pause. */
const HAND_BACK_RETRY_MS = 60_000;
/** Silero's default: its end-of-speech comes this long after the speech stopped. */
const VAD_SILENCE_MS = 550;
/** A worker on another protocol version waits this long for the caller's page to see why. */
const MISMATCH_NOTICE_MS = 3_000;
/** A turn recording keeps this much audio from before the caller's first speech, and after the last. */
const RECORDING_PAD_MS = 300;
/** Longest turn recording; audio past it is not kept. */
export const MAX_RECORDED_TURN_MS = 120_000;
const DAY_MS = 86_400_000;

const agentRoute = (hostUrl: string, path: string): string => `${hostUrl}/webhook/voice/livekit/agent/${path}`;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

/** The worker's HTTP client for the host's /webhook/voice/livekit/agent routes. */
export class HostLink {
  constructor(
    private readonly link: { hostUrl: string; secret: string; callId: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string): string {
    return agentRoute(this.link.hostUrl, path);
  }

  post(path: 'joined' | 'utterance' | 'ended', body: Record<string, unknown> = {}): Promise<Response> {
    return this.fetchImpl(this.url(path), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.link.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId: this.link.callId, ...body }),
      signal: AbortSignal.timeout(10_000),
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
const DEFAULT_CALL_LANGUAGE: CallLanguage = STT_LANGUAGE_CODES[0].startsWith('uk') ? 'uk' : 'en';

/** What the worker says itself when the exchange breaks, in the call's language. */
export const FAILURE_LINES: Record<'turn' | 'reply', Record<CallLanguage, string>> = {
  turn: { uk: 'Не розчув, повтори, будь ласка.', en: "Sorry, I didn't catch that." },
  reply: { uk: 'Не вийшло озвучити відповідь, вона є на екрані.', en: "Sorry, I couldn't read that reply out." },
};

/** The language a transcript is in, by its script; undefined when it has no letters. */
export function languageOf(text: string): CallLanguage | undefined {
  if (/\p{Script=Cyrillic}/u.test(text)) return 'uk';
  if (/[A-Za-z]/.test(text)) return 'en';
  return undefined;
}

/** The line's vocabulary for Gemini: trimmed, deduplicated ignoring case, and capped. */
export function sttVocabulary(terms: readonly string[], log: Pick<Console, 'warn'>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const term = raw.trim();
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  if (out.length > MAX_VOCABULARY_TERMS) {
    log.warn(
      `voice worker: the line's vocabulary has ${out.length} terms; the transcription gets the first ${MAX_VOCABULARY_TERMS}`,
    );
    return out.slice(0, MAX_VOCABULARY_TERMS);
  }
  return out;
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
    const frame = mergeFrames(buffer);
    // An empty result, not an error: the adapter's recovery probe then idles quietly.
    if (!this.opts.shouldServe()) return this.final('');
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
export class FallbackTranscription extends stt.StreamAdapter {
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
  private resampler?: { rate: number; resampler: AudioResampler };

  constructor(private readonly now: () => number = () => Date.now()) {}

  push(frame: AudioFrame): void {
    for (const pcm of this.to16k(frame)) this.append(pcm);
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

  private to16k(frame: AudioFrame): Int16Array[] {
    if (frame.sampleRate === INPUT_SAMPLE_RATE) return [frame.data];
    if (this.resampler?.rate !== frame.sampleRate) {
      this.resampler?.resampler.close();
      this.resampler = {
        rate: frame.sampleRate,
        resampler: new AudioResampler(frame.sampleRate, INPUT_SAMPLE_RATE, frame.channels),
      };
    }
    return this.resampler.resampler.push(frame).map((f) => f.data);
  }
}

/** 16-bit mono PCM as a WAV file. */
export function pcmToWav(pcm: Int16Array, sampleRate: number): Buffer {
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

/** A name as one safe path segment. */
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
      } else if (entry.isFile() && (await fs.promises.stat(full)).mtimeMs < cutoff) {
        await fs.promises.unlink(full);
        removed++;
        left--;
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
  setStatus(status: WalkieStatus): void;
  close(): Promise<void>;
}

/** What the session reports back. `audio` is the turn's recording, when recordings are on. */
export interface CallVoiceEvents {
  /** The caller finished a turn; this is its transcript. */
  onTurn(text: string, turn: TurnTake): void;
  onCallerSpeaking(speaking: boolean): void;
  /** The caller spoke but no transcript came of it. */
  onTurnLost(reason: string, fields: Record<string, unknown>, turn: TurnTake): void;
  /** Speech too short to count as a turn, with nothing transcribed (a cough, a noise). */
  onTurnDropped(reason: string, turn: TurnTake): void;
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
}

export interface WalkieDeps {
  /** Hand a transcript to the host. */
  send(text: string): Promise<SendResult>;
  say(text: string): Promise<boolean>;
  setStatus(status: WalkieStatus): void;
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
  private status?: WalkieStatus;
  private statusTimer?: ReturnType<typeof setTimeout>;
  private feedbackQueued = false;
  private closed = false;

  constructor(
    private readonly deps: WalkieDeps,
    private readonly options: { silenceMs: number; language: CallLanguage },
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

  onTurnLost(reason: string, fields: Record<string, unknown> = {}): void {
    if (this.closed) return;
    this.deps.log.warn(`walkie: a turn was lost (${reason})`, fields);
    this.feedback('turn');
  }

  /** A complete agent message from the host. */
  onReply(text: string): void {
    if (this.closed) return;
    this.thinkingUntil = 0;
    this.refresh();
    const spoken = speakableText(text);
    if (!spoken) return;
    this.enqueue(async () => {
      if (!(await this.deps.say(spoken)) && !this.closed) {
        this.deps.log.warn('walkie: a reply could not be synthesized');
        this.feedback('reply');
      }
    });
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
    if (!result.accepted) return this.feedback('turn');
    this.thinkingUntil = Math.max(this.thinkingUntil, this.now() + AWAIT_REPLY_MS);
    this.refresh();
  }

  private feedback(kind: 'turn' | 'reply'): void {
    if (this.closed || this.feedbackQueued) return;
    this.feedbackQueued = true;
    this.enqueue(async () => {
      this.feedbackQueued = false;
      await this.deps.say(FAILURE_LINES[kind][this.options.language]);
    });
  }

  private enqueue(job: () => Promise<void>): void {
    this.speech = this.speech
      .then(async () => {
        await this.callerIdle();
        if (!this.closed) await job();
      })
      .catch((err: unknown) => this.deps.log.warn('walkie: speaking failed', { err }));
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
    const next: WalkieStatus = t < this.thinkingUntil ? 'thinking' : 'idle';
    clearTimeout(this.statusTimer);
    if (next === 'thinking') {
      this.statusTimer = setTimeout(() => this.refresh(), this.thinkingUntil - t + 1);
      this.statusTimer.unref?.();
    }
    if (next !== this.status) {
      this.status = next;
      this.deps.setStatus(next);
    }
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
  /** Mark the worker's participant (the version-mismatch notice for the caller's page). */
  setStatus(ctx: CallJob, status: WalkieStatus): Promise<void>;
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

export const loadVad = (): Promise<VAD> => silero.VAD.load({ sampleRate: INPUT_SAMPLE_RATE });
export const loadFallbackVad = (): Promise<VAD> =>
  silero.VAD.load({ sampleRate: INPUT_SAMPLE_RATE, minSilenceDuration: FALLBACK_MIN_SILENCE_MS });

class WalkieAgent extends voice.Agent {
  constructor(
    private readonly onTurn: (text: string) => void,
    private readonly tap?: (frame: AudioFrame) => void,
  ) {
    super({ instructions: '' });
  }

  /** With no LLM in the session, nothing answers after this; the host's agent does, later. */
  override async onUserTurnCompleted(_chatCtx: llm.ChatContext, message: llm.ChatMessage): Promise<void> {
    const text = message.textContent?.trim();
    if (text) this.onTurn(text);
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

const setParticipantStatus = async (ctx: CallJob, status: WalkieStatus): Promise<void> => {
  await ctx.room.localParticipant?.setAttributes({ [WALKIE_STATUS_ATTRIBUTE]: status });
};

type WorkerLog = Pick<Console, 'info' | 'warn' | 'error'>;

/**
 * The call's AgentSession: VAD turns, streaming STT, Gemini TTS, no LLM, wired to `events`. Not
 * started; `sessionVoice` starts it in the room (a smoke test can start it on its own audio IO).
 */
export function walkieSession(
  meta: LiveKitJobMetadata,
  settings: VoiceSettings,
  vads: { vad: VAD; fallbackVad?: VAD },
  events: CallVoiceEvents,
  log: WorkerLog,
): { session: voice.AgentSession; agent: voice.Agent; say(text: string): Promise<boolean> } {
  const apiKey = settings.geminiKey;
  const capture = settings.record ? new TurnCapture() : undefined;
  const vocabulary = sttVocabulary(meta.vocabulary ?? [], log);
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
  const handBackTimer = fallback ? setInterval(handBack, 10_000) : undefined;
  handBackTimer?.unref();
  /** The models that transcribed the open turn. */
  const heardBy = new Set<string>();
  const take = (): TurnTake & { speechMs: number } => {
    const models = [...heardBy];
    heardBy.clear();
    turnOpen = false;
    const speechMs = turnSpeechMs;
    turnSpeechMs = 0;
    const turn = {
      audio: capture?.take(),
      sttModel: models.length > 0 ? models.join('+') : fallbackServing() ? (fallbackModel ?? '') : meta.sttModel,
      speechMs,
    };
    handBack();
    return turn;
  };

  const primaryTts = new google.beta.TTS({ apiKey, model: meta.ttsModel, voiceName: meta.ttsVoice, instructions: '' });
  let speech: tts.TTS = primaryTts;
  if (meta.ttsFallbackModel) {
    const ttsAdapter = new tts.FallbackAdapter({
      ttsInstances: [
        primaryTts,
        new google.beta.TTS({ apiKey, model: meta.ttsFallbackModel, voiceName: meta.ttsVoice, instructions: '' }),
      ],
      maxRetryPerTTS: 1,
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
    // Sentences batch into chunks of up to 400 characters, the first one short so speech starts
    // soon. Every chunk is requested at once, so the next one is ready while one plays.
    tts: new tts.StreamAdapter(
      speech,
      new tokenize.basic.SentenceTokenizer({ minTokenLength: 250, maxTokenLength: 400, firstTokenLength: 20 }),
    ),
    turnHandling: {
      // The turn detector models have no Ukrainian; the default would build one anyway.
      turnDetection: 'vad',
      endpointing: { mode: 'fixed', minDelay: meta.silenceMs, maxDelay: Math.max(meta.silenceMs, 3000) },
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
      sttConnOptions: { maxRetry: 3 },
    },
  });

  let agentSpeaking = false;
  let agentSpokeAt = 0;
  let sttFailedAt = 0;
  let saying: { failed: boolean } | undefined;
  session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
    const speaking = ev.newState === 'speaking';
    if (speaking) {
      turnOpen = true;
      speakingSince = Date.now();
    } else if (ev.oldState === 'speaking') {
      turnSpeechMs += Math.max(0, Date.now() - speakingSince - VAD_SILENCE_MS);
    }
    capture?.onSpeaking(speaking);
    events.onCallerSpeaking(speaking);
  });
  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
    if (ev.isFinal && ev.transcript.trim()) heardBy.add(fallbackServing() ? (fallbackModel ?? '') : meta.sttModel);
  });
  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
    agentSpeaking = ev.newState === 'speaking';
    if (ev.oldState === 'speaking' || agentSpeaking) agentSpokeAt = Date.now();
  });
  session.on(voice.AgentSessionEventTypes.Error, (ev) => {
    const err = ev.error;
    if (err.recoverable) return;
    if (err.type === 'stt_error') sttFailedAt = Date.now();
    if (err.type === 'tts_error' && saying) saying.failed = true;
  });
  session.on(voice.AgentSessionEventTypes.UserTranscriptionTimeout, (ev) => {
    const { speechMs, ...turn } = take();
    // While the agent speaks the transcription hears silence on purpose: the caller is not heard.
    if (agentSpeaking || agentSpokeAt >= ev.vadSpeechStartedAt) return;
    const sttFailed = sttFailedAt >= ev.vadSpeechStartedAt;
    // Silero reports no speech length at its end of speech, so the session's own count is taken too.
    const spokeMs = Math.max(ev.speechDuration, speechMs);
    if (spokeMs < MIN_LOST_SPEECH_MS && !sttFailed) return events.onTurnDropped('too little speech', turn);
    events.onTurnLost(sttFailed ? 'transcription failed' : 'no transcript', { speechMs: spokeMs }, turn);
  });
  session.on(voice.AgentSessionEventTypes.Close, (ev) => {
    clearInterval(handBackTimer);
    events.onClosed(`session closed: ${ev.reason}`);
  });

  return {
    session,
    agent: new WalkieAgent(
      (text) => {
        const { speechMs: _speechMs, ...turn } = take();
        events.onTurn(text, turn);
      },
      capture && ((frame) => capture.push(frame)),
    ),
    async say(text) {
      const state = { failed: false };
      saying = state;
      try {
        await session.say(text, { allowInterruptions: false, addToChatCtx: false }).waitForPlayout();
      } finally {
        if (saying === state) saying = undefined;
      }
      return !state.failed;
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
  const logger = agentsLog().child({ callId: meta.callId });
  const log: WorkerLog = {
    info: (msg: string, fields?: unknown) => logger.info(fields ?? {}, msg),
    warn: (msg: string, fields?: unknown) => logger.warn(fields ?? {}, msg),
    error: (msg: string, fields?: unknown) => logger.error(fields ?? {}, msg),
  };
  const userData = ctx.proc.userData as WorkerUserData;
  userData.vad ??= await loadVad();
  if (meta.sttFallbackModel) userData.fallbackVad ??= await loadFallbackVad();
  const { session, agent, say } = walkieSession(
    meta,
    settings,
    { vad: userData.vad, fallbackVad: userData.fallbackVad },
    events,
    log,
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
    setStatus(status) {
      void setParticipantStatus(ctx, status).catch(() => undefined);
    },
    async close() {
      await session.close().catch(() => undefined);
    },
  };
}

function defaultDeps(): RunCallDeps {
  const logger = agentsLog();
  return {
    env: workerEnv(['GEMINI_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_HOST_URL', 'WALKIE_RECORDINGS_DAYS']),
    createVoice: (ctx, meta, settings, events) => sessionVoice(ctx as JobContext, meta, settings, events),
    setStatus: setParticipantStatus,
    log: {
      info: (msg: string, fields?: unknown) => logger.info(fields ?? {}, msg),
      warn: (msg: string, fields?: unknown) => logger.warn(fields ?? {}, msg),
    } as Pick<Console, 'info' | 'warn'>,
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
    await host.post('ended', { reason }).catch(() => undefined);
    await ctx.deleteRoom().catch(() => undefined);
    ctx.shutdown(reason);
  };
  if (!deps.env.LIVEKIT_API_SECRET) return abandon('LIVEKIT_API_SECRET is not set for the worker');

  if (header.v !== LIVEKIT_PROTOCOL_VERSION) {
    // Host and worker were not restarted together. Tell the caller's page, then let the host end it.
    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
    await deps.setStatus(ctx, 'updating').catch(() => undefined);
    await withTimeout(ctx.waitForParticipant(header.callerIdentity), 30_000, 'caller never joined').catch(
      () => undefined,
    );
    await sleep(MISMATCH_NOTICE_MS);
    return abandon(`protocol mismatch: host sent v${String(header.v)}, worker speaks v${LIVEKIT_PROTOCOL_VERSION}`);
  }
  const meta = parseJobMetadata(ctx.job.metadata);
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
        const res = await host.post('utterance', { text });
        if (res.status === 202) {
          const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
          return { accepted: true, status: 202, id: typeof body?.id === 'string' ? body.id : undefined };
        }
        void res.body?.cancel().catch(() => {});
        callLog.warn('voice worker: the host refused a turn', { status: res.status });
        return { accepted: false, status: res.status };
      },
      say: (text) => callVoice?.say(text) ?? Promise.resolve(false),
      setStatus: (status) => callVoice?.setStatus(status),
      log: callLog,
    },
    { silenceMs: meta.silenceMs, language: DEFAULT_CALL_LANGUAGE },
  );
  const end = async (reason: string, tellHost: boolean) => {
    if (ending) return;
    ending = true;
    walkie.close();
    hostLink.abort();
    if (tellHost) await host.post('ended', { reason }).catch(() => undefined);
    await callVoice?.close().catch(() => undefined);
    await ctx.deleteRoom().catch(() => undefined);
    ctx.shutdown(reason);
  };
  // Turn recordings are written once the turn is settled, off the path to the host.
  let turns = 0;
  const saveTurn = (
    { audio, sttModel }: TurnTake,
    transcript: string,
    outcome: { reason?: string; host?: SendResult },
  ) => {
    if (!audio) return;
    const turn = ++turns;
    const record: TurnRecord = {
      callId: meta.callId,
      lineId: meta.lineId,
      agent: meta.agentName,
      turn,
      startedAt: new Date(audio.startedAt).toISOString(),
      endedAt: new Date(audio.endedAt).toISOString(),
      speechMs: audio.speechMs,
      truncated: audio.truncated,
      sttModel,
      transcript,
      ...outcome,
    };
    void writeTurnRecording(deps.recordingsRoot ?? recordingsRoot(), record, audio).catch((err: unknown) =>
      callLog.warn('voice worker: could not save a turn recording', { err, turn }),
    );
  };
  try {
    callVoice = await deps.createVoice(
      ctx,
      meta,
      { geminiKey, record },
      {
        onTurn: (text, turn) => walkie.onTurn(text, (host) => saveTurn(turn, text, { host })),
        onCallerSpeaking: (speaking) => walkie.onCallerSpeaking(speaking),
        onTurnLost: (reason, fields, turn) => {
          walkie.onTurnLost(reason, fields);
          saveTurn(turn, '', { reason });
        },
        onTurnDropped: (reason, turn) => saveTurn(turn, '', { reason }),
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
    await end('job shutdown', true);
  });
  ctx.room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    if (participant.identity === meta.callerIdentity) void end('caller left', true);
  });

  host
    .events((event) => {
      if (event.type === 'end') void end(`host: ${event.reason}`, false);
      else if (event.type === 'reply') walkie.onReply(event.text);
      else if (event.type === 'thinking') walkie.onThinking();
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
  ]);
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
