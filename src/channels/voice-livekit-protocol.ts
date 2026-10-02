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

export const DEFAULT_WALKIE_STT_MODEL = 'gemini-3.8-flash';
export const DEFAULT_WALKIE_TTS_MODEL = 'gemini-3.1-flash-tts-preview';
export const DEFAULT_WALKIE_TTS_VOICE = 'Alnilam';
/** Silence that ends the caller's turn; shorter pauses mid-thought keep it open. */
export const DEFAULT_WALKIE_SILENCE_MS = 2500;

/** What the worker receives as job metadata. Nothing secret: agents-js logs the whole job on some paths. */
export interface LiveKitJobMetadata {
  /** 2 since the walkie-talkie worker; a worker of another version refuses the job. */
  v: 2;
  callId: string;
  lineId: string;
  agentName: string;
  callerName: string;
  callerIdentity: string;
  /** Spelling hints for the transcription: GPT_LIVE_VOCABULARY plus the agent's voice.vocabulary.txt. */
  vocabulary: string[];
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  silenceMs: number;
  /** Upper bound the worker enforces on itself if the host never ends the call. */
  maxDurationMs: number;
  joinTimeoutMs: number;
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
