/**
 * The call engine of the voice channel: the caller talks to the line's real
 * NanoClaw agent, not to a voice model playing it.
 *
 * The caller's browser joins a LiveKit room over WebRTC; a LiveKit Agents
 * worker (`src/voice-mode-worker.ts`, its own process: agents-js runs every
 * job in a forked child process) joins the same room, cuts the caller's audio
 * into turns, transcribes each turn and hands the text to the host, then speaks
 * every agent reply into the room with Gemini TTS. The host owns the call: it
 * admits it against the shared limits, creates a unique room, dispatches the
 * worker to it with the job metadata, charges the daily minutes, rechecks
 * access every few seconds and ends the call by deleting the room, which
 * disconnects caller and worker alike.
 *
 * This module is the call core, generic over a call *kind* (CallKind): what
 * differs between calls, such as who the caller is in the room and what each
 * turn tells the agent, comes from the kind `openCall` is given. The `/voice`
 * page call is one kind (its page and token routes live in voice-mode.ts).
 *
 * The worker reaches the host over HTTP on the webhook server
 * (`/webhook/voice-mode/livekit/agent/*`), at an address from its own settings,
 * authenticated by a per-call secret both sides derive from the LiveKit API
 * secret (never in the dispatch metadata, never in the caller's token):
 *  - `GET  agent/events`     an NDJSON stream of agent replies to speak, the
 *    agent still working, and when to end, with pings;
 *  - `POST agent/joined`     the caller is in the room; the clock starts here;
 *  - `POST agent/utterance`  one transcribed caller turn, fed to the agent as
 *    an inbound message with the id `livekit:<callId>:<n>`; answered 202 only
 *    once the agent's session stored it, so the caller's "sent" mark is true;
 *    after the caller's page hung up, still taken for HANGUP_GRACE_MS;
 *  - `POST agent/ended`      the worker's session is over;
 *  - `POST agent/jev`        a jev call's words, speech marks and playback reports (meet-jev).
 *
 * A jev call (`/voice jev` or `/meet <link> jev`, the job's `jev`) takes no `agent/utterance` turns from
 * the worker: the meet-jev module decides when the agent gets a turn (submitTurn, with the same checks)
 * and which of its replies are spoken; the rest are only in the call chat. A jev meeting's transcript
 * reaches its loop from Recall (`jevCall`), not from the worker.
 *
 * A call talks in one of the agent's chats (its *call chat*), not on the voice
 * line: the line's `/voice` chat (its voice_mode_lines binding), while that
 * chat stays wired to the agent. Each turn is routed into that chat's session
 * through the normal inbound path as a message from the call kind's sender
 * (the line's own caller, or a guest with no role over the agent), addressed
 * to the line's agent only; the transcript is posted into the chat,
 * and the agent answers there as it always does. While the call is live, every
 * message the agent delivers to that chat is also spoken, and its typing there
 * is the worker's `thinking`. With no call chat a call is refused, and a
 * running one ends at its next turn.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';

import { AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk';

import type { ChannelAdapter, InboundEvent } from './adapter.js';
import { getChannelAdapterExact } from './channel-registry.js';
import type { VoiceModeTurn, VoiceModeTurnEvent } from './voice-mode-route.js';
import { lineIdOf, sameCallerAndAgent, type ResolveLineOptions, type VoiceModeLine } from './voice-mode-line.js';
import {
  DEFAULT_LIVEKIT_AGENT_NAME,
  DEFAULT_VOICE_SILENCE_MS,
  DEFAULT_VOICE_STT_MODEL,
  LIVEKIT_PROTOCOL_VERSION,
  liveKitCallSecret,
  PING_INTERVAL_MS,
  settleWithin,
  baseLanguage,
  DEFAULT_VOICE_LANGUAGES,
  MAX_JEV_EVENTS_PER_POST,
  MAX_JEV_POST_BYTES,
  WORKER_REQUEST_TIMEOUT_MS,
  type CallUtterance,
  type LiveKitHostEvent,
  type LiveKitJobMetadata,
  type CallEndReason,
  type CallRoomMetadata,
} from './voice-mode-protocol.js';
import { getMessagingGroup, getMessagingGroupsByAgentGroup } from '../db/messaging-groups.js';
import { getVoiceModeLine } from '../db/voice-mode-lines.js';
import { registerPostDeliveryHook, setOutboundPresentation, type OutboundAddress } from '../delivery.js';
import { log } from '../log.js';
import { platformMessageId } from '../platform-id.js';
import { registerTypingObserver } from '../modules/typing/index.js';
import { createJevCall, type JevCall, type JevDeps, type JevTurnResult } from '../modules/meet-jev/index.js';
import type { MessagingGroup } from '../types.js';
import { TTS_DEFAULT_CHOICE } from '../voice-mode-tts.js';

export const MINUTE_MS = 60_000;
const MAX_QUEUED_EVENTS = 50;
/**
 * The longest utterance the host takes, in UTF-8 bytes: above MAX_TURN_TEXT_BYTES, which still caps review drafts on
 * the worker and clients, so a long spoken turn (about 20 minutes of Ukrainian) is not refused.
 */
const MAX_UTTERANCE_TEXT_BYTES = 32 * 1024;
/** Room for a full-length utterance even when JSON escapes double its text, plus the envelope. */
const MAX_AGENT_BODY_BYTES = 2 * MAX_UTTERANCE_TEXT_BYTES + 1024;
/** An `agent/jev` batch: up to MAX_JEV_EVENTS_PER_POST mostly short partials, or a few long finals. */
const MAX_JEV_BODY_BYTES = MAX_JEV_POST_BYTES;
/** The worker opens its event stream right after it reports the caller in; without it nothing reaches the caller. */
const WORKER_STREAM_TIMEOUT_MS = 30_000;
export const MAX_UTTERANCES_PER_MINUTE = 20;
/** The router has this long to store a turn in the agent's session, so the worker hears the 504 before it gives up. */
const ROUTE_TIMEOUT_MS = WORKER_REQUEST_TIMEOUT_MS - 2_000;
/** Turns routing at once on a call. The worker sends one at a time, so more is a worker gone wrong. */
const MAX_TURNS_IN_FLIGHT = 3;
/** How long teardown waits on a call kind's end (a meeting bot leaving); past it the kind goes on alone. */
const END_HOOK_TIMEOUT_MS = 10_000;
/** Outcomes a call keeps by the worker's turn key, so a retried turn is answered, not routed again. */
const MAX_REMEMBERED_TURNS = 32;
const MAX_TURN_KEY_LENGTH = 64;
/** How long the room's end reason may hold up the hangup; past it the page shows a plain "ended". */
const END_NOTICE_TIMEOUT_MS = 2_000;
/**
 * After the caller's page hangs up, the worker may still post a turn the caller already heard was
 * sent (a spoken send whose final was still out): it is taken this long, or until the worker's `ended`.
 */
const HANGUP_GRACE_MS = 5_000;

/** The transcription takes its language codes as a hint only, so a Ukrainian turn can come out in Russian spelling. */
export const CALL_LANGUAGE_NOTE =
  'The caller speaks Ukrainian or English; a transcript that looks Russian is Ukrainian misspelled by speech ' +
  'recognition, so answer in Ukrainian (in English if the caller spoke English), never in Russian.';

/**
 * How a spoken reply is shaped for the ear. Every format rule for a spoken reply lives in the turn notes; the
 * resident voice-mode-formatting instructions carry only what no turn's note can.
 */
export const CALL_SPEECH_FORMAT_NOTE = 'No markdown, no links, no code blocks, numbers written as words.';

/** How long a /voice answer runs, then the speech format. */
export const CALL_DEPTH_NOTE =
  'Match the depth to the question: brief for simple ones; for design, strategy or anything that needs care, ' +
  'take the time to think and verify, and give the full considered answer in plain speech. Lead with the ' +
  `answer; for a long one, say how many points there are, then take them one at a time. ${CALL_SPEECH_FORMAT_NOTE}`;

