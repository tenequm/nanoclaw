/**
 * `/voice` (on Slack `!voice`, since Slack's client eats unknown slash commands), run in a chat
 * wired to an agent by someone core grants an owner or admin role over that agent, shows the
 * sender their call link for each such agent and makes this chat (and thread) the chat its calls
 * talk in. The first run creates the agent's line and makes the sender its caller; later runs by
 * the caller show the same link again (sealed under the host key, see src/secret-seal.ts) and end
 * no call. A line is shown and moved only by its caller: another admin is told whose it is.
 * `/voice new` re-mints the caller's own link, which ends a call made with the old one. The line's page
 * calls run the jev loop (src/modules/meet-jev/: the agent decides from the conversation when to answer)
 * where the host has the Jev key; `/voice plain` turns the line to the wake phrase and send word until
 * `/voice` (or `/voice jev`) is sent again. That opt-out lives in host memory: a restart returns it to jev.
 *
 * A message interceptor, so the command never reaches an agent's session: the link is the line's
 * credential. In a direct chat the reply carries it. In a group it goes only to the sender: a
 * private reply in the chat where the channel has one (Telegram's ephemeral messages), else their
 * direct chat. A known sender without the role is refused; an unknown sender or an unwired chat
 * gets nothing.
 *
 * The page call that link opens is here too (createCallPage): the `/voice` call kind of the call core
 * and the page's `livekit`, `livekit/token` and `livekit/end` routes, which voice-mode.ts serves.
 */
import type http from 'node:http';

import { AccessToken, TrackSource } from 'livekit-server-sdk';

import type { InboundEvent } from './adapter.js';
import { getChannelAdapterExact } from './channel-registry.js';
import { JEV_API_KEY } from '../config.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { mintVoiceModeLine, openVoiceModeLink } from '../db/voice-mode-lines.js';
import { log } from '../log.js';
import { ensureUserDm } from '../modules/permissions/user-dm.js';
import { registerMessageInterceptor } from '../router.js';
import { encryptionKey } from '../secret-seal.js';
import type { MessagingGroup } from '../types.js';
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
import {
  CALL_SPEECH_FORMAT_NOTE,
  callChatReplyNote,
  chatLabel,
  JSON_HEADERS,
  readJsonObject,
  reply,
  type CallKind,
  type LiveKitVoice,
  type LiveKitVoiceConfig,
} from './voice-mode-livekit.js';
import { linePlatformId } from './voice-mode-line.js';
import { callPageHtml, type VoiceModeUiConfig } from './voice-mode-page.js';
import { LIVEKIT_PROTOCOL_VERSION } from './voice-mode-protocol.js';

/** The call page URL for a token. */
export type CallUrlFn = (token: string) => string;

/** The live voice-mode adapter's page URLs (it knows the public origin), or null when the channel is not running. */
function liveCallUrl(): CallUrlFn | null {
  const adapter = liveVoiceAdapter();
  return adapter ? (token) => adapter.callUrl(token) : null;
}

/**
 * `/voice`, `/voice@<bot>` (Telegram groups) and, on Slack, `!voice`, with `new` (`renew`: mint a fresh
 * link), `plain` (the line's calls leave the jev loop) or `jev` (the default, said out loud) as the only
 * arguments that matter; null for any other message. `plain` and `jev` only when given.
 */
export function parseVoiceCommand(
  text: string,
  channelType: string,
): { renew: boolean; jev?: true; plain?: true } | null {
  const match = /^\s*([!/]voice(?:@\S*)?)(?!\S)(?:\s+(\S+))?/i.exec(text);
  if (!match) return null;
  if (match[1][0] === '!' && !BANG_CHANNELS.has(channelType)) return null;
  const arg = match[2]?.toLowerCase();
  return {
    renew: arg === 'new',
    ...(arg === 'jev' ? { jev: true as const } : {}),
    ...(arg === 'plain' ? { plain: true as const } : {}),
  };
}

/** Lines opted out of the jev loop, by platform id: `/voice plain` adds one, any other `/voice` removes it. */
const plainLines = new Set<string>();

/** Whether the line's next page call runs the jev loop (where the host has the Jev key). */
export const lineRunsJev = (platformId: string): boolean => !plainLines.has(platformId);

/** Why /voice shows no link for one agent. */
export type VoiceNoLinkReason =
  | 'voice-unavailable'
  | 'no-key'
  | 'other-caller'
  /** A link minted before links were sealed; the next call made with it seals it. */
  | 'unsealed'
  /** The sealed link does not open with this host's key; the next call made with it seals it again. */
  | 'unreadable';

