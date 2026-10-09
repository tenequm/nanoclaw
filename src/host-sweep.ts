/**
 * Host sweep — the periodic resync over all session mailboxes.
 *
 * The per-session body lives in src/reconcile-session.ts (`reconcileSession`,
 * the ReconcileFn shape from src/reconcile.ts); execution runs through the
 * keyed workqueue (src/reconcile-queue.ts), RECONCILE_CONCURRENCY sessions
 * at a time. This module owns the resync floor: every 60s it enqueues the
 * singleton duties and every active session, then re-arms once the tick's
 * work has drained — so queue loss costs latency, never correctness, and an
 * explicit enqueue between ticks can never be lost to a concurrent sweep.
 * The re-exports below keep the long-standing import surface of this module
 * stable.
 */
import { INSTALL_SLUG } from './config.js';
import { reapRetainedSessions, stopOrphanedSessions } from './container-runner.js';
import { ensureEgressNetwork } from './egress-lockdown.js';
import { getActiveSessions } from './db/sessions.js';
import { onSessionDriverCreated, peekSessionDrivers, type SessionEventsDriver } from './drivers/index.js';
import { sweepInboundStaging } from './inbox-safety.js';
import type { SessionWatch } from './drivers/types.js';
import { log } from './log.js';
import { registerReconcileEnqueue } from './reconcile-feeds.js';
import { createReconcileQueue, type InProcessReconcileQueue } from './reconcile-queue.js';
import { reconcileSession } from './reconcile-session.js';
import { sessionKey } from './reconcile.js';

export {
  ABSOLUTE_CEILING_MS,
  CLAIM_STUCK_MS,
  _resetStuckProcessingRowsForTesting,
  decideStuckAction,
  shouldCloseTaskSession,
  type StuckDecision,
} from './reconcile-session.js';

const SWEEP_INTERVAL_MS = 60_000;

/**
 * Sessions reconciled in parallel. Each reconcile is one session's mailbox
 * round trip plus a few central reads; on a remote mailbox that is network
 * latency, and serially it made a tick scale as sessions × latency (300
 * sessions × 40 ms/hop ≈ 25 s per tick). Keys never overlap with themselves
 * (the queue serializes per key), sessions are independent by the mailbox
 * contract, and the two singleton duties tolerate running alongside sessions
 * (spawn re-heals the egress network itself; the approvals scan is a central
 * query). 8 is a modest fan-out for a remote store; local SQLite is
 * synchronous IO and neither gains nor loses.
 */
export const RECONCILE_CONCURRENCY = 8;

let running = false;
let queue: InProcessReconcileQueue | null = null;
let runtimeWatches: SessionWatch[] = [];
let unsubscribeDriverCreated: (() => void) | null = null;

/** Coalesced enqueue for the event feeds; drops harmlessly once stopped. */
function feedEnqueue(sessionId: string): void {
  const feedQueue = queue;
  if (running && feedQueue) feedQueue.add(sessionKey(sessionId));
}

/**
 * Reconcile promptly when a runtime reports a session ended: due mail on a
 * dead session waits one queue turn instead of the next resync tick. Arms
 * against every driver that already exists, and against each one built later
 * (a group on another runtime spawning after boot) — the sweep never
 * instantiates one, so suites (and hosts) that never selected a runtime are
 * untouched. Events are hints (they may drop, duplicate, or reference foreign
 * keys); the enqueue re-reads truth, so all of that is safe by construction.
 */
function armRuntimeWatch(): void {
  for (const driver of peekSessionDrivers()) watchDriver(driver);
  unsubscribeDriverCreated = onSessionDriverCreated(watchDriver);
}

