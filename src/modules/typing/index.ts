/**
 * Typing indicator refresh — default module.
 *
 * Most platforms expire a typing indicator after 5–10s, so a one-shot
 * call on message arrival goes stale long before the agent finishes
 * thinking. This module keeps it alive by re-firing `setTyping` on a
 * short interval, gated on the agent's *turn-in-flight* signal:
 * `processing_ack` rows in `outbound.db` with status='processing'.
 *
 * Why processing_ack and not heartbeat: the container only touches
 * `.heartbeat` inside the SDK event-stream loop, so during long pure
 * thinking gaps (especially with `effortLevel='xhigh'`) heartbeat
 * goes stale even though the agent is alive and working. The Claude
 * Agent SDK's own contract is that the loop runs until `ResultMessage`
 * — which corresponds 1:1 with `processing_ack` rows being cleared by
 * `markCompleted` in container/agent-runner/src/poll-loop.ts.
 *
 * After delivering a user-facing message, the refresh is paused for
 * POST_DELIVERY_PAUSE_MS so the client-side indicator can visually
 * clear.
 *
 * Default module status:
 *   - Lives in src/modules/ for signaling (not really core), but ships
 *     on main and is imported directly by core. No registry, no hook.
 *   - Removing requires editing src/router.ts, src/delivery.ts, and
 *     src/container-runner.ts to drop the calls.
 */
import type Database from 'better-sqlite3';

import { openOutboundDb } from '../../session-manager.js';
import { getProcessingClaims } from '../../db/session-db.js';
import { isContainerRunning } from '../../container-runner.js';
import { log } from '../../log.js';

const TYPING_REFRESH_MS = 4000;
/**
 * Grace window from startTypingRefresh: fire typing unconditionally
 * for this long regardless of heartbeat state. Covers container
 * spawn/wake latency (5–12s on cold start before first heartbeat).
 */
const TYPING_GRACE_MS = 15000;
/**
 * After we deliver a user-facing message, pause typing for this
 * long so the client-side indicator has time to visually clear.
 * Tuned for the longest common expiry (Discord ~10s). The interval
 * stays running; ticks inside the pause just skip the setTyping call.
 */
const POST_DELIVERY_PAUSE_MS = 10000;
/**
 * Absolute ceiling on a single typing-refresher's lifetime. Final
 * safety net so a forgotten stop / crashed delivery loop can't keep
 * typing alive indefinitely. Long enough to cover any realistic
 * single-turn agent loop (xhigh thinking + heavy tool use + 1M
 * context). The ceiling resets on each new inbound (startedAt is
 * reset in startTypingRefresh).
 */
const TYPING_TTL_MS = 10 * 60 * 1000; // 10 min

interface TypingAdapter {
  setTyping?(channelType: string, platformId: string, threadId: string | null, instance?: string): Promise<void>;
}

interface TypingTarget {
  agentGroupId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  /** Adapter instance that owns the chat; undefined = default (= channelType). */
  instance?: string;
  interval: NodeJS.Timeout;
  startedAt: number;
  pausedUntil: number; // epoch ms; 0 = not paused
  outDb: Database.Database | null; // lazily opened on first gating tick
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
    await adapter?.setTyping?.(channelType, platformId, threadId, instance);
  } catch {
    // Typing is best-effort — don't let it fail delivery or routing.
  }
}

/**
 * Is the agent's turn still in flight for this session?
 *
 * Two-stage check:
 *   1. Container must be running (in-process map, free).
 *   2. outbound.db must have at least one processing_ack row with
 *      status='processing'. Container writes these on markProcessing
 *      (poll-loop.ts:83) and clears via markCompleted on each turn
 *      boundary (poll-loop.ts:194 — fires after the SDK ResultMessage).
 *
 * outbound.db handle is cached on the TypingTarget to avoid open/close
 * per tick (4s cadence × N sessions adds up). Closed in stopTypingRefresh.
 */
function hasInflightWork(entry: TypingTarget, sessionId: string): boolean {
  if (!isContainerRunning(sessionId)) return false;
  if (!entry.outDb) {
    try {
      entry.outDb = openOutboundDb(entry.agentGroupId, sessionId);
    } catch {
      // outbound.db may not exist yet (container hasn't written anything).
      // Grace window is the right cover for this; treat as "not inflight"
      // and fall back to grace.
      return false;
    }
  }
  try {
    return getProcessingClaims(entry.outDb).length > 0;
  } catch {
    // DB handle went bad (file deleted, container restart). Drop and
    // let the next tick re-open.
    try {
      entry.outDb.close();
    } catch {
      /* ignore */
    }
    entry.outDb = null;
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
): void {
  const existing = typingRefreshers.get(sessionId);
  if (existing) {
    // Already refreshing. Fire an immediate tick for the new inbound
    // event and reset the grace window — the new message restarts
    // the container-wake latency budget. Also clear any lingering
    // post-delivery pause: a new inbound means the user expects
    // typing to show immediately.
    triggerTyping(channelType, platformId, threadId, instance).catch(() => {});
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
    return;
  }

  // Immediate tick + periodic refresh.
  triggerTyping(channelType, platformId, threadId, instance).catch(() => {});
  const startedAt = Date.now();
  const interval = setInterval(() => {
    const entry = typingRefreshers.get(sessionId);
    if (!entry) return; // stopped externally since this tick was scheduled

    // Inside a post-delivery pause: skip setTyping but keep the
    // interval running so we resume automatically once the pause
    // expires.
    if (entry.pausedUntil > Date.now()) return;

    const age = Date.now() - entry.startedAt;
    // Absolute ceiling — final safety net so a missed stop can't keep
    // typing alive indefinitely.
    if (age > TYPING_TTL_MS) {
      log.warn('Typing refresher hit TTL ceiling, stopping', { sessionId, ageMs: age });
      stopTypingRefresh(sessionId);
      return;
    }

    const withinGrace = age < TYPING_GRACE_MS;
    if (withinGrace || hasInflightWork(entry, sessionId)) {
      triggerTyping(entry.channelType, entry.platformId, entry.threadId, entry.instance).catch(() => {});
      return;
    }

    // Out of grace AND no inflight processing_ack — agent's turn is
    // done, stop refreshing.
    stopTypingRefresh(sessionId);
  }, TYPING_REFRESH_MS);
  // unref so a stale refresher can't hold the event loop alive.
  interval.unref();
  typingRefreshers.set(sessionId, {
    agentGroupId,
    channelType,
    platformId,
    threadId,
    instance,
    interval,
    startedAt,
    pausedUntil: 0,
    outDb: null,
  });
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
  entry.pausedUntil = Date.now() + POST_DELIVERY_PAUSE_MS;
}

export function stopTypingRefresh(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  clearInterval(entry.interval);
  if (entry.outDb) {
    try {
      entry.outDb.close();
    } catch {
      /* ignore */
    }
  }
  typingRefreshers.delete(sessionId);
}
