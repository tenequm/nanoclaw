/**
 * HostCommandService: the channel-agnostic owner of chat-command semantics.
 *
 * Every function here reads/writes the central DB and container config, and
 * returns view-model DATA (never formatted text). Callers (router fallback,
 * telegram-grammy adapter) render the views for their channel.
 *
 * Apply semantics:
 *   - /model and /config writes: INSTANT KILL of running containers, LAZY
 *     respawn. No wake message; the container returns on the next user
 *     message with the new config. The card/menu edit is the confirmation.
 *   - /restart: IMMEDIATE respawn WITH a wake message (like self-mod restarts).
 *
 * Authorization: every write re-checks hasAdminPrivilege(actor, agentGroup)
 * inside the service (defense in depth; callers also gate). Reads (getStatus,
 * getModelPicker, getConfigView, resolveTargets) do not check auth; callers
 * gate member-runnable reads.
 *
 * The underlying container kill/restart primitives are synchronous, so these
 * functions are synchronous too.
 */
import fs from 'fs';

import { restartAgentGroupContainers } from '../container-restart.js';
import { isContainerRunning, killContainer } from '../container-runner.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from '../db/container-configs.js';
import {
  getMessagingGroupAgentByPair,
  getMessagingGroupAgents,
  updateMessagingGroupAgent,
} from '../db/messaging-groups.js';
import { countDueMessages } from '../db/session-db.js';
import {
  findSessionByAgentGroup,
  findSessionForAgent,
  findTaskSessions,
  getSessionsByAgentGroup,
} from '../db/sessions.js';
import { log } from '../log.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import { inboundDbPath, withInboundDb } from '../session-manager.js';
import type { ContainerConfigRow, EngageMode, Session } from '../types.js';
import { readTranscriptStats } from './transcript.js';
import {
  describeModel,
  isEffortLevel,
  modelLabelFor,
  parsePositiveInt,
  resolveModelInput,
  MODEL_CATALOG,
  EFFORT_LEVELS,
  COMPACT_WINDOW_PRESETS,
  type ActivationChangeView,
  type ActivationView,
  type CommandFailure,
  type CommandResult,
  type ConfigChangeView,
  type ConfigField,
  type ConfigView,
  type ModelChangeView,
  type ModelPickerOption,
  type ModelPickerView,
  type RestartView,
  type StatusChatContext,
  type StatusView,
  type TargetAgent,
  type TargetResolution,
} from './types.js';

/** Default cli_scope when no container_configs row exists yet. */
const DEFAULT_CLI_SCOPE = 'group';

function fail(reason: CommandFailure['reason'], detail?: CommandFailure['detail']): CommandFailure {
  return { ok: false, reason, detail };
}

/**
 * Kill every running container for an agent group WITHOUT respawning. Used by
 * /model and /config writes: the container returns lazily on the next user
 * message and picks up the new config. Returns the number killed.
 */
function killAgentGroupContainersLazy(agentGroupId: string, reason: string): number {
  const sessions = getSessionsByAgentGroup(agentGroupId).filter(
    (s) => s.status === 'active' && isContainerRunning(s.id),
  );
  for (const s of sessions) {
    killContainer(s.id, reason);
  }
  if (sessions.length > 0) {
    log.info('Killed agent group containers for config apply (lazy respawn)', {
      agentGroupId,
      reason,
      count: sessions.length,
    });
  }
  return sessions.length;
}

// --- Target resolution ---

/**
 * Resolve a messaging group to its wired agent group(s).
 *
 * Determinism: the list is sorted by agent group name (localeCompare), with
 * the agent group id as a stable tiebreaker. Telegram pickers index into this
 * sorted order, so the sort MUST be stable across calls and processes. Never
 * change it to depend on insertion order or wiring priority.
 */
export function resolveTargets(messagingGroupId: string): TargetResolution {
  const wirings = getMessagingGroupAgents(messagingGroupId);
  const agents: TargetAgent[] = [];
  const seen = new Set<string>();
  for (const w of wirings) {
    if (seen.has(w.agent_group_id)) continue;
    seen.add(w.agent_group_id);
    const ag = getAgentGroup(w.agent_group_id);
    if (!ag) continue;
    agents.push({ agentGroupId: ag.id, agentName: ag.name });
  }

  agents.sort((a, b) => {
    const byName = a.agentName.localeCompare(b.agentName);
    if (byName !== 0) return byName;
    return a.agentGroupId.localeCompare(b.agentGroupId);
  });

  if (agents.length === 0) return { kind: 'none' };
  if (agents.length === 1) return { kind: 'single', agent: agents[0] };
  return { kind: 'multiple', agents };
}

