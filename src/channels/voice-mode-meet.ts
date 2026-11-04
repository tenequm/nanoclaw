/**
 * `/meet <google-meet-url>` (on Slack `!meet`), run in a chat wired to one agent by an owner or admin of
 * that agent whose voice line it is (or who gets a new one, as with `/voice`): the agent joins the meeting
 * as a voice participant through a Recall.ai bot (meet-recall.ts). A meeting is an ordinary call of the
 * call core whose caller is the bot's bridge page: the worker listens to the meeting's audio and its
 * speech plays into the meeting. The call talks in this chat, which becomes the line's call chat, so the
 * turns addressed to the agent and its answers land here. Meeting turns come from the meeting as a guest,
 * never from the line's caller. `/meet leave` sends the bot away; a call on the line's link ends a meeting,
 * as any newer call does. Off until RECALL_API_KEY and its settings are there. A meeting turn ends on a send
 * word, as on the call page with "a pause also sends" off; `pause` after the link makes the pause send it too.
 * `jev` also lets the agent join in unaddressed, when the Jev gate judges the conversation invites it.
 */
import type { InboundEvent } from './adapter.js';
import { JEV_API_KEY } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getVoiceModeLineForAgent } from '../db/voice-mode-lines.js';
import { log } from '../log.js';
import { DEFAULT_THRESHOLDS, gateEntryFor } from '../modules/jev-gate/config.js';
import { renderState, type GateHistoryRow } from '../modules/jev-gate/history.js';
import { askJev, decide } from '../modules/jev-gate/jev.js';
import { registerMessageInterceptor } from '../router.js';
import { encryptionKey } from '../secret-seal.js';
import type { MessagingGroup } from '../types.js';
import {
  bridgeIdentity,
  MEETING_JOIN_TIMEOUT_MS,
  MEETING_MAX_DURATION_MS,
  MEETING_SENDER,
  type RecallMeetBridge,
} from './meet-recall.js';
import type { VoiceModeChannelAdapter } from './voice-mode.js';
import {
  administeredWirings,
  BANG_CHANNELS,
  callThread,
  claimLine,
  commandChat,
  commandName,
  displayNameOf,
  liveVoiceAdapter,
  messageText,
} from './voice-mode-chat.js';
import { linePlatformId } from './voice-mode-line.js';
import { CALL_DEPTH_NOTE, type CallKind, type CallRefusal, type LiveKitVoice } from './voice-mode-livekit.js';

/** The worker and the bridge page, with room for the page to reconnect before its old self is gone. */
const MEETING_MAX_PARTICIPANTS = 3;
/** A `/meet ... jev` call's rolling transcript, in lines, that the Jev gate reads a candidate against. */
const MEETING_JEV_HISTORY_LINES = 12;
/** A line in that transcript is clipped: the gist is enough to tell what was already said or answered. */
const MEETING_JEV_LINE_CHARS = 600;
const MAX_WAKE_NAME_CHARS = 80;

/**
 * A meeting line as the Jev gate's state renders it: speaker-agnostic, since a meeting's audio comes
 * mixed, and the agent's own lines as `<agent> [assistant]`.
 */
function meetingLine(direction: 'in' | 'out', text: string, at: number): GateHistoryRow {
  return {
    timestamp: new Date(at).toISOString(),
    direction,
    kind: 'chat',
    text,
    sender: direction === 'in' ? MEETING_SENDER : '',
    isBot: false,
    jev: null,
    role: null,
    replyTo: null,
    hasMedia: false,
  };
}

/** The worker's wake name as it may enter Jev's questions: no control or format characters, capped. */
function wakeNameOf(raw: string): string {
  const flat = raw
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...flat].slice(0, MAX_WAKE_NAME_CHARS).join('').trim();
}

/** A `/meet` turn's note: anyone may have spoken, and every message to the chat is said into the meeting. */
function meetingReplyNote(languageNote: string): string {
  return (
    'Spoken in a live Google Meet you joined as a voice participant; someone there addressed you, ' +
    'and the speaker may be any participant, not only the chat owner. While the meeting lasts, every message ' +
    `you send to this chat is read aloud into the meeting word for word. ${CALL_DEPTH_NOTE} Offer anything ` +
    `meant for reading for after the meeting. ${languageNote}`
  );
}

