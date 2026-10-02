/**
 * LiveKit as a third voice engine for the voice channel, in walkie-talkie
 * mode: the caller talks to the line's real NanoClaw agent, not to a voice
 * model playing it.
 *
 * The caller's browser joins a LiveKit room over WebRTC; a LiveKit Agents
 * worker (`src/voice-livekit-worker.ts`, its own process: agents-js runs every
 * job in a forked child process) joins the same room, cuts the caller's audio
 * into turns, transcribes each turn and hands the text to the host, then speaks
 * every agent reply into the room with Gemini TTS. The host owns the call: it
 * admits it against the shared limits, creates a unique room, dispatches the
 * worker to it with the job metadata, mints the caller's token, charges the
 * daily minutes, rechecks access every few seconds and ends the call by
 * deleting the room, which disconnects caller and worker alike.
 *
 * The worker reaches the host over HTTP on the webhook server
 * (`/webhook/voice/livekit/agent/*`), at an address from its own settings,
 * authenticated by a per-call secret both sides derive from the LiveKit API
 * secret (never in the dispatch metadata, never in the caller's token):
 *  - `GET  agent/events`     an NDJSON stream of agent replies to speak, the
 *    agent still working, and when to end, with pings;
 *  - `POST agent/joined`     the caller is in the room; the clock starts here;
 *  - `POST agent/utterance`  one transcribed caller turn, fed to the agent as
 *    an inbound message with the id `livekit:<callId>:<n>`;
 *  - `POST agent/ended`      the worker's session is over.
 *
 * A call talks in one of the agent's chats (its *call chat*), not on the voice
 * line: the chat the line's owner last ran `/voice` in (voice_lines), else the
 * one chat of the WALKIE_MIRROR channel type wired to the agent
 * (pickMirrorTarget). Each turn is routed into that chat's session through the
 * normal inbound path as a message from the line's own caller, addressed to
 * the line's agent only; the transcript is posted into the chat, and the agent
 * answers there as it always does. While the call is live, every message the
 * agent delivers to that chat is also spoken, and its typing there is the
 * worker's `thinking`. With no call chat (WALKIE_MIRROR off,
 * or no single chat to pick) the call talks on the voice line itself, and the
 * agent's replies come back through deliver() by their `livekit:` reply id.
 */
import { createRequire } from 'node:module';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';

import { AccessToken, AgentDispatchClient, RoomServiceClient, TrackSource } from 'livekit-server-sdk';

import type { ChannelAdapter, InboundEvent, InboundMessage } from './adapter.js';
import { getChannelAdapterExact } from './channel-registry.js';
import type { ResolveLineOptions, VoiceLine } from './gpt-live-prompt.js';
import {
  DEFAULT_LIVEKIT_AGENT_NAME,
  DEFAULT_WALKIE_SILENCE_MS,
  DEFAULT_WALKIE_STT_MODEL,
  DEFAULT_WALKIE_TTS_MODEL,
  DEFAULT_WALKIE_TTS_VOICE,
  liveKitCallSecret,
  PING_INTERVAL_MS,
  type LiveKitHostEvent,
  type LiveKitJobMetadata,
} from './voice-livekit-protocol.js';
import {
  getMessagingGroup,
  getMessagingGroupByPlatform,
  getMessagingGroupsByAgentGroup,
} from '../db/messaging-groups.js';
import { getVoiceLine } from '../db/voice-lines.js';
import { registerPostDeliveryHook } from '../delivery.js';
import { log } from '../log.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import { registerTypingObserver } from '../modules/typing/index.js';
import type { MessagingGroup } from '../types.js';

const MINUTE_MS = 60_000;
const MAX_QUEUED_EVENTS = 50;
const MAX_AGENT_BODY_BYTES = 16 * 1024;
const CALLER_TOKEN_TTL_SECONDS = 120;
/** The worker opens its event stream right after it reports the caller in; without it nothing reaches the caller. */
const WORKER_STREAM_TIMEOUT_MS = 30_000;
/** A turn is at most 90 s of speech; Ukrainian runs about 4 KB of UTF-8 for that. */
export const MAX_UTTERANCE_BYTES = 8 * 1024;
export const MAX_UTTERANCES_PER_MINUTE = 20;