// --- Chat-context resolution helpers ---

/** Activation (engage) view from the wiring row for one (mg, agent) pair. */
function activationFor(messagingGroupId: string, agentGroupId: string): ActivationView | null {
  const wiring = getMessagingGroupAgentByPair(messagingGroupId, agentGroupId);
  if (!wiring) return null;
  return {
    engageMode: wiring.engage_mode,
    engagePattern: wiring.engage_pattern,
    senderScope: wiring.sender_scope,
  };
}

/**
 * Resolve (without creating) the existing session a chat's status should
 * reflect. Prefers the wiring's session mode; agent-shared collapses to the
 * group's single session, otherwise per-thread then shared. Returns null when
 * no session exists yet (a never-woken chat).
 */
function findChatSession(agentGroupId: string, chatCtx: StatusChatContext): Session | null {
  const wiring = getMessagingGroupAgentByPair(chatCtx.messagingGroupId, agentGroupId);
  if (wiring?.session_mode === 'agent-shared') {
    return findSessionByAgentGroup(agentGroupId) ?? null;
  }
  if (chatCtx.threadId) {
    const perThread = findSessionForAgent(agentGroupId, chatCtx.messagingGroupId, chatCtx.threadId);
    if (perThread) return perThread;
  }
  return findSessionForAgent(agentGroupId, chatCtx.messagingGroupId, null) ?? null;
}

/** Undelivered (due) inbound messages for a session, or null on any error. */
function safeQueueDepth(agentGroupId: string, sessionId: string): number | null {
  try {
    if (!fs.existsSync(inboundDbPath(agentGroupId, sessionId))) return null;
    return withInboundDb(agentGroupId, sessionId, (db) => countDueMessages(db));
  } catch (err) {
    log.debug('Queue depth read failed', { agentGroupId, sessionId, err: String(err) });
    return null;
  }
}

/** Active (pending/paused) scheduled task series for an agent group, or null. */
function safeTaskCount(agentGroupId: string): number | null {
  try {
    let total = 0;
    for (const s of findTaskSessions(agentGroupId)) {
      if (!fs.existsSync(inboundDbPath(agentGroupId, s.id))) continue;
      total += withInboundDb(agentGroupId, s.id, (db) => {
        const row = db
          .prepare(
            `SELECT COUNT(*) AS c FROM (
               SELECT 1 FROM messages_in
                WHERE kind = 'task' AND status IN ('pending', 'paused')
                GROUP BY series_id
             )`,
          )
          .get() as { c: number };
        return row.c;
      });
    }
    return total;
  } catch (err) {
    log.debug('Task count read failed', { agentGroupId, err: String(err) });
    return null;
  }
}

// --- Reads ---

/**
 * Read-only status for an agent group. Member-runnable; no auth check here.
 * Missing container_configs rows are treated as all-defaults rather than an
 * error, so a freshly created agent still yields a usable status card.
 *
 * When `chatCtx` is supplied, the card also reflects that chat's activation
 * wiring, its session's queue depth, and the session's transcript-derived
 * context/output/turn counts. Without it, activation + queue are omitted and
 * the transcript falls back to the group's newest .jsonl.
 */
export function getStatus(agentGroupId: string, chatCtx?: StatusChatContext): CommandResult<StatusView> {
  const ag = getAgentGroup(agentGroupId);
  if (!ag) return fail('unknown-agent');

  const cfg = getContainerConfig(agentGroupId);
  const activeSessions = getSessionsByAgentGroup(agentGroupId).filter((s) => s.status === 'active');

  let activation: ActivationView | null = null;
  let queueDepth: number | null = null;
  let session: Session | null = null;
  if (chatCtx) {
    activation = activationFor(chatCtx.messagingGroupId, agentGroupId);
    session = findChatSession(agentGroupId, chatCtx);
    if (session) queueDepth = safeQueueDepth(agentGroupId, session.id);
  }

  const stats = readTranscriptStats(agentGroupId, session?.id ?? null);

  const view: StatusView = {
    agentName: ag.name,
    agentGroupId,
    model: cfg?.model ?? null,
    modelLabel: cfg?.model ? modelLabelFor(cfg.model) : null,
    effort: cfg?.effort ?? null,
    autoCompactWindow: cfg?.auto_compact_window ?? null,
    maxMessagesPerPrompt: cfg?.max_messages_per_prompt ?? null,
    provider: cfg?.provider ?? null,
    cliScope: cfg?.cli_scope ?? DEFAULT_CLI_SCOPE,
    sessionCount: activeSessions.length,
    configUpdatedAt: cfg?.updated_at ?? null,
    activation,
    contextTokens: stats?.contextTokens ?? null,
    contextWindow: cfg?.auto_compact_window ?? null,
    sessionOutputTokens: stats?.outputTokens ?? null,
    sessionTurns: stats?.turns ?? null,
    queueDepth,
    taskCount: safeTaskCount(agentGroupId),
  };
  return { ok: true, view };
}