/** How the agent learns a message was spoken on a call in its chat, where every message it sends there is heard. */
export const callChatReplyNote = (languageNote: string): string =>
  'Spoken on a live voice call; while it lasts, every message you send to this chat is read aloud word for ' +
  `word. ${CALL_DEPTH_NOTE} Offer anything meant for reading (code, links, long lists) for after the call ` +
  `instead of sending it now. ${languageNote}`;

/** callChatReplyNote for the default languages. */
export const CALL_CHAT_REPLY_NOTE = callChatReplyNote(CALL_LANGUAGE_NOTE);

/** Added to a non-default VOICE_MODE_LANGUAGES note when Ukrainian is listed. */
const MISSPELLED_UKRAINIAN_NOTE =
  'A transcript that looks Russian is Ukrainian misspelled by speech recognition; answer in Ukrainian, never Russian.';

/** What a turn says about the caller's language: CALL_LANGUAGE_NOTE for the default languages, else the configured ones. */
export function callLanguageNote(languages: readonly string[]): string {
  if (
    languages.length === DEFAULT_VOICE_LANGUAGES.length &&
    languages.every((code, i) => code === DEFAULT_VOICE_LANGUAGES[i])
  ) {
    return CALL_LANGUAGE_NOTE;
  }
  const ukrainian = languages.some((code) => baseLanguage(code) === 'uk');
  return `The caller speaks ${languages.join(', ')}; answer in the language they spoke.${ukrainian ? ` ${MISSPELLED_UKRAINIAN_NOTE}` : ''}`;
}

/** The inbound text for one transcribed caller turn. */
export function turnMessageText(transcript: string, note: string): string {
  return `<voice source="livekit">${transcript}</voice>\n${note}`;
}

/** Inbound ids for caller turns are `livekit:<call>:<n>`; replies name them back in their in-reply-to. */
export const LIVEKIT_ID_PREFIX = 'livekit:';

function liveKitUtteranceMessageId(callId: string, utteranceId: string): string {
  return `${LIVEKIT_ID_PREFIX}${callId}:${utteranceId}`;
}

export function parseLiveKitUtteranceId(id: string): { callId: string; utteranceId: string } | null {
  if (!id.startsWith(LIVEKIT_ID_PREFIX)) return null;
  const [callId, utteranceId, ...rest] = id.slice(LIVEKIT_ID_PREFIX.length).split(':');
  return callId && utteranceId && rest.length === 0 ? { callId, utteranceId } : null;
}

/** The slices of the LiveKit server API the host uses; injectable for tests. */
export interface LiveKitServerApi {
  createRoom(options: {
    name: string;
    emptyTimeout: number;
    departureTimeout: number;
    maxParticipants: number;
  }): Promise<unknown>;
  deleteRoom(room: string): Promise<void>;
  createDispatch(room: string, agentName: string, options: { metadata: string }): Promise<unknown>;
  updateRoomMetadata(room: string, metadata: string): Promise<unknown>;
}

/** The `/voice` binding of a line, as stored; checked against the agent's wiring before use. */
export interface BoundCallChat {
  group: MessagingGroup;
  threadId: string | null;
}

/** The agent's chats a call can talk in; the central DB and live adapters by default, fakes in tests. */
export interface MirrorApi {
  groupsFor(agentGroupId: string): Promise<MessagingGroup[]>;
  adapter(key: string): Pick<ChannelAdapter, 'deliver'> | undefined;
  /** The chat `/voice` last pointed the line at, if any. */
  boundChat(lineId: string): Promise<BoundCallChat | null>;
}

/** A chat address as delivery and typing see it. */
export interface ChatAddress {
  channelType: string;
  platformId: string;
  threadId: string | null;
}

/** The chat a call talks in: the line's binding, which `/voice` and `/meet` set. */
export interface CallChat {
  group: MessagingGroup;
  threadId: string | null;
}

export interface SpeechSettings {
  sttModel?: string;
  silenceMs?: number;
}

export interface LiveKitVoiceConfig {
  /** The wake phrase's name (wakePhraseName): what a jev call's people call the agent, over the line's agent name. */
  wakeName?: string;
  /** VOICE_MODE_LANGUAGES as parseVoiceLanguages read it; DEFAULT_VOICE_LANGUAGES when unset. */
  languages?: readonly string[];
  /** Signaling URL the caller's browser connects to (LIVEKIT_URL). */
  url: string;
  /** Server-side URL for the host's API calls (LIVEKIT_WORKER_URL); defaults to `url`. */
  serverUrl?: string;
  apiKey: string;
  apiSecret: string;
  /** Dispatch name the worker registers under. */
  agentName?: string;
  /** Transcription settings the worker gets in the job metadata (VOICE_MODE_STT_*, VOICE_MODE_SILENCE_MS); the voice is the line's. */
  speech?: SpeechSettings;
  /** Test seam; defaults to the central DB and the live channel adapters. */
  mirrorApi?: MirrorApi;
  /** How long the worker has to open its event stream after reporting the caller in. */
  workerStreamTimeoutMs?: number;
  /** How long a turn may take to reach the agent's session before the worker hears it timed out. */
  routeTimeoutMs?: number;
  /** HANGUP_GRACE_MS; a test seam. */
  hangupGraceMs?: number;
  /** END_HOOK_TIMEOUT_MS; a test seam. */
  endHookTimeoutMs?: number;
  /** Test seam; defaults to the livekit-server-sdk clients. */
  api?: LiveKitServerApi;
  /** Test seam: what a jev call runs on; the meet-jev core and Jev client by default. */
  jev?: Partial<JevDeps>;
}

/** What the voice adapter shares with this engine: limits, access, routing. */
export interface LiveKitHost {
  resolveLine(platformId: string, options?: ResolveLineOptions): Promise<VoiceModeLine | null>;
  admitStart(platformId: string, t: number): { body: string; retryAfter: string } | null;
  /** Daily call time left on the line. */
  remainingTodayMs(platformId: string, t: number): number;
  chargeUsage(call: { platformId: string; startedAt: number }): void;
  /**
   * Route a turn through the host's inbound path, into the call chat. Resolves
   * true once the agent's session stored it (to answer, or as context), false when the router dropped it;
   * rejects when routing threw.
   */
  routeTurn(event: VoiceModeTurnEvent, turn: VoiceModeTurn): Promise<boolean>;
  /**
   * The caller joined: `route` is where the call's turns go now (`agentGroupId`: the line's agent).
   * Wakes that agent's existing session once, before the first turn (none is created), unless `live`
   * says the call ended meanwhile; a long silent call lets the session be reclaimed as usual, and the
   * next turn wakes it again.
   */
  callJoined?(callId: string, route: Omit<InboundEvent, 'message'>, agentGroupId: string, live: () => boolean): void;
  isRunning(): boolean;
  now(): number;
  accessCheckIntervalMs: number;
}

/** A call as its kind sees it. */
export interface KindCall {
  readonly callId: string;
  readonly platformId: string;
  readonly line: VoiceModeLine;
  readonly roomName: string;
  /** The participant the worker waits for and listens to. */
  readonly callerIdentity: string;
}

/**
 * What one kind of call brings to the core: everything else (admission, the room, the worker's
 * routes, the turns, the chat) is the same for every call.
 */