/** How the agent learns a message was spoken on a call and how its reply will be heard. */
export const WALKIE_REPLY_NOTE =
  'Spoken on a live voice call; your reply is read aloud word for word. Answer in a few short spoken ' +
  'sentences: no markdown, no links, no code blocks, numbers written as words. Send longer material ' +
  'as a separate written message to your chat.';

/** The same for a call that talks in a chat, where every message the agent sends there is spoken. */
export const WALKIE_CHAT_REPLY_NOTE =
  'Spoken on a live voice call; while it lasts, every message you send to this chat is read aloud word for ' +
  'word. Answer in a few short spoken sentences: no markdown, no links, no code blocks, numbers written as ' +
  'words. Offer longer material for after the call instead of sending it now.';

/** The inbound text for one transcribed caller turn. */
export function walkieMessageText(transcript: string, note: string = WALKIE_REPLY_NOTE): string {
  return `<voice source="livekit">${transcript}</voice>\n${note}`;
}

/** Inbound ids for caller turns are `livekit:<call>:<n>`; voice.ts parses replies with parseScopedId. */
export const LIVEKIT_ID_PREFIX = 'livekit:';

export function liveKitUtteranceMessageId(callId: string, utteranceId: string): string {
  return `${LIVEKIT_ID_PREFIX}${callId}:${utteranceId}`;
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
}

/** The `/voice` binding of a line, as stored; checked against the line before use. */
export interface BoundCallChat {
  group: MessagingGroup;
  threadId: string | null;
  /** The line's owner, the only one who can set the binding. */
  ownerId: string;
}

/** The agent's chats a call can talk in; the central DB and live adapters by default, fakes in tests. */
export interface MirrorApi {
  groupsFor(agentGroupId: string): Promise<MessagingGroup[]>;
  adapter(key: string): Pick<ChannelAdapter, 'deliver'> | undefined;
  /** The chat `/voice` last pointed the line at, if any. */
  boundChat(lineId: string): Promise<BoundCallChat | null>;
  isAdmin(userId: string, agentGroupId: string): Promise<boolean>;
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
  /** Set by `/voice`, or picked by the WALKIE_MIRROR rule. */
  source: 'voice-command' | 'default';
}

export interface WalkieSettings {
  sttModel?: string;
  ttsModel?: string;
  ttsVoice?: string;
  silenceMs?: number;
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
  /** Transcription and speech settings the worker gets in the job metadata (WALKIE_*). */
  walkie?: WalkieSettings;
  /** Channel type of the default call chat (WALKIE_MIRROR) when `/voice` has not set one; off when unset. */
  mirror?: string;
  /** Test seam; defaults to the central DB and the live channel adapters. */
  mirrorApi?: MirrorApi;
  /** How long the caller has to join the room after the token is minted. */
  joinTimeoutMs?: number;
  /** How long the worker has to open its event stream after reporting the caller in. */
  workerStreamTimeoutMs?: number;
  /** Test seam; defaults to the livekit-server-sdk clients. */
  api?: LiveKitServerApi;
}

/** What the voice adapter shares with this engine: limits, access, routing. */
export interface LiveKitHost {
  resolveLine(platformId: string, options?: ResolveLineOptions): Promise<VoiceLine | null>;
  sameCallerAndAgent(a: VoiceLine, b: VoiceLine): boolean;
  admitStart(platformId: string, t: number): { body: string; retryAfter: string } | null;
  /** Daily call time left on the line, all engines counted. */
  remainingTodayMs(platformId: string, t: number): number;
  chargeUsage(call: { platformId: string; startedAt: number }): void;
  /** Newest wins across engines: end any other engine's call on the line. */
  endOtherCalls(platformId: string, reason: string): void;
  /** Hand a turn to the router; fire and forget, so a routing failure is logged there, not reported here. */
  onInbound(platformId: string, message: InboundMessage): void;
  /** Route a turn into the call chat, through the same inbound path the chat's own messages take. */
  onInboundEvent(event: InboundEvent): void;
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
  sent: number;
  /** Where the call talks; null while it talks on the voice line. Refreshed on join and every turn. */
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
}

