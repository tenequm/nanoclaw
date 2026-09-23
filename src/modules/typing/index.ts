/**
 * Typing indicator refresh — default module.
 *
 * Most platforms expire a typing indicator after 5–10s, so a one-shot
 * call on message arrival goes stale long before the agent finishes
 * thinking. This module keeps it alive by re-firing `setTyping` on a
 * short interval while the agent is actually working.
 *
 * "Working" is decided from the runner's own presence report, read on the
 * delivery poll (`notePresence`): the turn state the runner writes to its
 * container record (`working` while a turn runs, `idle` when it ends) plus
 * an optional status line it may publish under the `live_status` state key.
 * The host no longer has to guess from a heartbeat FILE — which is
 * invisible when the delivering process doesn't share a filesystem with
 * the runner, and never says "stop". A runner that predates the turn
 * report never reaches `notePresence` with a turn, so those sessions keep
 * the old heartbeat-file behaviour unchanged.
 *
 * Status text: while the turn is `working` and fresh, a reported status
 * line rides on the same refresh — every tick sends `setTyping` exactly as
 * plain typing does, and the text only changes the payload
 * (`setTyping(..., text, 'agent')`). On platforms with a sticky status
 * (Slack's assistant status) it replaces the generic "typing" line;
 * platforms that cannot show text ignore it and keep their usual cadence.
 *
 * When a turn ends (idle, or a `working` report that has gone stale) the
 * refresh ENDS: the interval is cleared and the adapter's optional
 * `clearTyping` fires once, for platforms whose indicator does not expire
 * on its own within a turn (Slack's assistant status persists until a post,
 * an explicit clear, or a two-minute timeout).
 *
 * After delivering a user-facing message, the refresh is paused for
 * POST_DELIVERY_PAUSE_MS so the client-side indicator can visually
 * clear.
 *
 * Threadless chats on a thread-only platform (Slack's assistant status
 * paints only inside a thread) get a reaction ack instead: 👀 on the
 * triggering message while the agent works, removed when it replies or
 * the refresh ends.
 *
 * Default module status:
 *   - Lives in src/modules/ for signaling (not really core), but ships
 *     on main and is imported directly by core. No registry, no hook.
 *   - Removing requires editing src/router.ts, src/delivery.ts, and
 *     src/container-runner.ts to drop the calls.
 */
import fs from 'fs';

import { log } from '../../log.js';
import { heartbeatPath } from '../../session-manager.js';

const TYPING_REFRESH_MS = 4000;
/**
 * Grace window from startTypingRefresh: fire typing unconditionally
 * for this long regardless of turn/heartbeat state. Covers container
 * spawn/wake latency (5–12s on cold start before the first turn report).
 */
const TYPING_GRACE_MS = 15000;
/**
 * After the grace window, a heartbeat must be mtimed within this
 * many ms of now to count as "agent is working." Only used for older
 * runners that never report a turn (see notePresence).
 */
const HEARTBEAT_FRESH_MS = 6000;
/**
 * A `working` turn report counts as live only if its stamp is within this
 * many ms of now. The runner re-marks `working` every 5s, so this is three
 * re-marks: a report older than that means the runner stopped moving (turn
 * ended without an idle write, or the runner died) and we stop refreshing.
 */
const TURN_STALE_MS = 15000;
/**
 * After we deliver a user-facing message, pause typing for this
 * long so the client-side indicator has time to visually clear.
 * Tuned for the longest common expiry (Discord ~10s). The interval
 * stays running; ticks inside the pause just skip the setTyping call.
 */
const POST_DELIVERY_PAUSE_MS = 10000;
/**
 * Longest continuous typing stretch without visible progress. Defense in
 * depth against a runner stuck re-marking `working` (or any other signal
 * that never ends): past it the indicator stops until a new turn starts, a
 * reply is delivered, or a new inbound wakes the session. Generous on
 * purpose: it bounds leaks, and back-to-back queued turns share one stretch.
 */
