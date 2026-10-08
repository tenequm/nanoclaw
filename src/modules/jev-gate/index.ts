/**
 * Jev ambient wake-gate.
 *
 * A wiring whose `engage_mode` is widened to pattern-everything engages on
 * every message. This gate stands behind that: for the wirings listed in
 * `data/jev-gate.json`, each non-mention group message that engaged is put to
 * Jev — a fast typed-judgment API — and a `silent` verdict is handed back to
 * the router, which flips `engages` off so the message falls into the existing
 * `ignored_message_policy: 'accumulate'` branch and is stored as silent
 * context instead of waking a container.
 *
 * Three properties matter more than the rubric:
 *
 *   FAIL-SILENT. Missing key, timeout, non-200, bad body, unreadable config,
 *   unreadable session DB — every one of them resolves to `silent`, which is
 *   exactly what the wiring did before the gate existed. Failing open on a
 *   pattern-everything wiring means a container wake per message.
 *
 *   NO NEW TABLES, NO TEXT. The verdict lands on the stored message only as a
 *   host-written `jev` metadata key in the content JSON, never in `text`: the
 *   agent's prompt and transcripts must not carry the gate's bookkeeping. The
 *   daily cap, the cooldown, and the bot-loop streak are re-derived from that
 *   key, which user text cannot forge. The host log carries the verdict line.
 *
 *   NO SHARED-EVENT MUTATION. The router's fan-out loop reuses one `event`
 *   across every wired agent, so the annotation is applied to a per-delivery
 *   copy handed back to the caller. Other wirings keep seeing the original.
 */
import { TIMEZONE } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { findSessionForAgent } from '../../db/sessions.js';
import { log } from '../../log.js';
import { gateEntryFor, type JevGateEntry } from './config.js';
import {
  consecutiveBotWakes,
  lastWakeAt,
  parseAuthor,
  readGateHistory,
  renderState,
  wakesToday,
  type JevMeta,
} from './history.js';
import { askJev, decide } from './jev.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { MessagingGroup, MessagingGroupAgent, UserRoleKind } from '../../types.js';

export {
  DEFAULT_ENTRY,
  DEFAULT_THRESHOLDS,
  gateConfigPath,
  gateEntryFor,
  loadGateConfig,
  resetGateConfigCache,
  writeGateEntry,
} from './config.js';
export type { JevGateEntry, JevGatePatch, JevThresholds } from './config.js';

export interface JevGateOutcome {
  /** True when the router must flip `engages` off (live mode, silent verdict). */
  silence: boolean;
  /** Per-delivery copy of the event carrying the verdict metadata. */
  event: InboundEvent;
  /** The verdict line, for the host log and tests. */
  annotation: string;
}

export interface JevGateInput {
  agent: MessagingGroupAgent;
  mg: MessagingGroup;
  event: InboundEvent;
  /** The wiring's effective thread id, for session resolution. */
  threadId: string | null;
  /** The sender's role the host resolved; the content's own `senderRole` is not trusted. */
  senderRole: UserRoleKind | undefined;
}

/**
 * Write the `jev` metadata key onto this delivery's copy of the content JSON.
 * Only the host writes this key; user text is a JSON string value and cannot
 * forge it.
 */
function annotateContent(raw: string, jev: JevMeta): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.text === 'string') {
      return JSON.stringify({ ...parsed, jev });
    }
    return raw;
  } catch {
    return raw;
  }
}

/**
 * The per-delivery copy. The adapter's deferred `materialize` writes the
 * downloaded attachment paths into the ORIGINAL event's content, which the
 * copy's snapshot would never see — so the copy re-annotates from the
 * original once it has materialized. The original's hook is memoized, so the
 * download stays shared with every other wiring; `at` is stamped once so the
 * stored verdict time does not drift by the download.
 */
function annotatedCopy(event: InboundEvent, meta: JevMeta): InboundEvent {
  const jev: JevMeta = { ...meta, at: new Date().toISOString() };
  const copy: InboundEvent = {
    ...event,
    message: { ...event.message, content: annotateContent(event.message.content, jev) },
  };
  const materialize = event.materialize;
  if (materialize) {
    copy.materialize = async () => {
      try {
        await materialize();
      } finally {
        copy.message.content = annotateContent(event.message.content, jev);
      }
    };
  }
  return copy;
}

function score(value: number): string {
  return value.toFixed(2);
}