/** Model picker data: current model plus catalog options with an active flag. */
export function getModelPicker(agentGroupId: string): CommandResult<ModelPickerView> {
  const ag = getAgentGroup(agentGroupId);
  if (!ag) return fail('unknown-agent');

  const cfg = getContainerConfig(agentGroupId);
  const currentId = cfg?.model ?? null;
  const options: ModelPickerOption[] = MODEL_CATALOG.map((m) => ({ ...m, active: m.id === currentId }));

  return {
    ok: true,
    view: { agentName: ag.name, agentGroupId, current: describeModel(currentId), options },
  };
}

/**
 * Root /config data: current scalars plus the option catalogs for menus. When
 * `chatCtx` is supplied, the view also carries the chat's activation wiring so
 * the root card and the Activation submenu render the current mode.
 */
export function getConfigView(agentGroupId: string, chatCtx?: StatusChatContext): CommandResult<ConfigView> {
  const ag = getAgentGroup(agentGroupId);
  if (!ag) return fail('unknown-agent');

  const cfg = getContainerConfig(agentGroupId);
  return {
    ok: true,
    view: {
      agentName: ag.name,
      agentGroupId,
      model: describeModel(cfg?.model ?? null),
      effort: cfg?.effort ?? null,
      autoCompactWindow: cfg?.auto_compact_window ?? null,
      maxMessagesPerPrompt: cfg?.max_messages_per_prompt ?? null,
      provider: cfg?.provider ?? null,
      cliScope: cfg?.cli_scope ?? DEFAULT_CLI_SCOPE,
      activation: chatCtx ? activationFor(chatCtx.messagingGroupId, agentGroupId) : null,
      modelOptions: MODEL_CATALOG,
      effortOptions: EFFORT_LEVELS,
      compactWindowPresets: COMPACT_WINDOW_PRESETS,
    },
  };
}

// --- Writes ---

/**
 * Switch the agent's model. Admin-only. Accepts a catalog alias or a raw
 * model id (format-validated). Instant-kill + lazy-respawn.
 */
export function setModel(
  agentGroupId: string,
  modelIdOrAlias: string,
  actorUserId: string,
): CommandResult<ModelChangeView> {
  const ag = getAgentGroup(agentGroupId);
  if (!ag) return fail('unknown-agent');
  if (!hasAdminPrivilege(actorUserId, agentGroupId)) return fail('unauthorized');

  const resolved = resolveModelInput(modelIdOrAlias);
  if (!resolved.ok) {
    return fail('invalid-value', {
      field: 'model',
      value: modelIdOrAlias,
      allowed: MODEL_CATALOG.map((m) => m.alias),
    });
  }

  const before = getContainerConfig(agentGroupId);
  const previous = describeModel(before?.model ?? null);

  ensureContainerConfig(agentGroupId);
  updateContainerConfigScalars(agentGroupId, { model: resolved.id });
  log.info('Model changed via chat command', {
    agentGroupId,
    actorUserId,
    from: previous.id,
    to: resolved.id,
  });

  const containersKilled = killAgentGroupContainersLazy(agentGroupId, 'model changed via chat command');

  return {
    ok: true,
    view: {
      agentName: ag.name,
      agentGroupId,
      previous,
      current: { id: resolved.id, label: resolved.label },
      containersKilled,
    },
  };
}

/**
 * Set one /config scalar field. Admin-only. Validation for each field is
 * cloned from `ncl groups config update` (src/cli/resources/groups.ts):
 *   - model: alias or raw-id (format-validated)
 *   - effort: one of low|medium|high|xhigh|max
 *   - auto-compact-window: positive integer (token count)
 *   - max-messages-per-prompt: positive integer
 * Instant-kill + lazy-respawn.
 */
