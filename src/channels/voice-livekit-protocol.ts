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

/** How an agent reply starts when it reaches the voice model outside a tool result. */
export const ANSWER_PREFIX = 'Answer from the backend';

/** What the worker receives as job metadata. Nothing secret: agents-js logs the whole job on some paths. */
export interface LiveKitJobMetadata {
  v: 1;
  callId: string;
  lineId: string;
  agentName: string;
  callerName: string;
  callerIdentity: string;
  instructions: string;
  model: string;
  voice: string;
  /** Function response scheduling; null for models that close the session on it. */
  scheduling: 'WHEN_IDLE' | null;
  /** Upper bound the worker enforces on itself if the host never ends the call. */
  maxDurationMs: number;
  /** The host answers an unanswered ask_agent with the timeout line after this long. */
  delegationTimeoutMs: number;
  /** What the caller hears then; a later reply is still spoken. */
  timeoutLine: string;
  joinTimeoutMs: number;
}

/**
 * One line of the host-to-worker event stream. A `reply` carries the ask_agent
 * consults it answers, the targeted one first; without any it answers none and
 * is spoken as a new turn.
 */
export type LiveKitHostEvent =
  | { type: 'reply'; text: string; consultIds?: string[]; timedOut?: boolean }
  | { type: 'say'; text: string }
  | { type: 'thinking'; status?: string }
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
