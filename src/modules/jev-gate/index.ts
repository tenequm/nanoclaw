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
 *   NO NEW TABLES. The verdict is appended to the stored message text as one
 *   compact `[jev: …]` line. That line is the decision log: it lands in the
 *   session's inbound.db (queryable), reaches the agent's prompt, and shows up
 *   in pond transcripts. The daily cap, the cooldown, and the bot-loop streak
 *   are all re-derived from those annotations — nothing is persisted by us.
 *
 *   NO SHARED-EVENT MUTATION. The router's fan-out loop reuses one `event`
 *   across every wired agent, so the annotation is applied to a per-delivery
 *   copy handed back to the caller. Other wirings keep seeing the original.
 */
import { TIMEZONE } from '../../config.js';
import { findSessionForAgent } from '../../db/sessions.js';
import { log } from '../../log.js';
import { gateEntryFor, type JevGateEntry } from './config.js';
import {
  consecutiveBotWakes,
  lastWakeAt,
  oneLine,
  parseAuthor,
  readGateHistory,
  renderStateLines,
  wakesToday,
} from './history.js';
import { askJev, decide } from './jev.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { MessagingGroup, MessagingGroupAgent } from '../../types.js';

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
export { WAKE_MARKER } from './history.js';

export interface JevGateOutcome {
  /** True when the router must flip `engages` off (live mode, silent verdict). */
  silence: boolean;
  /** Per-delivery copy of the event carrying the verdict annotation. */
  event: InboundEvent;
  /** The annotation line, for logs and tests. */
  annotation: string;
}

export interface JevGateInput {
  agent: MessagingGroupAgent;
  mg: MessagingGroup;
  event: InboundEvent;
  /** The wiring's effective thread id, for session resolution. */
  threadId: string | null;
}

/** Append the verdict to this delivery's copy of the content JSON. */
function annotateContent(raw: string, annotation: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.text === 'string') {
      return JSON.stringify({ ...parsed, text: `${parsed.text}\n${annotation}` });
    }
    return raw;
  } catch {
    return `${raw}\n${annotation}`;
  }
}

function score(value: number): string {
  return value.toFixed(2);
}

function outcome(entry: JevGateEntry, event: InboundEvent, wake: boolean, detail: string): JevGateOutcome {
  const verdict = wake ? 'reply' : 'silent';
  const annotation = `[jev: ${entry.mode === 'shadow' ? `shadow-${verdict}` : verdict} · ${detail}]`;
  return {
    silence: entry.mode === 'live' && !wake,
    event: { ...event, message: { ...event.message, content: annotateContent(event.message.content, annotation) } },
    annotation,
  };
}

function errorOutcome(entry: JevGateEntry, event: InboundEvent, reason: string): JevGateOutcome {
  const annotation = `[jev: error ${reason}]`;
  return {
    silence: entry.mode === 'live',
    event: { ...event, message: { ...event.message, content: annotateContent(event.message.content, annotation) } },
    annotation,
  };
}

/**
 * Judge one engaged, non-mention group message. Returns null when the gate is
 * off for this wiring — the router then behaves exactly as it does upstream.
 * Never throws.
 */
export async function runJevGate(input: JevGateInput): Promise<JevGateOutcome | null> {
  const { agent, mg, event, threadId } = input;
  const entry = gateEntryFor(agent.agent_group_id);
  if (!entry) return null;

  try {
    return await judge(entry, agent, mg, event, threadId);
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
): Promise<JevGateOutcome> {
  const session = await findSessionForAgent(agent.agent_group_id, mg.id, threadId);
  const rows = session ? await readGateHistory(agent.agent_group_id, session.id) : [];
  const message = parseAuthor(event.message.content);
  const now = new Date();

  // Free levers first — no reason to pay for a judgment we would override.
  if (entry.daily_cap > 0) {
    const used = wakesToday(rows, TIMEZONE, now);
    if (used >= entry.daily_cap) return outcome(entry, event, false, `daily_cap ${used}/${entry.daily_cap}`);
  }
  if (entry.cooldown_minutes > 0) {
    const last = lastWakeAt(rows);
    if (last && now.getTime() - last.getTime() < entry.cooldown_minutes * 60_000) {
      return outcome(entry, event, false, `cooldown ${entry.cooldown_minutes}m`);
    }
  }
  if (entry.max_consecutive_bot > 0 && message.isBot) {
    const streak = consecutiveBotWakes(rows);
    if (streak >= entry.max_consecutive_bot) {
      return outcome(entry, event, false, `bot_loop_guard ${streak}`);
    }
  }

  const who = `${message.sender || 'unknown'}${message.isBot ? ' [bot]' : ''}`;
  const state = [
    'Conversation so far (oldest first):',
    renderStateLines(rows) || '(no prior messages)',
    '',
    'NEW MESSAGE:',
    `${who}: ${oneLine(message.text)}`,
  ].join('\n');

  const result = await askJev(state);
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
