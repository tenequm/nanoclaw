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
 * worker to it with the job metadata, mints the caller's token, charges the
 * daily minutes, rechecks access every few seconds and ends the call by
 * deleting the room, which disconnects caller and worker alike.
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
 *  - `POST agent/ended`      the worker's session is over.
 *
 * A call talks in one of the agent's chats (its *call chat*): the chat `/voice`
 * last bound the line to, while it is still wired to the agent and the line's
 * caller still administers it; else the one chat of the VOICE_MODE_MIRROR channel
 * type wired to the agent (pickMirrorTarget). With neither the call is refused.
 * Each turn is written into the line's agent's session for that chat
 * (voice-mode-route.ts) as a message from the line's caller, for that agent
 * only; the transcript is posted into the chat, and the agent answers there as
 * it always does. While the call is live, every message the agent delivers to
 * that chat is also spoken, and its working there is the worker's `thinking`.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';

import { AccessToken, AgentDispatchClient, RoomServiceClient, TrackSource } from 'livekit-server-sdk';

import type { ChannelAdapter, InboundEvent } from './adapter.js';
import { getChannelAdapterExact } from './channel-registry.js';
import { callPageHtml } from './voice-mode-page.js';
import { sameCallerAndAgent, type ResolveLineOptions, type VoiceLine } from './voice-mode-line.js';
import { stopThinking } from './voice-mode-route.js';
import {
  baseLanguage,
  DEFAULT_LIVEKIT_AGENT_NAME,
  DEFAULT_VOICE_LANGUAGES,
  DEFAULT_VOICE_SILENCE_MS,
  DEFAULT_VOICE_STT_FALLBACK_MODEL,
  DEFAULT_VOICE_STT_MODEL,
  DEFAULT_VOICE_TTS_FALLBACK_MODEL,
  DEFAULT_VOICE_TTS_MODEL,
  DEFAULT_VOICE_TTS_VOICE,
  LIVEKIT_PROTOCOL_VERSION,
  liveKitCallSecret,
  PING_INTERVAL_MS,
  WORKER_REQUEST_TIMEOUT_MS,
  type LiveKitHostEvent,
  type LiveKitJobMetadata,
  type CallEndReason,
  type CallRoomMetadata,
} from './voice-mode-protocol.js';
import { getMessagingGroup, getMessagingGroupsByAgentGroup } from '../db/messaging-groups.js';
import { getVoiceModeLine } from '../db/voice-mode-lines.js';
import { registerPostDeliveryHook } from '../delivery.js';
import { log } from '../log.js';
import type { MessagingGroup } from '../types.js';

const MINUTE_MS = 60_000;
const MAX_QUEUED_EVENTS = 50;
const MAX_AGENT_BODY_BYTES = 16 * 1024;
const CALLER_TOKEN_TTL_SECONDS = 120;
/** The worker opens its event stream right after it reports the caller in; without it nothing reaches the caller. */
const WORKER_STREAM_TIMEOUT_MS = 30_000;
/** A turn is at most 90 s of speech; Ukrainian runs about 4 KB of UTF-8 for that. */
const MAX_UTTERANCE_BYTES = 8 * 1024;
const MAX_UTTERANCES_PER_MINUTE = 20;
/** The router has this long to store a turn in the agent's session, so the worker hears the 504 before it gives up. */
const ROUTE_TIMEOUT_MS = WORKER_REQUEST_TIMEOUT_MS - 2_000;
/** Turns routing at once on a call. The worker sends one at a time, so more is a worker gone wrong. */
const MAX_TURNS_IN_FLIGHT = 3;
/** Outcomes a call keeps by the worker's turn key, so a retried turn is answered, not routed again. */
const MAX_REMEMBERED_TURNS = 32;
const MAX_TURN_KEY_LENGTH = 64;
/** How long the room's end reason may hold up the hangup; past it the page shows a plain "ended". */
const END_NOTICE_TIMEOUT_MS = 2_000;

/** How the agent learns a message was spoken on a call: while it lasts, every message it sends to the chat is spoken. */
export const CALL_REPLY_NOTE =
  'Spoken on a live voice call; while it lasts, every message you send to this chat is read aloud word for ' +
  'word. Answer in a few short spoken sentences: no markdown, no links, no code blocks, numbers written as ' +
  'words. Offer longer material for after the call instead of sending it now.';

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });

/**
 * The note a caller's turn carries about their language, from VOICE_MODE_LANGUAGES: empty for English
 * only, else the configured languages. Speech recognition often spells Ukrainian as Russian, so
 * with Ukrainian configured and Russian not, a Russian-looking transcript is misheard Ukrainian.
 */