function outcome(entry: JevGateEntry, event: InboundEvent, wake: boolean, detail: string): JevGateOutcome {
  const verdict = wake ? 'reply' : 'silent';
  const annotation = `[jev: ${entry.mode === 'shadow' ? `shadow-${verdict}` : verdict} · ${detail}]`;
  const meta: JevMeta = { v: verdict, mode: entry.mode };
  return {
    // Shadow's baseline is the pre-gate wiring (mention-only), not the
    // pattern-everything wiring the gate rides on — so shadow suppresses
    // every ambient message while logging what live WOULD have done. A
    // shadow verdict that wakes would turn calibration mode into one
    // container wake per message the moment the wiring is widened.
    silence: entry.mode === 'shadow' || !wake,
    event: annotatedCopy(event, meta),
    annotation,
  };
}

function errorOutcome(entry: JevGateEntry, event: InboundEvent, reason: string): JevGateOutcome {
  const annotation = `[jev: error ${reason}]`;
  const meta: JevMeta = { v: 'error', mode: entry.mode };
  return {
    silence: true,
    event: annotatedCopy(event, meta),
    annotation,
  };
}

/**
 * Judge one engaged, non-mention group message. Returns null when the gate is
 * off for this wiring — the router then behaves exactly as it does upstream.
 * Never throws.
 */
export async function runJevGate(input: JevGateInput): Promise<JevGateOutcome | null> {
  const { agent, mg, event, threadId, senderRole } = input;
  const entry = gateEntryFor(agent.agent_group_id);
  if (!entry) return null;

  try {
    return await judge(entry, agent, mg, event, threadId, senderRole);
  } catch (err) {
    // Any unexpected throw is a silent verdict, not a wake.
    log.warn('Jev gate threw — falling back to silent', { agentGroupId: agent.agent_group_id, err });
    return errorOutcome(entry, event, 'internal');
  }
}

async function judge(
  entry: JevGateEntry,
  agent: MessagingGroupAgent,
  mg: MessagingGroup,
  event: InboundEvent,
  threadId: string | null,
  senderRole: UserRoleKind | undefined,
): Promise<JevGateOutcome> {
  const session = await findSessionForAgent(agent.agent_group_id, mg.id, threadId);
  const rows = session ? await readGateHistory(agent.agent_group_id, session.id) : [];
  const message = { ...parseAuthor(event.message.content), role: senderRole ?? null };
  const now = new Date();

  // Free levers first — no reason to pay for a judgment we would override.
  // Each lever derives from verdicts of the CURRENT mode, so shadow simulates
  // the cap/cooldown/streak that live would apply, without either mode
  // consuming the other's quota.
  if (entry.daily_cap > 0) {
    const used = wakesToday(rows, TIMEZONE, now, entry.mode);
    if (used >= entry.daily_cap) return outcome(entry, event, false, `daily_cap ${used}/${entry.daily_cap}`);
  }
  if (entry.cooldown_minutes > 0) {
    const last = lastWakeAt(rows, entry.mode);
    if (last && now.getTime() - last.getTime() < entry.cooldown_minutes * 60_000) {
      return outcome(entry, event, false, `cooldown ${entry.cooldown_minutes}m`);
    }
  }
  if (entry.max_consecutive_bot > 0 && message.isBot) {
    const streak = consecutiveBotWakes(rows, entry.mode);
    if (streak >= entry.max_consecutive_bot) {
      return outcome(entry, event, false, `bot_loop_guard ${streak}`);
    }
  }

  const agentName = await agentNameFor(agent.agent_group_id);
  const state = renderState(
    rows,
    { timestamp: event.message.timestamp, direction: 'in', kind: event.message.kind, ...message },
    agentName,
  );

  const result = await askJev(state, agentName);
  if (!result.ok) return errorOutcome(entry, event, result.reason);

  const decision = decide(result.scores, entry.thresholds);
  const detail = [
    `value=${score(decision.value)}`,
    `veto=${score(decision.veto)}`,
    ...(decision.reason ? [decision.reason] : []),
  ].join(' · ');

  log.debug('Jev gate verdict', {
    agentGroupId: agent.agent_group_id,
    mode: entry.mode,
    wake: decision.wake,
    ...result.scores,
  });

  return outcome(entry, event, decision.wake, detail);
}

/** The name the agent goes by in chat, as its container is configured with it. */
async function agentNameFor(agentGroupId: string): Promise<string> {
  const assistantName = (await getContainerConfig(agentGroupId))?.assistant_name;
  return assistantName ?? (await getAgentGroup(agentGroupId))?.name ?? agentGroupId;
}
