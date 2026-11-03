/**
 * `/meet <google-meet-url>` (on Slack `!meet`), run in a chat wired to one agent by an owner or admin of
 * that agent whose voice line it is (or who gets a new one, as with `/voice`): the agent joins the meeting
 * as a voice participant, through a self-hosted Attendee bot that mirrors every meeting participant into
 * the call's LiveKit room and streams the voice worker's speech back into the meeting. The call talks in
 * this chat, which becomes the line's call chat, so the transcript of what the agent was asked and its
 * answers land here. `/meet leave` sends the bot away; a call on the line's link ends a meeting, as any
 * newer call does. The bridge is MEET_PROVIDER's (MEET_BRIDGES below; attendee by default), off until its
 * settings are there.
 */
import type { InboundEvent } from './adapter.js';
import { wiringThreadsEnabled } from './channel-defaults.js';
import { getChannelAdapter, getChannelAdapterExact } from './channel-registry.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { bindVoiceModeLineChat, createVoiceModeLine, getVoiceModeLineForAgent } from '../db/voice-mode-lines.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import { getUser } from '../modules/permissions/db/users.js';
import { registerMessageInterceptor } from '../router.js';
import { encryptionKey } from '../secret-seal.js';
import type { MessagingGroup } from '../types.js';
import { createRecallMeetBridge, RECALL_MEET_ENV_KEYS, recallMeetConfigFromEnv } from './meet-recall.js';
import type { VoiceModeChannelAdapter } from './voice-mode.js';
import { senderUserId } from './voice-mode-command.js';
import type { MeetBridge, MeetingStart } from './voice-mode-livekit.js';
import { linePlatformId, VOICE_MODE_CHANNEL } from './voice-mode-line.js';

const BANG_CHANNELS = new Set(['slack']);
const ATTENDEE_TIMEOUT_MS = 15_000;

/** The Attendee REST API (docs/openapi.yml in attendee-labs/attendee) as a meeting bridge. */
export function createAttendeeBridge(
  config: { url: string; apiKey: string },
  fetchImpl: typeof fetch = fetch,
): MeetBridge {
  const base = config.url.replace(/\/+$/, '');
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const res = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Token ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ATTENDEE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`attendee POST ${path}: HTTP ${res.status} ${detail}`);
    }
    return ((await res.json().catch(() => null)) as Record<string, unknown> | null) ?? {};
  };
  return {
    async join({ meetingUrl, botName, roomName, sourceIdentity }) {
      // The room must exist first: Attendee's watcher joins it, and LiveKit may not auto-create rooms.
      const bot = await post('/api/v1/bots', {
        meeting_url: meetingUrl,
        bot_name: botName,
        // No recording is stored: the meeting only flows through the room.
        recording_settings: { format: 'none' },
        room_sync_settings: { livekit: { room_name: roomName, source_participant: { identity: sourceIdentity } } },
      });
      if (typeof bot.id !== 'string' || !bot.id) throw new Error('attendee: the bot was created without an id');
      return { botId: bot.id };
    },
    async leave(botId) {
      await post(`/api/v1/bots/${encodeURIComponent(botId)}/leave`, {});
    },
  };
}

/**
 * The meeting bridges MEET_PROVIDER picks from: each names the settings it reads from .env and builds
 * its bridge from them, or null when they are incomplete or invalid.
 */
const MEET_BRIDGES: Record<
  string,
  { keys: string[]; create(env: Record<string, string | undefined>): MeetBridge | null }
