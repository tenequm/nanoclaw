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
 * host (which starts the clock), publish the agent's audio track, then:
 *  - Silero VAD scores the caller's audio in 32 ms windows; a TurnDetector
 *    collects one turn, through short pauses, until the caller has been
 *    silent for `silenceMs`, and drops turns with too little speech (coughs);
 *  - each turn is transcribed in one Gemini request and posted to the host,
 *    which hands it to the agent as a spoken message;
 *  - each complete agent reply from the host's event stream is turned into
 *    plain speakable text, cut into sentence-sized chunks, synthesized with
 *    Gemini TTS and played into the room; replies play whole and in order.
 * Walkie-talkie: while a reply plays, the caller's audio is dropped, and a
 * reply waits for a caller who is mid-turn to finish. While the agent thinks
 * the line stays silent; the caller can keep talking, and each turn goes to
 * the agent as a follow-up.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  AutoSubscribe,
  cli,
  defineAgent,
  log as agentsLog,
  ServerOptions,
  VADEventType,
  type JobContext,
  type JobProcess,
  type VAD,
} from '@livekit/agents';
import * as silero from '@livekit/agents-plugin-silero';
import {
  AudioFrame,
  AudioResampler,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from '@livekit/rtc-node';

import {
  DEFAULT_LIVEKIT_AGENT_NAME,
  HOST_SILENCE_MS,
  liveKitCallSecret,
  liveKitHostUrl,
  type LiveKitHostEvent,
  type LiveKitJobMetadata,
} from './channels/voice-livekit-protocol.js';
import { readEnvFile } from './env.js';

/** The worker's duration cap outlasts the host's by this; it only fires when the host is gone. */
const WORKER_DEADLINE_GRACE_MS = 30_000;
const HOST_PROBE_INTERVAL_MS = 30_000;
const HOST_PROBE_TIMEOUT_MS = 3_000;

/** Silero runs at 16 kHz, and that is what the transcription gets. */
export const INPUT_SAMPLE_RATE = 16_000;
/** Gemini TTS speaks 24 kHz PCM; the agent's track runs at that rate. */
export const OUTPUT_SAMPLE_RATE = 24_000;
/** Silero's own activation threshold: a window above it is speech. */
const SPEECH_THRESHOLD = 0.5;
export const MIN_SPEECH_MS = 400;
/** Longest turn: about 4 KB of Ukrainian transcript and 4 MB of base64 audio, well inside both caps. */
export const MAX_TURN_MS = 90_000;
/** VAD fires a little after the onset, so the turn keeps this much from before its first speech window. */
const PRE_ROLL_MS = 300;
/** Of the silence that ended the turn, this much stays in the audio; the rest is cut. */
const POST_ROLL_MS = 400;
/** Room echo the browser's canceller missed still counts as playback for this long. */
const PLAYBACK_TAIL_MS = 300;
/** One typing tick from the host keeps "thinking" up this long; the host re-fires every 4 s. */
const THINKING_HOLD_MS = 10_000;
/** After a turn went out, "thinking" holds at most this long without a reply or typing tick. */
const AWAIT_REPLY_MS = 120_000;
/** Text per TTS request: synthesis time grows with length, and the next chunk is made while one plays. */
export const TTS_CHUNK_CHARS = 400;
const FRAME_MS = 20;

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const STT_TIMEOUT_MS = 30_000;
const TTS_TIMEOUT_MS = 60_000;
const STT_ATTEMPTS = 2;
/** Gemini TTS now and then answers with text instead of audio; Google advises retrying. */
const TTS_ATTEMPTS = 3;

const agentRoute = (hostUrl: string, path: string): string => `${hostUrl}/webhook/voice/livekit/agent/${path}`;

const samplesFor = (ms: number, sampleRate: number): number => Math.round((ms * sampleRate) / 1000);

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

export interface Turn {
  pcm: Int16Array;
  speechMs: number;
}

export interface TurnDetectorOptions {
  sampleRate: number;
  silenceMs: number;
  minSpeechMs?: number;
  maxTurnMs?: number;
  preRollMs?: number;
  postRollMs?: number;
  /** A turn ended with less speech than minSpeechMs and was dropped. */
  onDrop?: (speechMs: number) => void;
}

/**
 * Cuts the caller's audio into turns from per-window VAD decisions. A turn opens on the first
 * speech window, survives pauses shorter than `silenceMs`, and ends after `silenceMs` of silence
 * or at `maxTurnMs`. Time is counted in samples, so it follows the audio, not the clock.
 */
export class TurnDetector {
  private chunks: Int16Array[] = [];
  private preRoll: Int16Array[] = [];
  private preRollSamples = 0;
  private inTurn = false;
  private samples = 0;
  private speechSamples = 0;
  private silenceSamples = 0;
  private lastSpeechEnd = 0;
  private readonly silenceLimit: number;
  private readonly maxSamples: number;
  private readonly preRollLimit: number;
  private readonly postRoll: number;
  private readonly minSpeechMs: number;

  constructor(private readonly opts: TurnDetectorOptions) {
    this.silenceLimit = samplesFor(opts.silenceMs, opts.sampleRate);
    this.maxSamples = samplesFor(opts.maxTurnMs ?? MAX_TURN_MS, opts.sampleRate);
    this.preRollLimit = samplesFor(opts.preRollMs ?? PRE_ROLL_MS, opts.sampleRate);
    this.postRoll = samplesFor(opts.postRollMs ?? POST_ROLL_MS, opts.sampleRate);
    this.minSpeechMs = opts.minSpeechMs ?? MIN_SPEECH_MS;
  }

  /** A turn is open: the caller has spoken and not yet been silent long enough. */
  get active(): boolean {
    return this.inTurn;
  }

  /** Feed one VAD window; returns the turn this window completed, if any. */
  push(window: Int16Array, speech: boolean): Turn | null {
    const pcm = window.slice();
    if (!this.inTurn) {
      if (!speech) {
        this.preRoll.push(pcm);
        this.preRollSamples += pcm.length;
        while (this.preRoll.length > 1 && this.preRollSamples - this.preRoll[0].length >= this.preRollLimit) {
          this.preRollSamples -= this.preRoll.shift()!.length;
        }
        return null;
      }
      this.inTurn = true;
      this.chunks = this.preRoll;
      this.samples = this.preRollSamples;
      this.preRoll = [];
      this.preRollSamples = 0;
    }
    this.chunks.push(pcm);
    this.samples += pcm.length;
    if (speech) {
      this.speechSamples += pcm.length;
      this.silenceSamples = 0;
      this.lastSpeechEnd = this.samples;
    } else {
      this.silenceSamples += pcm.length;
    }
    if (this.silenceSamples >= this.silenceLimit || this.samples >= this.maxSamples) return this.finish();
    return null;
  }

  /** Forget everything heard so far, the open turn included. */
  reset(): void {
    this.inTurn = false;
    this.chunks = [];
    this.preRoll = [];
    this.preRollSamples = 0;
    this.samples = 0;
    this.speechSamples = 0;
    this.silenceSamples = 0;
    this.lastSpeechEnd = 0;
  }

  private finish(): Turn | null {
    const length = Math.min(this.samples, this.lastSpeechEnd + this.postRoll);
    const speechMs = Math.round((this.speechSamples * 1000) / this.opts.sampleRate);
    const chunks = this.chunks;
    this.reset();
    if (speechMs < this.minSpeechMs) {
      this.opts.onDrop?.(speechMs);
      return null;
    }
    const pcm = new Int16Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      if (offset >= length) break;
      const part = chunk.subarray(0, length - offset);
      pcm.set(part, offset);
      offset += part.length;
    }
    return { pcm, speechMs };
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

/** Speech audio from Gemini: raw `audio/L16;rate=…` from the 3.1 TTS models, WAV from 3.8. */
export function decodeSpeechAudio(data: Buffer, mimeType: string): { pcm: Int16Array; sampleRate: number } {
  let sampleRate = Number(/rate=(\d+)/i.exec(mimeType)?.[1]) || OUTPUT_SAMPLE_RATE;
  let body = data;
  if (/wav/i.test(mimeType) || data.subarray(0, 4).toString('ascii') === 'RIFF') {
    let offset = 12;
    body = Buffer.alloc(0);
    while (offset + 8 <= data.length) {
      const id = data.subarray(offset, offset + 4).toString('ascii');
      const size = data.readUInt32LE(offset + 4);
      if (id === 'fmt ') sampleRate = data.readUInt32LE(offset + 12);
      if (id === 'data') {
        body = data.subarray(offset + 8, Math.min(data.length, offset + 8 + size));
        break;
      }
      offset += 8 + size + (size % 2);
    }
  }
  const pcm = new Int16Array(Math.floor(body.length / 2));
  for (let i = 0; i < pcm.length; i++) pcm[i] = body.readInt16LE(i * 2);
  return { pcm, sampleRate };
}

/** A Gemini API failure; `status` 0 means the request never got an answer. */
export class GeminiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

const retryable = (err: unknown): boolean =>
  !(err instanceof GeminiError) || err.status === 0 || err.status === 429 || err.status >= 500;

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType?: string; data?: string };
}

