/**
 * What the voice host (`voice-livekit.ts`) and the LiveKit worker
 * (`../voice-livekit-worker.ts`) share. Dependency-free on purpose: the worker
 * imports it, and must not load the host's database and channel modules.
 */
import { createHmac } from 'node:crypto';

export const DEFAULT_LIVEKIT_AGENT_NAME = 'nanoclaw-voice';

/** The host pings the worker's event stream this often, so silence means a dead link. */
export const PING_INTERVAL_MS = 15_000;
/** The worker drops the host link after this long without a line: three missed pings. */
export const HOST_SILENCE_MS = 3 * PING_INTERVAL_MS;

/** Wire version of the job metadata; host and worker must agree, so they ship and restart together. */
export const LIVEKIT_PROTOCOL_VERSION = 3;

/** Streaming transcription over the Gemini Live API, verbatim. */
export const DEFAULT_WALKIE_STT_MODEL = 'gemini-3.5-transcribe-live';
/** Unary transcription, used only while the streaming model fails: its quota is small. */
export const DEFAULT_WALKIE_STT_FALLBACK_MODEL = 'gemini-3.5-transcribe';
export const DEFAULT_WALKIE_TTS_MODEL = 'gemini-3.8-flash-tts';
export const DEFAULT_WALKIE_TTS_FALLBACK_MODEL = 'gemini-3.8-flash-lite-tts';
export const DEFAULT_WALKIE_TTS_VOICE = 'Alnilam';
/** Silence that ends the caller's turn; shorter pauses mid-thought keep it open. */
export const DEFAULT_WALKIE_SILENCE_MS = 2500;
/** Channel type of the default call chat when `/voice` has not set one (WALKIE_MIRROR). */
export const DEFAULT_WALKIE_MIRROR = 'telegram';

/** What the worker receives as job metadata. Nothing secret: agents-js logs the whole job on some paths. */
export interface LiveKitJobMetadata {
  /** LIVEKIT_PROTOCOL_VERSION; a worker of another version tells the page it is updating and leaves. */
  v: number;
  callId: string;
  lineId: string;
  agentName: string;
  callerName: string;
  callerIdentity: string;
  /** Spelling hints for the transcription: GPT_LIVE_VOCABULARY plus the agent's voice.vocabulary.txt. */
  vocabulary: string[];
  sttModel: string;
  /** Takes over while `sttModel` fails; empty for none. */
  sttFallbackModel: string;
  ttsModel: string;
  /** Takes over while `ttsModel` fails; empty for none. */
  ttsFallbackModel: string;
  ttsVoice: string;
  silenceMs: number;
  /** Upper bound the worker enforces on itself if the host never ends the call. */
  maxDurationMs: number;
  joinTimeoutMs: number;
}

/**
 * The worker's participant attribute for what `lk.agent.state` cannot say (its session has no
 * LLM, so it never thinks): "1" while the host says the agent works on a turn, "" otherwise.
 */
export const WALKIE_THINKING_ATTRIBUTE = 'nanoclaw.walkie.thinking';
/** The worker's participant attribute: "1" when it cannot serve this host's protocol version. */
export const WALKIE_UPDATING_ATTRIBUTE = 'nanoclaw.walkie.updating';
/** Text stream topic the worker sends one JSON `WalkieTurnStatus` on per caller turn. */
export const WALKIE_TURN_TOPIC = 'nanoclaw.walkie.turn';

/**
 * The room metadata the host sets when a mid-call `/voice` moves the call to another chat, so the
 * page's header follows it: the new call chat's label, or null once the call talks on the voice line.
 */
export interface WalkieRoomMetadata {
  chat: string | null;
}

/**
 * What became of a caller turn: sent to the agent, or lost because the transcription failed
 * (`stt`) or heard no words (`empty`), or the host refused it (`rejected`, `rate_limited`) or
 * did not answer (`timeout`).
 */
export interface WalkieTurnStatus {
  turn: number;
  status: 'sent' | 'lost';
  reason?: 'stt' | 'rejected' | 'rate_limited' | 'timeout' | 'empty';
  /** The final transcript, when there is one. */
  text?: string;
}

/**
 * One line of the host-to-worker event stream: a complete agent message to
 * speak, the agent still working (from the host's typing refresh), the end of
 * the call, or a keepalive.
 */
export type LiveKitHostEvent =
  | { type: 'reply'; text: string }
  | { type: 'thinking' }
  | { type: 'end'; reason: string }
  | { type: 'ping' };

/**
 * The bearer secret for one call's worker routes, derived from the LiveKit API
 * secret both processes already hold, so it never travels in the dispatch.
 */
export function liveKitCallSecret(apiSecret: string, callId: string): string {
  return createHmac('sha256', apiSecret).update(`nanoclaw-voice-call:${callId}`).digest('base64url');
}

/** Where the worker reaches the host's webhook server; only ever from the worker's own settings. */
export function liveKitHostUrl(env: { LIVEKIT_HOST_URL?: string; WEBHOOK_PORT?: string }): string {
  return (env.LIVEKIT_HOST_URL || `http://127.0.0.1:${env.WEBHOOK_PORT || '3000'}`).replace(/\/+$/, '');
}