export interface CallKind {
  /** The room name's first segment. */
  roomPrefix: string;
  /** How long the caller has to join the room once it is open. */
  joinTimeoutMs: number;
  /** The call's cap; the line's daily minutes can cut it shorter. */
  maxDurationMs: number;
  room: { emptyTimeout: number; departureTimeout: number; maxParticipants: number };
  /** The kind's part of the worker's job metadata. */
  job(call: Pick<KindCall, 'callId' | 'roomName'>): Pick<LiveKitJobMetadata, 'callerIdentity' | 'meeting' | 'jev'>;
  /** Who each turn comes from; a guest (no user id) gets no role over the agent. */
  sender(line: VoiceModeLine): { id: string | null; name: string };
  /** What each turn tells the agent, given the caller's language note (callLanguageNote). */
  turnNote(languageNote: string): string;
  /** The caller joined and the call talks in a chat; `say` posts there. */
  joined?(call: KindCall, say: (text: string) => void): void;
  /**
   * Makes the kind's own chat the line's call chat once the call is admitted, so a refused call moves no line;
   * false: the line is no longer its caller's. A kind with it is not refused for the line's old chat.
   */
  bindChat?(): Promise<boolean>;
  /** The call ended; `say` posts to its chat, null when it never went live there. Teardown awaits what it returns. */
  ended?(call: KindCall, reason: string, say: ((text: string) => void) | null): Promise<void> | void;
}

/** Why `openCall` opened no call. */
export type CallRefusal =
  | { ok: false; error: 'no-line' | 'no-chat' | 'room' | 'stopped' }
  | { ok: false; error: 'limit'; body: string; retryAfter: string };

/** `openCall`'s answer: the call, its room open and the worker dispatched, or why not. */
export type OpenCallResult =
  | {
      ok: true;
      call: KindCall;
      /** The chat the call talks in, as resolved at the start. */
      chat: CallChat;
      job: LiveKitJobMetadata;
      /** What ends the call from the join, and which cap it is. */
      limit: { ms: number; kind: 'daily' | 'duration' };
    }
  | CallRefusal;

interface LiveKitCall extends KindCall {
  kind: CallKind;
  secret: string;
  /** The kind's turn note, with the engine's language note. */
  note: string;
  state: 'connecting' | 'live';
  /** Set when the worker reports the caller in the room; the daily budget is charged from here. */
  startedAt?: number;
  ended: boolean;
  joinTimer?: ReturnType<typeof setTimeout>;
  streamTimer?: ReturnType<typeof setTimeout>;
  expires?: ReturnType<typeof setTimeout>;
  accessTimer?: ReturnType<typeof setInterval>;
  pingTimer?: ReturnType<typeof setInterval>;
  stream?: http.ServerResponse;
  queue: LiveKitHostEvent[];
  /** Accepted utterance times (config clock), for the per-minute cap. */
  utteranceStarts: number[];
  utterances: number;
  /** What became of each turn, by the worker's turn key; a retry gets the same answer. */
  turnOutcomes: Map<string, Promise<TurnOutcome>>;
  turnsInFlight: number;
  /** Where the call talks; null while it has none (the next turn ends the call). Refreshed on join and every turn. */
  chat: CallChat | null;
  /** Orders chat refreshes: only the latest one started may set `chat`. */
  chatRefreshes: number;
  /**
   * The chat the call talked in before `/voice` moved it mid-call, still spoken
   * so an answer in flight there is heard. Dropped at a turn once a whole turn
   * went by with no agent message or typing there.
   */
  previousChat: { chat: CallChat; active: boolean } | null;
  cleanup?: Promise<void>;
  /** The latest chat-label write; the end reason waits for it, so a late label cannot erase the reason. */
  metadataWrite?: Promise<void>;
  /** Settles once the room carries why the call ended (or that failed) and the worker was told. */
  announced?: Promise<void>;
  /** A jev call's loop; set from the start for a job with `jev`. */
  jev?: JevCall;
}

/** The host's answer to one utterance POST. */
interface TurnOutcome {
  status: number;
  body: string;
  /** On a 202: the host's utterance id for the turn. */
  id?: string;
}

export interface LiveKitVoice {
  /** The worker's `livekit/agent/*` routes. */
  handleAgentHttp(req: http.IncomingMessage, res: http.ServerResponse, route: string, url: URL): Promise<void>;
  /**
   * Admit a call of `kind` on the line, open its room and dispatch the worker; the line's running call
   * ends (newest wins).
   */
  openCall(platformId: string, kind: CallKind): Promise<OpenCallResult>;
  /**
   * Ends the line's call `callId` when it still is the line's call, and resolves once its room is gone.
   * `grace`: its worker's turns are still taken for HANGUP_GRACE_MS.
   */
  endCall(platformId: string, callId: unknown, reason: string, options?: { grace?: boolean }): Promise<void>;
  /** Whether `callId` is still the line's running call: not ended, not replaced. */
  isLive(platformId: string, callId: string): boolean;
  /** The jev loop of the running call `callId`, for a source outside the worker (a meeting's Recall transcript). */
  jevCall(callId: string): JevCall | undefined;
  /** An agent message reached a chat: speak it on the live call that talks there. `replyTo`: the call turn it answers. */
  chatMessage(
    chat: ChatAddress,
    agentGroupId: string,
    text: string,
    replyTo?: { callId: string; utteranceId: string } | null,
  ): void;
  /** Whether `chatMessage` with the same arguments would speak it on a live call right now; changes nothing. */
  speaksChat(chat: ChatAddress, agentGroupId: string, replyTo: { callId: string; utteranceId: string } | null): boolean;
  /**
   * The agent is working in a chat: tell its live call that talks there. `working`: the runner has
   * picked up what reached that chat last (the typing module's `TypingTick.working`).
   */
  chatTyping(chat: ChatAddress, agentGroupId: string, working?: boolean): void;
  /** The running call on a line, for the daily budget. */
  activeCall(platformId: string): { platformId: string; startedAt: number } | undefined;
  teardown(): Promise<void>;
}

const defaultMirrorApi: MirrorApi = {
  groupsFor: (agentGroupId) => getMessagingGroupsByAgentGroup(agentGroupId),
  adapter: (key) => getChannelAdapterExact(key),
  async boundChat(lineId) {
    const id = lineIdOf(lineId);
    const current = id ? await getVoiceModeLine(id) : undefined;
    if (!current) return null;
    const group = current.messaging_group_id && (await getMessagingGroup(current.messaging_group_id));
    return group ? { group, threadId: current.thread_id } : null;
  },
};

/** How the page names the chat a call talks in. */
export const chatLabel = (group: MessagingGroup): string =>
  group.name || (group.is_group ? group.channel_type : `${group.channel_type} DM`);

/** A call talks in `chat`, and `to` is that chat: the same thread, or the chat itself when delivery drops the thread. */
const isCallChat = (chat: CallChat, to: ChatAddress): boolean =>
  chat.group.channel_type === to.channelType &&
  chat.group.platform_id === to.platformId &&
  (to.threadId === null || to.threadId === chat.threadId);

/** Every running engine, for the delivery and typing taps below. */
const engines = new Set<LiveKitVoice>();

/** The words of a chat message's parsed content, or null for edits, reactions, cards and host command replies. */
function wordsOf(id: string, kind: string, content: Readonly<Record<string, unknown>>): string | null {
  if (kind !== 'chat' && kind !== 'chat-sdk') return null;
  if (id.startsWith('hcmd-')) return null;
  if (content.operation || content.type || typeof content.text !== 'string') return null;
  return content.text.trim() || null;
}

/** The words of a delivered chat message, or null for edits, reactions, cards and host command replies. */
export function spokenText(message: { id: string; kind: string; content: string }): string | null {
  try {
    return wordsOf(message.id, message.kind, JSON.parse(message.content) as Record<string, unknown>);
  } catch {
    return null;
  }
}

type ChatMessageAddress = {
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
  inReplyTo?: string | null;
};

