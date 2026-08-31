/**
 * "Agent is working" signal — default module.
 *
 * Most platforms expire a typing indicator after 5–10s, so a one-shot
 * call on message arrival goes stale long before the agent finishes
 * thinking. This module keeps it alive by re-firing `setTyping` on a
 * short interval — but only while the agent is actually WORKING, gated
 * on the heartbeat file's mtime after an initial grace period.
 *
 * After delivering a user-facing message, the refresh is paused for
 * POST_DELIVERY_PAUSE_MS so the client-side indicator can visually
 * clear.
 *
 * Two platform shapes, two renderings:
 *
 *  - EPHEMERAL indicator (Telegram's chat action): expires on its own,
 *    so the refresh interval IS the lifecycle and teardown needs no
 *    cleanup.
 *  - PERSISTENT, thread-scoped indicator (Slack's assistant status):
 *    paints only inside a thread and clears only when the app next
 *    posts. That needs both halves the ephemeral case never did — an
 *    explicit `clearTyping` on every teardown path (otherwise a turn
 *    that ends without a reply leaves a stale status painted until the
 *    platform's own timeout), and a fallback for threadless chats,
 *    where no status can be painted at all. The fallback is a reaction
 *    ack: 👀 on the triggering message while the agent works, removed
 *    when it replies or goes idle.
 *
 * Default module status:
 *   - Lives in src/modules/ for signaling (not really core), but ships
 *     on main and is imported directly by core. No registry, no hook.
 *   - Removing requires editing src/router.ts, src/delivery.ts, and
 *     src/container-runner.ts to drop the calls.
 */
import fs from 'fs';

import { heartbeatPath } from '../../session-manager.js';

const TYPING_REFRESH_MS = 4000;
/**
 * Grace window from startTypingRefresh: fire typing unconditionally
 * for this long regardless of heartbeat state. Covers container
 * spawn/wake latency (5–12s on cold start before first heartbeat).
 */
const TYPING_GRACE_MS = 15000;
/**
 * After the grace window, a heartbeat must be mtimed within this
 * many ms of now to count as "agent is working." The agent-runner
 * ticks the heartbeat every 2s for the whole of an in-flight turn
 * (TURN_HEARTBEAT_INTERVAL_MS in container/agent-runner/src/heartbeat.ts),
 * so 6s is well above the working floor and small enough to stop
 * typing quickly when the agent goes idle.
 */
const HEARTBEAT_FRESH_MS = 6000;
/**
 * After we deliver a user-facing message, pause typing for this
 * long so the client-side indicator has time to visually clear.
 * Tuned for the longest common expiry (Discord ~10s). The interval
 * stays running; ticks inside the pause just skip the setTyping call.
 */
const POST_DELIVERY_PAUSE_MS = 10000;

/**
 * Status text for platforms that render one. Slack shows it in the thread
 * just above the composer; the platform supplies the agent's identity, so
 * this reads as a continuation of the name rather than a full sentence.
 */
const TYPING_STATUS = 'is thinking...';

/** Reaction ack for platforms that cannot paint a threadless indicator. */
const ACK_EMOJI = 'eyes';

interface TypingAdapter {
  setTyping?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    instance?: string,
    status?: string,
  ): Promise<void>;
  clearTyping?(channelType: string, platformId: string, threadId: string | null, instance?: string): Promise<void>;
  addReaction?(
    channelType: string,
    platformId: string,
    messageId: string,
    emoji: string,
    instance?: string,
  ): Promise<void>;
  removeReaction?(
    channelType: string,
    platformId: string,
    messageId: string,
    emoji: string,
    instance?: string,
  ): Promise<void>;
  typingRequiresThread?(channelType: string, instance?: string): boolean;
}

