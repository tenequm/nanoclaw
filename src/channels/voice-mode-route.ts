/**
 * How a caller's turn reaches the agent: written straight into the session of the one agent the
 * line belongs to, in the call chat, as a waking message from the
 * line's caller - the same steps the router takes for an engaged message (thread policy, session
 * mode, cross-session backfill and fan-out, typing, wake). The router is not involved because a
 * turn is addressed to one agent whatever else is wired to that chat and whatever its trigger;
 * the caller's access to that agent and the call chat's wiring are checked by the voice engine
 * before every turn.
 *
 * While the agent works on a turn in a call chat, its live call hears it is thinking: the chat's
 * typing goes to the chat's own platform, so this follows the session's heartbeat the way the
 * typing module does.
 */
import fs from 'node:fs';

import type { InboundEvent } from './adapter.js';
import { resolveThreadPolicy } from './channel-defaults.js';
import { getChannelAdapter, getChannelDefaults } from './channel-registry.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getMessagingGroupAgentByPair, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { getSession } from '../db/sessions.js';
import { log } from '../log.js';
import { onHostStart } from '../host-lifecycle.js';
import { backfillSession, fanInboundMessage } from '../modules/cross-session-context/index.js';
import { startTypingRefresh, stopTypingRefresh } from '../modules/typing/index.js';
import { requestWake } from '../request-wake.js';
import { heartbeatPath, resolveSession, writeSessionMessage } from '../session-manager.js';

/** The typing module's cadence: a tick every 4 s, 15 s of grace, a heartbeat fresh for 6 s. */
const THINKING_TICK_MS = 4_000;
const THINKING_GRACE_MS = 15_000;
const HEARTBEAT_FRESH_MS = 6_000;

const thinkingWatchers = new Map<string, { startedAt: number; onThinking: () => void; timer: NodeJS.Timeout }>();

/**
 * The host takes inbound messages only once running sessions are adopted (src/index.ts); the page can
 * take a call before that, so turns wait for the same point: host modules start right after it.
 */
let hostStarted = false;
onHostStart(() => {
  hostStarted = true;
});

function heartbeatFresh(agentGroupId: string, sessionId: string): boolean {
  try {
    return Date.now() - fs.statSync(heartbeatPath(agentGroupId, sessionId)).mtimeMs < HEARTBEAT_FRESH_MS;
  } catch {
    return false;
  }
}

/** Tick `onThinking` while the session works on the turn: through the grace period, then while its heartbeat is fresh. */
function watchThinking(agentGroupId: string, sessionId: string, onThinking: () => void): void {
  onThinking();
  const existing = thinkingWatchers.get(sessionId);
  if (existing) {
    existing.startedAt = Date.now();
    existing.onThinking = onThinking;
    return;
  }
  const watcher = {
    startedAt: Date.now(),
    onThinking,
    timer: setInterval(() => {
      if (Date.now() - watcher.startedAt < THINKING_GRACE_MS || heartbeatFresh(agentGroupId, sessionId)) {
        watcher.onThinking();
        return;
      }
      stopThinking(sessionId);
    }, THINKING_TICK_MS),
  };
  watcher.timer.unref();
  thinkingWatchers.set(sessionId, watcher);
}

/** Stop the session's thinking watcher: its answer was delivered, or the agent could not be woken. */
export function stopThinking(sessionId: string): void {
  const watcher = thinkingWatchers.get(sessionId);
  if (!watcher) return;
  clearInterval(watcher.timer);
  thinkingWatchers.delete(sessionId);
}

/** Stop every thinking watcher (channel teardown). */
export function stopThinkingWatchers(): void {
  for (const { timer } of thinkingWatchers.values()) clearInterval(timer);
  thinkingWatchers.clear();
}

/**
 * Store a turn in `agentGroupId`'s session for the event's chat and wake the agent. Resolves true
 * once stored, false when the chat or its wiring to that agent is gone; rejects when storing threw.
 * `onThinking` is ticked while the agent works on it.
 */
export async function routeVoiceTurn(
  event: InboundEvent,
  agentGroupId: string,
  onThinking?: () => void,
): Promise<boolean> {
  if (!hostStarted) throw new Error('the host is still starting');
  const instance = event.instance ?? event.channelType;
  const mg = await getMessagingGroupByPlatform(event.channelType, event.platformId, instance);
  const wiring = mg && !mg.denied_at ? await getMessagingGroupAgentByPair(mg.id, agentGroupId) : undefined;
  const agentGroup = wiring ? await getAgentGroup(agentGroupId) : undefined;
  if (!mg || !wiring || !agentGroup) {
    log.warn('livekit-voice: the turn has no wired chat to go to', { channelType: event.channelType, agentGroupId });
    return false;
  }

  const threadsEnabled = resolveThreadPolicy(
    wiring.threads ?? null,
    getChannelDefaults(instance, mg.channel_type),
    mg.is_group === 1,
    getChannelAdapter(instance)?.supportsThreads === true,
  );
  const threadId = threadsEnabled ? event.threadId : null;
  const sessionMode =
    threadsEnabled && wiring.session_mode !== 'agent-shared' && mg.is_group !== 0 ? 'per-thread' : wiring.session_mode;
  const { session, created } = await resolveSession(agentGroupId, mg.id, threadId, sessionMode);
  await backfillSession(agentGroup, session, mg, { created });

  const messageId = `${event.message.id}:${agentGroupId}`;
  await writeSessionMessage(agentGroupId, session.id, {
    id: messageId,
    kind: event.message.kind,
    timestamp: event.message.timestamp,
    platformId: event.platformId,
    channelType: event.channelType,
    threadId,
    content: event.message.content,
    trigger: true,
  });

  startTypingRefresh(session.id, agentGroupId, event.channelType, event.platformId, threadId, mg.instance);
  const fresh = await getSession(session.id);
  const woke = fresh ? await requestWake(fresh, 'inbound-message') : false;
  if (!woke) stopTypingRefresh(session.id);
  else if (onThinking) watchThinking(agentGroupId, session.id, onThinking);
  void fanInboundMessage({
    session,
    mg,
    messageId,
    kind: event.message.kind,
    channelType: event.channelType,
    content: event.message.content,
    timestamp: event.message.timestamp,
  });
  return true;
}