> = {
  attendee: {
    keys: ['ATTENDEE_URL', 'ATTENDEE_API_KEY'],
    create: (env) =>
      env.ATTENDEE_URL && env.ATTENDEE_API_KEY
        ? createAttendeeBridge({ url: env.ATTENDEE_URL, apiKey: env.ATTENDEE_API_KEY })
        : null,
  },
  recall: {
    keys: [...RECALL_MEET_ENV_KEYS],
    create: (env) => {
      // Missing or invalid settings leave /meet off rather than stopping the voice channel from starting.
      try {
        return createRecallMeetBridge(recallMeetConfigFromEnv(env as Record<string, string>));
      } catch (err) {
        log.warn('voice-mode: Recall meeting bridge is not configured; /meet is off', {
          err: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },
  },
};

/** MEET_PROVIDER's bridge (attendee when unset), or none: then `/meet` says it is not configured. */
export function meetBridgeFromEnv(
  read: (keys: string[]) => Record<string, string | undefined> = readEnvFile,
): MeetBridge | undefined {
  const provider = (read(['MEET_PROVIDER']).MEET_PROVIDER || 'attendee').trim().toLowerCase();
  const entry = MEET_BRIDGES[provider];
  if (!entry) {
    log.warn('voice-mode: unknown MEET_PROVIDER; /meet is off', { provider });
    return undefined;
  }
  return entry.create(read(entry.keys)) ?? undefined;
}

export type MeetCommand = { action: 'join'; url: string } | { action: 'leave' } | { action: 'usage' };

/** A Google Meet link as typed, or as Slack wraps it (`<https://...>` or `<https://...|label>`); null otherwise. */
export function meetingUrl(raw: string): string | null {
  const unwrapped = raw.replace(/^<([^|>]+)(?:\|[^>]*)?>$/, '$1');
  let url: URL;
  try {
    url = new URL(unwrapped);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'meet.google.com' || url.pathname.length < 2) return null;
  return url.toString();
}

/** `/meet <url>`, `/meet leave`, `/meet@<bot> ...` and, on Slack, `!meet ...`; null for any other message. */
export function parseMeetCommand(text: string, channelType: string): MeetCommand | null {
  const match = /^\s*([!/]meet(?:@\S*)?)(?!\S)(?:\s+(\S+))?/i.exec(text);
  if (!match) return null;
  if (match[1][0] === '!' && !BANG_CHANNELS.has(channelType)) return null;
  const arg = match[2];
  if (arg?.toLowerCase() === 'leave') return { action: 'leave' };
  const url = arg ? meetingUrl(arg) : null;
  return url ? { action: 'join', url } : { action: 'usage' };
}

/** What `/meet` needs of the voice channel; the live adapter by default. */
export type MeetingControl = Pick<VoiceModeChannelAdapter, 'meetingsEnabled' | 'startMeeting' | 'leaveMeeting'>;

export type MeetOutcome =
  | { kind: 'drop' }
  | { kind: 'refused' }
  | { kind: 'several-agents' }
  | { kind: 'usage' }
  | { kind: 'voice-unavailable' | 'not-configured' | 'no-key'; agentName: string }
  | { kind: 'other-caller'; agentName: string; caller?: string }
  | { kind: 'started'; agentName: string; url: string }
  | { kind: 'failed'; agentName: string; start: Extract<MeetingStart, { ok: false }> }
  | { kind: 'left' | 'no-meeting'; agentName: string };

export interface MeetRunOptions {
  meetings?: MeetingControl | null;
  key?: Buffer | null;
}

const liveMeetings = (): MeetingControl | null =>
  (getChannelAdapterExact(VOICE_MODE_CHANNEL) as VoiceModeChannelAdapter | undefined) ?? null;

/**
 * /meet over a chat's wired agents, with /voice's rules: unknown senders and unwired chats are dropped,
 * a sender with no owner or admin role over any of them is refused, and only the line's own caller
 * moves or uses a line. A chat where the sender administers more than one agent is refused: one meeting,
 * one agent.
 */
export async function runMeetCommand(
  mg: MessagingGroup,
  threadId: string | null,
  userId: string | null,
  command: MeetCommand,
  { meetings = liveMeetings(), key = encryptionKey() }: MeetRunOptions = {},
): Promise<MeetOutcome> {
  if (!userId || !(await getUser(userId))) return { kind: 'drop' };
  const wirings = await getMessagingGroupAgents(mg.id);
  if (wirings.length === 0) return { kind: 'drop' };
  const mine = [];
  for (const wiring of wirings) if (await hasAdminPrivilege(userId, wiring.agent_group_id)) mine.push(wiring);
  if (mine.length === 0) return { kind: 'refused' };
  if (mine.length > 1) return { kind: 'several-agents' };
  if (command.action === 'usage') return { kind: 'usage' };
  const wiring = mine[0];
  const ag = await getAgentGroup(wiring.agent_group_id);
  if (!ag) return { kind: 'drop' };
  const agentName = ag.name;
  if (!meetings) return { kind: 'voice-unavailable', agentName };
  if (!meetings.meetingsEnabled) return { kind: 'not-configured', agentName };
  const existing = await getVoiceModeLineForAgent(ag.id);
  const otherCaller = async (owner: string): Promise<MeetOutcome> => ({
    kind: 'other-caller',
    agentName,
    caller: (await getUser(owner))?.display_name ?? undefined,
  });
  if (command.action === 'leave') {
    if (!existing) return { kind: 'no-meeting', agentName };
    if (existing.owner_user_id !== userId) return otherCaller(existing.owner_user_id);
    return { kind: meetings.leaveMeeting(linePlatformId(existing.line_id)) ? 'left' : 'no-meeting', agentName };
  }
  const callThread = threadId !== null && wiringThreadsEnabled(wiring, mg) ? threadId : null;
  const target = { agentGroupId: ag.id, ownerUserId: userId, messagingGroupId: mg.id, threadId: callThread };
  let lineId: string | undefined;
  if (existing) {
    const bound = await bindVoiceModeLineChat({ ...target, callerUserId: userId });
    if (!bound) return otherCaller(existing.owner_user_id);
    lineId = bound.line_id;
  } else {
    // A first line, as /voice makes one: its link stays sealed until /voice shows it.
    if (!key) return { kind: 'no-key', agentName };
    const created = await createVoiceModeLine(target, key);
    const line = created?.line ?? (await bindVoiceModeLineChat({ ...target, callerUserId: userId }));
    if (!line) {
      const owner = (await getVoiceModeLineForAgent(ag.id))?.owner_user_id;
      return owner ? otherCaller(owner) : { kind: 'drop' };
    }
    lineId = line.line_id;
  }
  log.info('/meet: joining a meeting', { agentGroupId: ag.id, messagingGroupId: mg.id, line: lineId });
  const start = await meetings.startMeeting(linePlatformId(lineId), command.url);
  return start.ok ? { kind: 'started', agentName, url: command.url } : { kind: 'failed', agentName, start };
}

const meetCommandName = (channelType: string): string => (BANG_CHANNELS.has(channelType) ? '!meet' : '/meet');

/** The /meet reply, or null when the sender gets no answer. */
export function meetCommandReply(outcome: MeetOutcome, cmd = '/meet'): string | null {
  switch (outcome.kind) {
    case 'drop':
      return null;
    case 'refused':
      return `Only an owner or admin of this agent can use ${cmd}.`;
    case 'several-agents':
      return `This chat has several agents you administer; run ${cmd} in a chat with just one of them.`;
    case 'usage':
      return `Send ${cmd} <Google Meet link> to bring the agent into a meeting, or ${cmd} leave to send it away.`;
    case 'voice-unavailable':
      return `${outcome.agentName}: voice calls are off on this host (the voice-mode channel is not configured).`;
    case 'not-configured':
      return `${outcome.agentName}: meetings are not configured on this host (MEET_PROVIDER and its settings, e.g. ATTENDEE_URL and ATTENDEE_API_KEY).`;
    case 'no-key':
      return `${outcome.agentName}: call link storage is not set up on this host, so it has no voice line to join with.`;
    case 'other-caller':
      return `${outcome.agentName}: this voice line is ${outcome.caller ?? 'another admin'}'s; only they can take it into a meeting.`;
    case 'started':
      return (
        `\u{1F4DE} ${outcome.agentName} is asking to join ${outcome.url}. Admit "${outcome.agentName}" from the ` +
        `meeting's lobby; it answers when someone says its wake phrase. What it hears and says shows here. ` +
        `${cmd} leave sends it away.`
      );
    case 'failed':
      return `${outcome.agentName} could not join the meeting: ${failureText(outcome.start)}`;
    case 'left':
      return `${outcome.agentName} is leaving the meeting.`;
    case 'no-meeting':
      return `${outcome.agentName} is not in a meeting.`;
  }
}

function failureText(start: Extract<MeetingStart, { ok: false }>): string {
  switch (start.error) {
    case 'not-configured':
      return 'meetings are not configured on this host.';
    case 'no-line':
    case 'no-chat':
      return 'its voice line has no chat to talk in here.';
    case 'limit':
      return start.message ?? 'the voice line is over its limits.';
    case 'room':
      return 'the call room could not be opened.';
    case 'bot':
      return 'the meeting bot service refused or did not answer.';
    case 'stopped':
      return 'the call was replaced or the voice channel stopped meanwhile.';
  }
}

function messageText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text.trim() : '';
  } catch {
    return content.trim();
  }
}

/** Claims every /meet message; the agents never see one. Anything that cannot be /meet leaves before parsing. */
export async function handleMeetCommand(event: InboundEvent, options?: MeetRunOptions): Promise<boolean> {
  if (event.message.kind !== 'chat' && event.message.kind !== 'chat-sdk') return false;
  if (!/meet/i.test(event.message.content)) return false;
  const command = parseMeetCommand(messageText(event.message.content), event.channelType);
  if (!command) return false;

  const instance = event.instance ?? event.channelType;
  const adapter = getChannelAdapterExact(instance);
  if (!adapter) {
    log.warn('/meet dropped: the chat adapter is offline', { channelType: event.channelType });
    return true;
  }
  // As /voice: a platform without threads collapses them, and a Slack top-level message means the chat itself.
  const threadId = getChannelAdapter(instance)?.supportsThreads ? event.threadId : null;
  const chatThread = threadId !== null && threadId === `${event.platformId}:${event.message.id}` ? null : threadId;
  const mg = await getMessagingGroupByPlatform(event.channelType, event.platformId, instance);
  const userId = senderUserId(event);
  if (!mg || mg.denied_at || !userId) {
    log.info('/meet from an unknown sender or an unwired chat dropped', { channelType: event.channelType });
    return true;
  }
  try {
    const outcome = await runMeetCommand(mg, chatThread, userId, command, options);
    const text = meetCommandReply(outcome, meetCommandName(event.channelType));
    if (text !== null) await adapter.deliver(event.platformId, threadId, { kind: 'chat', content: { text } });
  } catch (err) {
    log.warn('/meet failed', { channelType: event.channelType, err: err instanceof Error ? err.message : String(err) });
  }
  return true;
}

registerMessageInterceptor((event) => handleMeetCommand(event));
