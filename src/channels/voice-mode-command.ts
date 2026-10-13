/**
 * `/voice` (on Slack `!voice`, since Slack's client eats unknown slash commands), run in a chat
 * wired to an agent by someone core grants an owner or admin role over that agent, shows the
 * sender their call link for each such agent and makes this chat (and thread) the chat its calls
 * talk in. The first run creates the agent's line and makes the sender its caller; later runs by
 * the caller show the same link again (sealed under the host key, see src/secret-seal.ts) and end
 * no call. A line is shown and moved only by its caller: another admin is told whose it is.
 * `/voice new` re-mints the caller's own link, which ends a call made with the old one.
 *
 * A message interceptor, so the command never reaches an agent's session: the link is the line's
 * credential. In a direct chat the reply carries it. In a group it goes only to the sender: a
 * private reply in the chat where the channel has one (Telegram's ephemeral messages), else their
 * direct chat. A known sender without the role is refused; an unknown sender or an unwired chat
 * gets nothing.
 */
import type { InboundEvent } from './adapter.js';
import { wiringThreadsEnabled } from './channel-defaults.js';
import { getChannelAdapter, getChannelAdapterExact } from './channel-registry.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import {
  bindVoiceModeLineChat,
  createVoiceModeLine,
  getVoiceModeLineForAgent,
  mintVoiceModeLine,
  openVoiceModeLink,
} from '../db/voice-mode-lines.js';
import { log } from '../log.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import { getUser } from '../modules/permissions/db/users.js';
import { ensureUserDm } from '../modules/permissions/user-dm.js';
import { registerMessageInterceptor } from '../router.js';
import { encryptionKey } from '../secret-seal.js';
import type { MessagingGroup } from '../types.js';
import type { VoiceModeChannelAdapter } from './voice-mode.js';
import { VOICE_MODE_CHANNEL } from './voice-mode-line.js';

/** Channels whose client intercepts `/`: the command is typed `!voice` there. */
const BANG_CHANNELS = new Set(['slack']);

/** The call page URL for a token. */
export type CallUrlFn = (token: string) => string;

const liveAdapter = () => getChannelAdapterExact(VOICE_MODE_CHANNEL) as VoiceModeChannelAdapter | undefined;

/** The live voice-mode adapter's page URLs (it knows the public origin), or null when the channel is not running. */
function liveCallUrl(): CallUrlFn | null {
  const adapter = liveAdapter();
  return adapter ? (token) => adapter.callUrl(token) : null;
}

function messageText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text.trim() : '';
  } catch {
    return content.trim();
  }
}

/**
 * `/voice`, `/voice@<bot>` (Telegram groups) and, on Slack, `!voice`, with `new` as the only argument
 * that matters (`renew`: mint a fresh link); null for any other message.
 */
export function parseVoiceCommand(text: string, channelType: string): { renew: boolean } | null {
  const match = /^\s*([!/]voice(?:@\S*)?)(?!\S)(?:\s+(\S+))?/i.exec(text);
  if (!match) return null;
  if (match[1][0] === '!' && !BANG_CHANNELS.has(channelType)) return null;
  return { renew: match[2]?.toLowerCase() === 'new' };
}