function turnLanguageNote(languages: readonly string[]): string {
  const bases = [...new Set(languages.map(baseLanguage))];
  if (bases.every((base) => base === 'en')) return '';
  const names = bases.map((base) => languageNames.of(base) ?? base);
  return [
    names.length > 1
      ? `The caller speaks ${names.join(' or ')}; answer in the language of their transcript.`
      : `The caller speaks ${names[0]}; answer in ${names[0]}.`,
    bases.includes('uk') && !bases.includes('ru')
      ? 'A transcript that looks Russian is Ukrainian misspelled by speech recognition, so answer it in Ukrainian, never in Russian.'
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * The note a caller turn carries: how its reply is heard, plus what VOICE_MODE_LANGUAGES says about the
 * caller's language (nothing for English only). The transcription takes the language codes as a
 * hint only, so e.g. a Ukrainian turn can come out in Russian spelling.
 */
export function turnReplyNote(languages: readonly string[]): string {
  return [CALL_REPLY_NOTE, turnLanguageNote(languages)].filter(Boolean).join(' ');
}

/** The inbound text for one transcribed caller turn. */
export function turnMessageText(transcript: string, note: string = CALL_REPLY_NOTE): string {
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

/** The `/voice` binding of a line, as stored; checked against the line before use. */
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

/** The chat a call talks in. The caller there is always the line's own caller. */
export interface CallChat {
  group: MessagingGroup;
  threadId: string | null;
  /** Set by `/voice`, or picked by the VOICE_MODE_MIRROR rule. */
  source: 'voice-command' | 'default';
}

export interface SpeechSettings {
  sttModel?: string;
  /** Unset for the default; `off` (or empty) for no fallback. */
  sttFallbackModel?: string;
  ttsModel?: string;
  /** Unset for the default; `off` (or empty) for no fallback. */
  ttsFallbackModel?: string;
  ttsVoice?: string;
  silenceMs?: number;
  /** VOICE_MODE_LANGUAGES, parsed: the transcription's language hints and the agent's language note. */
  languages?: readonly string[];
}

export interface LiveKitVoiceConfig {
  /** Signaling URL the caller's browser connects to (LIVEKIT_URL). */
  url: string;
  /** Server-side URL for the host's API calls (LIVEKIT_WORKER_URL); defaults to `url`. */
  serverUrl?: string;
  apiKey: string;
  apiSecret: string;
  /** Dispatch name the worker registers under. */
  agentName?: string;
  /** Transcription and speech settings the worker gets in the job metadata (VOICE_MODE_*). */
  speech?: SpeechSettings;
  /** Channel type of the fallback call chat when the `/voice` chat is no longer wired; none when unset or `off`. voice-mode.ts passes VOICE_MODE_MIRROR, default DEFAULT_VOICE_MIRROR. */
  mirror?: string;
  /** Test seam; defaults to the central DB and the live channel adapters. */
  mirrorApi?: MirrorApi;
  /** How long the caller has to join the room after the token is minted. */
  joinTimeoutMs?: number;
  /** How long the worker has to open its event stream after reporting the caller in. */
  workerStreamTimeoutMs?: number;
  /** How long a turn may take to reach the agent's session before the worker hears it timed out. */
  routeTimeoutMs?: number;
  /** Test seam; defaults to the livekit-server-sdk clients. */
  api?: LiveKitServerApi;
}

/** What the voice adapter shares with this engine: limits, access, routing. */
export interface LiveKitHost {
  resolveLine(platformId: string, options?: ResolveLineOptions): Promise<VoiceLine | null>;
  admitStart(platformId: string, t: number): { body: string; retryAfter: string } | null;
  /** Daily call time left on the line. */
  remainingTodayMs(platformId: string, t: number): number;
  chargeUsage(call: { platformId: string; startedAt: number }): void;
  /**
   * Hand a turn to the line's agent in the call chat (voice-mode-route.ts). Resolves
   * true once the agent's session stored it (to answer, or as context), false when the router dropped it;
   * rejects when routing threw.
   */
  routeTurn(event: InboundEvent, agentGroupId: string, onThinking?: () => void): Promise<boolean>;
  isRunning(): boolean;
  now(): number;
  maxCallDurationMs: number;
  accessCheckIntervalMs: number;
}

interface LiveKitCall {
  callId: string;
  platformId: string;
  line: VoiceLine;
  roomName: string;
  secret: string;
  callerIdentity: string;
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
  sent: number;
  /** Where the call talks; null when it has no chat (turns are refused). Refreshed on join and every turn. */
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
}

/** The host's answer to one utterance POST. */
interface TurnOutcome {
  status: number;
  body: string;
}

export interface LiveKitVoice {
  /** The `livekit` routes: the browser's on the page server, the worker's (`livekit/agent/*`) on the webhook server. */
  handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: string,
    url: URL,
    /** The line a call-link token opens, as its platform id, or null. */
    lineForToken: (token: string) => Promise<string | null>,
  ): Promise<void>;
  /** An agent message reached a chat: speak it on the live call that talks there. `replyTo`: the call turn it answers. */
  chatMessage(
    chat: ChatAddress,
    agentGroupId: string,
    text: string,
    replyTo?: { callId: string; utteranceId: string } | null,
  ): void;
  /** The agent is working in a chat: tell its live call that talks there. */
  chatTyping(chat: ChatAddress, agentGroupId: string): void;
  /** The running call on a line, for the daily budget. */
  activeCall(platformId: string): { platformId: string; startedAt: number } | undefined;
  teardown(): Promise<void>;
}

/**
 * The one chat of `channelType` wired to the agent that a call is mirrored into: the only live one,
 * or the only direct chat among several. None when there is no such chat or the choice is ambiguous.
 */
export function pickMirrorTarget(
  groups: readonly MessagingGroup[],
  channelType: string,
): { target: MessagingGroup } | { skip: string } {
  const live = [
    ...new Map(
      groups.filter((g) => g.channel_type === channelType && !g.denied_at && !g.detached_at).map((g) => [g.id, g]),
    ).values(),
  ];
  if (live.length === 0) return { skip: `no ${channelType} chat is wired to the agent` };
  if (live.length === 1) return { target: live[0] };
  const direct = live.filter((g) => !g.is_group);
  if (direct.length === 1) return { target: direct[0] };
  return { skip: `${live.length} ${channelType} chats are wired to the agent and none is the one direct chat` };
}

const defaultMirrorApi: MirrorApi = {
  groupsFor: (agentGroupId) => getMessagingGroupsByAgentGroup(agentGroupId),
  adapter: (key) => getChannelAdapterExact(key),
  async boundChat(lineId) {
    const line = await getVoiceModeLine(lineId.replace(/^voice-mode:/, ''));
    const group = line?.messaging_group_id && (await getMessagingGroup(line.messaging_group_id));
    if (!line || !group) return null;
    return { group, threadId: line.thread_id };
  },
};

/** How the page names the chat a call talks in. */
const chatLabel = (group: MessagingGroup): string =>
  group.name || (group.is_group ? group.channel_type : `${group.channel_type} DM`);

/** A call talks in `chat`, and `to` is that chat: the same thread, or the chat itself when delivery drops the thread. */
const isCallChat = (chat: CallChat, to: ChatAddress): boolean =>
  chat.group.channel_type === to.channelType &&
  chat.group.platform_id === to.platformId &&
  (to.threadId === null || to.threadId === chat.threadId);

/** Every running engine, for the delivery and typing taps below. */
const engines = new Set<LiveKitVoice>();

/** The words of a delivered chat message, or null for edits, reactions, cards and host command replies. */
export function spokenText(message: { id: string; kind: string; content: string }): string | null {
  if (message.kind !== 'chat' && message.kind !== 'chat-sdk') return null;
  if (message.id.startsWith('hcmd-')) return null;
  try {
    const content = JSON.parse(message.content) as Record<string, unknown>;
    if (content.operation || content.type || typeof content.text !== 'string') return null;
    return content.text.trim() || null;
  } catch {
    return null;
  }
}

/** Delivery tap: an agent message reached a chat; a live call talking there speaks it. */
export function liveKitChatDelivered(
  msg: {
    id: string;
    kind: string;
    content: string;
    channelType: string | null;
    platformId: string | null;
    threadId: string | null;
    inReplyTo?: string | null;
  },
  agentGroupId: string,
): void {
  if (engines.size === 0 || !msg.channelType || !msg.platformId) return;
  const text = spokenText(msg);
  if (!text) return;
  // Delivery hands the id over agent-scoped (`<id>:<agent group>`, the router's inbound row id).
  const scope = `:${agentGroupId}`;
  const inReplyTo = msg.inReplyTo?.endsWith(scope) ? msg.inReplyTo.slice(0, -scope.length) : msg.inReplyTo;
  const replyTo = inReplyTo ? parseLiveKitUtteranceId(inReplyTo) : null;
  const chat = { channelType: msg.channelType, platformId: msg.platformId, threadId: msg.threadId ?? null };
  for (const engine of engines) engine.chatMessage(chat, agentGroupId, text, replyTo);
}

/** Typing tap: the agent works in a chat; its live call talking there hears it is thinking. */
export function liveKitChatTyping(chat: ChatAddress, agentGroupId: string): void {
  for (const engine of engines) engine.chatTyping(chat, agentGroupId);
}

registerPostDeliveryHook((msg, session) => {
  // The agent answered: a call stops showing it as thinking until its next turn.
  stopThinking(session.id);
  liveKitChatDelivered(msg, session.agent_group_id);
});

const NO_CHAT = 'This voice line has no chat to talk in. Run /voice in a chat with the agent.';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

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

export function createLiveKitVoice(config: LiveKitVoiceConfig, host: LiveKitHost): LiveKitVoice {
  const api = config.api ?? defaultApi(config);
  const agentName = config.agentName || DEFAULT_LIVEKIT_AGENT_NAME;
  // .env drops empty values, so `off` is how a fallback is turned off there.
  const fallbackModel = (raw: string | undefined, fallback: string): string => {
    const model = (raw ?? fallback).trim();
    return /^(off|none)$/i.test(model) ? '' : model;
  };
  const speech = {
    sttModel: config.speech?.sttModel || DEFAULT_VOICE_STT_MODEL,
    sttFallbackModel: fallbackModel(config.speech?.sttFallbackModel, DEFAULT_VOICE_STT_FALLBACK_MODEL),
    ttsModel: config.speech?.ttsModel || DEFAULT_VOICE_TTS_MODEL,
    ttsFallbackModel: fallbackModel(config.speech?.ttsFallbackModel, DEFAULT_VOICE_TTS_FALLBACK_MODEL),
    ttsVoice: config.speech?.ttsVoice || DEFAULT_VOICE_TTS_VOICE,
    silenceMs: config.speech?.silenceMs || DEFAULT_VOICE_SILENCE_MS,
    languages: config.speech?.languages?.length ? [...config.speech.languages] : [...DEFAULT_VOICE_LANGUAGES],
  };
  const replyNote = turnReplyNote(speech.languages);
  const mirrorChannel = config.mirror && config.mirror !== 'off' ? config.mirror : null;
  const mirrorApi = config.mirrorApi ?? defaultMirrorApi;
  const joinTimeoutMs = config.joinTimeoutMs ?? 60_000;
  const routeTimeoutMs = config.routeTimeoutMs ?? ROUTE_TIMEOUT_MS;
  const calls = new Map<string, LiveKitCall>();
  const cleanups = new Set<Promise<void>>();
  /** Per line, so transcripts land in the order they were spoken. */
  const mirrorChains = new Map<string, Promise<void>>();
  /** The last call-chat note logged per line and topic, so a line logs when it changes, not every turn. */
  const chatNotes = new Map<string, string>();
  let page: string | undefined;

  const reply = (res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };

  const findCall = (callId: unknown): LiveKitCall | undefined =>
    typeof callId === 'string' ? [...calls.values()].find((c) => c.callId === callId) : undefined;

  const push = (call: LiveKitCall, event: LiveKitHostEvent): void => {
    if (call.stream && !call.stream.writableEnded) {
      call.stream.write(`${JSON.stringify(event)}\n`);
      return;
    }
    call.queue.push(event);
    if (call.queue.length > MAX_QUEUED_EVENTS) call.queue.shift();
  };

  /** What chat resolution needs of a call; a call start checks it before the call exists. */
  type ChatProbe = Pick<LiveKitCall, 'line' | 'platformId' | 'callId'>;

  const noteChat = (
    call: ChatProbe,
    topic: 'binding' | 'choice',
    note: string | null,
    fields: Record<string, unknown> = {},
  ): void => {
    const key = `${call.platformId}|${topic}`;
    if (note === null) {
      chatNotes.delete(key);
      return;
    }
    const value = `${note}|${JSON.stringify(fields)}`;
    if (chatNotes.get(key) === value) return;
    chatNotes.set(key, value);
    log.info(`livekit-voice: ${note}`, { platformId: call.platformId, callId: call.callId, ...fields });
  };

  /** The `/voice` chat while it is still the agent's, else the VOICE_MODE_MIRROR pick. (The caller's role is the line's check.) */
  const resolveChat = async (call: ChatProbe): Promise<CallChat | null> => {
    const { line } = call;
    const groups = await mirrorApi.groupsFor(line.agentGroupId);
    const bound = await mirrorApi.boundChat(call.platformId);
    if (bound) {
      const g = bound.group;
      const wired = !g.denied_at && !g.detached_at && groups.some((w) => w.id === g.id);
      if (!wired) {
        noteChat(call, 'binding', 'the /voice chat is no longer wired to the agent; using the default', {
          chat: g.id,
        });
      } else {
        noteChat(call, 'binding', null);
        return { group: g, threadId: bound.threadId, source: 'voice-command' };
      }
    }
    if (!mirrorChannel) {
      noteChat(call, 'choice', 'call has no chat: the /voice chat is unusable and VOICE_MODE_MIRROR is off');
      return null;
    }
    const pick = pickMirrorTarget(groups, mirrorChannel);
    if ('skip' in pick) {
      noteChat(call, 'choice', `call has no chat: the /voice chat is unusable and ${pick.skip}`);
      return null;
    }
    return { group: pick.target, threadId: null, source: 'default' };
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
        log.warn('livekit-voice: could not show the new call chat on the page', { callId: call.callId, err }),
    );
  };

  /**
   * Re-resolve where the call talks; `turn` marks a caller turn, where a chat
   * left behind by a mid-call `/voice` ages out once it went quiet.
   */
  const refreshChat = async (call: LiveKitCall, turn: boolean): Promise<CallChat | null> => {
    const refresh = ++call.chatRefreshes;
    let chat: CallChat | null;
    try {
      chat = await resolveChat(call);
    } catch (err) {
      log.warn('livekit-voice: could not resolve the call chat', {
        platformId: call.platformId,
        err,
      });
      chat = null;
    }
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
    if (chat) {
      const { group, threadId, source } = chat;
      noteChat(call, 'choice', 'call talks in the agent chat', { chat: group.id, threadId, source });
    }
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

  const postToChat = async (chat: CallChat, text: string): Promise<void> => {
    const adapter = mirrorApi.adapter(chat.group.instance ?? chat.group.channel_type);
    if (!adapter) {
      log.warn('livekit-voice: the call chat adapter is offline', { chat: chat.group.id });
      return;
    }
    await adapter.deliver(chat.group.platform_id, chat.threadId, { kind: 'chat', content: { text } });
  };

  /** Best effort and off the caller's path; ordered per line. */
  const mirror = (platformId: string, chat: CallChat, text: string): void => {
    const next = (mirrorChains.get(platformId) ?? Promise.resolve())
      .then(() => postToChat(chat, text))
      .catch((err: unknown) =>
        log.warn('livekit-voice: transcript post failed', { platformId, chat: chat.group.id, err }),
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
        log.warn('livekit-voice: room delete failed', { callId: call.callId, attempt, err });
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)).unref());
      }
    }
    log.error('livekit-voice: room was not deleted; the worker stops on its own when the host link closes', {
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        // The whole metadata is replaced, so the chat label the page shows goes along.
        (call.metadataWrite ?? Promise.resolve()).then(() =>
          api.updateRoomMetadata(call.roomName, roomMetadata(call.chat, code)),
        ),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timed out')), END_NOTICE_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
    } catch (err) {
      if (!isNotFound(err))
        log.info('livekit-voice: could not set the end reason on the room', { callId: call.callId, err });
    } finally {
      clearTimeout(timer);
    }
  };

  /** `end`: why, as the page names it; left out for ends no page is there to hear about. */
  const endCall = (call: LiveKitCall, reason: string, end?: CallEndReason): void => {
    if (call.ended) return;
    call.ended = true;
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
    log.info('livekit-voice: call ended', { platformId: call.platformId, callId: call.callId, reason });
  };

  const checkAccess = async (call: LiveKitCall): Promise<boolean> => {
    if (call.ended) return false;
    try {
      const current = await host.resolveLine(call.platformId);
      if (current && sameCallerAndAgent(call.line, current) && calls.get(call.platformId) === call && !call.ended)
        return true;
    } catch (err) {
      log.warn('livekit-voice: call access check failed', { platformId: call.platformId, err });
    }
    endCall(call, 'caller access revoked or line changed', 'revoked');
    return false;
  };

  const readJson = async (req: http.IncomingMessage): Promise<Record<string, unknown> | null> => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > MAX_AGENT_BODY_BYTES) return null;
      chunks.push(chunk as Buffer);
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  /** Admit the call, open its room, dispatch the worker and hand the caller a token for that room only. */
  const startCall = async (res: http.ServerResponse, platformId: string): Promise<void> => {
    const line = await host.resolveLine(platformId, { forCall: true });
    if (!line) return reply(res, 403, 'Caller access denied or voice line is not set up');
    // Before anything is spent or ended: a call with no chat to talk in is refused outright.
    if (!(await resolveChat({ line, platformId, callId: 'starting' }))) return reply(res, 409, NO_CHAT);
    const t = host.now();
    const refusal = host.admitStart(platformId, t);
    if (refusal) return reply(res, 429, refusal.body, { 'Retry-After': refusal.retryAfter });
    // admitStart refused a day with no minutes left. The running call's time is already in the
    // day's total, so ending it below does not change what is left.
    const remainingMs = host.remainingTodayMs(platformId, t);
    const capMs = Math.min(host.maxCallDurationMs, remainingMs);
    // Newest wins on the line.
    const previous = calls.get(platformId);
    if (previous) endCall(previous, 'replaced by a new call', 'newer_call');
    const callId = randomUUID();
    const call: LiveKitCall = {
      callId,
      platformId,
      line,
      roomName: `voice-mode-${platformId.replace(/^voice-mode:/, '')}-${randomBytes(6).toString('hex')}`,
      secret: liveKitCallSecret(config.apiSecret, callId),
      callerIdentity: `caller-${callId.slice(0, 8)}`,
      state: 'connecting',
      ended: false,
      queue: [],
      utteranceStarts: [],
      utterances: 0,
      turnOutcomes: new Map(),
      turnsInFlight: 0,
      sent: 0,
      chat: null,
      chatRefreshes: 0,
      previousChat: null,
    };
    calls.set(platformId, call);
    call.joinTimer = setTimeout(() => endCall(call, 'caller never joined'), joinTimeoutMs);
    call.joinTimer.unref();
    call.accessTimer = setInterval(() => void checkAccess(call), host.accessCheckIntervalMs);
    call.accessTimer.unref();
    const metadata: LiveKitJobMetadata = {
      v: LIVEKIT_PROTOCOL_VERSION,
      callId,
      lineId: platformId,
      agentName: line.agent.name,
      callerName: line.caller.name,
      callerIdentity: call.callerIdentity,
      vocabulary: [...(line.agent.vocabulary ?? [])],
      ...speech,
      maxDurationMs: capMs,
      joinTimeoutMs,
    };
    let token: string;
    try {
      await api.createRoom({ name: call.roomName, emptyTimeout: 60, departureTimeout: 10, maxParticipants: 2 });
      await api.createDispatch(call.roomName, agentName, { metadata: JSON.stringify(metadata) });
      const at = new AccessToken(config.apiKey, config.apiSecret, {
        identity: call.callerIdentity,
        name: line.caller.name,
        ttl: CALLER_TOKEN_TTL_SECONDS,
      });
      at.addGrant({
        roomJoin: true,
        room: call.roomName,
        canPublish: true,
        canPublishSources: [TrackSource.MICROPHONE],
        canSubscribe: true,
        canPublishData: false,
        canUpdateOwnMetadata: false,
      });
      token = await at.toJwt();
    } catch (err) {
      log.warn('livekit-voice: room setup failed', { platformId, callId, err });
      // Ended meanwhile: its cleanup may have run before the room existed.
      if (call.ended) await trackedDeleteRoom(call);
      else endCall(call, 'room setup failed');
      return reply(res, 502, 'livekit-voice: could not open the call room');
    }
    // The chat the call talks in, for the page to show; resolved again when the caller joins.
    const chatGroup = (await refreshChat(call, false))?.group;
    if (!chatGroup && !call.ended) {
      endCall(call, 'no chat to talk in');
      return reply(res, 409, NO_CHAT);
    }
    const chat = chatGroup ? chatLabel(chatGroup) : undefined;
    if (call.ended || !host.isRunning()) {
      // Replaced or torn down while connecting: that cleanup ran before the room and dispatch
      // existed, so delete them here or they wait for the caller until LiveKit's empty timeout.
      if (call.ended) await trackedDeleteRoom(call);
      else endCall(call, 'replaced while connecting');
      return reply(res, 409, 'This call attempt is no longer active');
    }
    if (res.destroyed) {
      // The page went away during setup and never gets the token, so nobody joins the room.
      log.info('livekit-voice: page left during call setup', { platformId, callId });
      return endCall(call, 'page left during call setup');
    }
    log.info('livekit-voice: call started', {
      platformId,
      callId,
      room: call.roomName,
      agent: line.agent.name,
      sttModel: speech.sttModel,
      sttFallbackModel: speech.sttFallbackModel,
      ttsModel: speech.ttsModel,
      ttsFallbackModel: speech.ttsFallbackModel,
    });
    // What the page needs for its hints: the silence that sends a turn, and the cap that ends the
    // call (from join; onJoined recomputes it, never later than this).
    const limit = { ms: capMs, kind: remainingMs < host.maxCallDurationMs ? 'daily' : 'duration' };
    reply(
      res,
      200,
      JSON.stringify({
        url: config.url,
        token,
        callId,
        agent: line.agent.name,
        chat,
        silenceMs: speech.silenceMs,
        limit,
      }),
      JSON_HEADERS,
    );
  };

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
    const budgetCaps = remainingMs < host.maxCallDurationMs;
    call.expires = setTimeout(
      () =>
        budgetCaps
          ? endCall(call, 'daily minute budget', 'limit_daily')
          : endCall(call, 'duration limit', 'limit_duration'),
      Math.max(1, budgetCaps ? remainingMs : host.maxCallDurationMs),
    );
    call.expires.unref();
    if (!call.stream) {
      call.streamTimer = setTimeout(() => {
        if (!call.stream) endCall(call, 'worker never opened its event stream', 'worker_gone');
      }, config.workerStreamTimeoutMs ?? WORKER_STREAM_TIMEOUT_MS);
      call.streamTimer.unref();
    }
    log.info('livekit-voice: caller joined', { platformId: call.platformId, callId: call.callId });
    // Known before the first turn, so the agent's messages to that chat are spoken from the start.
    void refreshChat(call, false);
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
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return reply(res, 400, 'text is required');
    if (Buffer.byteLength(text) > MAX_UTTERANCE_BYTES) {
      return reply(res, 413, `utterance is too large (${MAX_UTTERANCE_BYTES / 1024} KB max)`);
    }
    const turnKey =
      typeof body.turnKey === 'string' && body.turnKey.length <= MAX_TURN_KEY_LENGTH ? body.turnKey : undefined;
    const known = turnKey && call.turnOutcomes.get(turnKey);
    if (known) return answer(res, await known);
    if (call.turnsInFlight >= MAX_TURNS_IN_FLIGHT) return reply(res, 429, 'Too many turns are still being routed');
    const t = host.now();
    call.utteranceStarts = call.utteranceStarts.filter((at) => at > t - MINUTE_MS);
    if (call.utteranceStarts.length >= MAX_UTTERANCES_PER_MINUTE) {
      return reply(res, 429, 'Too many utterances this minute', {
        'Retry-After': String(Math.max(1, Math.ceil((call.utteranceStarts[0] + MINUTE_MS - t) / 1000))),
      });
    }
    call.utteranceStarts.push(t);
    call.turnsInFlight++;
    const outcome = takeTurn(call, text, t, turnKey);
    if (turnKey) {
      call.turnOutcomes.set(turnKey, outcome);
      for (const key of call.turnOutcomes.keys()) {
        if (call.turnOutcomes.size <= MAX_REMEMBERED_TURNS) break;
        call.turnOutcomes.delete(key);
      }
    }
    answer(res, await outcome);
  };

  const answer = (res: http.ServerResponse, outcome: TurnOutcome): void =>
    reply(res, outcome.status, outcome.body, outcome.status === 202 ? JSON_HEADERS : {});

  /**
   * The turn keeps its in-flight slot until routing ends, which can be after the 504: the router may
   * still store the turn then, and the worker hears `turn-stored` for its `turnKey`. The route timeout
   * counts from `receivedAt`, so the lookups before routing cannot push the answer past the worker's
   * own request timeout.
   */
  const takeTurn = async (
    call: LiveKitCall,
    text: string,
    receivedAt: number,
    turnKey: string | undefined,
  ): Promise<TurnOutcome> => {
    const release = () => void call.turnsInFlight--;
    let routed: Promise<boolean> | undefined;
    try {
      if (!(await checkAccess(call))) return { status: 403, body: 'Caller access denied' };
      if (!host.isRunning()) return { status: 503, body: 'The voice channel is shutting down' };
      const chat = await refreshChat(call, true);
      // The call can end or be replaced while the chat lookups run; its turn must not reach the agent then.
      if (call.ended || calls.get(call.platformId) !== call) return { status: 409, body: 'The call has ended' };
      if (!chat) return { status: 409, body: 'The call has no chat to talk in' };
      const utteranceId = String(++call.utterances);
      // Always the line's own caller: the person whose /voice minted the link.
      const sender = call.line.caller;
      const message: InboundEvent['message'] = {
        id: liveKitUtteranceMessageId(call.callId, utteranceId),
        kind: 'chat',
        content: JSON.stringify({
          text: turnMessageText(text, replyNote),
          sender: sender.name,
          senderId: sender.id,
          livekit: { callId: call.callId, utteranceId },
        }),
        timestamp: new Date().toISOString(),
        isMention: true,
        isGroup: chat.group.is_group !== 0,
      };
      const address = {
        channelType: chat.group.channel_type,
        platformId: chat.group.platform_id,
        threadId: chat.threadId,
      };
      routed = host.routeTurn(
        { ...address, instance: chat.group.instance ?? chat.group.channel_type, message },
        call.line.agentGroupId,
        () => liveKitChatTyping(address, call.line.agentGroupId),
      );
      // Shown once the agent has it, even when that comes after the worker was told it timed out.
      void routed.then(
        (stored) => {
          if (stored) mirror(call.platformId, chat, `🎙 ${sender.name}: ${text}`);
        },
        () => undefined,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), Math.max(0, routeTimeoutMs - (host.now() - receivedAt)));
        timer.unref();
      });
      const fields = { callId: call.callId, utteranceId };
      try {
        const stored = await Promise.race([routed, timedOut]);
        if (stored === 'timeout') {
          log.warn('livekit-voice: a turn did not reach the agent in time', fields);
          if (turnKey) {
            void routed.then(
              (late) => {
                if (!late) return;
                log.info('livekit-voice: a timed-out turn reached the agent', fields);
                const accepted = { status: 202, body: JSON.stringify({ id: utteranceId }) };
                if (call.turnOutcomes.has(turnKey)) call.turnOutcomes.set(turnKey, Promise.resolve(accepted));
                if (!call.ended) push(call, { type: 'turn-stored', turnKey, id: utteranceId });
              },
              () => undefined,
            );
          }
          return { status: 504, body: 'The turn did not reach the agent in time' };
        }
        if (!stored) {
          log.warn('livekit-voice: the router did not hand a turn to the agent', fields);
          return { status: 422, body: 'The agent did not take the turn' };
        }
        return { status: 202, body: JSON.stringify({ id: utteranceId }) };
      } catch {
        return { status: 500, body: 'Routing the turn failed' };
      } finally {
        clearTimeout(timer);
      }
    } finally {
      if (routed) void routed.then(release, release);
      else release();
    }
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
    const body = await readJson(req);
    if (!body) return reply(res, 400, 'Body must be a small JSON object');
    const call = findCall(body.callId);
    // Unknown, ended and unauthenticated look alike to the caller of these routes.
    if (!call || call.ended || !secret || !sameSecret(secret, call.secret)) return reply(res, 409, 'No such call');
    if (route === 'livekit/agent/joined') return onJoined(res, call);
    if (route === 'livekit/agent/utterance') return onUtterance(res, call, body);
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

  const pageHeaders = (): Record<string, string> => {
    const lk = new URL(config.url);
    const https = `${lk.protocol === 'ws:' ? 'http:' : 'https:'}//${lk.host}`;
    return {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      // The voice page as one self-contained document (inline module script and styles, data: fonts
      // and images); signaling to the LiveKit server. WebRTC media is not governed by connect-src.
      'Content-Security-Policy':
        "default-src 'self' 'unsafe-inline' blob: data:; " +
        `connect-src 'self' ${lk.protocol}//${lk.host} ${https}; media-src 'self' blob: mediastream:; ` +
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    };
  };

  const engine: LiveKitVoice = {
    async handleHttp(req, res, route, url, lineForToken) {
      if (route.startsWith('livekit/agent/')) return handleAgent(req, res, route, url);
      if (route === 'livekit') {
        if (req.method !== 'GET') return reply(res, 405, 'GET only');
        page ??= callPageHtml();
        res.writeHead(200, pageHeaders());
        res.end(page);
        return;
      }
      if (req.method !== 'POST') return reply(res, 405, 'POST only');
      const token = url.searchParams.get('t') ?? '';
      const platformId = await lineForToken(token);
      if (!platformId) return reply(res, 403, 'Unknown call link');
      if (route === 'livekit/token') return startCall(res, platformId);
      if (route === 'livekit/end') {
        const body = await readJson(req);
        const call = calls.get(platformId);
        if (call && body && call.callId === body.callId) {
          // The page gave up waiting for the worker, or the worker said it runs another version.
          const reason =
            body.reason === 'no-agent'
              ? 'no voice worker joined (worker down, or not on this protocol version)'
              : body.reason === 'updating'
                ? 'the voice worker is on another protocol version'
                : 'hangup';
          endCall(call, reason);
          await call.cleanup;
        }
        return reply(res, 204, '');
      }
      reply(res, 404, 'Not found');
    },

    chatMessage(chat, agentGroupId, text, replyTo) {
      for (const call of calls.values()) {
        if (call.state !== 'live' || call.ended || call.line.agentGroupId !== agentGroupId) continue;
        const turn = replyTo?.callId === call.callId ? replyTo.utteranceId : null;
        if (callChatAt(call, chat)) push(call, { type: 'reply', text, turn });
      }
    },

    chatTyping(chat, agentGroupId) {
      for (const call of calls.values()) {
        if (call.state !== 'live' || call.ended || call.line.agentGroupId !== agentGroupId) continue;
        if (callChatAt(call, chat)) push(call, { type: 'thinking' });
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
      await Promise.all([...cleanups, ...mirrorChains.values()]);
    },
  };
  engines.add(engine);
  return engine;
}