export interface GeminiOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

async function generateContent(
  opts: GeminiOptions,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<GeminiPart[]> {
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(
      `${opts.apiBase ?? GEMINI_API_BASE}/models/${encodeURIComponent(opts.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': opts.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch (err) {
    throw new GeminiError(0, `request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const json = (await res.json().catch(() => null)) as {
    error?: { message?: string };
    candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  } | null;
  if (!res.ok) throw new GeminiError(res.status, `${res.status} ${json?.error?.message?.slice(0, 200) ?? ''}`.trim());
  return json?.candidates?.[0]?.content?.parts ?? [];
}

async function withAttempts<T>(attempts: number, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= attempts || !retryable(err)) throw err;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
}

/** The transcription prompt: verbatim, Ukrainian or English, the line's names as spelling hints. */
export function transcriptionPrompt(vocabulary: readonly string[]): string {
  return [
    'Transcribe the speech in this audio verbatim.',
    'The speaker speaks Ukrainian or English and may switch between them mid-sentence.',
    'Keep every word as spoken, in the language it was spoken in: Ukrainian in Cyrillic, English in Latin letters. ' +
      'No paraphrasing, no translation, no corrections, no summary.',
    vocabulary.length > 0
      ? `Names and terms that may come up, spelled the way to write them: ${vocabulary.join(', ')}.`
      : '',
    'Output only the transcript text, with no labels, timestamps, quotes or notes. ' +
      'If there is no intelligible speech, output nothing.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Gemini 3 text models think by default; low keeps a transcript fast. Other models get no setting. */
const sttThinking = (model: string): Record<string, unknown> =>
  /^gemini-3/.test(model) && !/transcribe|tts|live|image/.test(model)
    ? { thinkingConfig: { thinkingLevel: 'low' } }
    : {};

export function transcriptionRequest(pcm: Int16Array, model: string, vocabulary: readonly string[]) {
  return {
    contents: [
      {
        role: 'user',
        parts: [
          { text: transcriptionPrompt(vocabulary) },
          { inlineData: { mimeType: 'audio/wav', data: pcmToWav(pcm, INPUT_SAMPLE_RATE).toString('base64') } },
        ],
      },
    ],
    generationConfig: { temperature: 0, ...sttThinking(model) },
  };
}

/** What the model writes for a turn with no words in it, e.g. "[silence]" or "(no speech)". */
const NOISE_ONLY = /^[[(][^\])]*[\])]$/;

/** One turn's audio to text; empty when it holds no speech. */
export async function transcribe(
  pcm: Int16Array,
  opts: GeminiOptions & { vocabulary: readonly string[] },
): Promise<string> {
  const parts = await withAttempts(STT_ATTEMPTS, () =>
    generateContent(opts, transcriptionRequest(pcm, opts.model, opts.vocabulary), STT_TIMEOUT_MS),
  );
  const text = parts
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim()
    .replace(/^["“«](.*)["”»]$/s, '$1')
    .trim();
  return NOISE_ONLY.test(text) ? '' : text;
}

/** Gemini TTS for one chunk of plain text; the voice carries the persona, so no style words are sent. */
export async function synthesize(
  text: string,
  opts: GeminiOptions & { voice: string },
): Promise<{ pcm: Int16Array; sampleRate: number }> {
  const body = {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice } } },
    },
  };
  return withAttempts(TTS_ATTEMPTS, async () => {
    const parts = await generateContent(opts, body, TTS_TIMEOUT_MS);
    const audio = parts.flatMap((p) => (p.inlineData?.data ? [p.inlineData] : []));
    if (audio.length === 0) throw new GeminiError(500, 'the model answered without audio');
    const mimeType = audio[0].mimeType ?? '';
    const decoded = audio.map((a) => decodeSpeechAudio(Buffer.from(a.data!, 'base64'), mimeType));
    const pcm = new Int16Array(decoded.reduce((n, d) => n + d.pcm.length, 0));
    let offset = 0;
    for (const d of decoded) {
      pcm.set(d.pcm, offset);
      offset += d.pcm.length;
    }
    return { pcm, sampleRate: decoded[0].sampleRate };
  });
}

