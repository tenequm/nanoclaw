/**
 * `/meet <google-meet-url>` (on Slack `!meet`), run in a chat wired to one agent by an owner or admin of
 * that agent whose voice line it is (or who gets a new one, as with `/voice`): the agent joins the meeting
 * as a voice participant through a Recall.ai bot (meet-recall.ts). A meeting is an ordinary call of the
 * call core whose caller is the bot's bridge page: the worker listens to the meeting's audio and its
 * speech plays into the meeting. The call talks in this chat, which becomes the line's call chat, so the
 * turns addressed to the agent and its answers land here. Meeting turns come from the meeting as a guest,
 * never from the line's caller. `/meet leave` sends the bot away; a call on the line's link ends a meeting,
 * as any newer call does. Off until RECALL_API_KEY and its settings are there.
 */
import type { InboundEvent } from './adapter.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getVoiceModeLineForAgent } from '../db/voice-mode-lines.js';
import { log } from '../log.js';
import { getUser } from '../modules/permissions/db/users.js';
import { registerMessageInterceptor } from '../router.js';
import { encryptionKey } from '../secret-seal.js';
import type { MessagingGroup } from '../types.js';
import { bridgeIdentity, type RecallMeetBridge } from './meet-recall.js';
import type { VoiceModeChannelAdapter } from './voice-mode.js';
import {
  administeredWirings,
  BANG_CHANNELS,
  callThread,
  claimLine,
  commandChat,
  commandName,
  liveVoiceAdapter,
  messageText,
} from './voice-mode-chat.js';
import { linePlatformId } from './voice-mode-line.js';
import type { CallKind, CallRefusal, LiveKitVoice } from './voice-mode-livekit.js';

const MINUTE_MS = 60_000;
/** A meeting bot can wait in the meeting's lobby until someone admits it. */
export const MEETING_JOIN_TIMEOUT_MS = 10 * MINUTE_MS;
/** A meeting runs longer than a call: this cap, under the line's daily minutes, instead of the call cap. */
export const MEETING_MAX_DURATION_MS = 60 * MINUTE_MS;
/** The worker and the bridge page, with room for the page to reconnect before its old self is gone. */
const MEETING_MAX_PARTICIPANTS = 3;
/** Who a meeting turn comes from: anyone in the meeting may have spoken. */
const MEETING_SENDER = 'Meeting';

/** A `/meet` turn's note: anyone may have spoken, and every message to the chat is said into the meeting. */
export function meetingReplyNote(languageNote: string): string {
  return (
    'Spoken in a live Google Meet you joined as a voice participant; someone there addressed you, ' +
    'and the speaker may be any participant, not only the chat owner. While the meeting lasts, every message ' +
    'you send to this chat is read aloud into the meeting word for word: keep it brief and conversational, lead ' +
    'with the answer, no markdown, no links, no code blocks, numbers written as words. Offer anything meant for ' +
    `reading for after the meeting. ${languageNote}`
  );
}

/** What `/meet` hears back: the meeting call started, or why not. */
export type MeetingStart =
  | { ok: true }
  | { ok: false; error: Exclude<CallRefusal['error'], 'limit'> | 'bot' }
  | { ok: false; error: 'limit'; message: string };

/** The voice channel's meetings: one per line at most, as calls are. */
export interface Meetings {
  start(platformId: string, meetingUrl: string): Promise<MeetingStart>;
  /** Ends the line's meeting call; false when it has none. */
  leave(platformId: string): boolean;
}

/**
 * The meeting call kind over the call core: the bridge page is the caller, turns come from the meeting,
 * and the Recall bot comes and goes with the call.
 */