/** Where an agent message went and the call turn it answers, for the live calls to match. */
function chatTarget(
  msg: ChatMessageAddress,
  agentGroupId: string,
): { chat: ChatAddress; replyTo: { callId: string; utteranceId: string } | null } | null {
  if (!msg.channelType || !msg.platformId) return null;
  return {
    chat: { channelType: msg.channelType, platformId: msg.platformId, threadId: msg.threadId ?? null },
    // Delivery hands the id over agent-scoped.
    replyTo: msg.inReplyTo ? parseLiveKitUtteranceId(platformMessageId(msg.inReplyTo, agentGroupId)) : null,
  };
}

/** Delivery tap: an agent message reached a chat; a live call talking there speaks it. */
export function liveKitChatDelivered(
  msg: ChatMessageAddress & { id: string; kind: string; content: string },
  agentGroupId: string,
): void {
  if (engines.size === 0) return;
  const text = spokenText(msg);
  const target = text ? chatTarget(msg, agentGroupId) : null;
  if (!text || !target) return;
  for (const engine of engines) engine.chatMessage(target.chat, agentGroupId, text, target.replyTo);
}

/** Leads the chat's copy of an agent message a live call was given to speak (not proof it was heard). */
export const SPOKEN_MARK = '\u{1F50A} ';

/**
 * Presentation tap: the chat's copy of an agent message that a live call is about to speak starts
 * with SPOKEN_MARK. Only what the platform shows: the stored message, the post-delivery hooks, the
 * spoken text and the agent's context keep the original. The same match as the delivery tap.
 */
export function liveKitChatPresentation(
  msg: OutboundAddress,
  content: Readonly<Record<string, unknown>>,
  agentGroupId: string,
): Record<string, unknown> | null {
  if (engines.size === 0 || !wordsOf(msg.id, msg.kind, content)) return null;
  const target = chatTarget(msg, agentGroupId);
  if (!target || ![...engines].some((engine) => engine.speaksChat(target.chat, agentGroupId, target.replyTo))) {
    return null;
  }
  return { ...content, text: `${SPOKEN_MARK}${content.text as string}` };
}

/** Typing tap: the agent works in a chat; its live call talking there hears it is thinking, and when it picked a turn up. */
export function liveKitChatTyping(chat: ChatAddress, agentGroupId: string, working = false): void {
  for (const engine of engines) engine.chatTyping(chat, agentGroupId, working);
}

registerPostDeliveryHook((msg, session) => liveKitChatDelivered(msg, session.agent_group_id));
setOutboundPresentation((msg, content, session) => liveKitChatPresentation(msg, content, session.agent_group_id));
registerTypingObserver(({ agentGroupId, working, ...chat }) => liveKitChatTyping(chat, agentGroupId, working));

export const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