/** What `/meet` hears back: the meeting call started, or why not. */
export type MeetingStart = { ok: true } | CallRefusal | { ok: false; error: 'bot' };

/** How a meeting runs, from the command's words after the link. */
export interface MeetingOptions {
  /** `pause`: a pause sends the turn, not only the send word. */
  pauseSends: boolean;
  /** `jev`: unaddressed speech is a candidate the Jev gate may let through. */
  jev: boolean;
}

/** The voice channel's meetings: one per line at most, as calls are. */
export interface Meetings {
  /** `bindChat`: makes the command's chat the line's call chat, once the call is admitted (CallKind.bindChat). */
  start(
    platformId: string,
    meetingUrl: string,
    options: MeetingOptions,
    bindChat?: () => Promise<boolean>,
  ): Promise<MeetingStart>;
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
  { judgeJev = askJev, now = () => Date.now() }: { judgeJev?: typeof askJev; now?: () => number } = {},
): Meetings {
  /** The meeting call running on each line, by call id. */
  const live = new Map<string, string>();

  /**
   * Jev's judge of a candidate against the meeting's rolling transcript, with the agent's gate thresholds
   * (the defaults without a live gate entry); an error or timeout keeps it out. The agent goes by
   * `wakeName`, the name the meeting wakes on, and by the line's agent name only without one.
   */
  const jevCandidates = (): NonNullable<CallKind['candidates']> => {
    const lines: GateHistoryRow[] = [];
    return {
      async judge(call, text, rawWakeName) {
        const agentName = wakeNameOf(rawWakeName) || call.line.agent.name;
        const fields = { callId: call.callId };
        const result = await judgeJev(renderState(lines, meetingLine('in', text, now()), agentName), agentName);
        if (!result.ok) {
          log.info('meet: jev candidate dropped', { ...fields, error: result.reason });
          return false;
        }
        const thresholds = gateEntryFor(call.line.agentGroupId)?.thresholds ?? DEFAULT_THRESHOLDS;
        const decision = decide(result.scores, thresholds);
        log.info(`meet: jev candidate ${decision.wake ? 'wakes the agent' : 'dropped'}`, {
          ...fields,
          value: decision.value,
          veto: decision.veto,
          ...(decision.reason ? { reason: decision.reason } : {}),
          ...result.scores,
        });
        return decision.wake;
      },
      heard(direction, text) {
        lines.push(meetingLine(direction, text.slice(0, MEETING_JEV_LINE_CHARS), now()));
        lines.splice(0, Math.max(0, lines.length - MEETING_JEV_HISTORY_LINES));
      },
    };
  };

  const start: Meetings['start'] = async (platformId, meetingUrl, options, bindChat) => {
    /** The bot, once its create was sent; whether the call already ended. */
    const meeting: { bot?: Promise<string | null>; ended: boolean } = { ended: false };
    const leaveBot = (): Promise<void> | undefined => meeting.bot?.then((id) => (id ? bridge.leave(id) : undefined));
    const kind: CallKind = {
      roomPrefix: 'meet',
      joinTimeoutMs: MEETING_JOIN_TIMEOUT_MS,
      maxDurationMs: MEETING_MAX_DURATION_MS,
      // The bot can sit in the meeting's lobby for minutes before its page joins.
      room: {
        emptyTimeout: MEETING_JOIN_TIMEOUT_MS / 1000,
        departureTimeout: 10,
        maxParticipants: MEETING_MAX_PARTICIPANTS,
      },
      job: ({ roomName }) => ({
        callerIdentity: bridgeIdentity(roomName),
        meeting: { pauseSends: options.pauseSends, jev: options.jev },
      }),
      sender: () => ({ id: null, name: MEETING_SENDER }),
      turnNote: meetingReplyNote,
      joined: (call, say) => say(`\u{1F4DE} ${call.line.agent.name} is in the meeting.`),
      ended: (call, reason, say) => {
        meeting.ended = true;
        if (live.get(call.platformId) === call.callId) live.delete(call.platformId);
        say?.(`\u{1F4DE} Left the meeting (${reason}).`);
        return leaveBot();
      },
      ...(options.jev ? { candidates: jevCandidates() } : {}),
      ...(bindChat ? { bindChat } : {}),
    };
    const opened = await core.openCall(platformId, kind);
    if (!opened.ok) return opened;
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
    log.info('meet: meeting call started', { platformId, callId: call.callId, room: call.roomName, botId, ...options });
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

/** `pauseSends` and `jev` only when on. */
export type MeetCommand =
  | { action: 'join'; url: string; pauseSends?: true; jev?: true }
  | { action: 'leave' }
  | { action: 'usage' };

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

/**
 * `/meet <url>`, `/meet <url> pause`, `/meet <url> jev` (`pause` and `jev` in any order around the link),
 * `/meet leave`, `/meet@<bot> ...` and, on Slack, `!meet ...`; null for any other message.
 */
export function parseMeetCommand(text: string, channelType: string): MeetCommand | null {
  const match = /^\s*([!/]meet(?:@\S*)?)(?!\S)(.*)$/is.exec(text);
  if (!match) return null;
  if (match[1][0] === '!' && !BANG_CHANNELS.has(channelType)) return null;
  const args = match[2].trim().split(/\s+/).filter(Boolean);
  if (args.length === 1 && args[0].toLowerCase() === 'leave') return { action: 'leave' };
  const pauses = args.filter((arg) => arg.toLowerCase() === 'pause');
  const jevs = args.filter((arg) => arg.toLowerCase() === 'jev');
  const links = args.filter((arg) => !['pause', 'jev'].includes(arg.toLowerCase()));
  const url = pauses.length <= 1 && jevs.length <= 1 && links.length === 1 ? meetingUrl(links[0]) : null;
  if (!url) return { action: 'usage' };
  return {
    action: 'join',
    url,
    ...(pauses.length ? { pauseSends: true as const } : {}),
    ...(jevs.length ? { jev: true as const } : {}),
  };
}

/** What `/meet` needs of the voice channel: its meetings, null when they are not configured. */
export type MeetingControl = Pick<VoiceModeChannelAdapter, 'meetings'>;

export type MeetOutcome =
  | { kind: 'drop' }
  | { kind: 'refused' }
  | { kind: 'several-agents' }
  | { kind: 'usage' }
  | { kind: 'voice-unavailable' | 'not-configured' | 'no-key' | 'no-jev'; agentName: string }
  | { kind: 'other-caller'; agentName: string; caller?: string }
  | { kind: 'started'; agentName: string; url: string; pauseSends?: true; jev?: true }
  | { kind: 'failed'; agentName: string; start: Extract<MeetingStart, { ok: false }> }
  | { kind: 'left' | 'no-meeting'; agentName: string };

export interface MeetRunOptions {
  /** The voice channel; null when it is not running here. The live adapter by default. */
  meetings?: MeetingControl | null;
  key?: Buffer | null;
  /** Whether the Jev gate has its JEV_API_KEY here, which `jev` needs. */
  jevAvailable?: boolean;
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
  {
    meetings: control = liveVoiceAdapter() ?? null,
    key = encryptionKey(),
    jevAvailable = Boolean(JEV_API_KEY),
  }: MeetRunOptions = {},
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
  const existing = await getVoiceModeLineForAgent(ag.id);
  if (existing && existing.owner_user_id !== userId) {
    return { kind: 'other-caller', agentName, caller: await displayNameOf(existing.owner_user_id) };
  }
  if (command.action === 'leave') {
    if (!existing) return { kind: 'no-meeting', agentName };
    return { kind: meetings.leave(linePlatformId(existing.line_id)) ? 'left' : 'no-meeting', agentName };
  }
  if (command.jev && !jevAvailable) return { kind: 'no-jev', agentName };
  const target = {
    agentGroupId: ag.id,
    ownerUserId: userId,
    messagingGroupId: mg.id,
    threadId: callThread(wiring, mg, threadId),
  };
  let lineId = existing?.line_id;
  if (!lineId) {
    // A first line, as /voice makes one: its link stays sealed until /voice shows it.
    const claim = await claimLine(target, key);
    if (claim.kind === 'no-key') return { kind: 'no-key', agentName };
    if (claim.kind === 'other-caller') return { kind: 'other-caller', agentName, caller: claim.caller };
    lineId = claim.line.line_id;
  }
  log.info('/meet: joining a meeting', { agentGroupId: ag.id, messagingGroupId: mg.id, line: lineId });
  const start = await meetings.start(
    linePlatformId(lineId),
    command.url,
    { pauseSends: command.pauseSends === true, jev: command.jev === true },
    // An existing line moves to this chat only once the meeting call is admitted.
    async () => (await claimLine(target, key)).kind === 'bound',
  );
  if (!start.ok) return { kind: 'failed', agentName, start };
  return {
    kind: 'started',
    agentName,
    url: command.url,
    ...(command.pauseSends ? { pauseSends: true as const } : {}),
    ...(command.jev ? { jev: true as const } : {}),
  };
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
      return (
        `Send ${cmd} <Google Meet link> to bring the agent into a meeting, or ${cmd} leave to send it away. ` +
        `A turn ends on a send word; add pause (${cmd} <link> pause) to send it on a pause too, and jev ` +
        `(${cmd} <link> jev) to let it join in unaddressed when the conversation invites it.`
      );
    case 'voice-unavailable':
      return `${outcome.agentName}: voice calls are off on this host (the voice-mode channel is not configured).`;
    case 'not-configured':
      return `${outcome.agentName}: meetings are not configured on this host (RECALL_API_KEY, MEET_RECALL_PAGE_URL and MEET_RECALL_LIVEKIT_URL).`;
    case 'no-key':
      return `${outcome.agentName}: call link storage is not set up on this host, so it has no voice line to join with.`;
    case 'no-jev':
      return `${outcome.agentName}: jev needs the Jev gate's JEV_API_KEY on this host; send ${cmd} <link> without jev.`;
    case 'other-caller':
      return `${outcome.agentName}: this voice line is ${outcome.caller ?? 'another admin'}'s; only they can take it into a meeting.`;
    case 'started':
      return (
        `\u{1F4DE} ${outcome.agentName} is asking to join ${outcome.url}. ` +
        `Admit "${outcome.agentName}" from the meeting's lobby; it answers when someone says its wake phrase, ` +
        `and a turn ends on a send word${outcome.pauseSends ? ' or a pause' : ''}. What it is asked and its answers ` +
        `show here.${outcome.jev ? ' It may also join in unaddressed when the conversation invites it.' : ''} ` +
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
    case 'no-line':
      return 'its voice line is gone, or its caller no longer owns or administers the agent.';
    case 'no-chat':
      return 'its voice line has no chat to talk in here.';
    case 'limit':
      return start.body;
    case 'room':
      return 'the call room could not be opened.';
    case 'bot':
      return 'the meeting bot service refused or did not answer.';
    case 'stopped':
      return 'the call was replaced or the voice channel stopped meanwhile.';
  }
}

/** Claims every /meet message; the agents never see one. Anything that cannot be /meet leaves before parsing. */
async function handleMeetCommand(event: InboundEvent): Promise<boolean> {
  if (event.message.kind !== 'chat' && event.message.kind !== 'chat-sdk') return false;
  if (!/meet/i.test(event.message.content)) return false;
  const command = parseMeetCommand(messageText(event.message.content), event.channelType);
  if (!command) return false;
  const chat = await commandChat(event, '/meet');
  if (!chat) return true;
  const { adapter, threadId, chatThread, mg, userId } = chat;
  try {
    const outcome = await runMeetCommand(mg, chatThread, userId, command);
    const text = meetCommandReply(outcome, commandName('meet', event.channelType));
    if (text !== null) await adapter.deliver(event.platformId, threadId, { kind: 'chat', content: { text } });
  } catch (err) {
    log.warn('/meet failed', { channelType: event.channelType, err: err instanceof Error ? err.message : String(err) });
  }
  return true;
}

registerMessageInterceptor((event) => handleMeetCommand(event));