export function createMeetings(
  core: Pick<LiveKitVoice, 'openCall' | 'endCall'>,
  bridge: RecallMeetBridge,
  { joinTimeoutMs = MEETING_JOIN_TIMEOUT_MS }: { joinTimeoutMs?: number } = {},
): Meetings {
  /** The meeting call running on each line, by call id. */
  const live = new Map<string, string>();

  const start = async (platformId: string, meetingUrl: string): Promise<MeetingStart> => {
    /** The bot, once its create was sent; whether the call already ended. */
    const meeting: { bot?: Promise<string | null>; ended: boolean } = { ended: false };
    const leaveBot = (): Promise<void> | undefined => meeting.bot?.then((id) => (id ? bridge.leave(id) : undefined));
    const kind: CallKind = {
      roomPrefix: 'meet',
      joinTimeoutMs,
      maxDurationMs: MEETING_MAX_DURATION_MS,
      // The bot can sit in the meeting's lobby for minutes before its page joins.
      room: {
        emptyTimeout: Math.ceil(joinTimeoutMs / 1000),
        departureTimeout: 10,
        maxParticipants: MEETING_MAX_PARTICIPANTS,
      },
      job: ({ roomName }) => ({ callerIdentity: bridgeIdentity(roomName), meeting: { pauseSends: false } }),
      sender: () => ({ id: null, name: MEETING_SENDER }),
      turnNote: meetingReplyNote,
      joined: (call, say) => say(`\u{1F4DE} ${call.line.agent.name} is in the meeting.`),
      ended: (call, reason, say) => {
        meeting.ended = true;
        if (live.get(call.platformId) === call.callId) live.delete(call.platformId);
        say?.(`\u{1F4DE} Left the meeting (${reason}).`);
        return leaveBot();
      },
    };
    const opened = await core.openCall(platformId, kind);
    if (!opened.ok) return opened.error === 'limit' ? { ok: false, error: 'limit', message: opened.body } : opened;
    const { call } = opened;
    live.set(platformId, call.callId);
    meeting.bot = bridge.join({ meetingUrl, botName: call.line.agent.name, roomName: call.roomName }).then(
      ({ botId }) => botId,
      (err: unknown) => {
        log.warn('meet: the meeting bot could not be created', { platformId, callId: call.callId, err });
        return null;
      },
    );
    // Ended between the room opening and the create: the end hook had no bot to send away.
    if (meeting.ended) void leaveBot();
    const botId = await meeting.bot;
    if (!botId) {
      await core.endCall(platformId, call.callId, 'meeting bot could not be created');
      return { ok: false, error: 'bot' };
    }
    if (meeting.ended) return { ok: false, error: 'stopped' };
    log.info('meet: meeting call started', { platformId, callId: call.callId, room: call.roomName, botId });
    return { ok: true };
  };

  return {
    start,
    leave(platformId) {
      const callId = live.get(platformId);
      if (!callId) return false;
      void core.endCall(platformId, callId, 'left by /meet leave');
      return true;
    },
  };
}

export type MeetCommand = { action: 'join'; url: string } | { action: 'leave' } | { action: 'usage' };

/**
 * A Google Meet link as typed, or as Slack wraps it (`<https://...>` or `<https://...|label>`), as its origin and
 * path only; null for anything else, or one with credentials or a port.
 */
export function meetingUrl(raw: string): string | null {
  const unwrapped = raw.replace(/^<([^|>]+)(?:\|[^>]*)?>$/, '$1');
  let url: URL;
  try {
    url = new URL(unwrapped);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'meet.google.com' || url.pathname.length < 2) return null;
  if (url.username || url.password || url.port) return null;
  // Only the meeting code path goes on to the bot: no query or fragment.
  return `${url.origin}${url.pathname}`;
}

/** `/meet <url>`, `/meet leave`, `/meet@<bot> ...` and, on Slack, `!meet ...`; null for any other message. */
export function parseMeetCommand(text: string, channelType: string): MeetCommand | null {
  const match = /^\s*([!/]meet(?:@\S*)?)(?!\S)(.*)$/is.exec(text);
  if (!match) return null;
  if (match[1][0] === '!' && !BANG_CHANNELS.has(channelType)) return null;
  const args = match[2].trim().split(/\s+/).filter(Boolean);
  if (args.length === 1 && args[0].toLowerCase() === 'leave') return { action: 'leave' };
  const url = args.length === 1 ? meetingUrl(args[0]) : null;
  return url ? { action: 'join', url } : { action: 'usage' };
}