/** What /voice did for one agent of the chat: the sender's link, or why there is none. */
export type VoiceTargetResult =
  | { ok: true; agentGroupId: string; agentName: string; link: string; replaced: boolean; lineId: string }
  | { ok: false; agentGroupId: string; agentName: string; reason: VoiceNoLinkReason; caller?: string };

/** What /voice did in a chat: nothing to say (unknown sender), a refusal, or one result per agent. */
export type VoiceCommandOutcome =
  | { kind: 'drop' }
  | { kind: 'refused' }
  | { kind: 'done'; results: VoiceTargetResult[] };

export interface VoiceRunOptions {
  /** The call page URL of a token; null when the voice-mode channel is not running here. */
  callUrl?: CallUrlFn | null;
  /** `/voice new`: re-mint the sender's own links. */
  renew?: boolean;
  /** The host key sealing links; null when it is not set up. */
  key?: Buffer | null;
  /** Only these agents (re-minting links that went where they should not). */
  agentGroupIds?: ReadonlySet<string>;
}

/**
 * /voice over a chat's wired agents: unknown senders are dropped silently, known senders without
 * an owner or admin role over any of them are refused. For every agent the sender administers: a
 * new line with this chat as its call chat, or, on the sender's own line, this chat as its call chat
 * and its link shown again (a fresh one with `renew`). Another caller's line is left alone, and
 * without a key nothing is minted or shown.
 */
export async function runVoiceCommand(
  mg: MessagingGroup,
  threadId: string | null,
  userId: string | null,
  { callUrl = liveCallUrl(), renew = false, key = encryptionKey(), agentGroupIds }: VoiceRunOptions = {},
): Promise<VoiceCommandOutcome> {
  const wirings = await administeredWirings(mg, userId, agentGroupIds);
  if (!wirings || !userId) return { kind: 'drop' };
  const results: VoiceTargetResult[] = [];
  for (const wiring of wirings) {
    const ag = await getAgentGroup(wiring.agent_group_id);
    if (!ag) continue;
    const agent = { agentGroupId: ag.id, agentName: ag.name };
    const noLink = (reason: VoiceNoLinkReason, caller?: string): VoiceTargetResult => ({
      ok: false,
      ...agent,
      reason,
      ...(caller ? { caller } : {}),
    });
    // A host without the channel or the key must not mint, rotate or move anything.
    if (!callUrl || !key) {
      results.push(noLink(callUrl ? 'no-key' : 'voice-unavailable'));
      continue;
    }
    const target = {
      agentGroupId: ag.id,
      ownerUserId: userId,
      messagingGroupId: mg.id,
      threadId: callThread(wiring, mg, threadId),
    };
    const minted = (token: string, lineId: string, replaced: boolean): VoiceTargetResult => {
      log.info('Voice mode link minted via /voice', { ...target, line: lineId, replaced });
      return { ok: true, ...agent, link: callUrl(token), replaced, lineId };
    };
    const claim = await claimLine(target, key);
    if (claim.kind === 'created') {
      results.push(minted(claim.token, claim.line.line_id, false));
      continue;
    }
    if (claim.kind === 'other-caller' || claim.kind === 'no-key') {
      results.push(noLink(claim.kind, claim.kind === 'other-caller' ? claim.caller : undefined));
      continue;
    }
    const line = claim.line;
    log.info('Voice mode call chat set via /voice', { ...target, line: line.line_id });
    if (renew) {
      const fresh = await mintVoiceModeLine(target, key);
      results.push(minted(fresh.token, fresh.line.line_id, true));
      continue;
    }
    const opened = await openVoiceModeLink(line, key);
    results.push(
      'token' in opened
        ? { ok: true, ...agent, link: callUrl(opened.token), replaced: false, lineId: line.line_id }
        : noLink(opened.missing),
    );
  }
  return results.length > 0 ? { kind: 'done', results } : { kind: 'refused' };
}

/** The command as the sender types it: Slack's client eats unknown slash commands. */
export const voiceCommandName = (channelType: string): string => commandName('voice', channelType);

/** The call links in an outcome, one line each; they are credentials, so they go to the sender only. */
export function voiceLinkLines(outcome: VoiceCommandOutcome): string[] {
  if (outcome.kind !== 'done') return [];
  return outcome.results.flatMap((r) => (r.ok ? [`🎙 Talk to ${r.agentName}: ${r.link}`] : []));
}