/** The sender's namespaced user id, read the way the permissions module reads it; no row is created. */
export function senderUserId(event: InboundEvent): string | null {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(event.message.content) as Record<string, unknown>;
  } catch {
    return null;
  }
  const author = typeof content.author === 'object' && content.author !== null ? content.author : undefined;
  const handle = [content.senderId, content.sender, (author as { userId?: unknown } | undefined)?.userId].find(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  if (!handle) return null;
  return handle.includes(':') ? handle : `${event.channelType}:${handle}`;
}

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
  | { ok: true; agentGroupId: string; agentName: string; link: string; replaced: boolean }
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
  if (!userId || !(await getUser(userId))) return { kind: 'drop' };
  const wirings = await getMessagingGroupAgents(mg.id);
  if (wirings.length === 0) return { kind: 'drop' };
  const results: VoiceTargetResult[] = [];
  for (const wiring of wirings) {
    if (agentGroupIds && !agentGroupIds.has(wiring.agent_group_id)) continue;
    if (!(await hasAdminPrivilege(userId, wiring.agent_group_id))) continue;
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
    // None when the wiring keeps no threads, else the one /voice was run in.
    const callThread = threadId !== null && wiringThreadsEnabled(wiring, mg) ? threadId : null;
    const target = { agentGroupId: ag.id, ownerUserId: userId, messagingGroupId: mg.id, threadId: callThread };
    const minted = (token: string, lineId: string, replaced: boolean): VoiceTargetResult => {
      log.info('Voice mode link minted via /voice', { ...target, line: lineId, replaced });
      return { ok: true, ...agent, link: callUrl(token), replaced };
    };
    // A plain run only creates a line: one another run created meanwhile keeps its caller and link.
    const created = (await getVoiceModeLineForAgent(ag.id)) ? undefined : await createVoiceModeLine(target, key);
    if (created) {
      results.push(minted(created.token, created.line.line_id, false));
      continue;
    }
    const line = await bindVoiceModeLineChat({
      agentGroupId: ag.id,
      callerUserId: userId,
      messagingGroupId: mg.id,
      threadId: callThread,
    });
    if (!line) {
      const owner = (await getVoiceModeLineForAgent(ag.id))?.owner_user_id;
      results.push(noLink('other-caller', owner ? ((await getUser(owner))?.display_name ?? undefined) : undefined));
      continue;
    }
    log.info('Voice mode call chat set via /voice', { ...target, line: line.line_id });
    if (renew) {
      const fresh = await mintVoiceModeLine(target, key);
      results.push(minted(fresh.token, fresh.line.line_id, true));
      continue;
    }
    const opened = await openVoiceModeLink(line, key);
    results.push(
      'token' in opened ? { ok: true, ...agent, link: callUrl(opened.token), replaced: false } : noLink(opened.missing),
    );
  }
  return results.length > 0 ? { kind: 'done', results } : { kind: 'refused' };
}

/** The command as the sender types it: Slack's client eats unknown slash commands. */
export const voiceCommandName = (channelType: string): string => (BANG_CHANNELS.has(channelType) ? '!voice' : '/voice');

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

/** The /voice reply, or null when the sender gets no answer. */
export function voiceCommandReply(outcome: VoiceCommandOutcome, cmd = '/voice'): string | null {
  if (outcome.kind === 'drop') return null;
  if (outcome.kind === 'refused') return `Only an owner or admin of this agent can use ${cmd}.`;
  const links = voiceLinkLines(outcome);
  const notes = outcome.results.flatMap((r) => (r.ok ? [] : [noLinkLine(r, cmd)]));
  const replaced = outcome.results.some((r) => r.ok && r.replaced);
  const bound = `Calls talk in this chat, until ${cmd} is run in another one.${replaced ? ' Any earlier link no longer works.' : ''}`;
  return [...links, ...(links.length > 0 ? [bound] : []), ...notes].join('\n\n');
}

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

  const instance = event.instance ?? event.channelType;
  const adapter = getChannelAdapterExact(instance);
  if (!adapter) {
    log.warn('/voice dropped: the chat adapter is offline', { channelType: event.channelType });
    return true;
  }
  // Mirror the router: a platform without threads collapses them to the chat.
  const threadId = getChannelAdapter(instance)?.supportsThreads ? event.threadId : null;
  // Slack gives every top-level message a thread of its own (its ts); a top-level command means the chat itself.
  const chatThread = threadId !== null && threadId === `${event.platformId}:${event.message.id}` ? null : threadId;
  const mg = await getMessagingGroupByPlatform(event.channelType, event.platformId, instance);
  const userId = senderUserId(event);
  const cmd = voiceCommandName(event.channelType);
  if (!mg || mg.denied_at || !userId) {
    log.info('/voice from an unknown sender or an unwired chat dropped', {
      channelType: event.channelType,
      platformId: event.platformId,
    });
    return true;
  }
  // Straight to the chat's adapter, never through a session: the agent must not hold the call link.
  const say = (text: string) => adapter.deliver(event.platformId, threadId, { kind: 'chat', content: { text } });
  try {
    // Without a private reply a group's links go to the direct chat: check it first, so /voice new ends no call for nothing.
    if (command.renew && mg.is_group !== 0 && !privateReply && !(await directChat(userId, instance))) {
      await say(noDirectChat(cmd));
      return true;
    }
    let outcome = await runVoiceCommand(mg, chatThread, userId, { callUrl, renew: command.renew });
    let text = voiceCommandReply(outcome, cmd);
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
        text = [voiceCommandReply(outcome, cmd), exposedNote].filter((t) => t !== null).join('\n\n');
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