export function setConfigValue(
  agentGroupId: string,
  field: ConfigField,
  value: string,
  actorUserId: string,
): CommandResult<ConfigChangeView> {
  const ag = getAgentGroup(agentGroupId);
  if (!ag) return fail('unknown-agent');
  if (!hasAdminPrivilege(actorUserId, agentGroupId)) return fail('unauthorized');

  const before = getContainerConfig(agentGroupId);

  const updates: Partial<
    Pick<ContainerConfigRow, 'model' | 'effort' | 'auto_compact_window' | 'max_messages_per_prompt'>
  > = {};
  let previous: string | number | null;
  let current: string | number;
  let previousLabel: string | null | undefined;
  let currentLabel: string | null | undefined;

  switch (field) {
    case 'model': {
      const resolved = resolveModelInput(value);
      if (!resolved.ok) {
        return fail('invalid-value', { field, value, allowed: MODEL_CATALOG.map((m) => m.alias) });
      }
      updates.model = resolved.id;
      previous = before?.model ?? null;
      current = resolved.id;
      previousLabel = before?.model ? modelLabelFor(before.model) : null;
      currentLabel = resolved.label;
      break;
    }
    case 'effort': {
      const level = value.trim().toLowerCase();
      if (!isEffortLevel(level)) {
        return fail('invalid-value', { field, value, allowed: EFFORT_LEVELS });
      }
      updates.effort = level;
      previous = before?.effort ?? null;
      current = level;
      break;
    }
    case 'auto-compact-window': {
      const parsed = parsePositiveInt(value);
      if (parsed === null) {
        return fail('invalid-value', { field, value, allowed: COMPACT_WINDOW_PRESETS });
      }
      updates.auto_compact_window = parsed;
      previous = before?.auto_compact_window ?? null;
      current = parsed;
      break;
    }
    case 'max-messages-per-prompt': {
      const parsed = parsePositiveInt(value);
      if (parsed === null) {
        return fail('invalid-value', { field, value });
      }
      updates.max_messages_per_prompt = parsed;
      previous = before?.max_messages_per_prompt ?? null;
      current = parsed;
      break;
    }
    default:
      return fail('unknown-field', { field: String(field) });
  }

  ensureContainerConfig(agentGroupId);
  updateContainerConfigScalars(agentGroupId, updates);
  log.info('Config changed via chat command', { agentGroupId, actorUserId, field, from: previous, to: current });

  const containersKilled = killAgentGroupContainersLazy(agentGroupId, `config ${field} changed via chat command`);

  return {
    ok: true,
    view: { agentName: ag.name, agentGroupId, field, previous, current, previousLabel, currentLabel, containersKilled },
  };
}

/**
 * Set a chat's activation (engage) config on the wiring row. Admin-only.
 *
 * Unlike /model and /config scalar writes, engage rules are evaluated HOST-side
 * on the next inbound message, so there is NO container kill: the change applies
 * immediately in this chat. For mode 'pattern' a non-empty, compilable regex is
 * required (validated with `new RegExp`); for 'mention'/'mention-sticky' the
 * pattern is nulled.
 */
export function setActivation(
  messagingGroupId: string,
  agentGroupId: string,
  mode: EngageMode,
  pattern: string | null,
  actorUserId: string,
): CommandResult<ActivationChangeView> {
  const ag = getAgentGroup(agentGroupId);
  if (!ag) return fail('unknown-agent');
  if (!hasAdminPrivilege(actorUserId, agentGroupId)) return fail('unauthorized');

  const wiring = getMessagingGroupAgentByPair(messagingGroupId, agentGroupId);
  if (!wiring) return fail('unknown-agent');

  let storedPattern: string | null = null;
  if (mode === 'pattern') {
    const src = (pattern ?? '').trim();
    if (src === '') {
      return fail('invalid-value', {
        field: 'pattern',
        value: pattern ?? '',
        message: 'A regex is required for pattern mode.',
      });
    }
    try {
      new RegExp(src);
    } catch (err) {
      return fail('invalid-value', {
        field: 'pattern',
        value: src,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    storedPattern = src;
  }

  updateMessagingGroupAgent(wiring.id, { engage_mode: mode, engage_pattern: storedPattern });
  log.info('Activation changed via chat command', {
    messagingGroupId,
    agentGroupId,
    actorUserId,
    mode,
    pattern: storedPattern,
  });

  return { ok: true, view: { agentName: ag.name, agentGroupId, mode, pattern: storedPattern } };
}

/**
 * Restart the agent container NOW. Admin-only. Immediate respawn with a wake
 * message, matching the self-mod restart pattern.
 */
export function restartAgent(agentGroupId: string, actorUserId: string): CommandResult<RestartView> {
  const ag = getAgentGroup(agentGroupId);
  if (!ag) return fail('unknown-agent');
  if (!hasAdminPrivilege(actorUserId, agentGroupId)) return fail('unauthorized');

  const restarted = restartAgentGroupContainers(
    agentGroupId,
    'restarted via chat command',
    'Container restarted by an admin. Continue where you left off and report readiness to the user.',
  );
  log.info('Agent restarted via chat command', { agentGroupId, actorUserId, restarted });

  return { ok: true, view: { agentName: ag.name, agentGroupId, restarted } };
}