function noLinkLine(r: Extract<VoiceTargetResult, { ok: false }>, cmd: string): string {
  const fresh = `send ${cmd} new for a fresh one (calls on the old link end)`;
  switch (r.reason) {
    case 'voice-unavailable':
      return `${r.agentName}: voice calls are off on this host (the voice-mode channel is not configured).`;
    case 'no-key':
      return `${r.agentName}: call link storage is not set up on this host, so no link can be shown or made.`;
    case 'other-caller':
      return `${r.agentName}: this line is ${r.caller ?? 'another admin'}'s; only they can get its link or move its calls.`;
    case 'unsealed':
      return `${r.agentName}: calls now talk in this chat. Its link predates stored links: it shows here after its next call, or ${fresh}.`;
    case 'unreadable':
      return `${r.agentName}: calls now talk in this chat, but its stored link cannot be read on this host: it shows here after its next call, or ${fresh}.`;
  }
}

/** The line's mode after a /voice: none named where the host has no Jev key, as every call is plain then. */
export type VoiceMode = 'jev' | 'plain' | null;

/** The /voice reply, or null when the sender gets no answer. `mode`: what the line's calls now run. */
export function voiceCommandReply(outcome: VoiceCommandOutcome, cmd = '/voice', mode: VoiceMode = null): string | null {
  if (outcome.kind === 'drop') return null;
  if (outcome.kind === 'refused') return `Only an owner or admin of this agent can use ${cmd}.`;
  const links = voiceLinkLines(outcome);
  const notes = outcome.results.flatMap((r) => (r.ok ? [] : [noLinkLine(r, cmd)]));
  const replaced = outcome.results.some((r) => r.ok && r.replaced);
  const bound = `Calls talk in this chat, until ${cmd} is run in another one.${replaced ? ' Any earlier link no longer works.' : ''}`;
  const modeLine =
    mode === 'jev'
      ? `Calls on this link run in jev mode: the agent decides from the conversation when to answer. Send ${cmd} plain for the wake phrase and send word instead.`
      : mode === 'plain'
        ? `Calls on this link use the wake phrase and send word. Send ${cmd} to go back to jev mode.`
        : null;
  const shown = links.length > 0 ? [bound, ...(modeLine ? [modeLine] : [])] : [];
  return [...links, ...shown, ...notes].join('\n\n');
}

/** An explicit `/voice jev` needs the Jev key: without it every verdict fails silent and the agent never answers unaddressed. */
const noJev = (cmd: string) => `jev mode needs the Jev gate's JEV_API_KEY on this host; send ${cmd} without jev.`;

/**
 * Sends `text` so only the sender sees it, in the chat the command came from: `sent`, `unavailable`
 * (nothing was posted; fall back to the direct chat) or `public` (it was posted for everyone and
 * then deleted, so the links in it must be replaced).
 */
export type PrivateReply = (text: string) => Promise<'sent' | 'unavailable' | 'public'>;

const noDirectChat = (cmd: string) =>
  `I cannot message you privately here: start a direct chat with me, then run ${cmd} again.`;
const EXPOSED = 'The link I sent was visible to the whole chat, so it was replaced: calls made with it end.';
const notReplaced = (cmd: string) =>
  `The link I sent was visible to the whole chat and could not be replaced: send ${cmd} new to replace it.`;

/** An error's kind only: delivery errors can carry the request, and with it a call link. */
const errorKind = (err: unknown): string =>
  (err as { _tag?: string })?._tag ?? (err instanceof Error ? err.name : typeof err);

/**
 * Claims every /voice message; the agents never see one. Runs on every inbound message, so anything
 * that cannot be /voice leaves before parsing; `callUrlFor` defaults to the live adapter's, looked up
 * only for a command. `privateReply` is the chat's own sender-only reply, where the channel has one.
 */