/** Answers a voice route: plain text unless `headers` say otherwise, never cached. */
export function reply(
  res: http.ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function defaultApi(config: LiveKitVoiceConfig): LiveKitServerApi {
  const host = config.serverUrl || config.url;
  const rooms = new RoomServiceClient(host, config.apiKey, config.apiSecret, { requestTimeout: 10 });
  const dispatch = new AgentDispatchClient(host, config.apiKey, config.apiSecret, { requestTimeout: 10 });
  return {
    createRoom: (options) => rooms.createRoom(options),
    deleteRoom: (room) => rooms.deleteRoom(room),
    createDispatch: (room, agentName, options) => dispatch.createDispatch(room, agentName, options),
    updateRoomMetadata: (room, metadata) => rooms.updateRoomMetadata(room, metadata),
  };
}

const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const isNotFound = (err: unknown): boolean => {
  const e = err as { status?: unknown; code?: unknown } | null;
  return e?.status === 404 || e?.code === 'not_found';
};

/**
 * The request's JSON object, or null when it is larger than `maxBytes`, not JSON or not an object;
 * an empty body is `whenEmpty` (null by default).
 */
export async function readJsonObject(
  req: http.IncomingMessage,
  maxBytes: number,
  whenEmpty: Record<string, unknown> | null = null,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) return null;
    chunks.push(chunk as Buffer);
  }
  if (total === 0) return whenEmpty;
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createLiveKitVoice(config: LiveKitVoiceConfig, host: LiveKitHost): LiveKitVoice {
  const api = config.api ?? defaultApi(config);
  const agentName = config.agentName || DEFAULT_LIVEKIT_AGENT_NAME;
  const languages = config.languages?.length ? [...config.languages] : [...DEFAULT_VOICE_LANGUAGES];
  // What every turn tells the agent about the caller's language; the same for the engine's life.
  const languageNote = callLanguageNote(languages);
  const speech = {
    sttModel: config.speech?.sttModel || DEFAULT_VOICE_STT_MODEL,
    silenceMs: config.speech?.silenceMs || DEFAULT_VOICE_SILENCE_MS,
  };
  const mirrorApi = config.mirrorApi ?? defaultMirrorApi;
  const routeTimeoutMs = config.routeTimeoutMs ?? ROUTE_TIMEOUT_MS;
  const hangupGraceMs = config.hangupGraceMs ?? HANGUP_GRACE_MS;
  const endHookTimeoutMs = config.endHookTimeoutMs ?? END_HOOK_TIMEOUT_MS;
  const calls = new Map<string, LiveKitCall>();
  /** Calls the caller's page hung up, by call id, while their worker may still post a turn (HANGUP_GRACE_MS). */
  const hungUp = new Map<string, { call: LiveKitCall; timer: ReturnType<typeof setTimeout> }>();
  const cleanups = new Set<Promise<void>>();
  /** Per line, so transcripts land in the order they were spoken. */
  const mirrorChains = new Map<string, Promise<void>>();
  /** The last call-chat note logged per line, so a line logs when it changes, not every turn. */
  const chatNotes = new Map<string, string>();

  const findCall = (callId: unknown): LiveKitCall | undefined =>
    typeof callId === 'string' ? [...calls.values()].find((c) => c.callId === callId) : undefined;

  const endGrace = (callId: string): void => {
    clearTimeout(hungUp.get(callId)?.timer);
    hungUp.delete(callId);
  };

  /** A turn of `call` may still reach the agent: it is the line's live call, or its page hung up and the grace runs, with no newer call on the line. */
  const takesTurns = (call: LiveKitCall): boolean =>
    call.ended ? hungUp.has(call.callId) && !calls.has(call.platformId) : calls.get(call.platformId) === call;

  const push = (call: LiveKitCall, event: LiveKitHostEvent): void => {
    if (call.stream && !call.stream.writableEnded) {
      call.stream.write(`${JSON.stringify(event)}\n`);
      return;
    }
    call.queue.push(event);
    if (call.queue.length > MAX_QUEUED_EVENTS) call.queue.shift();
  };

  /** What chat resolution needs of a call; a call start checks it before the call exists, with no call id. */
  type ChatProbe = Pick<LiveKitCall, 'line' | 'platformId'> & { callId?: string };

  const noteChat = (call: ChatProbe, note: string, fields: Record<string, unknown> = {}): void => {
    const value = `${note}|${JSON.stringify(fields)}`;
    if (chatNotes.get(call.platformId) === value) return;
    chatNotes.set(call.platformId, value);
    log.info(`livekit-voice-mode: ${note}`, {
      platformId: call.platformId,
      ...(call.callId && { callId: call.callId }),
      ...fields,
    });
  };

  /**
   * The line's `/voice` chat while it is still wired to the agent, else none. The line's one owner is
   * its caller, whose role every access check of the line holds already.
   */
  const resolveChat = async (call: ChatProbe): Promise<CallChat | null> => {
    const bound = await mirrorApi.boundChat(call.platformId);
    if (!bound) {
      noteChat(call, 'call has no chat to talk in: the line has no /voice chat');
      return null;
    }
    const g = bound.group;
    const groups = await mirrorApi.groupsFor(call.line.agentGroupId);
    if (g.denied_at || g.detached_at || !groups.some((w) => w.id === g.id)) {
      noteChat(call, 'call has no chat to talk in: the /voice chat is no longer wired to the agent', { chat: g.id });
      return null;
    }
    return { group: g, threadId: bound.threadId };
  };

  const sameChat = (a: CallChat | null, b: CallChat | null): boolean =>
    a?.group.id === b?.group.id && a?.threadId === b?.threadId;

  const roomMetadata = (chat: CallChat | null, end?: CallEndReason): string =>
    JSON.stringify({ chat: chat ? chatLabel(chat.group) : null, ...(end && { end }) } satisfies CallRoomMetadata);

  const showChat = (call: LiveKitCall, chat: CallChat | null): void => {
    if (call.ended) return;
    call.metadataWrite = api.updateRoomMetadata(call.roomName, roomMetadata(chat)).then(
      () => undefined,
      (err: unknown) =>
        log.warn('livekit-voice-mode: could not show the new call chat on the page', { callId: call.callId, err }),
    );
  };

  /** resolveChat, with a failed lookup taken as no chat. */
  const probeChat = async (call: ChatProbe): Promise<CallChat | null> => {
    try {
      return await resolveChat(call);
    } catch (err) {
      log.warn('livekit-voice-mode: could not resolve the call chat', { platformId: call.platformId, err });
      return null;
    }
  };

  /**
   * Re-resolve where the call talks; `turn` marks a caller turn, where a chat
   * left behind by a mid-call `/voice` ages out once it went quiet.
   */
  const refreshChat = async (call: LiveKitCall, turn: boolean): Promise<CallChat | null> => {
    const refresh = ++call.chatRefreshes;
    const chat = await probeChat(call);
    // A slower, older refresh (the join's, say) must not undo a newer one.
    if (refresh !== call.chatRefreshes) return chat;
    if (turn && call.previousChat) {
      if (call.previousChat.active) call.previousChat.active = false;
      else call.previousChat = null;
    }
    if (!sameChat(call.chat, chat)) {
      // The worker's own lines say "check the chat" only when there is one.
      if (!call.chat !== !chat && !call.ended) push(call, { type: 'chat', chat: !!chat });
      call.previousChat = call.chat ? { chat: call.chat, active: false } : null;
      call.chat = chat;
      // The token reply named the first chat; a later move (a mid-call `/voice`) reaches the page here.
      if (refresh > 1) showChat(call, chat);
    }
    if (chat) noteChat(call, 'call talks in the agent chat', { chat: chat.group.id, threadId: chat.threadId });
    return chat;
  };

  /** The chat the call talks in, or the one it just left, that `to` addresses; marks the left one as still in use. */
  const callChatAt = (call: LiveKitCall, to: ChatAddress): boolean => {
    if (call.chat && isCallChat(call.chat, to)) return true;
    if (call.previousChat && isCallChat(call.previousChat.chat, to)) {
      call.previousChat.active = true;
      return true;
    }
    return false;
  };

  /**
   * The chat a live call speaks an agent message that reached `to` from: the one it talks in, the one
   * it just left, or none. Pure: chatMessage marks a left chat as still in use, speaksChat does not.
   */
  const speechChat = (
    call: LiveKitCall,
    to: ChatAddress,
    agentGroupId: string,
    replyTo: { callId: string; utteranceId: string } | null,
  ): 'current' | 'previous' | null => {
    if (call.state !== 'live' || call.ended || call.line.agentGroupId !== agentGroupId) return null;
    // An answer to a turn of another call (the one this call replaced) is never spoken into this one.
    if (replyTo && replyTo.callId !== call.callId) return null;
    if (call.chat && isCallChat(call.chat, to)) return 'current';
    if (call.previousChat && isCallChat(call.previousChat.chat, to)) return 'previous';
    return null;
  };

  const postToChat = async (chat: CallChat, text: string): Promise<void> => {
    const adapter = mirrorApi.adapter(chat.group.instance ?? chat.group.channel_type);
    if (!adapter) {
      log.warn('livekit-voice-mode: the call chat adapter is offline', { chat: chat.group.id });
      return;
    }
    await adapter.deliver(chat.group.platform_id, chat.threadId, { kind: 'chat', content: { text } });
  };

  /** Best effort and off the caller's path; ordered per line. */
  const mirror = (platformId: string, chat: CallChat, text: string): void => {
    const next = (mirrorChains.get(platformId) ?? Promise.resolve())
      .then(() => postToChat(chat, text))
      .catch((err: unknown) =>
        log.warn('livekit-voice-mode: transcript post failed', { platformId, chat: chat.group.id, err }),
      );
    mirrorChains.set(platformId, next);
    void next.then(() => {
      if (mirrorChains.get(platformId) === next) mirrorChains.delete(platformId);
    });
  };

  /** The room going away is what ends the call for caller and worker; retried, a missing room counts as gone. */
  const deleteRoom = async (call: LiveKitCall): Promise<void> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await api.deleteRoom(call.roomName);
        return;
      } catch (err) {
        if (isNotFound(err)) return;
        log.warn('livekit-voice-mode: room delete failed', { callId: call.callId, attempt, err });
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)).unref());
      }
    }
    log.error('livekit-voice-mode: room was not deleted; the worker stops on its own when the host link closes', {
      callId: call.callId,
      room: call.roomName,
    });
  };

  /** Teardown awaits every delete in flight, wherever it started. The delete waits for `once` first. */
  const trackedDeleteRoom = (call: LiveKitCall, once: Promise<void> = Promise.resolve()): Promise<void> => {
    const cleanup = once.then(() => deleteRoom(call)).finally(() => cleanups.delete(cleanup));
    cleanups.add(cleanup);
    return cleanup;
  };

  /** Room metadata the page reads when it is disconnected, so it can say why; best effort and bounded. */
  const announceEnd = async (call: LiveKitCall, code: CallEndReason): Promise<void> => {
    try {
      // The whole metadata is replaced, so the chat label the page shows goes along.
      const written = (call.metadataWrite ?? Promise.resolve())
        .then(() => api.updateRoomMetadata(call.roomName, roomMetadata(call.chat, code)))
        .then(() => true);
      if (!(await settleWithin(written, END_NOTICE_TIMEOUT_MS, false))) throw new Error('timed out');
    } catch (err) {
      if (!isNotFound(err))
        log.info('livekit-voice-mode: could not set the end reason on the room', { callId: call.callId, err });
    }
  };

  /** `end`: why, as the page names it; left out for ends no page is there to hear about. */
  const endCall = (call: LiveKitCall, reason: string, end?: CallEndReason): void => {
    if (call.ended) return;
    call.ended = true;
    call.jev?.end(reason);
    clearTimeout(call.joinTimer);
    clearTimeout(call.streamTimer);
    clearTimeout(call.expires);
    clearInterval(call.accessTimer);
    clearInterval(call.pingTimer);
    if (call.startedAt !== undefined) host.chargeUsage({ platformId: call.platformId, startedAt: call.startedAt });
    if (calls.get(call.platformId) === call) calls.delete(call.platformId);
    const stream = call.stream;
    call.stream = undefined;
    // The room gets the reason before the worker hears of the end: the worker leaves the room as
    // soon as it does, and the page would see it go before it could read why.
    call.announced = (end ? announceEnd(call, end) : Promise.resolve()).then(() => {
      if (stream && !stream.writableEnded) {
        stream.write(`${JSON.stringify({ type: 'end', reason } satisfies LiveKitHostEvent)}\n`);
        stream.end();
      }
    });
    call.cleanup = trackedDeleteRoom(call, call.announced);
    if (call.kind.ended) endedHook(call, call.kind.ended, reason);
    log.info('livekit-voice-mode: call ended', { platformId: call.platformId, callId: call.callId, reason });
  };

  /** The kind hears of the end; teardown awaits what it still does (a bot leaving) for END_HOOK_TIMEOUT_MS. */
  const endedHook = (call: LiveKitCall, ended: NonNullable<CallKind['ended']>, reason: string): void => {
    const chat = call.chat;
    const say = chat && call.state === 'live' ? (text: string) => mirror(call.platformId, chat, text) : null;
    const hook = Promise.resolve()
      .then(() => ended(call, reason, say))
      .catch((err: unknown) =>
        log.warn('livekit-voice-mode: the call kind failed at the end', { callId: call.callId, err }),
      );
    const done: Promise<void> = settleWithin(hook, endHookTimeoutMs, 'timeout' as const)
      .then((settled) => {
        if (settled === 'timeout')
          log.warn('livekit-voice-mode: the call kind is still ending; going on without it', { callId: call.callId });
      })
      .finally(() => cleanups.delete(done));
    cleanups.add(done);
  };

  const checkAccess = async (call: LiveKitCall): Promise<boolean> => {
    if (!takesTurns(call)) return false;
    try {
      const current = await host.resolveLine(call.platformId);
      if (current && sameCallerAndAgent(call.line, current) && takesTurns(call)) return true;
    } catch (err) {
      log.warn('livekit-voice-mode: call access check failed', { platformId: call.platformId, err });
    }
    endCall(call, 'caller access revoked or line changed', 'revoked');
    endGrace(call.callId);
    return false;
  };

  /** Admit the call, open its room and dispatch the worker to it. */
  const openCall = async (platformId: string, kind: CallKind): Promise<OpenCallResult> => {
    if (!host.isRunning()) return { ok: false, error: 'stopped' };
    const line = await host.resolveLine(platformId, { forCall: true });
    if (!line) return { ok: false, error: 'no-line' };
    // Before anything is spent or ended: a line with no chat to talk in is refused outright.
    if (!kind.bindChat && !(await probeChat({ line, platformId }))) {
      log.info('livekit-voice-mode: call refused: the line has no chat to talk in', { platformId });
      return { ok: false, error: 'no-chat' };
    }
    const t = host.now();
    const refusal = host.admitStart(platformId, t);
    if (refusal) return { ok: false, error: 'limit', ...refusal };
    if (kind.bindChat && !(await kind.bindChat())) return { ok: false, error: 'no-line' };
    // admitStart refused a day with no minutes left. The running call's time is already in the
    // day's total, so ending it below does not change what is left.
    const remainingMs = host.remainingTodayMs(platformId, t);
    const capMs = Math.min(kind.maxDurationMs, remainingMs);
    // Newest wins on the line.
    const previous = calls.get(platformId);
    if (previous) endCall(previous, 'replaced by a new call', 'newer_call');
    const callId = randomUUID();
    const roomName = `${kind.roomPrefix}-${platformId.replace(/^voice(?:-mode)?:/, '')}-${randomBytes(6).toString('hex')}`;
    const job = kind.job({ callId, roomName });
    const call: LiveKitCall = {
      callId,
      platformId,
      line,
      kind,
      roomName,
      secret: liveKitCallSecret(config.apiSecret, callId),
      callerIdentity: job.callerIdentity,
      note: kind.turnNote(languageNote),
      state: 'connecting',
      ended: false,
      queue: [],
      utteranceStarts: [],
      utterances: 0,
      turnOutcomes: new Map(),
      turnsInFlight: 0,
      chat: null,
      chatRefreshes: 0,
      previousChat: null,
    };
    if (job.jev) call.jev = openJev(call, job.meeting ? 'meet' : 'voice');
    calls.set(platformId, call);
    call.joinTimer = setTimeout(() => endCall(call, 'caller never joined'), kind.joinTimeoutMs);
    call.joinTimer.unref();
    call.accessTimer = setInterval(() => void checkAccess(call), host.accessCheckIntervalMs);
    call.accessTimer.unref();
    const metadata: LiveKitJobMetadata = {
      v: LIVEKIT_PROTOCOL_VERSION,
      callId,
      lineId: platformId,
      agentName: line.agent.name,
      callerName: line.caller.name,
      ...job,
      vocabulary: [...(line.agent.vocabulary ?? [])],
      languages,
      ...(line.agent.wakeNames?.length ? { wakeNames: [...line.agent.wakeNames] } : {}),
      ...speech,
      tts: line.tts ?? TTS_DEFAULT_CHOICE,
      maxDurationMs: capMs,
      joinTimeoutMs: kind.joinTimeoutMs,
    };
    try {
      await api.createRoom({ name: roomName, ...kind.room });
      await api.createDispatch(roomName, agentName, { metadata: JSON.stringify(metadata) });
    } catch (err) {
      log.warn('livekit-voice-mode: room setup failed', { platformId, callId, err });
      // Ended meanwhile: its cleanup may have run before the room existed.
      if (call.ended) await trackedDeleteRoom(call);
      else endCall(call, 'room setup failed');
      return { ok: false, error: 'room' };
    }
    // The chat the call talks in, for the kind to show; resolved again when the caller joins.
    const chat = await refreshChat(call, false);
    if (!chat && !call.ended) {
      endCall(call, 'no chat to talk in');
      return { ok: false, error: 'no-chat' };
    }
    if (call.ended || !host.isRunning() || !chat) {
      // Replaced or torn down while connecting: that cleanup ran before the room and dispatch
      // existed, so delete them here or they wait for the caller until LiveKit's empty timeout.
      if (call.ended) await trackedDeleteRoom(call);
      else endCall(call, 'replaced while connecting');
      return { ok: false, error: 'stopped' };
    }
    return {
      ok: true,
      call,
      chat,
      job: metadata,
      // From the join; onJoined recomputes it, never later than this.
      limit: { ms: capMs, kind: remainingMs < kind.maxDurationMs ? 'daily' : 'duration' },
    };
  };

  /** Where a turn goes: the call chat. */
  const turnRoute = (call: LiveKitCall, chat: CallChat): Omit<VoiceModeTurnEvent, 'message'> => ({
    channelType: chat.group.channel_type,
    instance: chat.group.instance ?? chat.group.channel_type,
    platformId: chat.group.platform_id,
    threadId: chat.threadId,
    // Addressed to the line's agent only, whoever else is wired to the chat and whatever its trigger.
    agentGroupId: call.line.agentGroupId,
  });

  /** The worker saw the caller join: start the clock and the duration / budget cap. */
  const onJoined = (res: http.ServerResponse, call: LiveKitCall): void => {
    if (call.state === 'live') return reply(res, 200, JSON.stringify({ ok: true }), JSON_HEADERS);
    const t = host.now();
    const remainingMs = host.remainingTodayMs(call.platformId, t);
    if (remainingMs <= 0) {
      endCall(call, 'daily minute budget', 'limit_daily');
      return reply(res, 409, 'This voice line has used its call minutes for today');
    }
    call.state = 'live';
    call.startedAt = t;
    clearTimeout(call.joinTimer);
    const budgetCaps = remainingMs < call.kind.maxDurationMs;
    call.expires = setTimeout(
      () =>
        budgetCaps
          ? endCall(call, 'daily minute budget', 'limit_daily')
          : endCall(call, 'duration limit', 'limit_duration'),
      Math.max(1, budgetCaps ? remainingMs : call.kind.maxDurationMs),
    );
    call.expires.unref();
    if (!call.stream) {
      call.streamTimer = setTimeout(() => {
        if (!call.stream) endCall(call, 'worker never opened its event stream', 'worker_gone');
      }, config.workerStreamTimeoutMs ?? WORKER_STREAM_TIMEOUT_MS);
      call.streamTimer.unref();
    }
    log.info('livekit-voice-mode: caller joined', { platformId: call.platformId, callId: call.callId });
    // Known before the first turn, so the agent's messages to that chat are spoken from the start.
    void refreshChat(call, false).then((chat) => {
      if (chat && !call.ended) {
        call.kind.joined?.(call, (text) => mirror(call.platformId, chat, text));
        host.callJoined?.(call.callId, turnRoute(call, chat), call.line.agentGroupId, () => !call.ended);
      }
    });
    reply(res, 200, JSON.stringify({ ok: true }), JSON_HEADERS);
  };

  const onEvents = (res: http.ServerResponse, call: LiveKitCall): void => {
    const previous = call.stream;
    if (previous && !previous.writableEnded) previous.end();
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    res.flushHeaders();
    call.stream = res;
    clearTimeout(call.streamTimer);
    for (const event of call.queue.splice(0)) res.write(`${JSON.stringify(event)}\n`);
    clearInterval(call.pingTimer);
    call.pingTimer = setInterval(() => push(call, { type: 'ping' }), PING_INTERVAL_MS);
    call.pingTimer.unref();
    res.on('close', () => {
      // Replies can no longer reach the caller, so the call is over.
      if (call.stream === res && !call.ended) endCall(call, 'worker link closed', 'worker_gone');
    });
  };

  /**
   * One transcribed caller turn: the agent gets it as a spoken message in the call chat, which also
   * shows it. Answered 202 only once the agent's session stored it; a worker that retries a turn
   * under the same `turnKey` gets the first answer instead of a second copy for the agent.
   */
  const onUtterance = async (
    res: http.ServerResponse,
    call: LiveKitCall,
    body: Record<string, unknown>,
  ): Promise<void> => {
    if (call.state !== 'live') return reply(res, 409, 'The caller is not in the call');
    if (call.jev) return reply(res, 409, 'A jev call takes its turns from agent/jev');
    const utterance: { [K in keyof CallUtterance]?: unknown } = body;
    const text = typeof utterance.text === 'string' ? utterance.text.trim() : '';
    if (!text) return reply(res, 400, 'text is required');
    if (Buffer.byteLength(text) > MAX_UTTERANCE_TEXT_BYTES) {
      return reply(res, 413, `utterance is too large (${MAX_UTTERANCE_TEXT_BYTES / 1024} KB max)`);
    }
    const turnKey =
      typeof utterance.turnKey === 'string' && utterance.turnKey.length <= MAX_TURN_KEY_LENGTH
        ? utterance.turnKey
        : undefined;
    const known = turnKey && call.turnOutcomes.get(turnKey);
    if (known) return answer(res, await known);
    const admitted = admitTurn(call);
    if (!admitted.ok) {
      return reply(res, 429, admitted.body, admitted.retryAfter ? { 'Retry-After': admitted.retryAfter } : {});
    }
    const outcome = takeTurn(call, text, admitted.t, turnKey);
    if (turnKey) {
      call.turnOutcomes.set(turnKey, outcome);
      for (const key of call.turnOutcomes.keys()) {
        if (call.turnOutcomes.size <= MAX_REMEMBERED_TURNS) break;
        call.turnOutcomes.delete(key);
      }
    }
    answer(res, await outcome);
  };

  /**
   * A turn's place under the call's limits: taken (it counts toward both until routing ends), with its
   * start on the config clock, or why not.
   */
  const admitTurn = (call: LiveKitCall): { ok: true; t: number } | { ok: false; body: string; retryAfter?: string } => {
    if (call.turnsInFlight >= MAX_TURNS_IN_FLIGHT) {
      return { ok: false, body: 'Too many turns are still being routed' };
    }
    const t = host.now();
    call.utteranceStarts = call.utteranceStarts.filter((at) => at > t - MINUTE_MS);
    if (call.utteranceStarts.length >= MAX_UTTERANCES_PER_MINUTE) {
      return {
        ok: false,
        body: 'Too many utterances this minute',
        retryAfter: String(Math.max(1, Math.ceil((call.utteranceStarts[0] + MINUTE_MS - t) / 1000))),
      };
    }
    call.utteranceStarts.push(t);
    call.turnsInFlight++;
    return { ok: true, t };
  };

  const answer = (res: http.ServerResponse, outcome: TurnOutcome): void =>
    reply(res, outcome.status, outcome.body, outcome.status === 202 ? JSON_HEADERS : {});

  /** Why a turn of `call` cannot go to the agent now (its caller lost access, the channel stops), or null. */
  const turnRefusal = async (call: LiveKitCall): Promise<TurnOutcome | null> => {
    if (!(await checkAccess(call))) return { status: 403, body: 'Caller access denied' };
    if (!host.isRunning()) return { status: 503, body: 'The voice channel is shutting down' };
    return null;
  };

  /**
   * The turn keeps its in-flight slot until routing ends, which can be after the 504: the router may
   * still store the turn then, and the worker hears `turn-stored` for its `turnKey`. The route timeout
   * counts from `receivedAt`, so the lookups before routing cannot push the answer past the worker's
   * own request timeout. `jev`: a jev call's turn, its note added to the kind's; one superseded
   * (`signal`) before routing is not routed. Nobody waits on a jev turn's HTTP answer, so it has no
   * route timeout: it waits for routing to finish, or for `signal`, and its outcome is then real.
   */
  const takeTurn = async (
    call: LiveKitCall,
    text: string,
    receivedAt: number,
    turnKey: string | undefined,
    jev?: { note: string; signal: AbortSignal },
  ): Promise<TurnOutcome> => {
    const release = () => void call.turnsInFlight--;
    let routed: Promise<boolean> | undefined;
    try {
      const refused = await turnRefusal(call);
      if (refused) return refused;
      const chat = await refreshChat(call, true);
      // The call can end or be replaced while the chat lookups run; its turn must not reach the agent then.
      if (!takesTurns(call)) return { status: 409, body: 'The call has ended' };
      if (!chat) {
        endCall(call, 'no chat to talk in');
        return { status: 409, body: 'The call has no chat to talk in' };
      }
      if (jev?.signal.aborted) return { status: 409, body: 'The turn was superseded' };
      const utteranceId = String(++call.utterances);
      const sender = call.kind.sender(call.line);
      const message: InboundEvent['message'] = {
        id: liveKitUtteranceMessageId(call.callId, utteranceId),
        kind: 'chat',
        content: JSON.stringify({
          text: turnMessageText(text, jev ? `${call.note}\n${jev.note}` : call.note),
          sender: sender.name,
          ...(sender.id ? { senderId: sender.id } : {}),
          livekit: { callId: call.callId, utteranceId },
        }),
        timestamp: new Date().toISOString(),
        isMention: true,
        isGroup: chat.group.is_group !== 0,
      };
      routed = host.routeTurn({ ...turnRoute(call, chat), message }, { callerId: sender.id, chat: chat.group });
      // Shown once the agent has it, even when that comes after the worker was told it timed out.
      void routed.then(
        (stored) => {
          // The chat shows the words alone; the turn itself still comes from the caller by name.
          if (stored) mirror(call.platformId, chat, `\u{1F399} ${text}`);
        },
        () => undefined,
      );
      const fields = { callId: call.callId, utteranceId };
      try {
        const budgetMs = Math.max(0, routeTimeoutMs - (host.now() - receivedAt));
        const stored = jev
          ? await untilAborted(routed, jev.signal)
          : await settleWithin(routed, budgetMs, 'timeout' as const);
        if (stored === 'aborted') return { status: 409, body: 'The turn was superseded' };
        if (stored === 'timeout') {
          log.warn('livekit-voice-mode: a turn did not reach the agent in time', fields);
          void routed.then(
            (late) => {
              if (!late) return;
              log.info('livekit-voice-mode: a timed-out turn reached the agent', fields);
              if (!turnKey) return;
              const accepted = { status: 202, body: JSON.stringify({ id: utteranceId }) };
              if (call.turnOutcomes.has(turnKey)) call.turnOutcomes.set(turnKey, Promise.resolve(accepted));
              if (!call.ended) push(call, { type: 'turn-stored', turnKey, id: utteranceId });
            },
            (err: unknown) => log.warn('livekit-voice-mode: a timed-out turn failed to route', { ...fields, err }),
          );
          return { status: 504, body: 'The turn did not reach the agent in time' };
        }
        if (!stored) {
          log.warn('livekit-voice-mode: the router did not hand a turn to the agent', fields);
          return { status: 422, body: 'The agent did not take the turn' };
        }
        return { status: 202, body: JSON.stringify({ id: utteranceId }), id: utteranceId };
      } catch {
        return { status: 500, body: 'Routing the turn failed' };
      }
    } finally {
      if (routed) void routed.then(release, release);
      else release();
    }
  };

  /** A jev call's turn, under the same admission, access and limit checks as a worker's turn. */
  const submitTurn = async (
    call: LiveKitCall,
    message: string,
    note: string,
    signal: AbortSignal,
  ): Promise<JevTurnResult> => {
    if (call.state !== 'live' || !takesTurns(call)) return { ok: false, reason: 'the call has ended' };
    const admitted = admitTurn(call);
    if (!admitted.ok) return { ok: false, reason: admitted.body };
    const outcome = await takeTurn(call, message, admitted.t, undefined, { note, signal });
    return outcome.id ? { ok: true, turnId: outcome.id } : { ok: false, reason: `${outcome.status}: ${outcome.body}` };
  };

  const openJev = (call: LiveKitCall, kind: 'voice' | 'meet'): JevCall =>
    createJevCall(
      {
        callId: call.callId,
        kind,
        callerName: call.line.caller.name,
        agentName: config.wakeName ?? call.line.agent.name,
        agentAliases: [call.line.agent.name, ...(call.line.agent.wakeNames ?? [])].filter(
          (name) => name !== (config.wakeName ?? call.line.agent.name),
        ),
        maxTextBytes: MAX_UTTERANCE_TEXT_BYTES,
        submitTurn: (message, note, signal) => submitTurn(call, message, note, signal),
        push: (event) => {
          if (!call.ended) push(call, event);
        },
        now: () => host.now(),
      },
      config.jev,
    );

  /** `agent/jev`: a jev call's worker events, in order, into its loop. */
  const onJev = (res: http.ServerResponse, call: LiveKitCall, body: Record<string, unknown>): void => {
    if (!call.jev) return reply(res, 409, 'Not a jev call');
    if (call.state !== 'live') return reply(res, 409, 'The caller is not in the call');
    const events = body.events;
    if (!Array.isArray(events) || events.length > MAX_JEV_EVENTS_PER_POST) {
      return reply(res, 400, `events must be an array of at most ${MAX_JEV_EVENTS_PER_POST}`);
    }
    reply(res, 200, JSON.stringify(call.jev.workerEvents(events)), JSON_HEADERS);
  };

  /** /webhook/voice-mode/livekit/agent/*: the worker's side, authenticated by the per-call secret. */
  const handleAgent = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: string,
    url: URL,
  ): Promise<void> => {
    const auth = req.headers.authorization ?? '';
    const secret = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (route === 'livekit/agent/events') {
      if (req.method !== 'GET') return reply(res, 405, 'GET only');
      const call = findCall(url.searchParams.get('call'));
      if (!call || call.ended || !secret || !sameSecret(secret, call.secret)) return reply(res, 404, 'No such call');
      return onEvents(res, call);
    }
    if (req.method !== 'POST') return reply(res, 405, 'POST only');
    // No secret, no body read: nothing unauthenticated is buffered.
    if (!secret) return reply(res, 409, 'No such call');
    const body = await readJsonObject(
      req,
      route === 'livekit/agent/jev' ? MAX_JEV_BODY_BYTES : MAX_AGENT_BODY_BYTES,
      {},
    );
    if (!body) return reply(res, 400, 'Body must be a small JSON object');
    const call = findCall(body.callId);
    const late = !call && typeof body.callId === 'string' ? hungUp.get(body.callId)?.call : undefined;
    if (late && secret && sameSecret(secret, late.secret)) {
      // The page hung up: the worker's turns still land within the grace; its `ended` closes it.
      if (route === 'livekit/agent/utterance') return onUtterance(res, late, body);
      if (route === 'livekit/agent/ended') {
        endGrace(late.callId);
        return reply(res, 204, '');
      }
    }
    // Unknown, ended and unauthenticated look alike to the caller of these routes.
    if (!call || call.ended || !secret || !sameSecret(secret, call.secret)) return reply(res, 409, 'No such call');
    if (route === 'livekit/agent/joined') return onJoined(res, call);
    if (route === 'livekit/agent/utterance') return onUtterance(res, call, body);
    if (route === 'livekit/agent/jev') return onJev(res, call, body);
    if (route === 'livekit/agent/ended') {
      endCall(
        call,
        typeof body.reason === 'string' ? `worker: ${body.reason.slice(0, 80)}` : 'worker ended',
        body.restart === true ? 'worker_restart' : 'worker_gone',
      );
      // The worker deletes the room once answered; the page reads the reason off it first.
      await call.announced;
      return reply(res, 204, '');
    }
    reply(res, 404, 'Not found');
  };

  const engine: LiveKitVoice = {
    handleAgentHttp: handleAgent,
    openCall,

    async endCall(platformId, callId, reason, { grace = false } = {}) {
      const call = calls.get(platformId);
      if (!call || call.callId !== callId) return;
      endCall(call, reason);
      if (grace) {
        const timer = setTimeout(() => hungUp.delete(call.callId), hangupGraceMs);
        timer.unref();
        hungUp.set(call.callId, { call, timer });
      }
      await call.cleanup;
    },

    isLive(platformId, callId) {
      const call = calls.get(platformId);
      return call?.callId === callId && !call.ended;
    },

    jevCall(callId) {
      const call = findCall(callId);
      return call && !call.ended ? call.jev : undefined;
    },

    chatMessage(chat, agentGroupId, text, replyTo) {
      for (const call of calls.values()) {
        const at = speechChat(call, chat, agentGroupId, replyTo ?? null);
        if (!at) continue;
        if (at === 'previous' && call.previousChat) call.previousChat.active = true;
        // The loop decides whether it is spoken; its own lines enter its window from playback reports.
        if (call.jev) {
          call.jev.reply(text, replyTo ? replyTo.utteranceId : null);
          continue;
        }
        push(call, { type: 'reply', text, turn: replyTo ? replyTo.utteranceId : null });
      }
    },

    speaksChat(chat, agentGroupId, replyTo) {
      // A jev call has not decided yet whether it speaks the message.
      return [...calls.values()].some((call) => !call.jev && speechChat(call, chat, agentGroupId, replyTo) !== null);
    },

    chatTyping(chat, agentGroupId, working = false) {
      for (const call of calls.values()) {
        if (call.state !== 'live' || call.ended || call.line.agentGroupId !== agentGroupId) continue;
        if (!callChatAt(call, chat) || call.jev) continue;
        push(call, { type: 'thinking' });
        if (working) push(call, { type: 'working' });
      }
    },

    activeCall(platformId) {
      const call = calls.get(platformId);
      return call && call.startedAt !== undefined && !call.ended
        ? { platformId, startedAt: call.startedAt }
        : undefined;
    },

    async teardown() {
      engines.delete(engine);
      for (const call of [...calls.values()]) endCall(call, 'teardown', 'shutdown');
      for (const callId of [...hungUp.keys()]) endGrace(callId);
      await Promise.all([...cleanups, ...mirrorChains.values()]);
    },
  };
  engines.add(engine);
  return engine;
}

/** `promise`'s outcome, or 'aborted' as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | 'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted');
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