interface TypingTarget {
  agentGroupId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  /** Adapter instance that owns the chat; undefined = default (= channelType). */
  instance?: string;
  /**
   * How this session's "working" signal is rendered. Decided once per
   * refresher from the address it was started on: 'status' is the normal
   * indicator, 'reaction' the fallback when the platform needs a thread and
   * this chat has none. A re-trigger re-decides, since an agent-shared
   * session can move between chats.
   */
  mode: 'status' | 'reaction';
  /** Platform id of the message the ack sits on ('reaction' mode only). */
  messageId?: string;
  /** Whether the ack reaction is currently on the message. */
  acked: boolean;
  interval: NodeJS.Timeout;
  startedAt: number;
  pausedUntil: number; // epoch ms; 0 = not paused
}

let adapter: TypingAdapter | null = null;
const typingRefreshers = new Map<string, TypingTarget>();

/**
 * Bind the typing module to the channel delivery adapter so it can
 * call `setTyping`. Called once by `src/delivery.ts` inside
 * `setDeliveryAdapter`. Passing a fresh adapter replaces the prior
 * binding and leaves active refreshers in place (they'll use the
 * new adapter on their next tick).
 */
export function setTypingAdapter(a: TypingAdapter): void {
  adapter = a;
}

async function triggerTyping(
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
): Promise<void> {
  try {
    await adapter?.setTyping?.(channelType, platformId, threadId, instance, TYPING_STATUS);
  } catch {
    // Typing is best-effort — don't let it fail delivery or routing.
  }
}

/**
 * Take down whatever this entry painted. Safe to call more than once and on
 * platforms that implement neither half: a redundant clear on an already
 * clear indicator is a no-op everywhere.
 */
function clearSignal(entry: TypingTarget): void {
  if (entry.mode === 'reaction') {
    if (!(entry.acked && entry.messageId)) return;
    entry.acked = false;
    void adapter
      ?.removeReaction?.(entry.channelType, entry.platformId, entry.messageId, ACK_EMOJI, entry.instance)
      .catch(() => {});
    return;
  }
  void adapter?.clearTyping?.(entry.channelType, entry.platformId, entry.threadId, entry.instance).catch(() => {});
}

/** Paint the initial signal for an entry: status, or a one-shot ack. */
function paintSignal(entry: TypingTarget): void {
  if (entry.mode === 'status') {
    triggerTyping(entry.channelType, entry.platformId, entry.threadId, entry.instance).catch(() => {});
    return;
  }
  if (entry.acked || !entry.messageId) return;
  entry.acked = true;
  void adapter
    ?.addReaction?.(entry.channelType, entry.platformId, entry.messageId, ACK_EMOJI, entry.instance)
    .catch(() => {});
}

/**
 * Which rendering this address supports. A platform that can only paint
 * inside a thread (Slack) gets the reaction ack when the session is
 * threadless — which is every shared-session wiring.
 */
function resolveMode(channelType: string, threadId: string | null, instance?: string): 'status' | 'reaction' {
  if (threadId !== null) return 'status';
  return adapter?.typingRequiresThread?.(channelType, instance) ? 'reaction' : 'status';
}

function isHeartbeatFresh(agentGroupId: string, sessionId: string): boolean {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    const stat = fs.statSync(hbPath);
    return Date.now() - stat.mtimeMs < HEARTBEAT_FRESH_MS;
  } catch {
    return false;
  }
}

