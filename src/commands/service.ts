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
 * The compact window is NOT a container_configs column on this tree: upstream
 * moved it to the group's Claude settings file
 * (data/v2-sessions/<agent_group_id>/.claude-shared/settings.json,
 * `autoCompactWindow` - see "Per-agent Claude config" in CLAUDE.md). Reads and
 * writes for the 'auto-compact-window' field go there; the lazy-respawn apply
 * still holds because the SDK loads settings at session start.
 *
 * Typography rule for this module: ASCII only in user-facing strings and
 * comments. Emoji are allowed as UI glyphs (none used here).
 */
import fs from 'fs';
import path from 'path';

import { restartAgentGroupContainers } from '../container-restart.js';
import { isContainerRunning, killContainer } from '../container-runner.js';
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
import { inboundDbPath } from '../mailbox/sqlite/paths.js';
import { countDueMessages, openInboundDb } from '../mailbox/sqlite/session-db.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import { sessionsBaseDir } from '../session-manager.js';
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

// --- Compact window (per-agent settings.json) ---

function settingsJsonPath(agentGroupId: string): string {
  return path.join(sessionsBaseDir(), agentGroupId, '.claude-shared', 'settings.json');
}

/** The group's autoCompactWindow from settings.json, or null when unset/unreadable. */
function readAutoCompactWindow(agentGroupId: string): number | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsJsonPath(agentGroupId), 'utf8')) as {
      autoCompactWindow?: unknown;
    };
    const n = parsed.autoCompactWindow;
    return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Write autoCompactWindow into the group's settings.json, preserving every
 * other key. Throws when an EXISTING file cannot be parsed: clobbering a
 * malformed-but-present settings file would destroy hooks/env config the
 * install depends on, so that case must surface as a command failure.
 */
