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
import { resolveThreadPolicy } from './channel-defaults.js';
import { getChannelAdapter, getChannelAdapterExact, getChannelDefaults } from './channel-registry.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import {
  bindVoiceModeLineChat,
  getVoiceModeLineForAgent,
  getLegacyVoiceModeLinesForAgent,
  mintVoiceModeLine,
} from '../db/voice-mode-lines.js';
import { isVoiceLineOwner, setVoiceLineTarget } from '../db/voice-lines.js';
import { log } from '../log.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import { getUser } from '../modules/permissions/db/users.js';
import { ensureUserDm } from '../modules/permissions/user-dm.js';
import { registerMessageInterceptor } from '../router.js';
import type { MessagingGroup, MessagingGroupAgent } from '../types.js';
import type { VoiceModeChannelAdapter } from './voice-mode.js';

/** Channels whose client intercepts `/`: the command is typed `!voice` there. */
const BANG_CHANNELS = new Set(['slack']);

/** The call page URL for a token. */
export type CallUrlFn = (token: string) => string;

/** The live voice-mode adapter's page URLs (it knows the public origin), or null when the channel is not running. */
function liveCallUrl(): CallUrlFn | null {
  const adapter = getChannelAdapterExact('voice-mode') as VoiceModeChannelAdapter | undefined;
  return adapter ? (token) => adapter.callUrl(token) : null;
}