/**
 * An agent message as words to say: markdown, links, code and markup removed, every line a
 * sentence. The agent is asked for plain spoken text; this covers the times it is not.
 */
export function speakableText(message: string): string {
  const lines = message
    .replace(/```[\s\S]*?(```|$)/g, '\n')
    .replace(/<[^>\n]+>/g, ' ')
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

/** Plain text in chunks of at most `maxChars`, cut at sentence ends, then at commas or spaces. */
export function splitForSpeech(text: string, maxChars = TTS_CHUNK_CHARS): string[] {
  const sentences = text.match(/[^.!?…]+(?:[.!?…]+["'»”)\]]*|$)\s*/g) ?? [];
  const pieces: string[] = [];
  for (const sentence of sentences.map((s) => s.trim()).filter(Boolean)) {
    let rest = sentence;
    while (rest.length > maxChars) {
      const window = rest.slice(0, maxChars + 1);
      const cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '));
      const at = cut > maxChars / 3 ? cut + 1 : window.lastIndexOf(' ') > 0 ? window.lastIndexOf(' ') : maxChars;
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) pieces.push(rest);
  }
  const chunks: string[] = [];
  for (const piece of pieces) {
    const last = chunks.at(-1);
    if (last !== undefined && last.length + 1 + piece.length <= maxChars)
      chunks[chunks.length - 1] = `${last} ${piece}`;
    else chunks.push(piece);
  }
  return chunks;
}

export type WalkieState = 'listening' | 'sending' | 'thinking' | 'speaking';

export interface SpeechAudio {
  pcm: Int16Array;
  sampleRate: number;
}

/** What a call needs from the outside: Gemini, the host, the room. Fakes in tests. */
export interface WalkieDeps {
  transcribe(pcm: Int16Array): Promise<string>;
  /** Hand a transcript to the host; resolves whether the agent got it. */
  send(text: string): Promise<boolean>;
  synthesize(text: string): Promise<SpeechAudio>;
  /** Resolves once the audio has played out. */
  play(audio: SpeechAudio): Promise<void>;
  caption(role: 'caller' | 'agent', text: string): void;
  setState(state: WalkieState): void;
  log: Pick<Console, 'info' | 'warn'>;
  now?: () => number;
}

export interface WalkieOptions {
  silenceMs: number;
  minSpeechMs?: number;
  playbackTailMs?: number;
}

/** One call in walkie-talkie mode: caller turns out to the agent, agent replies into the room. */
export class WalkieCall {
  private readonly turns: TurnDetector;
  private readonly now: () => number;
  /** A reply holds the channel, from its first chunk until the tail after its last. */
  private playing = false;
  private sending = 0;
  private thinkingUntil = 0;
  private turnQueue: Promise<void> = Promise.resolve();
  private replyQueue: Promise<void> = Promise.resolve();
  private idleWaiters: Array<() => void> = [];
  private state?: WalkieState;
  private stateTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(
    private readonly deps: WalkieDeps,
    private readonly options: WalkieOptions,
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.turns = new TurnDetector({
      sampleRate: INPUT_SAMPLE_RATE,
      silenceMs: options.silenceMs,
      minSpeechMs: options.minSpeechMs,
      onDrop: (speechMs) => deps.log.info('walkie: dropped a turn with too little speech', { speechMs }),
    });
    this.refresh();
  }

  /** One VAD window of the caller's audio. */
  onAudio(pcm: Int16Array, speech: boolean): void {
    if (this.closed || this.playing) return;
    const turn = this.turns.push(pcm, speech);
    if (!this.turns.active) this.wakeIdle();
    if (turn) this.turnQueue = this.turnQueue.then(() => this.sendTurn(turn));
  }

  /** A complete agent message from the host. */
  onReply(text: string): void {
    if (this.closed) return;
    this.thinkingUntil = 0;
    this.refresh();
    const spoken = speakableText(text);
    const chunks = splitForSpeech(spoken);
    if (chunks.length === 0) return;
    // Synthesis starts now, one chunk after another; playback waits for the replies before it.
    const audio: Array<Promise<SpeechAudio | null>> = [];
    let previous: Promise<unknown> = Promise.resolve();
    for (const chunk of chunks) {
      const next = previous.then(() =>
        this.closed
          ? null
          : this.deps.synthesize(chunk).catch((err: unknown) => {
              this.deps.log.warn('walkie: speech synthesis failed; skipping a chunk', { err });
              return null;
            }),
      );
      audio.push(next);
      previous = next;
    }
    this.replyQueue = this.replyQueue.then(() => this.playReply(spoken, audio));
  }

  /** The agent is still working (the host's typing refresh). */
  onThinking(): void {
    if (this.closed) return;
    this.thinkingUntil = Math.max(this.thinkingUntil, this.now() + THINKING_HOLD_MS);
    this.refresh();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.stateTimer);
    this.wakeIdle();
  }

  private async sendTurn(turn: Turn): Promise<void> {
    if (this.closed) return;
    this.sending++;
    this.refresh();
    try {
      let text: string;
      try {
        text = await this.deps.transcribe(turn.pcm);
      } catch (err) {
        this.deps.log.warn('walkie: transcription failed; the turn is lost', { err, speechMs: turn.speechMs });
        return;
      }
      if (!text || this.closed) {
        if (!text) this.deps.log.info('walkie: a turn held no words', { speechMs: turn.speechMs });
        return;
      }
      this.deps.caption('caller', text);
      const sent = await this.deps.send(text).catch((err: unknown) => {
        this.deps.log.warn('walkie: could not hand the turn to the host', { err });
        return false;
      });
      if (sent) this.thinkingUntil = Math.max(this.thinkingUntil, this.now() + AWAIT_REPLY_MS);
    } finally {
      this.sending--;
      this.refresh();
    }
  }

  private async playReply(text: string, audio: Array<Promise<SpeechAudio | null>>): Promise<void> {
    // Before taking the channel: the caller can still talk while the first chunk is made.
    await audio[0];
    await this.callerIdle();
    if (this.closed) return;
    this.playing = true;
    this.turns.reset();
    this.refresh();
    this.deps.caption('agent', text);
    try {
      for (const pending of audio) {
        const chunk = await pending;
        if (this.closed) return;
        if (!chunk) continue;
        await this.deps.play(chunk).catch((err: unknown) => this.deps.log.warn('walkie: playback failed', { err }));
      }
    } finally {
      const tail = this.options.playbackTailMs ?? PLAYBACK_TAIL_MS;
      if (tail > 0 && !this.closed) await new Promise((r) => setTimeout(r, tail));
      this.playing = false;
      this.refresh();
    }
  }

  private callerIdle(): Promise<void> {
    if (!this.turns.active || this.closed) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private wakeIdle(): void {
    for (const wake of this.idleWaiters.splice(0)) wake();
  }

  private refresh(): void {
    if (this.closed) return;
    const t = this.now();
    const next: WalkieState = this.playing
      ? 'speaking'
      : this.sending > 0
        ? 'sending'
        : t < this.thinkingUntil
          ? 'thinking'
          : 'listening';
    clearTimeout(this.stateTimer);
    if (next === 'thinking') {
      this.stateTimer = setTimeout(() => this.refresh(), this.thinkingUntil - t + 1);
      this.stateTimer.unref?.();
    }
    if (next !== this.state) {
      this.state = next;
      this.deps.setState(next);
    }
  }
}

/**
 * Asks the host's agent events route without credentials: its 404 ("No such call") proves the
 * worker reaches a running voice host. Returns what is wrong, or null.
 */
export async function probeHost(hostUrl: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchImpl(agentRoute(hostUrl, 'events'), { signal: AbortSignal.timeout(HOST_PROBE_TIMEOUT_MS) });
  } catch (err) {
    return `is unreachable (${err instanceof Error ? err.message : String(err)})`;
  }
  void res.body?.cancel().catch(() => {});
  if (res.status === 404) return null;
  if (res.status === 403) {
    return 'refuses this worker (403): voice routes serve loopback peers only unless GPT_LIVE_ALLOW_NON_LOOPBACK=1';
  }
  if (res.status === 503) return 'answers 503: its voice channel or LiveKit path is not running';
  return `answers ${res.status}, so it is not a NanoClaw voice host`;
}

/** Watches the worker's host URL: probed at startup, and every interval while it fails. */
export class HostMonitor {
  private problem: string | null = null;
  private inFlight?: Promise<boolean>;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly hostUrl: string,
    private readonly log: Pick<Console, 'info' | 'error'>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly intervalMs = HOST_PROBE_INTERVAL_MS,
  ) {}

  /** The last probe failed. */
  get down(): boolean {
    return this.problem !== null;
  }

  start(): Promise<boolean> {
    this.log.info(`voice worker: host URL ${this.hostUrl}`);
    return this.check();
  }

  /** Probe now; resolves whether the host answered. Never rejects. */
  check(): Promise<boolean> {
    this.inFlight ??= this.probe().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  private async probe(): Promise<boolean> {
    clearTimeout(this.timer);
    const problem = await probeHost(this.hostUrl, this.fetchImpl);
    if (problem && problem !== this.problem) {
      this.log.error(
        `voice worker: the host at ${this.hostUrl} ${problem}; calls are refused until it answers. ` +
          "If that is not this NanoClaw's webhook server, set LIVEKIT_HOST_URL in .env",
      );
    } else if (!problem && this.problem) {
      this.log.info(`voice worker: the host at ${this.hostUrl} answers again`);
    }
    this.problem = problem;
    if (problem) {
      this.timer = setTimeout(() => void this.check(), this.intervalMs);
      this.timer.unref?.();
    }
    return !problem;
  }
}

export function parseJobMetadata(raw: string): LiveKitJobMetadata {
  const meta = JSON.parse(raw) as LiveKitJobMetadata;
  if (meta?.v !== 2 || !meta.callId || !meta.callerIdentity || !meta.agentName) {
    throw new Error('voice worker: job metadata is not a NanoClaw walkie-talkie call');
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

/** The room side of a call: the caller's speech in, the agent's voice, captions and state out. */
export interface CallMedia {
  start(handlers: { onWindow(pcm: Int16Array, speech: boolean): void; onCallerLeft(): void }): void;
  play(audio: SpeechAudio): Promise<void>;
  caption(role: 'caller' | 'agent', text: string): void;
  setState(state: WalkieState): void;
  close(): Promise<void>;
}

/** The slice of JobContext runCall uses. */
export type CallJob = Pick<
  JobContext,
  'job' | 'room' | 'connect' | 'waitForParticipant' | 'deleteRoom' | 'shutdown' | 'addShutdownCallback'
>;

export interface RunCallDeps {
  /** The worker's settings; read from .env in the job process, so secrets stay out of argv and process.env. */
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  createMedia(ctx: CallJob, meta: LiveKitJobMetadata, caller: RemoteParticipant): Promise<CallMedia>;
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
}

const loadVad = (): Promise<VAD> => silero.VAD.load({ sampleRate: INPUT_SAMPLE_RATE });

/** The caller's audio through Silero, as 32 ms windows with a speech decision each. */
async function pumpSpeech(
  track: RemoteTrack,
  vad: VAD,
  onWindow: (pcm: Int16Array, speech: boolean) => void,
  stopped: () => boolean,
): Promise<void> {
  const audio = new AudioStream(track, { sampleRate: INPUT_SAMPLE_RATE, numChannels: 1 });
  const vadStream = vad.stream();
  let open = true;
  // close(), not endInput(): agents 1.9.1's endInput closes a writable its own writer still locks.
  const closeVad = () => {
    if (!open) return;
    open = false;
    vadStream.close();
  };
  const feed = (async () => {
    for await (const frame of audio) {
      if (stopped() || !open) break;
      vadStream.pushFrame(frame);
    }
  })().finally(closeVad);
  try {
    for await (const event of vadStream) {
      if (stopped()) break;
      if (event.type !== VADEventType.INFERENCE_DONE) continue;
      for (const frame of event.frames) onWindow(frame.data, event.probability >= SPEECH_THRESHOLD);
    }
  } finally {
    closeVad();
    await feed.catch(() => undefined);
  }
}

/** The real room: the caller's microphone through Silero, one published track for the agent's voice. */
async function roomMedia(ctx: JobContext, meta: LiveKitJobMetadata, caller: RemoteParticipant): Promise<CallMedia> {
  const room = ctx.room;
  const local = room.localParticipant;
  if (!local) throw new Error('voice worker: not connected to the room');
  const userData = ctx.proc.userData as WorkerUserData;
  userData.vad ??= await loadVad();
  const vad = userData.vad;
  const source = new AudioSource(OUTPUT_SAMPLE_RATE, 1);
  const track = LocalAudioTrack.createAudioTrack('agent-voice', source);
  const publication = await local.publishTrack(
    track,
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
  );
  const listening = new Set<string>();
  let callerTrackSid: string | undefined;
  let closed = false;
  const logger = agentsLog();

  return {
    start({ onWindow, onCallerLeft }) {
      const listen = (track: RemoteTrack | undefined, pub: RemoteTrackPublication) => {
        if (closed || !track || track.kind !== TrackKind.KIND_AUDIO || !pub.sid || listening.has(pub.sid)) return;
        listening.add(pub.sid);
        callerTrackSid = pub.sid;
        void pumpSpeech(track, vad, onWindow, () => closed)
          .catch((err: unknown) => logger.warn({ err, callId: meta.callId }, 'voice worker: caller audio failed'))
          .finally(() => listening.delete(pub.sid!));
      };
      room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
        if (participant.identity === meta.callerIdentity) listen(track, pub);
      });
      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        if (participant.identity === meta.callerIdentity) onCallerLeft();
      });
      for (const pub of caller.trackPublications.values()) listen(pub.track, pub);
    },

    async play({ pcm, sampleRate }) {
      let samples = pcm;
      if (sampleRate !== OUTPUT_SAMPLE_RATE) {
        const resampler = new AudioResampler(sampleRate, OUTPUT_SAMPLE_RATE, 1);
        const frames = [...resampler.push(new AudioFrame(pcm, sampleRate, 1, pcm.length)), ...resampler.flush()];
        resampler.close();
        samples = new Int16Array(frames.reduce((n, f) => n + f.data.length, 0));
        let offset = 0;
        for (const f of frames) {
          samples.set(f.data, offset);
          offset += f.data.length;
        }
      }
      const step = samplesFor(FRAME_MS, OUTPUT_SAMPLE_RATE);
      for (let i = 0; i < samples.length && !closed; i += step) {
        const data = samples.slice(i, i + step);
        await source.captureFrame(new AudioFrame(data, OUTPUT_SAMPLE_RATE, 1, data.length));
      }
      if (!closed) await source.waitForPlayout();
    },

    caption(role, text) {
      const trackId = role === 'caller' ? callerTrackSid : publication.sid;
      void local
        .sendText(text, {
          topic: 'lk.transcription',
          attributes: {
            ...(trackId ? { 'lk.transcribed_track_id': trackId } : {}),
            'lk.segment_id': randomBytes(6).toString('hex'),
            'lk.transcription_final': 'true',
          },
        })
        .catch((err: unknown) => logger.warn({ err, callId: meta.callId }, 'voice worker: caption failed'));
    },

    setState(state) {
      void local.setAttributes({ 'lk.agent.state': state }).catch(() => undefined);
    },

    async close() {
      closed = true;
      source.clearQueue();
      await source.close().catch(() => undefined);
    },
  };
}

