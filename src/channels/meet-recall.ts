/**
 * The Recall.ai client `/meet` joins a meeting through: a Recall bot joins the meeting and runs the static
 * bridge page (assets/meet-recall-bridge/index.html) as its camera. The page joins the call's LiveKit room
 * as the call's caller, publishes the meeting's mixed audio and plays every other audio track in the room
 * (the voice worker's) into the meeting. Output Media mechanics: https://docs.recall.ai/docs/stream-media
 */
import { AccessToken, TrackSource } from 'livekit-server-sdk';

import { log } from '../log.js';

export const RECALL_REGIONS = ['us-east-1', 'us-west-2', 'eu-central-1', 'ap-northeast-1'] as const;
export type RecallRegion = (typeof RECALL_REGIONS)[number];

const DEFAULT_REGION: RecallRegion = 'eu-central-1';
const BRIDGE_TOKEN_TTL_SECONDS = 3 * 60 * 60;
const RECALL_REQUEST_TIMEOUT_MS = 15_000;
const LEAVE_ATTEMPTS = 3;
/** The bot metadata key that names the call's room, so a bot whose create never answered can be found. */
const ROOM_METADATA_KEY = 'nanoclaw_room';

export interface RecallMeetConfig {
  recallApiKey: string;
  region: RecallRegion;
  /** Public https URL of the bridge page. */
  pageUrl: string;
  /** Public wss URL of LiveKit, reachable from Recall's cloud (not nanoclaw's internal one). */
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  tokenTtlSeconds?: number;
  /** Test seams. */
  fetch?: typeof fetch;
  retryDelayMs?: (attempt: number) => number;
}

/** The Recall bots of `/meet` calls; faked in tests. */
export interface RecallMeetBridge {
  /** Sends a bot named `botName` to `meetingUrl`, its bridge page joining `roomName`. */
  join(options: { meetingUrl: string; botName: string; roomName: string }): Promise<{ botId: string }>;
  /** Makes the bot leave its meeting, retried; never rejects (a final failure is logged). */
  leave(botId: string): Promise<void>;
}

/** The bridge page's identity in the call's room: the call's caller, as the worker waits for it. */
export function bridgeIdentity(roomName: string): string {
  return `meet-bridge-${roomName}`;
}

export async function mintBridgeToken(
  config: Pick<RecallMeetConfig, 'livekitApiKey' | 'livekitApiSecret' | 'tokenTtlSeconds'>,
  roomName: string,
): Promise<string> {
  const at = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
    identity: bridgeIdentity(roomName),
    name: 'Meeting',
    ttl: config.tokenTtlSeconds ?? BRIDGE_TOKEN_TTL_SECONDS,
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

/** Recall answered with an HTTP error: it said what happened, so nothing is left to find. */
class RecallRefusal extends Error {}

export function createRecallMeetBridge(config: RecallMeetConfig): RecallMeetBridge {
  if (!RECALL_REGIONS.includes(config.region)) throw new Error(`meet-recall: unknown Recall region ${config.region}`);
  assertUrl('MEET_RECALL_PAGE_URL', config.pageUrl, 'https:');
  assertUrl('MEET_RECALL_LIVEKIT_URL', config.livekitUrl, 'wss:');
  const doFetch = config.fetch ?? fetch;
  const retryDelayMs = config.retryDelayMs ?? ((attempt: number) => 1000 * 2 ** attempt);
  const base = `https://${config.region}.recall.ai/api/v1`;

  /** The response body as JSON; undefined when it is not JSON. */
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
      // A server error may come after the bot was made: only a 4xx is a clear no.
      throw res.status < 500 ? new RecallRefusal(message) : new Error(message);
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
        if (attempt === LEAVE_ATTEMPTS - 1) {
          log.error('meet-recall: the bot did not leave its meeting', { botId, err });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)).unref());
      }
    }
  }

  /** A create that never clearly answered may still have made a bot: find the room's bots and send them away. */
  async function sweep(roomName: string): Promise<void> {
    try {
      const query = new URLSearchParams({ [`metadata__${ROOM_METADATA_KEY}`]: roomName });
      const listed = (await recall('GET', `/bot/?${query.toString()}`)) as { results?: unknown } | null | undefined;
      const ids = (Array.isArray(listed?.results) ? listed.results : []).flatMap((bot: unknown) => {
        const id = (bot as { id?: unknown } | null)?.id;
        return typeof id === 'string' && id ? [id] : [];
      });
      await Promise.all(ids.map((id) => leave(id)));
    } catch (err) {
      log.error('meet-recall: could not look for a bot whose create did not answer', { roomName, err });
    }
  }

  return {
    async join({ meetingUrl, botName, roomName }) {
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
          // The mixed mp4 is on by default; nothing here needs a recording or a transcript.
          recording_config: { video_mixed_mp4: null },
          // Default is 1h; a bot without a recording artifact may count as "not recording".
          automatic_leave: { in_call_not_recording_timeout: BRIDGE_TOKEN_TTL_SECONDS },
        });
      } catch (err) {
        if (!(err instanceof RecallRefusal)) await sweep(roomName);
        throw err;
      }
      const botId = (bot as { id?: unknown } | null | undefined)?.id;
      if (typeof botId !== 'string' || !botId) {
        await sweep(roomName);
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
  return {
    recallApiKey,
    region: (env.RECALL_REGION || DEFAULT_REGION) as RecallRegion,
    pageUrl,
    livekitUrl,
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