export interface LiveKitVoice {
  /** Routes under /webhook/voice/livekit. */
  handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: string,
    url: URL,
    tokens: ReadonlySet<string>,
    lineIdForToken: (token: string) => string,
  ): Promise<void>;
  /**
   * Speak an agent message on the line's LiveKit call. `target` is the parsed
   * livekit reply id, if the message answers one. Returns null when the message
   * is not this engine's (no call here and no livekit reply id).
   */
  deliver(
    platformId: string,
    target: { callId: string; utteranceId: string } | null,
    inReplyTo: string | undefined,
    text: string,
  ): Promise<{ id: string | undefined } | null>;
  setTyping(platformId: string): Promise<void>;
  /** An agent message reached a chat: speak it on the live call that talks there. */
  chatMessage(chat: ChatAddress, agentGroupId: string, text: string): void;
  /** The agent is working in a chat: tell its live call that talks there. */
  chatTyping(chat: ChatAddress, agentGroupId: string): void;
  /** The running call on a line, for the shared daily budget. */
  activeCall(platformId: string): { platformId: string; startedAt: number } | undefined;
  endLine(platformId: string, reason: string): void;
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
    const line = await getMessagingGroupByPlatform('voice', lineId);
    const row = line && (await getVoiceLine(line.id));
    const group = row?.target_messaging_group_id && (await getMessagingGroup(row.target_messaging_group_id));
    if (!row || !group) return null;
    return { group, threadId: row.thread_id, ownerId: row.owner_user_id };
  },
  isAdmin: (userId, agentGroupId) => hasAdminPrivilege(userId, agentGroupId),
};

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
  },
  agentGroupId: string,
): void {
  if (engines.size === 0 || !msg.channelType || !msg.platformId) return;
  const text = spokenText(msg);
  if (!text) return;
  const chat = { channelType: msg.channelType, platformId: msg.platformId, threadId: msg.threadId ?? null };
  for (const engine of engines) engine.chatMessage(chat, agentGroupId, text);
}

/** Typing tap: the agent works in a chat; its live call talking there hears it is thinking. */
export function liveKitChatTyping(chat: ChatAddress, agentGroupId: string): void {
  for (const engine of engines) engine.chatTyping(chat, agentGroupId);
}

