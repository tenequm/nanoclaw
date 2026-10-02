/**
 * Shared authorization helpers for the member-runnable read (/status) and /voice.
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
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';

export type StatusAccessDecision = 'allowed' | 'refuse' | 'drop';

/** Tri-state member gate for /status. Empty / null user id drops silently. */
export async function statusAccess(userId: string | null, agentGroupId: string): Promise<StatusAccessDecision> {
  if (!userId) return 'drop';
  const decision = await canAccessAgentGroup(userId, agentGroupId);
  if (decision.allowed) return 'allowed';
  return decision.reason === 'unknown_user' ? 'drop' : 'refuse';
}

/**
 * The same tri-state for /voice, which hands out the agent's call link and so
 * is admin-only: a member who is not an admin is refused.
 */
export async function voiceAccess(userId: string | null, agentGroupId: string): Promise<StatusAccessDecision> {
  const member = await statusAccess(userId, agentGroupId);
  if (member !== 'allowed' || !userId) return member;
  return (await hasAdminPrivilege(userId, agentGroupId)) ? 'allowed' : 'refuse';
}