/** What `/meet` needs of the voice channel: its meetings, null when they are not configured. */
export type MeetingControl = Pick<VoiceModeChannelAdapter, 'meetings'>;

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
  /** The voice channel; null when it is not running here. The live adapter by default. */
  meetings?: MeetingControl | null;
  key?: Buffer | null;
}

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
  { meetings: control = liveVoiceAdapter() ?? null, key = encryptionKey() }: MeetRunOptions = {},
): Promise<MeetOutcome> {
  const mine = await administeredWirings(mg, userId);
  if (!mine || !userId) return { kind: 'drop' };
  if (mine.length === 0) return { kind: 'refused' };
  if (mine.length > 1) return { kind: 'several-agents' };
  if (command.action === 'usage') return { kind: 'usage' };
  const wiring = mine[0];
  const ag = await getAgentGroup(wiring.agent_group_id);
  if (!ag) return { kind: 'drop' };
  const agentName = ag.name;
  if (!control) return { kind: 'voice-unavailable', agentName };
  const meetings = control.meetings;
  if (!meetings) return { kind: 'not-configured', agentName };
  const otherCaller = async (owner: string): Promise<MeetOutcome> => ({
    kind: 'other-caller',
    agentName,
    caller: (await getUser(owner))?.display_name ?? undefined,
  });
  if (command.action === 'leave') {
    const existing = await getVoiceModeLineForAgent(ag.id);
    if (!existing) return { kind: 'no-meeting', agentName };
    if (existing.owner_user_id !== userId) return otherCaller(existing.owner_user_id);
    return { kind: meetings.leave(linePlatformId(existing.line_id)) ? 'left' : 'no-meeting', agentName };
  }
  // A first line, as /voice makes one: its link stays sealed until /voice shows it.
  const claim = await claimLine(
    { agentGroupId: ag.id, ownerUserId: userId, messagingGroupId: mg.id, threadId: callThread(wiring, mg, threadId) },
    key,
  );
  if (claim.kind === 'no-key') return { kind: 'no-key', agentName };
  if (claim.kind === 'other-caller') return { kind: 'other-caller', agentName, caller: claim.caller };
  log.info('/meet: joining a meeting', { agentGroupId: ag.id, messagingGroupId: mg.id, line: claim.line.line_id });
  const start = await meetings.start(linePlatformId(claim.line.line_id), command.url);
  if (!start.ok) return { kind: 'failed', agentName, start };
  return { kind: 'started', agentName, url: command.url };
}

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
      return `${outcome.agentName}: meetings are not configured on this host (RECALL_API_KEY, MEET_RECALL_PAGE_URL and MEET_RECALL_LIVEKIT_URL).`;
    case 'no-key':
      return `${outcome.agentName}: call link storage is not set up on this host, so it has no voice line to join with.`;
    case 'other-caller':
      return `${outcome.agentName}: this voice line is ${outcome.caller ?? 'another admin'}'s; only they can take it into a meeting.`;
    case 'started':
      return (
        `\u{1F4DE} ${outcome.agentName} is asking to join ${outcome.url}. ` +
        `Admit "${outcome.agentName}" from the meeting's lobby; it answers when someone says its wake phrase, ` +
        `and a turn ends on a send word. What it is asked and its answers show here. ${cmd} leave sends it away.`
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
    case 'no-line':
    case 'no-chat':
      return 'its voice line has no chat to talk in here.';
    case 'limit':
      return start.message;
    case 'room':
      return 'the call room could not be opened.';
    case 'bot':
      return 'the meeting bot service refused or did not answer.';
    case 'stopped':
      return 'the call was replaced or the voice channel stopped meanwhile.';
  }
}

/** Claims every /meet message; the agents never see one. Anything that cannot be /meet leaves before parsing. */
export async function handleMeetCommand(event: InboundEvent, options?: MeetRunOptions): Promise<boolean> {
  if (event.message.kind !== 'chat' && event.message.kind !== 'chat-sdk') return false;
  if (!/meet/i.test(event.message.content)) return false;
  const command = parseMeetCommand(messageText(event.message.content), event.channelType);
  if (!command) return false;
  const chat = await commandChat(event, '/meet');
  if (!chat) return true;
  const { adapter, threadId, chatThread, mg, userId } = chat;
  try {
    const outcome = await runMeetCommand(mg, chatThread, userId, command, options);
    const text = meetCommandReply(outcome, commandName('meet', event.channelType));
    if (text !== null) await adapter.deliver(event.platformId, threadId, { kind: 'chat', content: { text } });
  } catch (err) {
    log.warn('/meet failed', { channelType: event.channelType, err: err instanceof Error ? err.message : String(err) });
  }
  return true;
}

registerMessageInterceptor((event) => handleMeetCommand(event));
