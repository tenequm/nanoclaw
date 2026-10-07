/**
 * `/voice` (on Slack `!voice`, since Slack's client eats unknown slash commands), run in a chat
 * wired to an agent by someone core grants an owner or admin role over that agent, makes this chat
 * (and thread) the chat the agent's calls talk in. The first run creates the agent's voice line,
 * mints its call link and sends it to the sender, who becomes the line's caller; later runs only
 * move the call chat, so the link and any live call stay. `/voice new` mints a fresh link instead:
 * only the hash is stored, so a lost link cannot be shown again, and re-minting is how a lost or
 * leaked one is replaced (a call made with the old link ends).
 *
 * A message interceptor, so the command never reaches an agent's session: the link is the line's
 * credential. In a direct chat the reply carries it; in a group chat it goes to the sender's direct
 * chat, so the other members never see it. A known sender without the role is refused; an unknown
 * sender or an unwired chat gets nothing.
 */
import type { InboundEvent } from './adapter.js';
import { wiringThreadsEnabled } from './voice-mode-integration.js';
import { getChannelAdapter, getChannelAdapterExact } from './channel-registry.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import {
  bindVoiceModeLineChat,
  createVoiceModeLine,
  getVoiceModeLineForAgent,
  mintVoiceModeLine,
} from '../db/voice-mode-lines.js';
import { log } from '../log.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import { getUser } from '../modules/permissions/db/users.js';
import { ensureUserDm } from '../modules/permissions/user-dm.js';
import { registerMessageInterceptor } from '../router.js';
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

