/**
 * The Recall.ai client `/meet` joins a meeting through: a Recall bot joins the meeting and runs the static
 * bridge page (assets/meet-recall-bridge/index.html) as its camera. The page joins the call's LiveKit room
 * as the call's caller, publishes the meeting's mixed audio and plays every other audio track in the room
 * (the voice worker's) into the meeting. Output Media mechanics: https://docs.recall.ai/docs/stream-media
 */
import { AccessToken, TrackSource } from 'livekit-server-sdk';

import { log } from '../log.js';
import { MINUTE_MS } from './voice-mode-livekit.js';

const RECALL_REGIONS = ['us-east-1', 'us-west-2', 'eu-central-1', 'ap-northeast-1'] as const;
export type RecallRegion = (typeof RECALL_REGIONS)[number];

/** A meeting bot can wait in the meeting's lobby until someone admits it. */
export const MEETING_JOIN_TIMEOUT_MS = 10 * MINUTE_MS;
/** A meeting runs longer than a call: this cap, under the line's daily minutes, instead of the call cap. */
export const MEETING_MAX_DURATION_MS = 60 * MINUTE_MS;
/** Who the bridge page is in the room, and who a meeting turn comes from: anyone in the meeting may have spoken. */
export const MEETING_SENDER = 'Meeting';

const DEFAULT_REGION: RecallRegion = 'eu-central-1';
const BRIDGE_TOKEN_TTL_SECONDS = 3 * 60 * 60;
/** A bot the host never sent away (it crashed) leaves on its own once the longest meeting call is over. */
const BOT_NOT_RECORDING_TIMEOUT_SECONDS = (MEETING_JOIN_TIMEOUT_MS + MEETING_MAX_DURATION_MS) / 1000;
const RECALL_REQUEST_TIMEOUT_MS = 15_000;
const LEAVE_ATTEMPTS = 3;
/** The longest wait between leave attempts, whatever Recall's Retry-After asks. */
const MAX_LEAVE_RETRY_DELAY_MS = 30_000;
/** Recall can still be making a bot when the first look for it after an unanswered create comes back empty. */
const RESWEEP_DELAY_MS = 20_000;
/** The bot metadata key that names the call's room, so a bot whose create never answered can be found. */
const ROOM_METADATA_KEY = 'nanoclaw_room';

export interface RecallMeetConfig {
  recallApiKey: string;
  region: RecallRegion;
  /** Public https URL of the bridge page. */
  pageUrl: string;
  /** Public wss URL of LiveKit, reachable from Recall's cloud (not nanoclaw's internal one). */
  livekitUrl: string;
  /**
   * Public `wss://` origin a jev meeting's bot streams each participant's audio to (`/voice/recall/...`
   * on the host's webhook server behind it). MEET_RECALL_AUDIO_URL, by default the bridge page's host.
   */
  audioOrigin: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  /** Test seams. */
  fetch?: typeof fetch;
  retryDelayMs?: (attempt: number) => number;
  resweepDelayMs?: number;
}

/**
 * The real-time events a jev meeting's websocket takes: each participant's audio, speaker turns,
 * presence, chat (names per https://docs.recall.ai/docs/real-time-websocket-endpoints#event-types).
 */
export const RECALL_JEV_EVENTS = [
  'audio_separate_raw.data',
  'participant_events.speech_on',
  'participant_events.speech_off',
  'participant_events.join',
  'participant_events.leave',
  'participant_events.chat_message',
] as const;

/** A jev meeting's audio: Recall streams each participant's own audio to `websocketUrl`; the host transcribes it. */
export interface RecallParticipantAudio {
  /** `wss://` with a `/` before the query, as Recall requires (`.../<callId>/?token=...`). */
  websocketUrl: string;
}

/** The Recall bots of `/meet` calls; faked in tests. */
export interface RecallMeetBridge {
  /**
   * Sends a bot named `botName` to `meetingUrl`, its bridge page joining `roomName`; with
   * `participantAudio` (jev meetings only) the bot also streams each participant's audio in real time.
   */
  join(options: {
    meetingUrl: string;
    botName: string;
    roomName: string;
    participantAudio?: RecallParticipantAudio;
  }): Promise<{ botId: string }>;
  /** Makes the bot leave its meeting, retried; never rejects (a final failure is logged). */
  leave(botId: string): Promise<void>;
}

/** The bridge page's identity in the call's room: the call's caller, as the worker waits for it. */
export function bridgeIdentity(roomName: string): string {
  return `meet-bridge-${roomName}`;
}

export async function mintBridgeToken(
  config: Pick<RecallMeetConfig, 'livekitApiKey' | 'livekitApiSecret'>,
  roomName: string,
): Promise<string> {
  const at = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
    identity: bridgeIdentity(roomName),
    name: MEETING_SENDER,
    ttl: BRIDGE_TOKEN_TTL_SECONDS,
  });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canSubscribe: true,
    canPublishData: false,
    canUpdateOwnMetadata: false,
  });
  return at.toJwt();
}