export async function handleVoiceCommand(
  event: InboundEvent,
  callUrlFor?: CallUrlFn | null,
  privateReply?: PrivateReply,
): Promise<boolean> {
  if (event.message.kind !== 'chat' && event.message.kind !== 'chat-sdk') return false;
  if (!/voice/i.test(event.message.content)) return false;
  const command = parseVoiceCommand(messageText(event.message.content), event.channelType);
  if (!command) return false;
  const callUrl = callUrlFor === undefined ? liveCallUrl() : callUrlFor;

  const chat = await commandChat(event, '/voice');
  if (!chat) return true;
  const { adapter, instance, threadId, chatThread, mg, userId } = chat;
  const cmd = voiceCommandName(event.channelType);
  // Straight to the chat's adapter, never through a session: the agent must not hold the call link.
  const say = (text: string) => adapter.deliver(event.platformId, threadId, { kind: 'chat', content: { text } });
  const mode: VoiceMode = !JEV_API_KEY ? null : command.plain ? 'plain' : 'jev';
  try {
    if (command.jev && !JEV_API_KEY) {
      // Only someone who may run /voice here hears about the host's setup; others as for /voice.
      const mine = await administeredWirings(mg, userId);
      if (!mine) {
        log.info('/voice from an unknown sender dropped', { channelType: event.channelType });
        return true;
      }
      const text = mine.length > 0 ? noJev(cmd) : voiceCommandReply({ kind: 'refused' }, cmd)!;
      if (mg.is_group === 0 || !privateReply || (await privateReply(text)) !== 'sent') await say(text);
      return true;
    }
    // Without a private reply a group's links go to the direct chat: check it first, so /voice new ends no call for nothing.
    if (command.renew && mg.is_group !== 0 && !privateReply && !(await directChat(userId, instance))) {
      await say(noDirectChat(cmd));
      return true;
    }
    let outcome = await runVoiceCommand(mg, chatThread, userId, { callUrl, renew: command.renew });
    if (outcome.kind === 'done') {
      for (const r of outcome.results) {
        if (!r.ok) continue;
        if (command.plain) plainLines.add(linePlatformId(r.lineId));
        else plainLines.delete(linePlatformId(r.lineId));
      }
    }
    let text = voiceCommandReply(outcome, cmd, mode);
    if (text === null) {
      log.info('/voice from an unknown sender dropped', { channelType: event.channelType });
      return true;
    }
    if (mg.is_group === 0) {
      await say(text);
      return true;
    }
    /** What the group hears about a link that went public, once its replacement was tried. */
    let exposedNote: string | null = null;
    if (privateReply) {
      const sent = await privateReply(text);
      if (sent === 'sent') return true;
      const shown = outcome.kind === 'done' ? outcome.results.filter((r) => r.ok).map((r) => r.agentGroupId) : [];
      // A reply without a link held nothing secret: it is answered in the chat below, as when unavailable.
      if (sent === 'public' && shown.length > 0) {
        log.warn('/voice private reply was posted publicly; replacing its links', { channelType: event.channelType });
        const stale = (agentGroupIds: string[], err?: unknown) =>
          log.error('/voice links posted publicly were not replaced', {
            channelType: event.channelType,
            agentGroupIds,
            ...(err === undefined ? {} : { err: errorKind(err) }),
          });
        try {
          outcome = await runVoiceCommand(mg, chatThread, userId, {
            callUrl,
            renew: true,
            agentGroupIds: new Set(shown),
          });
        } catch (err) {
          stale(shown, err);
          await say(notReplaced(cmd));
          return true;
        }
        const replaced = new Set(
          outcome.kind === 'done' ? outcome.results.filter((r) => r.ok && r.replaced).map((r) => r.agentGroupId) : [],
        );
        const left = shown.filter((id) => !replaced.has(id));
        if (left.length > 0) stale(left);
        exposedNote = left.length > 0 ? notReplaced(cmd) : EXPOSED;
        text = [voiceCommandReply(outcome, cmd, mode), exposedNote].filter((t) => t !== null).join('\n\n');
      }
    }
    if (voiceLinkLines(outcome).length === 0) {
      await say(text);
      return true;
    }
    // A link is a credential: in a group without a private reply it only goes to the sender's direct chat.
    if (await sendDirect(userId, instance, text)) {
      await say('Your call link is in our direct chat.');
      return true;
    }
    const replaced = outcome.kind === 'done' && outcome.results.some((r) => r.ok && r.replaced);
    await say(
      [exposedNote ?? (replaced ? 'Any earlier link no longer works.' : null), noDirectChat(cmd)]
        .filter((t) => t !== null)
        .join(' '),
    );
  } catch (err) {
    log.warn('/voice reply could not be delivered', { channelType: event.channelType, err: errorKind(err) });
  }
  return true;
}

/** The user's direct chat and its adapter, or null when there is none. */
async function directChat(userId: string, instance: string) {
  const dm = await ensureUserDm(userId, { privacySafeLogs: true, instance });
  const dmAdapter = dm ? getChannelAdapterExact(dm.instance ?? dm.channel_type) : undefined;
  return dm && dmAdapter ? { dm, dmAdapter } : null;
}

