/**
 * Recall.ai meeting bridge: a Recall bot joins the meeting and runs the static bridge page
 * (assets/meet-recall-bridge/index.html) as its camera. The page publishes the meeting's mixed audio
 * into the LiveKit room as a meeting-input participant and plays the voice worker's audio back into
 * the meeting. Output Media mechanics: https://docs.recall.ai/docs/stream-media
 */
import { AccessToken, TrackSource } from 'livekit-server-sdk';

import { readEnvFile } from '../env.js';

export interface MeetJoinOptions {
  meetingUrl: string;
  botName: string;
  roomName: string;
  sourceIdentity: string;
}

export interface MeetBridge {
  join(opts: MeetJoinOptions): Promise<{ botId: string }>;
  leave(botId: string): Promise<void>;
}

/** The worker mixes any participant carrying this attribute (value `1`) into its meeting input. */
export const MEETING_INPUT_ATTRIBUTE = 'nanoclaw.meeting_input';

export const RECALL_REGIONS = ['us-east-1', 'us-west-2', 'eu-central-1', 'ap-northeast-1'] as const;
export type RecallRegion = (typeof RECALL_REGIONS)[number];

const DEFAULT_REGION: RecallRegion = 'eu-central-1';
const BRIDGE_TOKEN_TTL_SECONDS = 3 * 60 * 60;
const RECALL_REQUEST_TIMEOUT_MS = 15_000;

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
  fetch?: typeof fetch;
}

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
    attributes: { [MEETING_INPUT_ATTRIBUTE]: '1' },
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

export function buildBridgePageUrl(
  pageUrl: string,
  params: { livekitUrl: string; token: string; source: string; name: string },
): string {
  const url = new URL(pageUrl);
  url.searchParams.set('url', params.livekitUrl);
  url.searchParams.set('token', params.token);
  url.searchParams.set('source', params.source);
  url.searchParams.set('name', params.name);
  return url.toString();
}

export function createRecallMeetBridge(config: RecallMeetConfig): MeetBridge {
  if (!RECALL_REGIONS.includes(config.region)) throw new Error(`meet-recall: unknown Recall region ${config.region}`);
  assertUrl('MEET_RECALL_PAGE_URL', config.pageUrl, ['https:', 'http:']);
  assertUrl('MEET_RECALL_LIVEKIT_URL', config.livekitUrl, ['wss:', 'ws:']);
  const doFetch = config.fetch ?? fetch;
  const base = `https://${config.region}.recall.ai/api/v1`;

  async function recall(path: string, body?: unknown): Promise<unknown> {
    const res = await doFetch(`${base}${path}`, {
      method: 'POST',
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
      throw new Error(`meet-recall: POST ${path} failed with ${res.status}: ${detail}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  return {
    async join({ meetingUrl, botName, roomName, sourceIdentity }) {
      const token = await mintBridgeToken(config, roomName);
      const pageUrl = buildBridgePageUrl(config.pageUrl, {
        livekitUrl: config.livekitUrl,
        token,
        source: sourceIdentity,
        name: botName,
      });
      const bot = await recall('/bot/', {
        meeting_url: meetingUrl,
        bot_name: botName,
        output_media: { camera: { kind: 'webpage', config: { url: pageUrl } } },
        variant: { google_meet: 'web_4_core', zoom: 'web_4_core', microsoft_teams: 'web_4_core' },
        // The mixed mp4 is on by default; nothing here needs a recording or a transcript.
        recording_config: { video_mixed_mp4: null },
        // Default is 1h; a bot without a recording artifact may count as "not recording".
        automatic_leave: { in_call_not_recording_timeout: BRIDGE_TOKEN_TTL_SECONDS },
      });
      const botId = (bot as { id?: unknown } | null)?.id;
      if (typeof botId !== 'string' || !botId) throw new Error('meet-recall: Recall returned no bot id');
      return { botId };
    },
    async leave(botId) {
      await recall(`/bot/${encodeURIComponent(botId)}/leave_call/`);
    },
  };
}

export const RECALL_MEET_ENV_KEYS = [
  'RECALL_API_KEY',
  'RECALL_REGION',
  'MEET_RECALL_PAGE_URL',
  'MEET_RECALL_LIVEKIT_URL',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
] as const;

/** Reads the provider's settings from .env; throws naming every missing key. */
export function recallMeetConfigFromEnv(env: Record<string, string> = readEnvFile([...RECALL_MEET_ENV_KEYS])) {
  const required = RECALL_MEET_ENV_KEYS.filter((key) => key !== 'RECALL_REGION');
  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) throw new Error(`meet-recall: missing ${missing.join(', ')}`);
  return {
    recallApiKey: env.RECALL_API_KEY,
    region: (env.RECALL_REGION || DEFAULT_REGION) as RecallRegion,
    pageUrl: env.MEET_RECALL_PAGE_URL,
    livekitUrl: env.MEET_RECALL_LIVEKIT_URL,
    livekitApiKey: env.LIVEKIT_API_KEY,
    livekitApiSecret: env.LIVEKIT_API_SECRET,
  } satisfies RecallMeetConfig;
}

function assertUrl(name: string, value: string, protocols: string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (err) {
    throw new Error(`meet-recall: ${name} is not a URL`, { cause: err });
  }
  if (!protocols.includes(parsed.protocol)) throw new Error(`meet-recall: ${name} must use ${protocols.join(' or ')}`);
}