/** The page URL Recall opens: its settings go in the hash, which no server or referrer ever sees. */
export function buildBridgePageUrl(
  pageUrl: string,
  params: { livekitUrl: string; token: string; name: string },
): string {
  const url = new URL(pageUrl);
  url.hash = new URLSearchParams({ url: params.livekitUrl, token: params.token, name: params.name }).toString();
  return url.toString();
}

/** Recall answered with an HTTP error; `retryAfterMs` is its Retry-After, when it sent one. */
class RecallHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
  }
}

/** Retry-After as seconds or an HTTP date, in ms; null when absent or unreadable. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/**
 * The bot's recording config, always with Zero Data Retention (`retention: null`,
 * https://docs.recall.ai/docs/zero-data-retention): left out, Recall keeps the recording media (participant
 * events included) indefinitely, and nothing here reads it back. Without participant audio: no artifact
 * at all (the mixed mp4 is on by default). With it: each participant's raw audio on one websocket
 * (https://docs.recall.ai/docs/how-to-get-separate-audio-per-participant-realtime), no Recall transcript.
 */
function botRecordingConfig(participantAudio?: RecallParticipantAudio): Record<string, unknown> {
  if (!participantAudio) return { video_mixed_mp4: null, retention: null };
  assertUrl('the participant audio websocket URL', participantAudio.websocketUrl, 'wss:');
  const url = new URL(participantAudio.websocketUrl);
  // https://docs.recall.ai/docs/real-time-websocket-endpoints#verification: Recall answers 400 otherwise.
  if (url.search && !url.pathname.endsWith('/')) {
    throw new Error('meet-recall: the participant audio websocket URL needs a / before its query');
  }
  return {
    video_mixed_mp4: null,
    audio_separate_raw: {},
    retention: null,
    realtime_endpoints: [{ type: 'websocket', url: participantAudio.websocketUrl, events: [...RECALL_JEV_EVENTS] }],
  };
}

/** A leave Recall refused because the bot is not in a call any more (it left on its own, or never got in). */
const BOT_GONE_STATUSES = new Set([400, 404, 410]);
/** A leave worth trying again: Recall was busy, or did not answer in time. */
const RETRIED_STATUSES = new Set([408, 429]);