/** Deliver to the user's direct chat; false when there is none or the send failed. */
async function sendDirect(userId: string, instance: string, text: string): Promise<boolean> {
  const direct = await directChat(userId, instance);
  if (!direct) return false;
  const { dm, dmAdapter } = direct;
  try {
    await dmAdapter.deliver(dm.platform_id, null, { kind: 'chat', content: { text } });
    return true;
  } catch (err) {
    log.warn('/voice could not reach the direct chat', { channelType: dm.channel_type, err: errorKind(err) });
    return false;
  }
}

registerMessageInterceptor((event) => handleVoiceCommand(event));

/** How long the caller's page has to join the room after it got its token. */
const CALL_JOIN_TIMEOUT_MS = 60_000;
const CALLER_TOKEN_TTL_SECONDS = 120;
/** The page's `livekit/end` body is a call id and a reason. */
const MAX_END_BODY_BYTES = 1024;

/** The 409 answer to a start on a line with no chat to talk in; the page tells it by `error`, not the status. */
const NO_CHAT_REFUSAL = JSON.stringify({
  error: 'no-chat',
  message: 'This voice line has no chat to talk in. Run /voice in a chat with the agent.',
});

/**
 * The 426 answer to a start from a client of another protocol version, before any room exists. Native
 * clients match the status and the words "update your client".
 */
const PROTOCOL_REFUSAL = JSON.stringify({
  error: 'protocol',
  protocol: LIVEKIT_PROTOCOL_VERSION,
  message: `The voice service is updating. Reload the page or update your client to protocol ${LIVEKIT_PROTOCOL_VERSION}.`,
});

/**
 * What every jev call turn tells the agent besides the loop's own note (the conversation and when to
 * stay silent): the loop, not every message, decides what is read aloud.
 */
export const jevCallReplyNote = (languageNote: string): string =>
  'Spoken on a live voice call; a reply you send to this chat is read aloud word for word unless the ' +
  `conversation has moved on. ${CALL_SPEECH_FORMAT_NOTE} ${languageNote}`;

/** The `/voice` call: the caller's own page joins the room, as the line's caller. `jev`: it runs the jev loop. */
function pageCallKind(maxCallDurationMs: number, jev = false): CallKind {
  return {
    roomPrefix: 'voice',
    joinTimeoutMs: CALL_JOIN_TIMEOUT_MS,
    maxDurationMs: maxCallDurationMs,
    room: { emptyTimeout: 60, departureTimeout: 10, maxParticipants: 2 },
    job: ({ callId }) => ({ callerIdentity: `caller-${callId.slice(0, 8)}`, ...(jev ? { jev: true } : {}) }),
    // Always the line's own caller, wherever the call talks: the line is that person's, not whoever ran /voice.
    sender: (line) => line.caller,
    turnNote: jev ? jevCallReplyNote : callChatReplyNote,
  };
}

/** What the page call needs of the voice adapter. */
export interface CallPageConfig {
  livekit: Pick<LiveKitVoiceConfig, 'url' | 'apiKey' | 'apiSecret'>;
  maxCallDurationMs: number;
  ui?: VoiceModeUiConfig;
  /** The line a link token opens, by platform id, or null. */
  lineForToken(token: string): Promise<string | null>;
}

