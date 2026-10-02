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
 * line: the chat `/voice` was last run in (voice_call_targets), else the one
 * chat of the WALKIE_MIRROR channel type wired to the agent (pickMirrorTarget).
 * Each turn is routed into that chat's session through the normal inbound path
 * as a message from the person who owns the line, the transcript is posted into
 * the chat, and the agent answers there as it always does. While the call is
 * live, every message the agent delivers to that chat is also spoken, and its
 * typing there is the worker's `thinking`. With no call chat (WALKIE_MIRROR off,
 * or no single chat to pick) the call talks on the voice line itself, and the
 * agent's replies come back through deliver() by their `livekit:` reply id.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';

import { AccessToken, AgentDispatchClient, RoomServiceClient, TrackSource } from 'livekit-server-sdk';

import type { ChannelAdapter, InboundEvent, InboundMessage } from './adapter.js';
import { getChannelAdapterExact } from './channel-registry.js';
import { callPageHtml, type VoiceUiConfig } from './gpt-live-call-page.js';
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
import { getVoiceCallTarget } from '../db/voice-call-targets.js';
import { registerPostDeliveryHook } from '../delivery.js';
import { log } from '../log.js';
import { canAccessAgentGroup } from '../modules/permissions/access.js';
import { getUser } from '../modules/permissions/db/users.js';
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
  senderId: string;
  /** The sender's display name, when the users row has one. */
  senderName: string | null;
}

/** The agent's chats a call can talk in; the central DB and live adapters by default, fakes in tests. */
export interface MirrorApi {
  groupsFor(agentGroupId: string): Promise<MessagingGroup[]>;
  adapter(key: string): Pick<ChannelAdapter, 'deliver'> | undefined;
  /** The chat `/voice` last pointed the line at, if any. */
  boundChat(lineId: string): Promise<BoundCallChat | null>;
  canAccess(userId: string, agentGroupId: string): Promise<boolean>;
}

/** A chat address as delivery and typing see it. */
export interface ChatAddress {
  channelType: string;
  platformId: string;
  threadId: string | null;
}

/** The chat a call talks in, and who the caller is there. */
export interface CallChat {
  group: MessagingGroup;
  threadId: string | null;
  sender: { id: string; name: string };
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
  onInbound(platformId: string, message: InboundMessage): Promise<void>;
  /** Route a turn into the call chat, through the same inbound path the chat's own messages take. */
  onInboundEvent(event: InboundEvent): Promise<void>;
  isRunning(): boolean;
  now(): number;
  maxCallDurationMs: number;
  accessCheckIntervalMs: number;
  /** Look of the call page (GPT_LIVE_UI); the walkie-talkie serves the same page as the OpenAI path. */
  ui?: VoiceUiConfig;
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
  /** The agent is working in a chat: tell the live call that talks there. */
  chatTyping(chat: ChatAddress): void;
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
    const row = line && (await getVoiceCallTarget(line.id));
    const group = row && (await getMessagingGroup(row.target_messaging_group_id));
    if (!row || !group) return null;
    const user = await getUser(row.sender_user_id);
    return {
      group,
      threadId: row.thread_id,
      senderId: row.sender_user_id,
      senderName: user?.display_name?.trim() || null,
    };
  },
  canAccess: async (userId, agentGroupId) => (await canAccessAgentGroup(userId, agentGroupId)).allowed,
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

/** Typing tap: the agent works in a chat; a live call talking there hears it is thinking. */
export function liveKitChatTyping(chat: ChatAddress): void {
  for (const engine of engines) engine.chatTyping(chat);
}

registerPostDeliveryHook((msg, session) => liveKitChatDelivered(msg, session.agent_group_id));
registerTypingObserver((channelType, platformId, threadId) => liveKitChatTyping({ channelType, platformId, threadId }));

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

  /** The `/voice` chat if it is still the agent's and its sender may still use the agent, else the WALKIE_MIRROR pick. */
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
      } else if (!(await mirrorApi.canAccess(bound.senderId, line.agentGroupId))) {
        noteChat(call, 'binding', 'whoever ran /voice can no longer use the agent; using the default', {
          chat: g.id,
        });
      } else {
        noteChat(call, 'binding', null);
        return {
          group: g,
          threadId: bound.threadId,
          sender: { id: bound.senderId, name: bound.senderName ?? line.caller.name },
          source: 'voice-command',
        };
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
    // The line's own caller: a known member of the agent by construction (resolveVoiceLine).
    return { group: pick.target, threadId: null, sender: line.caller, source: 'default' };
  };

  const refreshChat = async (call: LiveKitCall): Promise<CallChat | null> => {
    try {
      call.chat = await resolveChat(call);
    } catch (err) {
      log.warn('livekit-voice: could not resolve the call chat; the call talks on the voice line', {
        platformId: call.platformId,
        err,
      });
      call.chat = null;
    }
    if (call.chat) {
      const { group, threadId, source } = call.chat;
      noteChat(call, 'choice', 'call talks in the agent chat', { chat: group.id, threadId, source });
    }
    return call.chat;
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
    // The chat the call talks in, for the page to show; resolved again when the caller joins.
    const chatGroup = (await refreshChat(call))?.group;
    const chat = chatGroup ? chatGroup.name || chatGroup.channel_type : undefined;
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
    reply(res, 200, JSON.stringify({ url: config.url, token, callId, agent: line.agent.name, chat }), JSON_HEADERS);
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
    void refreshChat(call);
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
    const chat = await refreshChat(call);
    const utteranceId = String(++call.utterances);
    const sender = chat?.sender ?? call.line.caller;
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
    try {
      if (chat) {
        await host.onInboundEvent({
          channelType: chat.group.channel_type,
          instance: chat.group.instance ?? chat.group.channel_type,
          platformId: chat.group.platform_id,
          threadId: chat.threadId,
          // Only the line's agent hears its call, whoever else is wired to the chat.
          agentGroupId: call.line.agentGroupId,
          message: { ...message, content: JSON.stringify(message.content) },
        });
      } else {
        await host.onInbound(call.platformId, message);
      }
    } catch (err) {
      log.error('livekit-voice: onInbound threw', { platformId: call.platformId, err });
      return reply(res, 500, 'Could not reach the agent');
    }
    if (chat) mirror(call.platformId, chat, `🎙 ${sender.name}: ${text}`);
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
      // The voice page as one self-contained document (inline module script and styles, data: fonts
      // and images); signaling to the LiveKit server. WebRTC media is not governed by connect-src.
      'Content-Security-Policy':
        "default-src 'self' 'unsafe-inline' blob: data:; " +
        `connect-src 'self' ${lk.protocol}//${lk.host} ${https}; media-src 'self' blob: mediastream:; ` +
        "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    };
  };

  const engine: LiveKitVoice = {
    async handleHttp(req, res, route, url, tokens, lineIdForToken) {
      if (route.startsWith('livekit/agent/')) return handleAgent(req, res, route, url);
      if (route === 'livekit') {
        if (req.method !== 'GET') return reply(res, 405, 'GET only');
        page ??= callPageHtml({ ...host.ui, transport: 'livekit' });
        res.writeHead(200, pageHeaders());
        res.end(page);
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
        if (call.state !== 'live' || call.ended || !call.chat || call.line.agentGroupId !== agentGroupId) continue;
        if (isCallChat(call.chat, chat)) push(call, { type: 'reply', text });
      }
    },

    chatTyping(chat) {
      for (const call of calls.values()) {
        if (call.state === 'live' && !call.ended && call.chat && isCallChat(call.chat, chat)) {
          push(call, { type: 'thinking' });
        }
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