export function createRecallMeetBridge(config: RecallMeetConfig): RecallMeetBridge {
  if (!RECALL_REGIONS.includes(config.region)) throw new Error(`meet-recall: unknown Recall region ${config.region}`);
  assertUrl('MEET_RECALL_PAGE_URL', config.pageUrl, 'https:');
  assertUrl('MEET_RECALL_LIVEKIT_URL', config.livekitUrl, 'wss:');
  const doFetch = config.fetch ?? fetch;
  const retryDelayMs = config.retryDelayMs ?? ((attempt: number) => 1000 * 2 ** attempt);
  const resweepDelayMs = config.resweepDelayMs ?? RESWEEP_DELAY_MS;
  const base = `https://${config.region}.recall.ai/api/v1`;

  /** The response body as JSON; null when it is empty, undefined when it is not JSON. */
  async function recall(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        // The `Token` prefix is optional per https://docs.recall.ai/reference/authentication
        Authorization: `Token ${config.recallApiKey}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(RECALL_REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      // Recall may echo the page URL, which carries the LiveKit token.
      const detail = text.slice(0, 500).replace(/token=[^&"\s]+/g, 'token=REDACTED');
      const message = `meet-recall: ${method} ${path} failed with ${res.status}: ${detail}`;
      throw new RecallHttpError(message, res.status, retryAfterMs(res.headers.get('retry-after')));
    }
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }

  async function leave(botId: string): Promise<void> {
    for (let attempt = 0; attempt < LEAVE_ATTEMPTS; attempt++) {
      try {
        await recall('POST', `/bot/${encodeURIComponent(botId)}/leave_call/`);
        return;
      } catch (err) {
        const status = err instanceof RecallHttpError ? err.status : undefined;
        // A bot that already left on its own (everyone left the meeting) is refused, not missed.
        if (status !== undefined && BOT_GONE_STATUSES.has(status)) {
          log.info('meet-recall: Recall refused the leave; the bot is likely gone already', { botId, err });
          return;
        }
        const retried = status === undefined || status >= 500 || RETRIED_STATUSES.has(status);
        if (!retried || attempt === LEAVE_ATTEMPTS - 1) {
          log.error('meet-recall: the bot did not leave its meeting', { botId, err });
          return;
        }
        const delayMs = (err instanceof RecallHttpError ? err.retryAfterMs : null) ?? retryDelayMs(attempt);
        await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, MAX_LEAVE_RETRY_DELAY_MS)).unref());
      }
    }
  }

  /** A create that never clearly answered may still have made a bot: find the room's bots and send them away. */
  async function sweep(roomName: string): Promise<void> {
    try {
      const query = new URLSearchParams({ [`metadata__${ROOM_METADATA_KEY}`]: roomName });
      const listed = (await recall('GET', `/bot/?${query.toString()}`)) as { results?: unknown } | null | undefined;
      if (!Array.isArray(listed?.results)) {
        log.error('meet-recall: Recall listed the bots in a form it does not know', { roomName });
        return;
      }
      const ids = listed.results.flatMap((bot: unknown) => {
        const id = (bot as { id?: unknown } | null)?.id;
        return typeof id === 'string' && id ? [id] : [];
      });
      await Promise.all(ids.map((id) => leave(id)));
    } catch (err) {
      log.error('meet-recall: could not look for a bot whose create did not answer', { roomName, err });
    }
  }

  /** sweep now, and once more later in the background for a bot Recall was still making. */
  async function sweepTwice(roomName: string): Promise<void> {
    setTimeout(() => void sweep(roomName), resweepDelayMs).unref();
    await sweep(roomName);
  }

  return {
    async join({ meetingUrl, botName, roomName, participantAudio }) {
      const recordingConfig = botRecordingConfig(participantAudio);
      const token = await mintBridgeToken(config, roomName);
      const pageUrl = buildBridgePageUrl(config.pageUrl, { livekitUrl: config.livekitUrl, token, name: botName });
      let bot: unknown;
      try {
        bot = await recall('POST', '/bot/', {
          meeting_url: meetingUrl,
          bot_name: botName,
          metadata: { [ROOM_METADATA_KEY]: roomName },
          output_media: { camera: { kind: 'webpage', config: { url: pageUrl } } },
          variant: { google_meet: 'web_4_core', zoom: 'web_4_core', microsoft_teams: 'web_4_core' },
          recording_config: recordingConfig,
          // Default is 1h; a bot without a recording artifact may count as "not recording".
          automatic_leave: { in_call_not_recording_timeout: BOT_NOT_RECORDING_TIMEOUT_SECONDS },
        });
      } catch (err) {
        // A server error may come after the bot was made: only a 4xx is a clear no.
        if (!(err instanceof RecallHttpError && err.status < 500)) await sweepTwice(roomName);
        throw err;
      }
      const botId = (bot as { id?: unknown } | null | undefined)?.id;
      if (typeof botId !== 'string' || !botId) {
        await sweepTwice(roomName);
        throw new Error('meet-recall: Recall returned no bot id');
      }
      return { botId };
    },
    leave,
  };
}

/** The Recall settings in .env; the LiveKit key pair is the voice channel's own. */
export const RECALL_MEET_ENV_KEYS = [
  'RECALL_API_KEY',
  'RECALL_REGION',
  'MEET_RECALL_PAGE_URL',
  'MEET_RECALL_LIVEKIT_URL',
  'MEET_RECALL_AUDIO_URL',
] as const;

/** The client's settings, or null when RECALL_API_KEY is unset (`/meet` is off); throws naming what else is missing. */
export function recallMeetConfigFromEnv(
  env: Partial<Record<(typeof RECALL_MEET_ENV_KEYS)[number], string>>,
  livekit: { apiKey: string; apiSecret: string },
): RecallMeetConfig | null {
  const { RECALL_API_KEY: recallApiKey, MEET_RECALL_PAGE_URL: pageUrl, MEET_RECALL_LIVEKIT_URL: livekitUrl } = env;
  if (!recallApiKey) return null;
  if (!pageUrl || !livekitUrl) {
    const missing = [!pageUrl && 'MEET_RECALL_PAGE_URL', !livekitUrl && 'MEET_RECALL_LIVEKIT_URL'].filter(Boolean);
    throw new Error(`meet-recall: missing ${missing.join(', ')}`);
  }
  const audioUrl = env.MEET_RECALL_AUDIO_URL || pageUrl.replace(/^https:/, 'wss:');
  assertUrl('MEET_RECALL_AUDIO_URL', audioUrl, 'wss:');
  return {
    recallApiKey,
    region: (env.RECALL_REGION || DEFAULT_REGION) as RecallRegion,
    pageUrl,
    livekitUrl,
    audioOrigin: new URL(audioUrl).origin,
    livekitApiKey: livekit.apiKey,
    livekitApiSecret: livekit.apiSecret,
  };
}

function assertUrl(name: string, value: string, protocol: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (err) {
    throw new Error(`meet-recall: ${name} is not a URL`, { cause: err });
  }
  if (parsed.protocol !== protocol) throw new Error(`meet-recall: ${name} must use ${protocol}`);
}
