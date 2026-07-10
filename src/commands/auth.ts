/**
 * Shared authorization helper for the member-runnable read (/status).
 *
 * The router intercepts host commands BEFORE the per-agent fan-out (which is
 * where sender_scope / access gating normally runs), and the telegram adapter
 * handles them at the binding, so BOTH views must gate the /status read
 * themselves. This single tri-state decision keeps the two in lockstep:
 *
 *   - 'allowed': the user can access the agent group; render the status.
 *   - 'drop':    unknown sender (no users row); stay silent, mirroring how the
 *                router treats their normal messages.
 *   - 'refuse':  a known non-member; give an explicit refusal.
 *
 * Typography: ASCII only in strings/comments.
 */
import { canAccessAgentGroup } from '../modules/permissions/access.js';

export type StatusAccessDecision = 'allowed' | 'refuse' | 'drop';

/** Tri-state member gate for /status. Empty / null user id drops silently. */
export function statusAccess(userId: string | null, agentGroupId: string): StatusAccessDecision {
  if (!userId) return 'drop';
  const decision = canAccessAgentGroup(userId, agentGroupId);
  if (decision.allowed) return 'allowed';
  return decision.reason === 'unknown_user' ? 'drop' : 'refuse';
}