/** Whether /voice from this sender would mint a link: `new`, or an administered agent without a line yet. */
async function mintsAnyLink(mg: MessagingGroup, userId: string, renew: boolean): Promise<boolean> {
  if (!(await getUser(userId))) return false;
  for (const wiring of await getMessagingGroupAgents(mg.id)) {
    if (!(await hasAdminPrivilege(userId, wiring.agent_group_id))) continue;
    if (
      renew ||
      (!(await getVoiceModeLineForAgent(wiring.agent_group_id)) &&
        (await getLegacyVoiceModeLinesForAgent(wiring.agent_group_id)).length === 0)
    )
      return true;
  }
  return false;
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
  const [command = '', arg = ''] = text.toLowerCase().split(/\s+/);
  const matches =
    command === '!voice' ? BANG_CHANNELS.has(channelType) : command === '/voice' || command.startsWith('/voice@');
  return matches ? { renew: arg === 'new' } : null;
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

/** The thread a call should talk in: none when the wiring keeps no threads, else the one /voice was run in. */
function callChatThread(wiring: MessagingGroupAgent, mg: MessagingGroup, threadId: string | null): string | null {
  if (threadId === null) return null;
  const adapter = getChannelAdapter(mg.instance ?? mg.channel_type);
  const threads = resolveThreadPolicy(
    wiring.threads ?? null,
    getChannelDefaults(mg.instance ?? mg.channel_type, mg.channel_type),
    mg.is_group === 1,
    adapter?.supportsThreads === true,
  );
  return threads ? threadId : null;
}

/**
 * /voice over a chat's wired agents: unknown senders are dropped silently, known senders without
 * an owner or admin role over any of them are refused, and for every agent the sender administers
 * this chat becomes its line's call chat. An agent without a line gets one with a fresh link; a
 * line only its caller moves, so another admin's call never starts talking in their chat. With
 * `renew` (`/voice new`) the line's link is re-minted for the sender, which ends a call made with
 * the old one.
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
    const callThread = callChatThread(wiring, mg, threadId);
    if (!renew && !(await getVoiceModeLineForAgent(ag.id))) {
      const legacy = await getLegacyVoiceModeLinesForAgent(ag.id);
      if (legacy.length) {
        let rebound = false;
        for (const line of legacy) {
          if (!(await isVoiceLineOwner(line.id, userId))) continue;
          rebound =
            (await setVoiceLineTarget({
              lineMessagingGroupId: line.id,
              ownerUserId: userId,
              targetMessagingGroupId: mg.id,
              threadId: callThread,
            })) || rebound;
        }
        results.push(
          rebound
            ? { ok: true, agentName: ag.name, rebound: true }
            : { ok: false, agentName: ag.name, reason: 'other-caller' },
        );
        continue;
      }
    }
    if (!renew) {
      const moved = await bindVoiceModeLineChat({
        agentGroupId: ag.id,
        callerUserId: userId,
        messagingGroupId: mg.id,
        threadId: callThread,
      });
      if (moved) {
        log.info('Voice mode call chat moved via /voice', {
          agentGroupId: ag.id,
          line: moved.line_id,
          messagingGroupId: mg.id,
          threadId: callThread,
          userId,
        });
        results.push({ ok: true, agentName: ag.name, rebound: true });
        continue;
      }
      if (await getVoiceModeLineForAgent(ag.id)) {
        results.push({ ok: false, agentName: ag.name, reason: 'other-caller' });
        continue;
      }
    }
    const replaced =
      renew &&
      ((await getVoiceModeLineForAgent(ag.id)) !== undefined ||
        (await getLegacyVoiceModeLinesForAgent(ag.id)).length > 0);
    const { line, token } = await mintVoiceModeLine({
      agentGroupId: ag.id,
      ownerUserId: userId,
      messagingGroupId: mg.id,
      threadId: callThread,
    });
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

/** Claims every /voice message; the agents never see one. */
export async function handleVoiceCommand(
  event: InboundEvent,
  callUrl: CallUrlFn | null = liveCallUrl(),
): Promise<boolean> {
  if (event.message.kind !== 'chat' && event.message.kind !== 'chat-sdk') return false;
  const command = parseVoiceCommand(messageText(event.message.content), event.channelType);
  if (!command) return false;

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
  try {
    // In a group the link must reach the sender privately; without a direct chat nothing is minted.
    let direct: { adapter: typeof adapter; platformId: string } | null = null;
    if (mg.is_group !== 0 && callUrl && (await mintsAnyLink(mg, userId, command.renew))) {
      const dm = await ensureUserDm(userId, { privacySafeLogs: true, instance });
      const dmAdapter = dm ? getChannelAdapterExact(dm.instance ?? dm.channel_type) : undefined;
      if (!dm || !dmAdapter) {
        await adapter.deliver(event.platformId, threadId, {
          kind: 'chat',
          content: { text: `I cannot message you directly here: run ${cmd} in a direct chat with me.` },
        });
        return true;
      }
      direct = { adapter: dmAdapter, platformId: dm.platform_id };
    }
    const outcome = await runVoiceCommand(mg, chatThread, userId, callUrl, command.renew);
    const text = voiceCommandReply(outcome, cmd);
    if (text === null) {
      log.info('/voice from an unknown sender dropped', { channelType: event.channelType });
      return true;
    }
    const links = voiceLinkLines(outcome);
    if (mg.is_group !== 0 && links.length > 0) {
      // A link is a credential: in a group it only ever goes to the sender's direct chat.
      const groupText = direct
        ? [`${boundNote(cmd)} Your call link is in our direct chat.`, ...chatLines(outcome, cmd)].join('\n\n')
        : `I cannot message you directly here: run ${cmd} new in a direct chat with me.`;
      if (direct) {
        const directText = [...links, ...(linkReplaced(outcome) ? [NEW_LINK_NOTE] : [])].join('\n\n');
        await direct.adapter.deliver(direct.platformId, null, { kind: 'chat', content: { text: directText } });
      }
      await adapter.deliver(event.platformId, threadId, { kind: 'chat', content: { text: groupText } });
      return true;
    }
    // Straight to the chat's adapter, never through a session: the agent must not hold the call link.
    await adapter.deliver(event.platformId, threadId, { kind: 'chat', content: { text } });
  } catch (err) {
    log.warn('/voice reply could not be delivered', { channelType: event.channelType, err });
  }
  return true;
}

registerMessageInterceptor((event) => handleVoiceCommand(event));