function writeAutoCompactWindow(agentGroupId: string, tokens: number): void {
  const p = settingsJsonPath(agentGroupId);
  let parsed: Record<string, unknown> = {};
  if (fs.existsSync(p)) {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  }
  parsed.autoCompactWindow = tokens;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(parsed, null, 2)}\n`);
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

/** Undelivered (due) inbound messages for a session, or null on any error. */
function safeQueueDepth(agentGroupId: string, sessionId: string): number | null {
  try {
    const dbPath = inboundDbPath(agentGroupId, sessionId);
    if (!fs.existsSync(dbPath)) return null;
    const db = openInboundDb(dbPath);
    try {
      return countDueMessages(db);
    } finally {
      db.close();
    }
  } catch (err) {
    log.debug('Queue depth read failed', { agentGroupId, sessionId, err: String(err) });
    return null;
  }
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
export async function getStatus(agentGroupId: string, chatCtx?: StatusChatContext): Promise<CommandResult<StatusView>> {
  const ag = await getAgentGroup(agentGroupId);
  if (!ag) return fail('unknown-agent');

  const cfg = await getContainerConfig(agentGroupId);
  const activeSessions = (await getSessionsByAgentGroup(agentGroupId)).filter((s) => s.status === 'active');
  const autoCompactWindow = readAutoCompactWindow(agentGroupId);

  let activation: ActivationView | null = null;
  let queueDepth: number | null = null;
  let session: Session | null = null;
  if (chatCtx) {
    activation = await activationFor(chatCtx.messagingGroupId, agentGroupId);
    session = await findChatSession(agentGroupId, chatCtx);
    if (session) queueDepth = safeQueueDepth(agentGroupId, session.id);
  }

  const stats = readTranscriptStats(agentGroupId, session?.id ?? null);

  const view: StatusView = {
    agentName: ag.name,
    agentGroupId,
    model: cfg?.model ?? null,
    modelLabel: cfg?.model ? modelLabelFor(cfg.model) : null,
    effort: cfg?.effort ?? null,
    autoCompactWindow,
    maxMessagesPerPrompt: cfg?.max_messages_per_prompt ?? null,
    provider: cfg?.provider ?? null,
    cliScope: cfg?.cli_scope ?? DEFAULT_CLI_SCOPE,
    sessionCount: activeSessions.length,
    configUpdatedAt: cfg?.updated_at ?? null,
    activation,
    contextTokens: stats?.contextTokens ?? null,
    contextWindow: autoCompactWindow,
    sessionOutputTokens: stats?.outputTokens ?? null,
    sessionTurns: stats?.turns ?? null,
    queueDepth,
    taskCount: await safeTaskCount(agentGroupId),
  };
  return { ok: true, view };
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
      autoCompactWindow: readAutoCompactWindow(agentGroupId),
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
 * model id (format-validated). Instant-kill + lazy-respawn.
 */
export async function setModel(
  agentGroupId: string,
  modelIdOrAlias: string,
  actorUserId: string,
): Promise<CommandResult<ModelChangeView>> {
  const ag = await getAgentGroup(agentGroupId);
  if (!ag) return fail('unknown-agent');
  if (!(await hasAdminPrivilege(actorUserId, agentGroupId))) return fail('unauthorized');

  const resolved = resolveModelInput(modelIdOrAlias);
  if (!resolved.ok) {
    return fail('invalid-value', {
      field: 'model',
      value: modelIdOrAlias,
      allowed: MODEL_CATALOG.map((m) => m.alias),
    });
  }

  const before = await getContainerConfig(agentGroupId);
  const previous = describeModel(before?.model ?? null);

  await ensureContainerConfig(agentGroupId);
  await updateContainerConfigScalars(agentGroupId, { model: resolved.id });
  log.info('Model changed via chat command', {
    agentGroupId,
    actorUserId,
    from: previous.id,
    to: resolved.id,
  });

  // Only kill when the stored value actually moved. Re-selecting the model a
  // group is already on (easy to do from the /model menu, which shows the
  // current model as a tappable row) used to kill the container anyway,
  // destroying an in-flight turn for no config change at all. Note this
  // compares the STORED value: null (inherit the default) to an explicit id is
  // a real change even when the effective model is identical, because the
  // container reads the stored value.
  const changed = (before?.model ?? null) !== resolved.id;
  const containersKilled = changed
    ? await killAgentGroupContainersLazy(agentGroupId, 'model changed via chat command')
    : 0;
  if (!changed) {
    log.debug('Model unchanged, skipping container kill', { agentGroupId, model: resolved.id });
  }

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
 *   - auto-compact-window: positive integer (token count) -> settings.json
 *   - max-messages-per-prompt: positive integer
 * Instant-kill + lazy-respawn.
 */
export async function setConfigValue(
  agentGroupId: string,
  field: ConfigField,
  value: string,
  actorUserId: string,
): Promise<CommandResult<ConfigChangeView>> {
  const ag = await getAgentGroup(agentGroupId);
  if (!ag) return fail('unknown-agent');
  if (!(await hasAdminPrivilege(actorUserId, agentGroupId))) return fail('unauthorized');

  const before = await getContainerConfig(agentGroupId);

  const updates: Partial<Pick<ContainerConfigRow, 'model' | 'effort' | 'max_messages_per_prompt'>> = {};
  let previous: string | number | null;
  let current: string | number;
  let previousLabel: string | null | undefined;
  let currentLabel: string | null | undefined;
  let settingsWrite: number | null = null;

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
      previous = readAutoCompactWindow(agentGroupId);
      current = parsed;
      settingsWrite = parsed;
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

  if (settingsWrite !== null) {
    try {
      writeAutoCompactWindow(agentGroupId, settingsWrite);
    } catch (err) {
      // An existing-but-unparseable settings.json must never be clobbered.
      return fail('invalid-value', {
        field,
        value,
        message: `settings.json unreadable, fix it by hand first (${String(err)})`,
      });
    }
  } else {
    await ensureContainerConfig(agentGroupId);
    await updateContainerConfigScalars(agentGroupId, updates);
  }
  log.info('Config changed via chat command', { agentGroupId, actorUserId, field, from: previous, to: current });

  // Same no-op guard as setModel: re-picking the value already stored must not
  // kill a running container and lose its turn.
  const changed = previous !== current;
  const containersKilled = changed
    ? await killAgentGroupContainersLazy(agentGroupId, `config ${field} changed via chat command`)
    : 0;
  if (!changed) {
    log.debug('Config unchanged, skipping container kill', { agentGroupId, field, value: current });
  }

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
