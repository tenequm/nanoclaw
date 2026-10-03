/**
 * The wake seam.
 *
 * Every "make this session's container run" call site migrates from
 * importing `wakeContainer` directly to `requestWake`, giving wake intent a
 * single chokepoint so it can later be recorded durably (`wake_signals` in
 * src/db/coordination.ts) and served event-driven. The implementation below
 * is a pure delegation to `wakeContainer`, reason included, and MUST stay
 * that way until the durable rows become authoritative: no logging, no
 * signal writes, no behavior of its own. The reason reaches a container this
 * wake spawns as `NANOCLAW_WAKE_REASON` (every reason, not only
 * `voice-call`); the runner acts on `voice-call` alone.
 */
import { wakeContainer } from './container-runner.js';
import type { Session } from './types.js';

/**
 * Why the session should be running. Passed to the spawned container today
 * and later recorded on the wake-signal row; extend the union as call sites
 * migrate.
 */
export type WakeReason =
  | 'inbound-message'
  | 'due-message'
  | 'container-restart'
  | 'self-mod-apply'
  | 'agent-created'
  | 'interactive'
  | 'cli'
  | 'approval-response'
  | 'adoption'
  // A voice call joined: start the agent before the caller's first turn (no message is posted).
  | 'voice-call';

export async function requestWake(session: Session, reason: WakeReason): Promise<boolean> {
  return wakeContainer(session, reason);
}