async function handsOutLink(mg: MessagingGroup, userId: string, renew: boolean): Promise<'mint' | null> {
  if (!(await getUser(userId))) return null;
  for (const wiring of await getMessagingGroupAgents(mg.id)) {
    if (!(await hasAdminPrivilege(userId, wiring.agent_group_id))) continue;
    if (renew) return 'mint';
    if (!(await getVoiceModeLineForAgent(wiring.agent_group_id))) return 'mint';
  }
  return null;
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

/** What /voice did for one agent of the chat: a new link, the call chat moved, or nothing. */
export type VoiceTargetResult =
  | { ok: true; agentName: string; link: string; replaced: boolean }
  | { ok: true; agentName: string; rebound: true }
  | { ok: false; agentName: string; reason: 'voice-unavailable' | 'other-caller' };

/** What /voice did in a chat: nothing to say (unknown sender), a refusal, or one result per agent. */
export type VoiceCommandOutcome =
  | { kind: 'drop' }
  | { kind: 'refused' }
  | { kind: 'done'; results: VoiceTargetResult[] };

/**
 * /voice over a chat's wired agents: unknown senders are dropped silently, known senders without
 * an owner or admin role over any of them are refused, and for every agent the sender administers
 * this chat becomes its line's call chat. An agent without a line gets one with a fresh link; a
 * line only its caller moves, so another admin's call never starts talking in their chat.
 * With `renew` (`/voice new`) the line's link
 * is re-minted for the sender, which ends a call made with the old one.
 */
export async function runVoiceCommand(
  mg: MessagingGroup,
  threadId: string | null,
  userId: string | null,
  callUrl: CallUrlFn | null = liveCallUrl(),
  renew = false,
): Promise<VoiceCommandOutcome> {
  if (!userId || !(await getUser(userId))) return { kind: 'drop' };
  const wirings = await getMessagingGroupAgents(mg.id);
  if (wirings.length === 0) return { kind: 'drop' };
  const results: VoiceTargetResult[] = [];
  for (const wiring of wirings) {
    if (!(await hasAdminPrivilege(userId, wiring.agent_group_id))) continue;
    const ag = await getAgentGroup(wiring.agent_group_id);
    if (!ag) continue;
    // A host without the channel must not rotate a working link away.
    if (!callUrl) {
      results.push({ ok: false, agentName: ag.name, reason: 'voice-unavailable' });
      continue;
    }
    // None when the wiring keeps no threads, else the one /voice was run in.
    const callThread = threadId !== null && wiringThreadsEnabled(wiring, mg) ? threadId : null;
    const current = await getVoiceModeLineForAgent(ag.id);
    /** This chat becomes the line's call chat if the sender is its caller; otherwise the line is another admin's. */
    const bindHere = async (): Promise<VoiceTargetResult> => {
      const moved = await bindVoiceModeLineChat({
        agentGroupId: ag.id,
        callerUserId: userId,
        messagingGroupId: mg.id,
        threadId: callThread,
      });
      if (!moved) return { ok: false, agentName: ag.name, reason: 'other-caller' };
      log.info('Voice mode call chat moved via /voice', {
        agentGroupId: ag.id,
        line: moved.line_id,
        messagingGroupId: mg.id,
        threadId: callThread,
        userId,
      });
      return { ok: true, agentName: ag.name, rebound: true };
    };
    if (!renew && current) {
      results.push(await bindHere());
      continue;
    }
    const replaced = renew && current !== undefined;
    const target = { agentGroupId: ag.id, ownerUserId: userId, messagingGroupId: mg.id, threadId: callThread };
    // A plain run only creates a line: one another run created meanwhile keeps the link it handed out.
    const minted = renew ? await mintVoiceModeLine(target) : await createVoiceModeLine(target);
    if (!minted) {
      results.push(await bindHere());
      continue;
    }
    const { line, token } = minted;
    log.info('Voice mode link minted via /voice', {
      agentGroupId: ag.id,
      line: line.line_id,
      messagingGroupId: mg.id,
      threadId: callThread,
      replaced,
      userId,
    });
    results.push({ ok: true, agentName: ag.name, link: callUrl(token), replaced });
  }
  return results.length > 0 ? { kind: 'done', results } : { kind: 'refused' };
}

const UNAVAILABLE = 'Voice calls are off on this host (the voice-mode channel is not configured).';
const NEW_LINK_NOTE = 'Any earlier link no longer works.';
const boundNote = (cmd: string) => `Calls now talk in this chat, until ${cmd} is run in another one.`;
const lostLinkNote = (cmd: string) => `Lost the link? Send ${cmd} new for a fresh one (the old one stops working).`;

/** The command as the sender types it: Slack's client eats unknown slash commands. */
export const voiceCommandName = (channelType: string): string => (BANG_CHANNELS.has(channelType) ? '!voice' : '/voice');

/** The call links /voice hands out, one line each; they are credentials, so they go to the sender only. */
export function voiceLinkLines(outcome: VoiceCommandOutcome): string[] {
  if (outcome.kind !== 'done') return [];
  return outcome.results.flatMap((r) => ('link' in r ? [`🎙 Talk to ${r.agentName}: ${r.link}`] : []));
}

/** What the chat hears about agents whose call chat moved here, or stayed with another caller, links aside. */
function chatLines(outcome: VoiceCommandOutcome, cmd: string): string[] {
  if (outcome.kind !== 'done') return [];
  const rebound = outcome.results.flatMap((r) => ('rebound' in r ? [r.agentName] : []));
  const taken = outcome.results.flatMap((r) => (!r.ok && r.reason === 'other-caller' ? [r.agentName] : []));
  return [
    ...(rebound.length > 0 ? [`Calls with ${rebound.join(', ')} now talk in this chat. ${lostLinkNote(cmd)}`] : []),
    ...(taken.length > 0
      ? [
          `Calls with ${taken.join(', ')} are on another admin's link, so they stay where they talk. Send ${cmd} new to take the line over (that link stops working).`,
        ]
      : []),
  ];
}

const linkReplaced = (outcome: VoiceCommandOutcome): boolean =>
  outcome.kind === 'done' && outcome.results.some((r) => 'link' in r && r.replaced);

/** The /voice reply with the links, or null when the sender gets no answer. */
export function voiceCommandReply(outcome: VoiceCommandOutcome, cmd = '/voice'): string | null {
  if (outcome.kind === 'drop') return null;
  if (outcome.kind === 'refused') return `Only an owner or admin of this agent can use ${cmd}.`;
  const links = voiceLinkLines(outcome);
  const others = chatLines(outcome, cmd);
  if (links.length > 0) {
    const bound = boundNote(cmd);
    return [...links, linkReplaced(outcome) ? `${bound} ${NEW_LINK_NOTE}` : bound, ...others].join('\n\n');
  }
  if (others.length > 0) return others.join('\n\n');
  const several = outcome.results.length > 1;
  return [...new Set(outcome.results.map((r) => (several ? `${r.agentName}: ${UNAVAILABLE}` : UNAVAILABLE)))].join(
    '\n',
  );
}

const noDirectChat = (cmd: string) => `I cannot message you directly here: run ${cmd} in a direct chat with me.`;
const undeliveredLink = (cmd: string) => `I could not deliver your call link; run ${cmd} new for a fresh link.`;

/**
 * Claims every /voice message; the agents never see one. Runs on every inbound message, so anything
 * that cannot be /voice leaves before parsing; `callUrlFor` defaults to the live adapter's, looked up
 * only for a command.
 */
export async function handleVoiceCommand(event: InboundEvent, callUrlFor?: CallUrlFn | null): Promise<boolean> {
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
  /** Set while links are on their way: if delivery fails, the sender must hear the link is lost. */
  let sendingLinks: VoiceCommandOutcome | null = null;
  try {
    // A group command must establish private delivery before minting a bearer credential.
    let direct: { adapter: typeof adapter; platformId: string } | null = null;
    const handout = mg.is_group !== 0 && callUrl ? await handsOutLink(mg, userId, command.renew) : null;
    if (handout) {
      const dm = await ensureUserDm(userId, { privacySafeLogs: true, instance });
      const dmAdapter = dm ? getChannelAdapterExact(dm.instance ?? dm.channel_type) : undefined;
      if (dm && dmAdapter) direct = { adapter: dmAdapter, platformId: dm.platform_id };
      else {
        await adapter.deliver(event.platformId, threadId, { kind: 'chat', content: { text: noDirectChat(cmd) } });
        return true;
      }
    }
    const outcome = await runVoiceCommand(mg, chatThread, userId, callUrl, command.renew);
    const text = voiceCommandReply(outcome, cmd);
    if (text === null) {
      log.info('/voice from an unknown sender dropped', { channelType: event.channelType });
      return true;
    }
    const links = voiceLinkLines(outcome);
    if (links.length > 0) sendingLinks = outcome;
    if (mg.is_group !== 0 && links.length > 0) {
      // A link is a credential: in a group it only ever goes to the sender's direct chat.
      const groupText = direct
        ? [`${boundNote(cmd)} Your call link is in our direct chat.`, ...chatLines(outcome, cmd)].join('\n\n')
        : noDirectChat(`${cmd} new`);
      if (direct) {
        const directText = [...links, ...(linkReplaced(outcome) ? [NEW_LINK_NOTE] : [])].join('\n\n');
        await direct.adapter.deliver(direct.platformId, null, { kind: 'chat', content: { text: directText } });
        sendingLinks = null;
      }
      await adapter.deliver(event.platformId, threadId, { kind: 'chat', content: { text: groupText } });
      return true;
    }
    // Straight to the chat's adapter, never through a session: the agent must not hold the call link.
    await adapter.deliver(event.platformId, threadId, { kind: 'chat', content: { text } });
    sendingLinks = null;
  } catch (err) {
    log.warn('/voice reply could not be delivered', { channelType: event.channelType, err });
    if (sendingLinks) {
      await adapter
        .deliver(event.platformId, threadId, { kind: 'chat', content: { text: undeliveredLink(cmd) } })
        .catch((notice: unknown) =>
          log.warn('/voice could not say its link was lost', { channelType: event.channelType, err: notice }),
        );
    }
  }
  return true;
}

registerMessageInterceptor((event) => handleVoiceCommand(event));