function watchDriver(driver: SessionEventsDriver): void {
  // Raw test fakes may lack watchSessions; never crash on them.
  if (!running || typeof driver.watchSessions !== 'function') return;
  /* eslint-disable no-catch-all/no-catch-all -- a watch backend that cannot subscribe costs latency (the resync floor covers it), never the boot */
  try {
    runtimeWatches.push(
      driver.watchSessions(INSTALL_SLUG, (event) => {
        if (event.kind !== 'terminal' || !event.key.sessionId) return;
        feedEnqueue(event.key.sessionId);
      }),
    );
  } catch (err) {
    log.warn('Runtime watch feed unavailable — the resync floor covers it', { driver: driver.kind, err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

export function startHostSweep(): void {
  if (running) return;
  running = true;
  queue = createReconcileQueue({
    reconcile: reconcileSession,
    concurrency: RECONCILE_CONCURRENCY,
    singletons: {
      // Re-heal the egress network so already-running agents keep their
      // gateway hop if it was detached out-of-band. Best-effort: a heal
      // failure isn't a leak (agents stay on the internal net), so log and
      // continue — never surface a throw into queue backoff. No-op when
      // lockdown is disabled.
      'singleton:egress-reheal': async () => {
        try {
          ensureEgressNetwork();
        } catch (err) {
          log.error('Egress lockdown re-heal failed', { err });
        }
      },
      // Stop containers whose session or agent group was deleted: the
      // per-session reconcile only visits sessions that still have a row.
      // Then delete objects a retaining runtime kept across a stop whose
      // session row is gone (Block B): the host decides from its rows, the
      // driver deletes. A no-op on runtimes that retain nothing (Docker).
      'singleton:orphan-containers': async () => {
        try {
          await stopOrphanedSessions();
        } catch (err) {
          log.error('Orphaned container sweep failed', { err });
        }
        try {
          await reapRetainedSessions();
        } catch (err) {
          log.error('Retained-object sweep failed', { err });
        }
      },
      // Drop inbound attachments an adapter staged on disk once routing has
      // had its window to copy them into session inboxes.
      'singleton:inbound-staging': async () => {
        try {
          await sweepInboundStaging();
        } catch (err) {
          log.error('Inbound staging sweep failed', { err });
        }
      },
      // Finalize any "Reject with reason…" holds whose reply window elapsed
      // (admin ghosted, or the host restarted mid-capture). Central-DB scan,
      // once per tick — not per session.
      // MODULE-HOOK:approvals-reason-sweep:start
      'singleton:approvals-scan': async () => {
        try {
          const { sweepAwaitingReasonRejects } = await import('./modules/approvals/index.js');
          await sweepAwaitingReasonRejects();
        } catch (err) {
          log.error('Reject-with-reason sweep failed', { err });
        }
      },
      // MODULE-HOOK:approvals-reason-sweep:end
    },
  });
  // Event feeds — additive over the resync floor: mail writes and runtime
  // terminal events land as coalesced enqueues, so behavior only gets
  // faster, never different, and a lost event costs at most one tick.
  registerReconcileEnqueue(feedEnqueue);
  armRuntimeWatch();
  void sweep();
}

export function stopHostSweep(): void {
  running = false;
  registerReconcileEnqueue(null);
  unsubscribeDriverCreated?.();
  unsubscribeDriverCreated = null;
  const stoppingWatches = runtimeWatches;
  runtimeWatches = [];
  for (const stoppingWatch of stoppingWatches) {
    /* eslint-disable no-catch-all/no-catch-all -- a watch backend that is already gone must not block shutdown */
    try {
      stoppingWatch.stop();
    } catch (err) {
      log.warn('Runtime watch feed stop failed', { err });
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
  const stopping = queue;
  queue = null;
  if (stopping) void stopping.shutdown();
}

async function sweep(): Promise<void> {
  // Capture the queue for the whole tick: stopHostSweep nulls the module
  // reference mid-flight, and a stopping queue drops adds harmlessly.
  const tickQueue = queue;
  if (!running || !tickQueue) return;

  // Enqueue order matches the loop this replaces: egress re-heal, then every
  // active session, then the approvals scan; the orphan-container stop last. Keys START in that order; up to
  // RECONCILE_CONCURRENCY of them run at once.
  tickQueue.add('singleton:egress-reheal');
  try {
    const sessions = await getActiveSessions();
    for (const session of sessions) {
      tickQueue.add(sessionKey(session.id));
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }
  tickQueue.add('singleton:approvals-scan');
  tickQueue.add('singleton:orphan-containers');
  tickQueue.add('singleton:inbound-staging');

  // The tick ends — and the next one is armed — only after everything this
  // tick enqueued has run. Delayed backoff retries don't hold the tick open.
  await tickQueue.idle();
  if (!running) return;
  setTimeout(() => void sweep(), SWEEP_INTERVAL_MS);
}