export function startTypingRefresh(
  sessionId: string,
  agentGroupId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
  /** Platform id of the message that woke the session — the anchor for the
   *  reaction ack. Absent means no ack is possible for this trigger. */
  messageId?: string,
): void {
  const existing = typingRefreshers.get(sessionId);
  if (existing) {
    // Already refreshing. Fire an immediate tick for the new inbound
    // event and reset the grace window — the new message restarts
    // the container-wake latency budget. Also clear any lingering
    // post-delivery pause: a new inbound means the user expects
    // typing to show immediately.
    //
    // The signal moves to the new message: take the old ack down first
    // (its address fields are still the ones it was painted on), then
    // re-decide the rendering and paint against the new address.
    clearSignal(existing);
    existing.startedAt = Date.now();
    existing.pausedUntil = 0;
    // Keep the stored entry self-consistent: a re-trigger can arrive from
    // a different chat address (agent-shared sessions span messaging
    // groups, possibly on different platforms/instances), so the address
    // fields and the owning instance must move together — a torn entry
    // (old address + new instance) would hand e.g. a telegram platformId
    // to a Slack instance's setTyping on the next interval tick.
    existing.channelType = channelType;
    existing.platformId = platformId;
    existing.threadId = threadId;
    existing.instance = instance;
    existing.messageId = messageId;
    existing.mode = resolveMode(channelType, threadId, instance);
    paintSignal(existing);
    return;
  }

  const startedAt = Date.now();
  const interval = setInterval(() => {
    const entry = typingRefreshers.get(sessionId);
    if (!entry) return; // stopped externally since this tick was scheduled

    // Inside a post-delivery pause: skip setTyping but keep the
    // interval running so we resume automatically once the pause
    // expires.
    if (entry.pausedUntil > Date.now()) return;

    const withinGrace = Date.now() - entry.startedAt < TYPING_GRACE_MS;
    if (withinGrace || isHeartbeatFresh(entry.agentGroupId, sessionId)) {
      // Only the status rendering needs re-firing. A reaction does not
      // expire, so the ack is painted once at start and the ticks here
      // exist purely to keep the idle check below running.
      if (entry.mode === 'status') {
        triggerTyping(entry.channelType, entry.platformId, entry.threadId, entry.instance).catch(() => {});
      }
      return;
    }

    // startedAt === 0 marks a post-delivery entry: the reply already proved
    // the container is warm and already cleared the indicator, so a
    // momentarily stale heartbeat here skips the tick rather than tearing
    // the refresher down — a teardown would silence the signal for the rest
    // of a multi-message turn with nothing to re-arm it.
    if (entry.startedAt === 0) return;

    // Out of grace AND heartbeat stale — agent is idle, stop refreshing.
    // This is the path a turn that produced no user-facing message ends
    // on, so it is the one that has to take the signal down: nothing else
    // will, and a persistent indicator would sit there until the
    // platform's own timeout.
    clearSignal(entry);
    clearInterval(entry.interval);
    typingRefreshers.delete(sessionId);
  }, TYPING_REFRESH_MS);
  // unref so a stale refresher can't hold the event loop alive.
  interval.unref();
  const entry: TypingTarget = {
    agentGroupId,
    channelType,
    platformId,
    threadId,
    instance,
    mode: resolveMode(channelType, threadId, instance),
    messageId,
    acked: false,
    interval,
    startedAt,
    pausedUntil: 0,
  };
  typingRefreshers.set(sessionId, entry);
  paintSignal(entry);
}

/**
 * Pause the typing refresh for POST_DELIVERY_PAUSE_MS. Called after
 * a user-facing message is delivered so the client-side indicator
 * has a chance to visually clear before the agent's next SDK event
 * pushes it back on. No-op if no refresh is active for this session.
 */
export function pauseTypingRefreshAfterDelivery(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  // The reply IS the answer to the ack, so the reaction comes off now
  // rather than waiting for the session to go idle. (The status rendering
  // needs no equivalent: the platform auto-clears it on the post.)
  if (entry.mode === 'reaction') clearSignal(entry);
  // A delivered reply ends the cold-start grace: later ticks must prove
  // ongoing work via the heartbeat rather than coasting on TYPING_GRACE_MS.
  // Otherwise a follow-up message that reset grace just before this reply
  // landed lets a tick fire once the shorter post-delivery pause expires,
  // repainting a persistent indicator with no work behind it. (Upstream
  // nanocoai/nanoclaw#3400, leg 1.)
  entry.startedAt = 0;
  entry.pausedUntil = Date.now() + POST_DELIVERY_PAUSE_MS;
}

export function stopTypingRefresh(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  clearSignal(entry);
  clearInterval(entry.interval);
  typingRefreshers.delete(sessionId);
}
