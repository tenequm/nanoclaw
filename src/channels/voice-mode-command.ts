/**
 * `/voice` (on Slack `!voice`, since Slack's client eats unknown slash commands): the sender gets
 * the call link of each of their own voice lines of the chat's agent(s), and this chat becomes the
 * line's call chat, where its calls talk (src/channels/voice-mode-livekit.ts).
 *
 * A message interceptor, so the command never reaches an agent's session: the reply carries the
 * line's call link, which is its credential. The sender must be an owner account of the line
 * (`ncl voice-lines set|add-owner`) and an admin of the agent; anyone else gets a refusal, and an
 * unknown sender or an unwired chat gets nothing. In a group chat the link goes to the sender's
 * direct chat instead, so the other members never see it.
 */
import type { InboundEvent } from './adapter.js';
import { resolveThreadPolicy } from './channel-defaults.js';
import { getChannelAdapter, getChannelAdapterExact, getChannelDefaults } from './channel-registry.js';
import { getAgentGroup } from '../db/agent-groups.js';
import {
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  getMessagingGroupsByAgentGroup,
} from '../db/messaging-groups.js';
import { isVoiceLineOwner, setVoiceLineTarget } from '../db/voice-mode-lines.js';
import { log } from '../log.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import { getUser } from '../modules/permissions/db/users.js';
import { ensureUserDm } from '../modules/permissions/user-dm.js';
import { registerMessageInterceptor } from '../router.js';
import type { MessagingGroup, MessagingGroupAgent } from '../types.js';
import type { VoiceChannelAdapter } from './voice-mode.js';

/** Channels whose client intercepts `/`: the command is typed `!voice` there. */
const BANG_CHANNELS = new Set(['slack']);

/** A voice line's call link (`/voice?t=`); null when the host has none for it (voice off, or no link token here). */
export type VoiceLinkFn = (line: MessagingGroup) => string | null;

/** Asks the live voice adapter, the only holder of the link tokens. */
const liveVoiceLink: VoiceLinkFn = (line) =>
  (getChannelAdapterExact(line.instance ?? line.channel_type) as VoiceChannelAdapter | undefined)?.callLink?.(
    line.platform_id,
  ) ?? null;

function messageText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text.trim() : '';
  } catch {
    return content.trim();
  }
}

