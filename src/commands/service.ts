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
 * The host reads auto_compact_window from container_configs at spawn and sets
 * CLAUDE_CODE_AUTO_COMPACT_WINDOW in the container env. NULL means the runner's
 * 165k default (DEFAULT_AUTO_COMPACT_WINDOW mirrors it for display).
 *
 * Typography rule for this module: ASCII only in user-facing strings and
 * comments. Emoji are allowed as UI glyphs (none used here).
 */

import fs from 'fs';

import { getRegisteredChannelNames } from '../channels/channel-registry.js';
import { restartAgentGroupContainers } from '../container-restart.js';
import { isContainerRunning, killContainer } from '../container-runner.js';
import { getDb } from '../db/connection.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from '../db/container-configs.js';
import {
  getMessagingGroupAgentByPair,
  getMessagingGroupAgents,
  updateMessagingGroupAgent,
} from '../db/messaging-groups.js';
import {
  findSessionByAgentGroup,
  findSessionForAgent,
  findTaskSessions,
  getSessionsByAgentGroup,
} from '../db/sessions.js';
import { log } from '../log.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import type { ContainerConfigRow, EngageMode, Session } from '../types.js';
import { inboundDbPath } from '../mailbox/sqlite/paths.js';
import { openInboundDb } from '../mailbox/sqlite/session-db.js';
import { readSessionStatus } from './transcript.js';
import {
  describeModel,
  isEffortLevel,
  modelLabelFor,
  parsePositiveInt,
  resolveModelInput,
  MODEL_CATALOG,
  EFFORT_LEVELS,
  COMPACT_WINDOW_PRESETS,
  DEFAULT_AUTO_COMPACT_WINDOW,
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
async function killAgentGroupContainersLazy(agentGroupId: string, reason: string): Promise<number> {
  const sessions = (await getSessionsByAgentGroup(agentGroupId)).filter(
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
export async function resolveTargets(messagingGroupId: string): Promise<TargetResolution> {
  const wirings = await getMessagingGroupAgents(messagingGroupId);
  const agents: TargetAgent[] = [];
  const seen = new Set<string>();
  for (const w of wirings) {
    if (seen.has(w.agent_group_id)) continue;
    seen.add(w.agent_group_id);
    const ag = await getAgentGroup(w.agent_group_id);
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
async function activationFor(messagingGroupId: string, agentGroupId: string): Promise<ActivationView | null> {
  const wiring = await getMessagingGroupAgentByPair(messagingGroupId, agentGroupId);
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
async function findChatSession(agentGroupId: string, chatCtx: StatusChatContext): Promise<Session | null> {
  const wiring = await getMessagingGroupAgentByPair(chatCtx.messagingGroupId, agentGroupId);
  if (wiring?.session_mode === 'agent-shared') {
    return (await findSessionByAgentGroup(agentGroupId)) ?? null;
  }
  if (chatCtx.threadId) {
    const perThread = await findSessionForAgent(agentGroupId, chatCtx.messagingGroupId, chatCtx.threadId);
    if (perThread) return perThread;
  }
  return (await findSessionForAgent(agentGroupId, chatCtx.messagingGroupId, null)) ?? null;
}

/** Active (pending/paused) scheduled task series for an agent group, or null. */
async function safeTaskCount(agentGroupId: string): Promise<number | null> {
  try {
    let total = 0;
    for (const s of await findTaskSessions(agentGroupId)) {
      const dbPath = inboundDbPath(agentGroupId, s.id);
      if (!fs.existsSync(dbPath)) continue;
      const db = openInboundDb(dbPath);
      try {
        const row = db
          .prepare(
            `SELECT COUNT(*) AS c FROM (
               SELECT 1 FROM messages_in
                WHERE kind = 'task' AND status IN ('pending', 'paused')
                GROUP BY series_id
             )`,
          )
          .get() as { c: number };
        total += row.c;
      } finally {
        db.close();
      }
    }
    return total;
  } catch (err) {
    log.debug('Task count read failed', { agentGroupId, err: String(err) });
    return null;
  }
}

// --- Reads ---

export async function getAgentConfigStatus(agentGroupId: string) {
  const ag = await getAgentGroup(agentGroupId);
  if (!ag) return fail('unknown-agent');
  const cfg = await getContainerConfig(agentGroupId);
  return {
    ok: true as const,
    view: {
      agentName: ag.name,
      agentGroupId,
      model: cfg?.model ?? null,
      modelLabel: cfg?.model ? modelLabelFor(cfg.model) : null,
      effort: cfg?.effort ?? null,
      autoCompactWindow: cfg?.auto_compact_window ?? null,
      maxMessagesPerPrompt: cfg?.max_messages_per_prompt ?? null,
      provider: cfg?.provider ?? null,
      cliScope: cfg?.cli_scope ?? DEFAULT_CLI_SCOPE,
      configUpdatedAt: cfg?.updated_at ?? null,
    },
  };
}

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
export async function getStatus(agentGroupId: string, chatCtx?: StatusChatContext) {
  const config = await getAgentConfigStatus(agentGroupId);
  if (!config.ok) return config;
  const activeSessions = (await getSessionsByAgentGroup(agentGroupId)).filter((s) => s.status === 'active');

  let activation: ActivationView | null = null;

  let session: Session | null = null;
  if (chatCtx) {
    if (chatCtx.transcriptScope === 'session') {
      session = (await findSessionForAgent(agentGroupId, chatCtx.messagingGroupId, chatCtx.threadId)) ?? null;
    } else {
      activation = await activationFor(chatCtx.messagingGroupId, agentGroupId);
      session = await findChatSession(agentGroupId, chatCtx);
    }
  }

  const claude = config.view.provider === null || config.view.provider === 'claude';
  const { stats, queueDepth } = await readSessionStatus(
    agentGroupId,
    session?.id ?? null,
    chatCtx?.transcriptScope,
    claude,
  );

  const view = {
    ...config.view,
    sessionCount: activeSessions.length,
    activation,
    contextTokens: stats?.contextTokens ?? null,
    contextWindow: config.view.autoCompactWindow ?? DEFAULT_AUTO_COMPACT_WINDOW,
    sessionOutputTokens: stats?.outputTokens ?? null,
    sessionTurns: stats?.turns ?? null,
    queueDepth,
    taskCount: chatCtx?.transcriptScope === 'session' ? null : await safeTaskCount(agentGroupId),
  };
  return { ok: true as const, view };
}

/** Model picker data: current model plus catalog options with an active flag. */
export async function getModelPicker(agentGroupId: string): Promise<CommandResult<ModelPickerView>> {
  const ag = await getAgentGroup(agentGroupId);
  if (!ag) return fail('unknown-agent');

  const cfg = await getContainerConfig(agentGroupId);
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
export async function getConfigView(
  agentGroupId: string,
  chatCtx?: StatusChatContext,
): Promise<CommandResult<ConfigView>> {
  const ag = await getAgentGroup(agentGroupId);
  if (!ag) return fail('unknown-agent');

  const cfg = await getContainerConfig(agentGroupId);
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
      activation: chatCtx ? await activationFor(chatCtx.messagingGroupId, agentGroupId) : null,
      modelOptions: MODEL_CATALOG,
      effortOptions: EFFORT_LEVELS,
      compactWindowPresets: COMPACT_WINDOW_PRESETS,
    },
  };
}

// --- Writes ---

/**
 * Switch the agent's model. Admin-only. Accepts a catalog alias or a raw
 * model id (format-validated). An accompanying effort change applies in the same write.
 */
export async function setModel(
  agentGroupId: string,
  modelIdOrAlias: string | null,
  actorUserId: string,
  effort?: string | null,
): Promise<CommandResult<ModelChangeView>> {
  const result = await writeConfigValue(agentGroupId, 'model', modelIdOrAlias, actorUserId, effort);
  if (!result.ok) return result;
  const { agentName, previous, current, containersKilled } = result.view;
  return {
    ok: true,
    view: {
      agentName,
      agentGroupId,
      previous: describeModel(previous === null ? null : String(previous)),
      current: describeModel(current === null ? null : String(current)),
      containersKilled,
    },
  };
}

/**
 * Set one /config scalar field. Admin-only. Validation for each field is
 * cloned from `ncl groups config update` (src/cli/resources/groups.ts):
 *   - model: alias or raw-id (format-validated)
 *   - effort: one of low|medium|high|xhigh|max
 *   - auto-compact-window: positive integer (token count) -> settings.json
 *   - max-messages-per-prompt: positive integer
 * Instant-kill + lazy-respawn.
 */
export async function setConfigValue(
  agentGroupId: string,
  field: ConfigField,
  value: string | null,
  actorUserId: string,
): Promise<CommandResult<ConfigChangeView>> {
  return writeConfigValue(agentGroupId, field, value, actorUserId);
}

type ConfigColumn = 'model' | 'effort' | 'auto_compact_window' | 'max_messages_per_prompt';

function validateConfigChange(field: ConfigField, value: string | null, effort?: string | null) {
  const updates: Partial<Pick<ContainerConfigRow, ConfigColumn>> = {};
  const effortInput = field === 'effort' ? value : effort;
  if (effortInput !== undefined) {
    const level = effortInput?.trim().toLowerCase() ?? null;
    if (level !== null && !isEffortLevel(level))
      return fail('invalid-value', { field: 'effort', value: effortInput ?? undefined, allowed: EFFORT_LEVELS });
    updates.effort = level;
  }
  let column: ConfigColumn;
  switch (field) {
    case 'model': {
      column = 'model';
      const resolved = value === null ? { ok: true as const, id: null } : resolveModelInput(value);
      if (!resolved.ok)
        return fail('invalid-value', { field, value: value ?? undefined, allowed: MODEL_CATALOG.map((m) => m.alias) });
      updates.model = resolved.id;
      break;
    }
    case 'effort':
      column = 'effort';
      break;
    case 'auto-compact-window':
    case 'max-messages-per-prompt': {
      const parsed = value === null ? null : parsePositiveInt(value);
      if (parsed === null)
        return fail('invalid-value', {
          field,
          value: value ?? undefined,
          allowed: field === 'auto-compact-window' ? COMPACT_WINDOW_PRESETS : undefined,
        });
      column = field === 'auto-compact-window' ? 'auto_compact_window' : 'max_messages_per_prompt';
      updates[column] = parsed;
      break;
    }
    default:
      return fail('unknown-field', { field: String(field) });
  }
  return { ok: true as const, updates, column };
}

async function writeConfigValue(
  agentGroupId: string,
  field: ConfigField,
  value: string | null,
  actorUserId: string,
  effort?: string | null,
): Promise<CommandResult<ConfigChangeView>> {
  const change = validateConfigChange(field, value, effort);
  if (!change.ok) {
    if (!(await getAgentGroup(agentGroupId))) return fail('unknown-agent');
    if (!(await hasAdminPrivilege(actorUserId, agentGroupId))) return fail('unauthorized');
    return change;
  }
  const { column, updates } = change;
  const result = await getDb().transaction(async () => {
    const ag = await getAgentGroup(agentGroupId);
    if (!ag) return fail('unknown-agent');
    if (!(await hasAdminPrivilege(actorUserId, agentGroupId))) return fail('unauthorized');

    const before = await getContainerConfig(agentGroupId);
    const previous = before?.[column] ?? null;
    const current = updates[column] ?? null;
    const changes = Object.entries(updates).flatMap(([key, to]) => {
      const from = before?.[key as ConfigColumn] ?? null;
      return from === to ? [] : [{ field: key === 'effort' ? 'effort' : field, from, to }];
    });
    if (changes.length) {
      await ensureContainerConfig(agentGroupId);
      await updateContainerConfigScalars(agentGroupId, updates);
    }
    return {
      ok: true as const,
      changes,
      view: {
        agentName: ag.name,
        agentGroupId,
        field,
        previous,
        current,
        ...(field === 'model' && {
          previousLabel: describeModel(before?.model ?? null).label,
          currentLabel: describeModel(updates.model ?? null).label,
        }),
      },
    };
  });
  if (!result.ok) return result;
  for (const change of result.changes)
    log.info('Config changed via chat command', { agentGroupId, actorUserId, ...change });
  const containersKilled = result.changes.length
    ? await killAgentGroupContainersLazy(agentGroupId, `config ${field} changed via chat command`)
    : 0;
  return { ok: true, view: { ...result.view, containersKilled } };
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
export async function setActivation(
  messagingGroupId: string,
  agentGroupId: string,
  mode: EngageMode,
  pattern: string | null,
  actorUserId: string,
): Promise<CommandResult<ActivationChangeView>> {
  const ag = await getAgentGroup(agentGroupId);
  if (!ag) return fail('unknown-agent');
  if (!(await hasAdminPrivilege(actorUserId, agentGroupId))) return fail('unauthorized');

  const wiring = await getMessagingGroupAgentByPair(messagingGroupId, agentGroupId);
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

  await updateMessagingGroupAgent(wiring.id, { engage_mode: mode, engage_pattern: storedPattern });
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
export async function restartAgent(agentGroupId: string, actorUserId: string): Promise<CommandResult<RestartView>> {
  const ag = await getAgentGroup(agentGroupId);
  if (!ag) return fail('unknown-agent');
  if (!(await hasAdminPrivilege(actorUserId, agentGroupId))) return fail('unauthorized');

  const restarted = await restartAgentGroupContainers(
    agentGroupId,
    'restarted via chat command',
    'Container restarted by an admin. Continue where you left off and report readiness to the user.',
  );
  log.info('Agent restarted via chat command', { agentGroupId, actorUserId, restarted });

  return { ok: true, view: { agentName: ag.name, agentGroupId, restarted } };
}

// --- /voice ---

/**
 * Whether a chat offers /voice: wherever the voice-mode channel is installed (an admin's first /voice
 * creates a line). Installed, not running: Telegram syncs its command menus before voice-mode starts.
 */
export async function offersVoiceCommand(_agentGroupIds: Iterable<string>): Promise<boolean> {
  return getRegisteredChannelNames().includes('voice-mode');
}
