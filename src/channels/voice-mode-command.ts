/**
 * `/voice` (on Slack `!voice`, since Slack's client eats unknown slash commands), run in a chat
 * wired to an agent by someone core grants an owner or admin role over that agent: mints a fresh
 * call link for the agent's voice line (creating the line on first use), makes this chat (and
 * thread) the chat its calls talk in, and sends the sender the link. The previous link stops
 * working: only its hash was stored, so it cannot be shown again, and re-minting is how a lost or
 * leaked link is replaced. The sender becomes the line's caller.
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
import { mintVoiceModeLine } from '../db/voice-mode-lines.js';
import { log } from '../log.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import { getUser } from '../modules/permissions/db/users.js';
import { ensureUserDm } from '../modules/permissions/user-dm.js';
import { registerMessageInterceptor } from '../router.js';
import type { MessagingGroup, MessagingGroupAgent } from '../types.js';
import type { VoiceChannelAdapter } from './voice-mode.js';

/** Channels whose client intercepts `/`: the command is typed `!voice` there. */
const BANG_CHANNELS = new Set(['slack']);

/** The call page URL for a token. */
export type CallUrlFn = (token: string) => string;

/** The live voice-mode adapter's page URLs (it knows the public origin), or null when the channel is not running. */
function liveCallUrl(): CallUrlFn | null {
  const adapter = getChannelAdapterExact('voice-mode') as VoiceChannelAdapter | undefined;
  return adapter ? (token) => adapter.callUrl(token) : null;
}

/** Whether the sender is a known user with an owner or admin role over any agent wired to the chat. */
async function administersAny(mg: MessagingGroup, userId: string): Promise<boolean> {
  if (!(await getUser(userId))) return false;
  for (const wiring of await getMessagingGroupAgents(mg.id)) {
    if (await hasAdminPrivilege(userId, wiring.agent_group_id)) return true;
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
  | { ok: true; agentName: string; link: string }
  | { ok: false; agentName: string; reason: 'voice-unavailable' };

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
 * an owner or admin role over any of them are refused, and every agent the sender administers gets
 * a fresh link for its line, bound to this chat.
 */
export async function runVoiceCommand(
  mg: MessagingGroup,
  threadId: string | null,
  userId: string | null,
  callUrl: CallUrlFn | null = liveCallUrl(),
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
      userId,
    });
    results.push({ ok: true, agentName: ag.name, link: callUrl(token) });
  }
  return results.length > 0 ? { kind: 'done', results } : { kind: 'refused' };
}

const UNAVAILABLE = 'Voice calls are off on this host (the voice-mode channel is not configured).';
const BOUND_NOTE = 'Calls now talk in this chat, until /voice is run in another one. Earlier links no longer work.';

/** The call links /voice hands out, one line each; they are credentials, so they go to the sender only. */
export function voiceLinkLines(outcome: VoiceCommandOutcome): string[] {
  if (outcome.kind !== 'done') return [];
  return outcome.results.flatMap((r) => (r.ok ? [`🎙 Talk to ${r.agentName}: ${r.link}`] : []));
}

/** The /voice reply with the links, or null when the sender gets no answer. */
export function voiceCommandReply(outcome: VoiceCommandOutcome): string | null {
  if (outcome.kind === 'drop') return null;
  if (outcome.kind === 'refused') return 'Only an owner or admin of this agent can use /voice.';
  const links = voiceLinkLines(outcome);
  if (links.length > 0) return [...links, BOUND_NOTE].join('\n\n');
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
    if (mg.is_group !== 0 && callUrl && (await administersAny(mg, userId))) {
      const dm = await ensureUserDm(userId, { privacySafeLogs: true, instance });
      const dmAdapter = dm ? getChannelAdapterExact(dm.instance ?? dm.channel_type) : undefined;
      if (!dm || !dmAdapter) {
        await adapter.deliver(event.platformId, threadId, {
          kind: 'chat',
          content: { text: 'I cannot message you directly here: run /voice in a direct chat with me.' },
        });
        return true;
      }
      direct = { adapter: dmAdapter, platformId: dm.platform_id };
    }
    const outcome = await runVoiceCommand(mg, chatThread, userId, callUrl);
    const text = voiceCommandReply(outcome);
    if (text === null) {
      log.info('/voice from an unknown sender dropped', { channelType: event.channelType });
      return true;
    }
    const links = voiceLinkLines(outcome);
    if (direct && links.length > 0) {
      await direct.adapter.deliver(direct.platformId, null, { kind: 'chat', content: { text } });
      await adapter.deliver(event.platformId, threadId, {
        kind: 'chat',
        content: { text: `${BOUND_NOTE} Your new call link is in our direct chat.` },
      });
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
