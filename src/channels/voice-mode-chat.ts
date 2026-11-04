/**
 * What the voice channel's chat commands share: reading the command out of a chat message, the chat
 * and sender it came from, who may run it, and claiming the agent's voice line for that chat.
 */
import type { ChannelAdapter, InboundEvent } from './adapter.js';
import { wiringThreadsEnabled } from './channel-defaults.js';
import { getChannelAdapter, getChannelAdapterExact } from './channel-registry.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import {
  bindVoiceModeLineChat,
  createVoiceModeLine,
  getVoiceModeLineForAgent,
  type VoiceModeLineRow,
} from '../db/voice-mode-lines.js';
import { log } from '../log.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import { getUser } from '../modules/permissions/db/users.js';
import type { MessagingGroup, MessagingGroupAgent } from '../types.js';
import type { VoiceModeChannelAdapter } from './voice-mode.js';
import { VOICE_MODE_CHANNEL } from './voice-mode-line.js';

/** Channels whose client intercepts `/`: a command is typed `!<name>` there. */
export const BANG_CHANNELS = new Set(['slack']);

/** A command as the sender types it: Slack's client eats unknown slash commands. */
export const commandName = (name: string, channelType: string): string =>
  `${BANG_CHANNELS.has(channelType) ? '!' : '/'}${name}`;

/** The running voice-mode adapter, if any. */
export const liveVoiceAdapter = () => getChannelAdapterExact(VOICE_MODE_CHANNEL) as VoiceModeChannelAdapter | undefined;

export function messageText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text.trim() : '';
  } catch {
    return content.trim();
  }
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

/** The chat a command came from, as a command answers in it. */
export interface CommandChat {
  /** The chat's own adapter: replies go straight to it, never through a session. */
  adapter: ChannelAdapter;
  instance: string;
  /** Where replies go: the event's thread, none on a platform without threads. */
  threadId: string | null;
  /** The thread the command is about: none for a top-level message. */
  chatThread: string | null;
  mg: MessagingGroup;
  userId: string;
}

/**
 * The chat and sender of the command `cmd` in `event`; null, logged, when the chat adapter is offline,
 * the chat is unwired or denied, or the sender is unknown: such a command gets no answer.
 */
export async function commandChat(event: InboundEvent, cmd: string): Promise<CommandChat | null> {
  const instance = event.instance ?? event.channelType;
  const adapter = getChannelAdapterExact(instance);
  if (!adapter) {
    log.warn(`${cmd} dropped: the chat adapter is offline`, { channelType: event.channelType });
    return null;
  }
  // Mirror the router: a platform without threads collapses them to the chat.
  const threadId = getChannelAdapter(instance)?.supportsThreads ? event.threadId : null;
  // Slack gives every top-level message a thread of its own (its ts); a top-level command means the chat itself.
  const chatThread = threadId !== null && threadId === `${event.platformId}:${event.message.id}` ? null : threadId;
  const mg = await getMessagingGroupByPlatform(event.channelType, event.platformId, instance);
  const userId = senderUserId(event);
  if (!mg || mg.denied_at || !userId) {
    log.info(`${cmd} from an unknown sender or an unwired chat dropped`, {
      channelType: event.channelType,
      platformId: event.platformId,
    });
    return null;
  }
  return { adapter, instance, threadId, chatThread, mg, userId };
}

/**
 * The chat's wirings whose agent the sender administers (an owner or admin role), limited to `only`
 * when given; null when the sender is unknown or the chat has no agents, which gets no answer at all.
 */
export async function administeredWirings(
  mg: MessagingGroup,
  userId: string | null,
  only?: ReadonlySet<string>,
): Promise<MessagingGroupAgent[] | null> {
  if (!userId || !(await getUser(userId))) return null;
  const wirings = await getMessagingGroupAgents(mg.id);
  if (wirings.length === 0) return null;
  const mine: MessagingGroupAgent[] = [];
  for (const wiring of wirings) {
    if (only && !only.has(wiring.agent_group_id)) continue;
    if (await hasAdminPrivilege(userId, wiring.agent_group_id)) mine.push(wiring);
  }
  return mine;
}

/** The thread a line's calls talk in: none when the wiring keeps no threads, else the command's. */
export const callThread = (wiring: MessagingGroupAgent, mg: MessagingGroup, threadId: string | null): string | null =>
  threadId !== null && wiringThreadsEnabled(wiring, mg) ? threadId : null;

/** A line's call chat, set for its caller. */
export interface LineTarget {
  agentGroupId: string;
  ownerUserId: string;
  messagingGroupId: string;
  threadId: string | null;
}

/** What claiming the agent's line did. */
export type LineClaim =
  | { kind: 'created'; line: VoiceModeLineRow; token: string }
  | { kind: 'bound'; line: VoiceModeLineRow }
  /** Another caller's line, left alone; `caller` is their display name. */
  | { kind: 'other-caller'; caller?: string }
  /** The agent has no line, and without the host key none can be made. */
  | { kind: 'no-key' };

/**
 * Makes the target chat the call chat of the agent's line: a new line with the sender as its caller,
 * or the sender's own line moved there. Only creates when the agent has no line yet: one another run
 * created meanwhile keeps its caller and link.
 */
export async function claimLine(target: LineTarget, key: Buffer | null): Promise<LineClaim> {
  const existing = await getVoiceModeLineForAgent(target.agentGroupId);
  if (!existing && !key) return { kind: 'no-key' };
  const created = existing ? undefined : await createVoiceModeLine(target, key);
  if (created) return { kind: 'created', line: created.line, token: created.token };
  const line = await bindVoiceModeLineChat({
    agentGroupId: target.agentGroupId,
    callerUserId: target.ownerUserId,
    messagingGroupId: target.messagingGroupId,
    threadId: target.threadId,
  });
  if (line) return { kind: 'bound', line };
  const owner = (await getVoiceModeLineForAgent(target.agentGroupId))?.owner_user_id;
  return { kind: 'other-caller', caller: owner ? ((await getUser(owner))?.display_name ?? undefined) : undefined };
}