/** The `/voice` page call over the call core: its kind and the page's `livekit`, `livekit/token` and `livekit/end` routes. */
export function createCallPage(
  core: Pick<LiveKitVoice, 'openCall' | 'endCall' | 'isLive'>,
  config: CallPageConfig,
): { handle(req: http.IncomingMessage, res: http.ServerResponse, route: string, url: URL): Promise<void> } {
  const { lineForToken } = config;
  const pageCall = pageCallKind(config.maxCallDurationMs);
  const jevPageCall = pageCallKind(config.maxCallDurationMs, true);
  let page: string | undefined;

  /** The page call's token: it joins that room only, as the caller the worker waits for. */
  const callerToken = (call: { roomName: string; callerIdentity: string }, name: string): Promise<string> => {
    const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
      identity: call.callerIdentity,
      name,
      ttl: CALLER_TOKEN_TTL_SECONDS,
    });
    at.addGrant({
      roomJoin: true,
      room: call.roomName,
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE],
      canSubscribe: true,
      // Review mode's RPCs to the worker travel as data packets; LiveKit has no grant for RPC alone.
      // The worker answers its review methods only from this identity, and closes agents-js's own
      // session control topic, so this reaches nothing else.
      canPublishData: true,
      canUpdateOwnMetadata: false,
    });
    return at.toJwt();
  };

  /** Open a page call and hand the caller a token for its room only. `jev`: the call runs the jev loop. */
  const startPageCall = async (res: http.ServerResponse, platformId: string, jev: boolean): Promise<void> => {
    const opened = await core.openCall(platformId, jev ? jevPageCall : pageCall);
    if (!opened.ok) {
      switch (opened.error) {
        case 'no-line':
          return reply(res, 403, 'Caller access denied or voice line is not set up');
        case 'no-chat':
          return reply(res, 409, NO_CHAT_REFUSAL, JSON_HEADERS);
        case 'limit':
          return reply(res, 429, opened.body, { 'Retry-After': opened.retryAfter });
        case 'room':
          return reply(res, 502, 'livekit-voice-mode: could not open the call room');
        case 'stopped':
          return reply(res, 409, 'This call attempt is no longer active');
      }
    }
    const { call, chat, job, limit } = opened;
    let token: string;
    try {
      token = await callerToken(call, call.line.caller.name);
    } catch (err) {
      log.warn('livekit-voice-mode: room setup failed', { platformId, callId: call.callId, err });
      void core.endCall(platformId, call.callId, 'room setup failed');
      return reply(res, 502, 'livekit-voice-mode: could not open the call room');
    }
    // Replaced, ended or torn down while the token was signed: its own end deleted the room.
    if (!core.isLive(platformId, call.callId)) return reply(res, 409, 'This call attempt is no longer active');
    if (res.destroyed) {
      // The page went away during setup and never gets the token, so nobody joins the room.
      log.info('livekit-voice-mode: page left during call setup', { platformId, callId: call.callId });
      void core.endCall(platformId, call.callId, 'page left during call setup');
      return;
    }
    log.info('livekit-voice-mode: call started', {
      platformId,
      callId: call.callId,
      room: call.roomName,
      agent: job.agentName,
      sttModel: job.sttModel,
      tts: job.tts,
      ...(job.jev ? { jev: true } : {}),
    });
    // What the page needs for its hints: the silence that sends a turn, and the cap that ends the call.
    reply(
      res,
      200,
      JSON.stringify({
        protocol: LIVEKIT_PROTOCOL_VERSION,
        url: config.livekit.url,
        token,
        callId: call.callId,
        agent: job.agentName,
        chat: chatLabel(chat.group),
        silenceMs: job.silenceMs,
        limit,
      }),
      JSON_HEADERS,
    );
  };

  const pageHeaders = (): Record<string, string> => {
    const lk = new URL(config.livekit.url);
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

  /** The page call's routes: `livekit` (the page), `livekit/token` (start a call) and `livekit/end`. */
  const handleCallPage = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: string,
    url: URL,
  ): Promise<void> => {
    if (route === 'livekit') {
      if (req.method !== 'GET') return reply(res, 405, 'GET only');
      page ??= callPageHtml(config.ui);
      res.writeHead(200, pageHeaders());
      res.end(page);
      return;
    }
    if (req.method !== 'POST') return reply(res, 405, 'POST only');
    const platformId = await lineForToken(url.searchParams.get('t') ?? '');
    if (!platformId) return reply(res, 403, 'Unknown call link');
    if (route === 'livekit/token') {
      if (url.searchParams.get('v') !== String(LIVEKIT_PROTOCOL_VERSION)) {
        return reply(res, 426, PROTOCOL_REFUSAL, JSON_HEADERS);
      }
      // A client may choose per call (`jev=1` / `jev=0`); otherwise jev, unless /voice plain opted the line out.
      // Without the Jev key every verdict fails silent, so the call is a plain one.
      const asked = url.searchParams.get('jev');
      const jev = asked === '1' ? true : asked === '0' ? false : lineRunsJev(platformId);
      return startPageCall(res, platformId, jev && !!JEV_API_KEY);
    }
    if (route === 'livekit/end') {
      const body = await readJsonObject(req, MAX_END_BODY_BYTES, {});
      if (body) {
        // The page gave up waiting for the worker, or the worker said it runs another version.
        const reason =
          body.reason === 'no-agent'
            ? 'no voice worker joined (worker down, or not on this protocol version)'
            : body.reason === 'updating'
              ? 'the voice worker is on another protocol version'
              : 'hangup';
        await core.endCall(platformId, body.callId, reason, { grace: reason === 'hangup' });
      }
      return reply(res, 204, '');
    }
    reply(res, 404, 'Not found');
  };

  return { handle: handleCallPage };
}