const TYPING_CEILING_MS = 5 * 60 * 1000;
/**
 * How long a report left by a previous run keeps plain typing alive before
 * the runner reports this wake (slow cold start). The heartbeat file cannot
 * vouch here: the host removes it at spawn and the runner reports the turn
 * before its first event touches it.
 */
const LEFTOVER_REPORT_BUDGET_MS = 60_000;

/** Reaction ack for platforms that cannot paint a threadless indicator. */
const ACK_EMOJI = 'eyes';

interface TypingAdapter {
  setTyping?(
    channelType: string,
    platformId: string,
    threadId: string | null,
    instance?: string,
    status?: string,
    statusKind?: 'auto' | 'agent',
  ): Promise<void>;
  /**
   * Clear the typing indicator. Only platforms whose indicator does not
   * expire on its own implement it (e.g. Slack's assistant status); others
   * omit it and the module no-ops via optional chaining.
   */
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

/** A runner-authored status line, as read from the `live_status` state key. */
export interface PresenceStatus {
  text: string;
  /** session_state.updated_at in epoch ms. */
  atMs: number;
}

/** The runner's latest presence report, as read on the delivery poll. */
export interface PresenceReport {
  /** 'working' | 'idle', or null when the runner never reported (older runner). */
  turn: 'working' | 'idle' | null;
  /** container_state.updated_at in epoch ms, or null when there is no record. */
  updatedAtMs: number | null;
  /** Status text, or null when none is published. */
  status: PresenceStatus | null;
}

interface TypingTarget {
  agentGroupId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  /** Adapter instance that owns the chat; undefined = default (= channelType). */
  instance?: string;
  /**
   * How this session's "working" signal is rendered. Decided from the
   * address the refresher was started on: 'status' is the normal
   * indicator, 'reaction' the fallback when the platform needs a thread and
   * this chat has none. A re-trigger re-decides, since an agent-shared
   * session can move between chats.
   */
  mode: 'status' | 'reaction';
  /** Platform id of the message the ack sits on ('reaction' mode only). */
  messageId?: string;
  /** Whether the reaction ack is on, so it is added and removed exactly once. */
  painted: boolean;
  interval: NodeJS.Timeout;
  startedAt: number;
  pausedUntil: number; // epoch ms; 0 = not paused
  /** Start of the current typing stretch: the wake, or the last idle->working transition. */
  typingSince: number;
  /** The ceiling tripped: nothing is painted until the state changes or a new wake. */
  capped: boolean;
  /** Latest runner presence report; undefined until the first notePresence. */
  presence?: PresenceReport;
}

let adapter: TypingAdapter | null = null;
const typingRefreshers = new Map<string, TypingTarget>();

/**
 * Bind the typing module to the channel delivery adapter so it can
 * call `setTyping` and `clearTyping`. Called once by `src/delivery.ts`
 * inside `setDeliveryAdapter`. Passing a fresh adapter replaces the prior
 * binding and leaves active refreshers in place (they'll use the
 * new adapter on their next tick).
 */
export function setTypingAdapter(a: TypingAdapter): void {
  adapter = a;
}

/**
 * Every call here is best-effort: the signal is decoration, and a failure
 * must never reach delivery or routing. Swallowing silently makes the whole
 * surface undiagnosable though — a missing scope or a bad message id looks
 * identical to "working fine" — so failures are logged and then dropped.
 */
function signalFailed(op: string, fields: Record<string, unknown>, err: unknown): void {
  log.warn('activity signal failed', { op, ...fields, err: String(err) });
}

async function triggerTyping(
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
  status?: string,
  statusKind?: 'auto' | 'agent',
): Promise<void> {
  try {
    await adapter?.setTyping?.(channelType, platformId, threadId, instance, status, statusKind);
  } catch (err) {
    signalFailed('setTyping', { channelType, platformId, threadId, instance }, err);
  }
}

async function triggerClear(
  channelType: string,
  platformId: string,
  threadId: string | null,
  instance?: string,
): Promise<void> {
  try {
    await adapter?.clearTyping?.(channelType, platformId, threadId, instance);
  } catch (err) {
    signalFailed('clearTyping', { channelType, platformId, threadId, instance }, err);
  }
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

/** Paint the entry's signal: a typing tick, or the one-shot reaction ack. */
function paintSignal(entry: TypingTarget): void {
  if (entry.mode === 'status') {
    triggerTyping(entry.channelType, entry.platformId, entry.threadId, entry.instance).catch(() => {});
    return;
  }
  if (entry.painted || !entry.messageId) return;
  const messageId = entry.messageId;
  entry.painted = true;
  void adapter
    ?.addReaction?.(entry.channelType, entry.platformId, messageId, ACK_EMOJI, entry.instance)
    .catch((err) =>
      signalFailed(
        'addReaction',
        { channelType: entry.channelType, platformId: entry.platformId, messageId, instance: entry.instance },
        err,
      ),
    );
}

/** Take the entry's signal down: clear the status, or remove the ack once. */
function clearSignal(entry: TypingTarget): void {
  if (entry.mode === 'status') {
    triggerClear(entry.channelType, entry.platformId, entry.threadId, entry.instance).catch(() => {});
    return;
  }
  if (!entry.painted || !entry.messageId) return;
  entry.painted = false;
  const messageId = entry.messageId;
  void adapter
    ?.removeReaction?.(entry.channelType, entry.platformId, messageId, ACK_EMOJI, entry.instance)
    .catch((err) =>
      signalFailed(
        'removeReaction',
        { channelType: entry.channelType, platformId: entry.platformId, messageId, instance: entry.instance },
        err,
      ),
    );
}

/**
 * One refresh tick: the same setTyping call plain typing has always made,
 * carrying the status text (and `statusKind: 'agent'`) when there is one to
 * show. The cadence never depends on the text, so channels that cannot
 * show it keep their indicator alive exactly as before. A reaction ack does
 * not expire, so only the status rendering re-fires.
 */
function refresh(entry: TypingTarget, showStatus: boolean): void {
  if (entry.mode !== 'status' || entry.capped) return;
  const text = showStatus ? entry.presence?.status?.text : undefined;
  if (text) {
    triggerTyping(entry.channelType, entry.platformId, entry.threadId, entry.instance, text, 'agent').catch(() => {});
    return;
  }
  triggerTyping(entry.channelType, entry.platformId, entry.threadId, entry.instance).catch(() => {});
}

/**
 * End a refresher: stop the interval, drop the entry, and clear the
 * indicator once. Idempotent per session — the entry is removed first, so a
 * later tick or a stopTypingRefresh call finds nothing and does not clear
 * twice.
 */
function endRefresh(sessionId: string, entry: TypingTarget): void {
  clearInterval(entry.interval);
  typingRefreshers.delete(sessionId);
  clearSignal(entry);
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
    // The signal moves to the new message: take the old one down first
    // (its address fields are still the ones it was painted on), then
    // re-decide the rendering and paint against the new address. A status
    // at an unchanged address is just repainted — a clear racing the
    // repaint could land second and blank it.
    const moved =
      existing.channelType !== channelType ||
      existing.platformId !== platformId ||
      existing.threadId !== threadId ||
      existing.instance !== instance;
    if (existing.mode === 'reaction' || moved) clearSignal(existing);
    existing.startedAt = Date.now();
    existing.pausedUntil = 0;
    existing.typingSince = existing.startedAt;
    existing.capped = false;
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

    const now = Date.now();
    const report = entry.presence;
    // A report stamped before this wake is a previous run's leftover (a slow
    // cold start has not re-marked yet), so it must not end the first turn's
    // typing: treat it as not yet reported and keep typing for a bounded
    // budget (LEFTOVER_REPORT_BUDGET_MS).
    const fromThisWake = report?.updatedAtMs == null || report.updatedAtMs >= entry.startedAt;
    const reported = report !== undefined && report.turn !== null && fromThisWake;
    const leftover = report !== undefined && report.turn !== null && !fromThisWake;
    // Status text is shown only while the runner is provably inside this
    // turn: a `working` report with a fresh stamp. Anywhere else (grace on a
    // cold start, the heartbeat fallback) the text could be last turn's.
    const workingFresh =
      reported && report.turn === 'working' && report.updatedAtMs !== null && now - report.updatedAtMs < TURN_STALE_MS;

    // Inside a post-delivery pause: skip setTyping but keep the
    // interval running so we resume automatically once the pause
    // expires.
    if (entry.pausedUntil > now) return;

    // The end rules below still run once capped; only the painting stops.
    if (!entry.capped && now - entry.typingSince >= TYPING_CEILING_MS) {
      entry.capped = true;
      clearSignal(entry);
      log.warn('typing ceiling reached, indicator stopped', { sessionId, ceilingMs: TYPING_CEILING_MS });
    }

    // Within the grace window since the last inbound: fire
    // unconditionally, covering container spawn/wake latency before the
    // first turn report lands.
    if (now - entry.startedAt < TYPING_GRACE_MS) {
      refresh(entry, workingFresh);
      return;
    }

    // The runner reported a turn: follow it. 'working' with a fresh stamp
    // keeps refreshing; 'idle', or a 'working' report gone stale (runner
    // stopped re-marking), ends the refresh and clears the indicator.
    if (reported) {
      if (workingFresh) {
        refresh(entry, true);
        return;
      }
      endRefresh(sessionId, entry);
      return;
    }

    if (leftover && now - entry.startedAt < LEFTOVER_REPORT_BUDGET_MS) {
      refresh(entry, false);
      return;
    }

    // No turn reported this wake (older runner, or the leftover budget ran
    // out): fall back to the heartbeat file.
    if (isHeartbeatFresh(entry.agentGroupId, sessionId)) {
      refresh(entry, false);
      return;
    }
    endRefresh(sessionId, entry);
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
    painted: false,
    interval,
    startedAt,
    pausedUntil: 0,
    typingSince: startedAt,
    capped: false,
  };
  typingRefreshers.set(sessionId, entry);
  // Immediate tick (or ack) + periodic refresh.
  paintSignal(entry);
}

/**
 * Record the runner's latest presence report for a session, read on the
 * delivery poll: turn state plus optional status text. Stores it on the
 * active refresher entry; creates no entry if none is active (typing is
 * only ever started by an inbound message). A missing record or a null turn
 * (older runner) reads as "not reported" and leaves the heartbeat-file
 * fallback in charge.
 */
export function notePresence(sessionId: string, report: PresenceReport): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  const wasWorking = entry.presence?.turn === 'working';
  entry.presence = report;
  // A turn starting is a state change: the ceiling clock restarts. A fresh
  // re-mark of an ongoing `working` turn is not. Only a status repaints (on
  // the next tick); the ack stays with the inbound that placed it, so a later
  // turn never re-adds it to an answered message.
  if (report.turn === 'working' && !wasWorking) {
    entry.typingSince = Date.now();
    entry.capped = false;
  }
}

/**
 * Pause the typing refresh for POST_DELIVERY_PAUSE_MS. Called after
 * a user-facing message is delivered so the client-side indicator
 * has a chance to visually clear before the agent's next SDK event
 * pushes it back on. No-op if no refresh is active for this session.
 * (A delivered reply also clears a sticky status on the platform; the
 * first tick after the pause simply sends it again.)
 */
export function pauseTypingRefreshAfterDelivery(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  // The reply IS the answer to the ack, so the reaction comes off now
  // rather than waiting for the turn to end. (The status rendering needs no
  // equivalent: the platform auto-clears it on the post.)
  if (entry.mode === 'reaction') clearSignal(entry);
  entry.pausedUntil = Date.now() + POST_DELIVERY_PAUSE_MS;
  // A delivered reply is progress a stuck runner cannot fake: the ceiling
  // counts from here.
  entry.typingSince = Date.now();
  entry.capped = false;
}

export function stopTypingRefresh(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  endRefresh(sessionId, entry);
}