function defaultDeps(): RunCallDeps {
  const logger = agentsLog();
  return {
    env: workerEnv(['GEMINI_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_HOST_URL']),
    createMedia: (ctx, meta, caller) => roomMedia(ctx as JobContext, meta, caller),
    log: {
      info: (msg: string, fields?: unknown) => logger.info(fields ?? {}, msg),
      warn: (msg: string, fields?: unknown) => logger.warn(fields ?? {}, msg),
    } as Pick<Console, 'info' | 'warn'>,
  };
}

export async function runCall(ctx: CallJob, deps: RunCallDeps = defaultDeps()): Promise<void> {
  const { log } = deps;
  const meta = parseJobMetadata(ctx.job.metadata);
  const callFields = { callId: meta.callId };
  const hostUrl = liveKitHostUrl(deps.env);
  const host = new HostLink(
    {
      hostUrl,
      secret: liveKitCallSecret(deps.env.LIVEKIT_API_SECRET ?? '', meta.callId),
      callId: meta.callId,
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
  const geminiKey = deps.env.GEMINI_API_KEY;
  if (!geminiKey) return abandon('GEMINI_API_KEY is not set for the worker');

  await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
  let caller: RemoteParticipant;
  try {
    caller = await withTimeout(ctx.waitForParticipant(meta.callerIdentity), meta.joinTimeoutMs, 'caller never joined');
  } catch (err) {
    return abandon((err as Error).message);
  }
  const joined = await host.post('joined').catch(() => null);
  void joined?.body?.cancel().catch(() => {});
  // The host starts billing here; without its yes, nothing is published or transcribed.
  if (!joined?.ok) return abandon(`host refused the call (${joined?.status ?? 'unreachable'})`, { hostUrl });

  let media: CallMedia;
  try {
    media = await deps.createMedia(ctx, meta, caller);
  } catch (err) {
    return abandon('could not set up the call audio', { err });
  }
  const gemini = { apiKey: geminiKey, fetchImpl: deps.fetchImpl };
  const walkie = new WalkieCall(
    {
      transcribe: (pcm) => transcribe(pcm, { ...gemini, model: meta.sttModel, vocabulary: meta.vocabulary ?? [] }),
      send: async (text) => {
        const res = await host.post('utterance', { text });
        void res.body?.cancel().catch(() => {});
        if (res.status !== 202)
          log.warn('voice worker: the host refused a turn', { ...callFields, status: res.status });
        return res.status === 202;
      },
      synthesize: (text) => synthesize(text, { ...gemini, model: meta.ttsModel, voice: meta.ttsVoice }),
      play: (audio) => media.play(audio),
      caption: (role, text) => media.caption(role, text),
      setState: (state) => media.setState(state),
      log: {
        info: (msg: string, fields?: unknown) => log.info(msg, { ...callFields, ...(fields as object) }),
        warn: (msg: string, fields?: unknown) => log.warn(msg, { ...callFields, ...(fields as object) }),
      } as Pick<Console, 'info' | 'warn'>,
    },
    { silenceMs: meta.silenceMs },
  );
  const hostLink = new AbortController();
  let ending = false;
  const end = async (reason: string, tellHost: boolean) => {
    if (ending) return;
    ending = true;
    walkie.close();
    hostLink.abort();
    if (tellHost) await host.post('ended', { reason }).catch(() => undefined);
    await media.close().catch(() => undefined);
    await ctx.deleteRoom().catch(() => undefined);
    ctx.shutdown(reason);
  };
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

  media.start({
    onWindow: (pcm, speech) => walkie.onAudio(pcm, speech),
    onCallerLeft: () => void end('caller left', true),
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
    (proc.userData as WorkerUserData).vad = await loadVad();
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
  ]);
  // agents-js initializes its logger once the CLI runs a command; console until then.
  const mainLog = (level: 'info' | 'warn' | 'error') => (msg: string) => {
    try {
      agentsLog()[level](msg);
    } catch {
      console[level](msg);
    }
  };
  const monitor = new HostMonitor(liveKitHostUrl(env), { info: mainLog('info'), error: mainLog('error') });
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
      // request function fails or leaves the request unanswered.
      requestFunc: async (req) => {
        let name: string;
        try {
          name = parseJobMetadata(req.job.metadata).agentName;
        } catch {
          return req.reject();
        }
        // Without the host the call could not start; another worker may take it.
        if (monitor.down && !(await monitor.check())) {
          mainLog('warn')(`voice worker: refused a call; the host at ${monitor.hostUrl} does not answer`);
          return req.reject().catch(() => undefined);
        }
        await req.accept(name).catch(() => req.reject().catch(() => undefined));
      },
    }),
  );
  void monitor.start();
}