registerPostDeliveryHook((msg, session) => liveKitChatDelivered(msg, session.agent_group_id));
registerTypingObserver(({ agentGroupId, ...chat }) => liveKitChatTyping(chat, agentGroupId));

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function defaultApi(config: LiveKitVoiceConfig): LiveKitServerApi {
  const host = config.serverUrl || config.url;
  const rooms = new RoomServiceClient(host, config.apiKey, config.apiSecret, { requestTimeout: 10 });
  const dispatch = new AgentDispatchClient(host, config.apiKey, config.apiSecret, { requestTimeout: 10 });
  return {
    createRoom: (options) => rooms.createRoom(options),
    deleteRoom: (room) => rooms.deleteRoom(room),
    createDispatch: (room, agentName, options) => dispatch.createDispatch(room, agentName, options),
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
  const walkie = {
    sttModel: config.walkie?.sttModel || DEFAULT_WALKIE_STT_MODEL,
    ttsModel: config.walkie?.ttsModel || DEFAULT_WALKIE_TTS_MODEL,
    ttsVoice: config.walkie?.ttsVoice || DEFAULT_WALKIE_TTS_VOICE,
    silenceMs: config.walkie?.silenceMs || DEFAULT_WALKIE_SILENCE_MS,
  };
  const mirrorChannel = config.mirror && config.mirror !== 'off' ? config.mirror : null;
  const mirrorApi = config.mirrorApi ?? defaultMirrorApi;
  const joinTimeoutMs = config.joinTimeoutMs ?? 60_000;
  const calls = new Map<string, LiveKitCall>();
  const cleanups = new Set<Promise<void>>();
  /** Per line, so transcripts land in the order they were spoken. */
  const mirrorChains = new Map<string, Promise<void>>();
  /** The last call-chat note logged per line and topic, so a line logs when it changes, not every turn. */
  const chatNotes = new Map<string, string>();
  let clientJs: string | undefined;
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

  const noteChat = (
    call: LiveKitCall,
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

  /** The `/voice` chat if it is still the agent's and the line's owner still administers the agent, else the WALKIE_MIRROR pick. */
  const resolveChat = async (call: LiveKitCall): Promise<CallChat | null> => {
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
      } else if (!(await mirrorApi.isAdmin(bound.ownerId, line.agentGroupId))) {
        noteChat(call, 'binding', 'the line owner is no longer an admin of the agent; using the default', {
          chat: g.id,
        });
      } else {
        noteChat(call, 'binding', null);
        return { group: g, threadId: bound.threadId, source: 'voice-command' };
      }
    }
    if (!mirrorChannel) {
      noteChat(call, 'choice', 'call talks on the voice line: no /voice chat and WALKIE_MIRROR is off');
      return null;
    }
    const pick = pickMirrorTarget(groups, mirrorChannel);
    if ('skip' in pick) {
      noteChat(call, 'choice', `call talks on the voice line: no /voice chat and ${pick.skip}`);
      return null;
    }
    return { group: pick.target, threadId: null, source: 'default' };
  };

  const sameChat = (a: CallChat | null, b: CallChat | null): boolean =>
    a?.group.id === b?.group.id && a?.threadId === b?.threadId;

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
      log.warn('livekit-voice: could not resolve the call chat; the call talks on the voice line', {
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
      call.previousChat = call.chat ? { chat: call.chat, active: false } : null;
      call.chat = chat;
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

  /** Teardown awaits every delete in flight, wherever it started. */
  const trackedDeleteRoom = (call: LiveKitCall): Promise<void> => {
    const cleanup = deleteRoom(call).finally(() => cleanups.delete(cleanup));
    cleanups.add(cleanup);
    return cleanup;
  };

  const endCall = (call: LiveKitCall, reason: string): void => {
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
    if (stream && !stream.writableEnded) {
      stream.write(`${JSON.stringify({ type: 'end', reason } satisfies LiveKitHostEvent)}\n`);
      stream.end();
    }
    call.cleanup = trackedDeleteRoom(call);
    log.info('livekit-voice: call ended', { platformId: call.platformId, callId: call.callId, reason });
  };

  const checkAccess = async (call: LiveKitCall): Promise<boolean> => {
    if (call.ended) return false;
    try {
      const current = await host.resolveLine(call.platformId);
      if (current && host.sameCallerAndAgent(call.line, current) && calls.get(call.platformId) === call && !call.ended)
        return true;
    } catch (err) {
      log.warn('livekit-voice: call access check failed', { platformId: call.platformId, err });
    }
    endCall(call, 'caller access revoked or line changed');
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
    const line = await host.resolveLine(platformId, { persona: true });
    if (!line) return reply(res, 403, 'Caller access denied or voice line is not set up');
    const t = host.now();
    const refusal = host.admitStart(platformId, t);
    if (refusal) return reply(res, 429, refusal.body, { 'Retry-After': refusal.retryAfter });
    // Before ending anything: a refused start must not hang up the caller's running call. The
    // running calls' time is already in the day's total, so ending them below does not change it.
    const remainingMs = host.remainingTodayMs(platformId, t);
    if (remainingMs <= 0) return reply(res, 429, 'This voice line has used its call minutes for today.');
    // Newest wins on the line, whatever engine holds it.
    const previous = calls.get(platformId);
    if (previous) endCall(previous, 'replaced by a new call');
    host.endOtherCalls(platformId, 'replaced by a new call');
    const callId = randomUUID();
    const call: LiveKitCall = {
      callId,
      platformId,
      line,
      roomName: `voice-${platformId.replace(/^voice:/, '')}-${randomBytes(6).toString('hex')}`,
      secret: liveKitCallSecret(config.apiSecret, callId),
      callerIdentity: `caller-${callId.slice(0, 8)}`,
      state: 'connecting',
      ended: false,
      queue: [],
      utteranceStarts: [],
      utterances: 0,
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
      v: 2,
      callId,
      lineId: platformId,
      agentName: line.agent.name,
      callerName: line.caller.name,
      callerIdentity: call.callerIdentity,
      vocabulary: [...(line.agent.vocabulary ?? [])],
      ...walkie,
      maxDurationMs: Math.min(host.maxCallDurationMs, remainingMs),
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
      sttModel: walkie.sttModel,
      ttsModel: walkie.ttsModel,
    });
    reply(res, 200, JSON.stringify({ url: config.url, token, callId, agent: line.agent.name }), JSON_HEADERS);
  };

  /** The worker saw the caller join: start the clock and the duration / budget cap. */
  const onJoined = (res: http.ServerResponse, call: LiveKitCall): void => {
    if (call.state === 'live') return reply(res, 200, JSON.stringify({ ok: true }), JSON_HEADERS);
    const t = host.now();
    const remainingMs = host.remainingTodayMs(call.platformId, t);
    if (remainingMs <= 0) {
      endCall(call, 'daily minute budget');
      return reply(res, 409, 'This voice line has used its call minutes for today');
    }
    call.state = 'live';
    call.startedAt = t;
    clearTimeout(call.joinTimer);
    const budgetCaps = remainingMs < host.maxCallDurationMs;
    call.expires = setTimeout(
      () => endCall(call, budgetCaps ? 'daily minute budget' : 'duration limit'),
      Math.max(1, budgetCaps ? remainingMs : host.maxCallDurationMs),
    );
    call.expires.unref();
    if (!call.stream) {
      call.streamTimer = setTimeout(() => {
        if (!call.stream) endCall(call, 'worker never opened its event stream');
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
      if (call.stream === res && !call.ended) endCall(call, 'worker link closed');
    });
  };

  /** One transcribed caller turn: the agent gets it as a spoken message in the call chat, which also shows it. */
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
    const t = host.now();
    call.utteranceStarts = call.utteranceStarts.filter((at) => at > t - MINUTE_MS);
    if (call.utteranceStarts.length >= MAX_UTTERANCES_PER_MINUTE) {
      return reply(res, 429, 'Too many utterances this minute', {
        'Retry-After': String(Math.max(1, Math.ceil((call.utteranceStarts[0] + MINUTE_MS - t) / 1000))),
      });
    }
    call.utteranceStarts.push(t);
    if (!(await checkAccess(call))) return reply(res, 403, 'Caller access denied');
    if (!host.isRunning()) return reply(res, 503, 'The voice channel is shutting down');
    const chat = await refreshChat(call, true);
    const utteranceId = String(++call.utterances);
    // Always the line's own caller, wherever the call talks: the line is that person's, not whoever ran /voice.
    const sender = call.line.caller;
    const message: InboundMessage = {
      id: liveKitUtteranceMessageId(call.callId, utteranceId),
      kind: 'chat',
      content: {
        text: walkieMessageText(text, chat ? WALKIE_CHAT_REPLY_NOTE : WALKIE_REPLY_NOTE),
        sender: sender.name,
        senderId: sender.id,
        livekit: { callId: call.callId, utteranceId },
      },
      timestamp: new Date().toISOString(),
      isMention: true,
      isGroup: chat ? chat.group.is_group !== 0 : false,
    };
    if (chat) {
      host.onInboundEvent({
        channelType: chat.group.channel_type,
        instance: chat.group.instance ?? chat.group.channel_type,
        platformId: chat.group.platform_id,
        threadId: chat.threadId,
        // Addressed to the line's agent only, whoever else is wired to the chat and whatever its trigger.
        agentGroupId: call.line.agentGroupId,
        message: { ...message, content: JSON.stringify(message.content) },
      });
      mirror(call.platformId, chat, `🎙 ${sender.name}: ${text}`);
    } else {
      host.onInbound(call.platformId, message);
    }
    reply(res, 202, JSON.stringify({ id: utteranceId }), JSON_HEADERS);
  };

  /** /webhook/voice/livekit/agent/*: the worker's side, authenticated by the per-call secret. */
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
      endCall(call, typeof body.reason === 'string' ? `worker: ${body.reason.slice(0, 80)}` : 'worker ended');
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
      // One document plus the same-origin client bundle; signaling to the LiveKit server. WebRTC
      // media is not governed by connect-src.
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; " +
        `connect-src 'self' ${lk.protocol}//${lk.host} ${https}; media-src 'self' blob: mediastream:; ` +
        "worker-src 'self' blob:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    };
  };

  const engine: LiveKitVoice = {
    async handleHttp(req, res, route, url, tokens, lineIdForToken) {
      if (route.startsWith('livekit/agent/')) return handleAgent(req, res, route, url);
      if (route === 'livekit') {
        if (req.method !== 'GET') return reply(res, 405, 'GET only');
        page ??= liveKitCallPageHtml();
        res.writeHead(200, pageHeaders());
        res.end(page);
        return;
      }
      // Also matched from a page opened with a trailing slash, where the relative src gains a segment.
      if (route === 'livekit/client.js' || route === 'livekit/livekit/client.js') {
        if (req.method !== 'GET') return reply(res, 405, 'GET only');
        // The UMD bundle of livekit-client, served same-origin so the page needs no CDN.
        clientJs ??= fs.readFileSync(createRequire(import.meta.url).resolve('livekit-client'), 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(clientJs);
        return;
      }
      if (req.method !== 'POST') return reply(res, 405, 'POST only');
      const token = url.searchParams.get('t') ?? '';
      if (!tokens.has(token)) return reply(res, 403, 'Unknown call link');
      const platformId = lineIdForToken(token);
      if (route === 'livekit/token') return startCall(res, platformId);
      if (route === 'livekit/end') {
        const body = await readJson(req);
        const call = calls.get(platformId);
        if (call && body && call.callId === body.callId) {
          endCall(call, 'hangup');
          await call.cleanup;
        }
        return reply(res, 204, '');
      }
      reply(res, 404, 'Not found');
    },

    async deliver(platformId, target, inReplyTo, text) {
      const call = calls.get(platformId);
      if (target && (!call || call.callId !== target.callId)) {
        // An answer for a call that is over must not be spoken into a later one; retrying cannot help.
        log.info('livekit-voice: dropping a reply for an ended call', { platformId, ...target });
        return { id: undefined };
      }
      if (!call || call.state !== 'live') return target ? { id: undefined } : null;
      if (!text.trim()) throw new Error('livekit-voice: reply contains no speakable text');
      if (!(await checkAccess(call))) throw new Error('livekit-voice: caller access has been revoked');
      push(call, { type: 'reply', text });
      return { id: target ? inReplyTo : `${LIVEKIT_ID_PREFIX}${call.callId}:out-${++call.sent}` };
    },

    async setTyping(platformId) {
      const call = calls.get(platformId);
      if (call?.state === 'live' && !call.ended) push(call, { type: 'thinking' });
    },

    chatMessage(chat, agentGroupId, text) {
      for (const call of calls.values()) {
        if (call.state !== 'live' || call.ended || call.line.agentGroupId !== agentGroupId) continue;
        if (callChatAt(call, chat)) push(call, { type: 'reply', text });
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

    endLine(platformId, reason) {
      const call = calls.get(platformId);
      if (call) endCall(call, reason);
    },

    async teardown() {
      engines.delete(engine);
      for (const call of [...calls.values()]) endCall(call, 'teardown');
      await Promise.all([...cleanups, ...mirrorChains.values()]);
    },
  };
  engines.add(engine);
  return engine;
}

// String.raw keeps the page script's escapes intact; the script avoids backticks and ${.
const PAGE_SCRIPT = String.raw`
const LK = window.LivekitClient;
const linkToken = new URLSearchParams(location.search).get('t') || '';
const base = location.pathname.replace(/\/livekit\/?$/, '');
const q = '?t=' + encodeURIComponent(linkToken);
const btn = document.getElementById('btn');
const audioBtn = document.getElementById('audio');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const names = { agent: 'the agent' };
// The worker's lk.agent.state: the caller's turn, its transcript on the way, the agent at work, its reply.
const STATES = {
  listening: () => 'Listening',
  sending: () => 'Sending...',
  thinking: () => names.agent + ' is thinking',
  speaking: () => names.agent + ' is speaking',
};
let call = null;

function setStatus(text) { statusEl.textContent = text; }
function captionLine(role, label) {
  const p = document.createElement('p');
  p.className = 't ' + role;
  const b = document.createElement('b');
  b.textContent = label;
  const span = document.createElement('span');
  p.append(b, span);
  logEl.append(p);
  while (logEl.childElementCount > 200) logEl.firstElementChild.remove();
  return span;
}

// One text stream per transcript segment version; a newer stream for the same segment replaces it.
async function caption(c, reader, from) {
  const attrs = (reader.info && reader.info.attributes) || {};
  const mine = (c.localSid && attrs['lk.transcribed_track_id'] === c.localSid) ||
    (from && c.room && from.identity === c.room.localParticipant.identity);
  const key = attrs['lk.segment_id'] || reader.info.id;
  let entry = c.lines.get(key);
  if (!entry) {
    entry = { span: captionLine(mine ? 'caller' : 'agent', mine ? 'You' : names.agent) };
    c.lines.set(key, entry);
    if (c.lines.size > 300) c.lines.delete(c.lines.keys().next().value);
  }
  let text = '';
  for await (const chunk of reader) {
    if (c.ended) return;
    text += chunk;
    entry.span.textContent = text.trim();
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function endOnServer(c, beacon) {
  if (!c.callId || c.endSent) return;
  c.endSent = true;
  const url = base + '/livekit/end' + q;
  const body = JSON.stringify({ callId: c.callId });
  if (beacon && navigator.sendBeacon && navigator.sendBeacon(url, body)) return;
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

function hangup(c, message, beacon) {
  if (c.ended) return;
  c.ended = true;
  endOnServer(c, beacon);
  if (c.room) c.room.disconnect().catch(() => {});
  if (c.mic) c.mic.stop();
  for (const el of c.elements) el.remove();
  if (c.ctx) c.ctx.close().catch(() => {});
  if (call === c) call = null;
  audioBtn.hidden = true;
  setStatus(message);
  btn.textContent = 'Call';
  btn.className = '';
}

function start() {
  const c = { room: null, mic: null, ctx: null, callId: null, ended: false, endSent: false, localSid: null,
    lines: new Map(), elements: new Set() };
  call = c;
  btn.textContent = 'Hang up';
  btn.className = 'hang';
  // Inside the click: browsers (iOS Safari above all) unlock audio output only on a user gesture.
  c.ctx = new AudioContext();
  const resumed = c.ctx.resume().catch(() => {});
  const room = new LK.Room({ adaptiveStream: false, dynacast: false, disconnectOnPageLeave: false });
  c.room = room;
  room.startAudio().catch(() => {});
  run(c, room, resumed).catch((err) => hangup(c, 'Could not start: ' + ((err && err.message) || err)));
}

async function run(c, room, resumed) {
  setStatus('Starting the microphone...');
  c.mic = await LK.createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 });
  await resumed;
  if (c.ended) return hangup(c, 'Call ended.');
  setStatus('Connecting...');
  const res = await fetch(base + '/livekit/token' + q, { method: 'POST' });
  if (!res.ok) throw new Error((await res.text()) || 'HTTP ' + res.status);
  const s = await res.json();
  c.callId = s.callId;
  if (s.agent) names.agent = s.agent;
  if (c.ended) return endOnServer(c, false);
  room.registerTextStreamHandler('lk.transcription', (reader, from) => { caption(c, reader, from).catch(() => {}); });
  room.on(LK.RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== 'audio') return;
    const el = track.attach();
    el.hidden = true;
    document.body.append(el);
    c.elements.add(el);
  });
  room.on(LK.RoomEvent.TrackUnsubscribed, (track) => {
    for (const el of track.detach()) { c.elements.delete(el); el.remove(); }
  });
  room.on(LK.RoomEvent.AudioPlaybackStatusChanged, () => { audioBtn.hidden = room.canPlaybackAudio; });
  room.on(LK.RoomEvent.ParticipantConnected, (p) => { if (p.isAgent) setStatus('Live: talk to ' + names.agent + '.'); });
  room.on(LK.RoomEvent.ParticipantDisconnected, (p) => { if (p.isAgent) hangup(c, names.agent + ' left the call.'); });
  room.on(LK.RoomEvent.ParticipantAttributesChanged, (changed, p) => {
    const state = changed && changed['lk.agent.state'];
    if (p && p.isAgent && STATES[state]) setStatus(STATES[state]());
  });
  room.on(LK.RoomEvent.Disconnected, () => hangup(c, 'Call ended.'));
  // iOS Safari binds WebRTC UDP to the Wi-Fi interface, so UDP to a VPN (Tailscale) address
  // stalls until LiveKit's fallback timers fire; going straight to TURN/TLS (TCP) connects at once.
  // ?relay=1 / ?relay=0 overrides the iOS default for testing.
  const relayParam = new URLSearchParams(location.search).get('relay');
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const forceRelay = relayParam === null ? isIOS : relayParam === '1';
  await room.connect(s.url, s.token, forceRelay ? { autoSubscribe: true, rtcConfig: { iceTransportPolicy: 'relay' } } : { autoSubscribe: true });
  if (c.ended) return;
  // DTX off: the worker times the caller's turn by the silence it hears, so silence must keep arriving.
  const pub = await room.localParticipant.publishTrack(c.mic, { source: LK.Track.Source.Microphone, dtx: false, red: false });
  c.localSid = pub.trackSid;
  audioBtn.hidden = room.canPlaybackAudio;
  const agent = [...room.remoteParticipants.values()].find((p) => p.isAgent);
  const state = agent && agent.attributes && agent.attributes['lk.agent.state'];
  setStatus(STATES[state] ? STATES[state]() : agent ? 'Live: talk to ' + names.agent + '.' : 'Waiting for ' + names.agent + '...');
}

btn.addEventListener('click', () => (call ? hangup(call, 'Call ended.') : start()));
audioBtn.addEventListener('click', () => { if (call && call.room) call.room.startAudio().catch(() => {}); });
addEventListener('pagehide', () => { if (call) hangup(call, 'Call ended.', true); });
if (!LK) setStatus('The call client did not load.');
fetch(base + '/info' + q)
  .then((res) => (res.ok ? res.json() : null))
  .then((info) => {
    if (!info) return setStatus('This call link is not active.');
    names.agent = info.agent;
    document.getElementById('title').textContent = 'Call ' + info.agent;
  })
  .catch(() => {});
`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>Live Voice</title>
<style>
:root{--bg:#f6f5f2;--fg:#1d1d1f;--muted:#6b6b70;--card:#fff;--line:#e3e2de;--accent:#1a73e8;--danger:#c5221f}
@media (prefers-color-scheme: dark){:root{--bg:#141416;--fg:#ececef;--muted:#9a9aa2;--card:#1d1d21;--line:#2c2c31;--accent:#3b78e7;--danger:#d93025}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;justify-content:center;padding:24px 16px}
main{width:100%;max-width:560px;display:flex;flex-direction:column;gap:16px}
h1{font-size:20px;margin:0}
#status{color:var(--muted);min-height:1.45em}
.keys{display:flex;gap:12px;flex-wrap:wrap}
button{font:inherit;font-weight:600;border:0;border-radius:999px;padding:14px 28px;background:var(--accent);color:#fff;cursor:pointer}
button.hang{background:var(--danger)}
#audio{background:var(--card);color:var(--fg);border:1px solid var(--line)}
#log{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;min-height:200px;max-height:60vh;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
.t{margin:0}.t b{color:var(--muted);font-weight:600;margin-right:6px}
</style>
</head>
<body>
<main>
<h1 id="title">Live Voice</h1>
<div id="status">Press Call to start.</div>
<div class="keys"><button id="btn" type="button">Call</button><button id="audio" type="button" hidden>Tap to hear the call</button></div>
<div id="log" aria-live="polite"></div>
</main>
<script src="livekit/client.js"></script>
<script>
${PAGE_SCRIPT}
</script>
</body>
</html>
`;

/** The LiveKit call page: one document; livekit-client loads from the same origin. */
export function liveKitCallPageHtml(): string {
  return PAGE;
}