/** True for `/voice`, `/voice@<bot>` (Telegram groups) and, on Slack, `!voice`; trailing words are ignored. */
export function isVoiceCommand(text: string, channelType: string): boolean {
  const token = /^\S*/.exec(text)![0].toLowerCase();
  if (token === '!voice') return BANG_CHANNELS.has(channelType);
  return token === '/voice' || token.startsWith('/voice@');
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

/** What /voice did for one agent of the chat. */
export type VoiceTargetResult =
  | { ok: true; agentName: string; links: string[] }
  | { ok: false; agentName: string; reason: 'no-voice-line' | 'voice-unavailable' };

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

/** Make this chat the call chat of the agent's voice lines that `userId` owns, and return their links. */
async function bindLines(
  wiring: MessagingGroupAgent,
  mg: MessagingGroup,
  threadId: string | null,
  userId: string,
  agentName: string,
  linkFor: VoiceLinkFn,
): Promise<VoiceTargetResult> {
  const lines = (await getMessagingGroupsByAgentGroup(wiring.agent_group_id)).filter(
    (g) => g.channel_type === 'voice-mode' && !g.denied_at,
  );
  const owned: MessagingGroup[] = [];
  for (const line of lines) if (await isVoiceLineOwner(line.id, userId)) owned.push(line);
  if (owned.length === 0) return { ok: false, agentName, reason: 'no-voice-line' };
  const linked = owned.flatMap((line) => {
    const link = linkFor(line);
    return link ? [{ line, link }] : [];
  });
  if (linked.length === 0) return { ok: false, agentName, reason: 'voice-unavailable' };

  const callThread = callChatThread(wiring, mg, threadId);
  const bound: typeof linked = [];
  for (const entry of linked) {
    const ok = await setVoiceLineTarget({
      lineMessagingGroupId: entry.line.id,
      ownerUserId: userId,
      targetMessagingGroupId: mg.id,
      threadId: callThread,
    });
    // The owners changed since the read above: that line is no longer theirs to hand out.
    if (ok) bound.push(entry);
  }
  if (bound.length === 0) return { ok: false, agentName, reason: 'no-voice-line' };
  log.info('Voice call chat set via /voice', {
    agentGroupId: wiring.agent_group_id,
    lines: bound.map(({ line }) => line.platform_id),
    messagingGroupId: mg.id,
    threadId: callThread,
    userId,
  });
  return { ok: true, agentName, links: bound.map(({ link }) => link) };
}

/**
 * /voice over a chat's wired agents: unknown senders are dropped silently, known senders who
 * administer none of them are refused, and every agent the sender administers gets this chat as
 * the call chat of the sender's own line(s).
 */
export async function runVoiceCommand(
  mg: MessagingGroup,
  threadId: string | null,
  userId: string | null,
  linkFor: VoiceLinkFn = liveVoiceLink,
): Promise<VoiceCommandOutcome> {
  if (!userId || !(await getUser(userId))) return { kind: 'drop' };
  const wirings = await getMessagingGroupAgents(mg.id);
  if (wirings.length === 0) return { kind: 'drop' };
  const results: VoiceTargetResult[] = [];
  for (const wiring of wirings) {
    if (!(await hasAdminPrivilege(userId, wiring.agent_group_id))) continue;
    const ag = await getAgentGroup(wiring.agent_group_id);
    if (!ag) continue;
    results.push(await bindLines(wiring, mg, threadId, userId, ag.name, linkFor));
  }
  return results.length > 0 ? { kind: 'done', results } : { kind: 'refused' };
}

const FAILURE: Record<'no-voice-line' | 'voice-unavailable', string> = {
  'no-voice-line':
    "You have no voice line for this agent. The operator names a line's owner accounts with `ncl voice-lines set` and `add-owner`.",
  'voice-unavailable': 'Voice calls are off on this host (the voice channel is not configured).',
};

const BOUND_NOTE = 'Calls now talk in this chat, until /voice is run in another one.';

/** The call links /voice hands out, one line each; they are credentials, so they go to the sender only. */
export function voiceLinkLines(outcome: VoiceCommandOutcome): string[] {
  if (outcome.kind !== 'done') return [];
  return outcome.results.flatMap((r) => (r.ok ? r.links.map((link) => `🎙 Talk to ${r.agentName}: ${link}`) : []));
}

/** The /voice reply with the links, or null when the sender gets no answer. */
export function voiceCommandReply(outcome: VoiceCommandOutcome): string | null {
  if (outcome.kind === 'drop') return null;
  if (outcome.kind === 'refused') return 'Only an admin of this agent can use /voice.';
  const links = voiceLinkLines(outcome);
  if (links.length > 0) return [...links, BOUND_NOTE].join('\n\n');
  const several = outcome.results.length > 1;
  const reasons = new Set(
    outcome.results.map((r) => (r.ok ? '' : several ? `${r.agentName}: ${FAILURE[r.reason]}` : FAILURE[r.reason])),
  );
  return [...reasons].filter(Boolean).join('\n');
}

/**
 * In a group chat the links must not reach the other members: they go to the sender's direct
 * chat, and the group hears only that calls now talk there.
 */
async function sendLinksPrivately(userId: string, instance: string, links: string[]): Promise<string> {
  const unsent = `${BOUND_NOTE} I could not send you the link privately: run /voice in a direct chat with me to get it (calls then talk there).`;
  const dm = await ensureUserDm(userId, { privacySafeLogs: true, instance });
  const dmAdapter = dm ? getChannelAdapterExact(dm.instance ?? dm.channel_type) : undefined;
  if (!dm || !dmAdapter) return unsent;
  try {
    await dmAdapter.deliver(dm.platform_id, null, { kind: 'chat', content: { text: links.join('\n\n') } });
  } catch (err) {
    log.warn('/voice could not send the link privately', { channelType: dm.channel_type, err });
    return unsent;
  }
  return `${BOUND_NOTE} Your call link is in our direct chat.`;
}

/** Claims every /voice message; the agents never see one. */
export async function handleVoiceCommand(event: InboundEvent, linkFor: VoiceLinkFn = liveVoiceLink): Promise<boolean> {
  if (event.message.kind !== 'chat' && event.message.kind !== 'chat-sdk') return false;
  if (!isVoiceCommand(messageText(event.message.content), event.channelType)) return false;

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
  const outcome: VoiceCommandOutcome =
    mg && !mg.denied_at ? await runVoiceCommand(mg, chatThread, userId, linkFor) : { kind: 'drop' };
  let text = voiceCommandReply(outcome);
  if (text === null) {
    log.info('/voice from an unknown sender or an unwired chat dropped', {
      channelType: event.channelType,
      platformId: event.platformId,
    });
    return true;
  }
  const links = voiceLinkLines(outcome);
  try {
    if (mg?.is_group !== 0 && links.length > 0 && userId) text = await sendLinksPrivately(userId, instance, links);
    // Straight to the chat's adapter, never through a session: the agent must not hold the call link.
    await adapter.deliver(event.platformId, threadId, { kind: 'chat', content: { text } });
  } catch (err) {
    log.warn('/voice reply could not be delivered', { channelType: event.channelType, err });
  }
  return true;
}

registerMessageInterceptor((event) => handleVoiceCommand(event));
