/**
 * Shared types for the host command service (`src/commands/`).
 *
 * This module owns ALL chat-command semantics: the command registry, model
 * catalog, validation rules, target resolution, and the view-model shapes the
 * service returns. It is channel-agnostic and returns DATA (view-models),
 * never formatted text. Channel adapters (telegram-grammy) and the router
 * fallback path consume these types and render them.
 *
 * Typography rule for this module: ASCII only in user-facing strings and
 * comments (no em-dash, en-dash, smart quotes, unicode ellipsis, arrows,
 * bullet chars, or non-breaking space). Emoji are allowed as UI glyphs.
 */
import type { EngageMode, SenderScope } from '../types.js';

// --- Commands ---

export type CommandName = 'model' | 'status' | 'config' | 'restart';

export interface CommandSpec {
  /** Short popup/help description. Safe for setMyCommands (<= 256 chars). */
  description: string;
  /**
   * True when an unprivileged group member may run the command. Only /status
   * is member-runnable; the rest require admin privilege over the target
   * agent group. Members never get a popup entry (see the telegram grants
   * module); this flag only governs whether a typed command is honored.
   */
  memberRunnable: boolean;
}

/**
 * The four chat commands. Order is the canonical popup order: read-only
 * /status first, then the mutating trio.
 */
export const COMMANDS: Record<CommandName, CommandSpec> = {
  status: {
    description: 'Show the agent config: model, effort, compact window, container state',
    memberRunnable: true,
  },
  model: {
    description: 'Switch the model (picker, or /model <alias-or-id>)',
    memberRunnable: false,
  },
  config: {
    description: 'Tune model, effort, and compact window',
    memberRunnable: false,
  },
  restart: {
    description: 'Restart the agent container now',
    memberRunnable: false,
  },
};

/** Canonical command order for popups and pickers (also the admin popup set). */
export const COMMAND_ORDER: readonly CommandName[] = ['status', 'model', 'config', 'restart'] as const;

// --- Model catalog ---

export interface ModelCatalogEntry {
  /** Short alias typed in chat, e.g. "opus". */
  alias: string;
  /** Friendly label shown in cards/menus, e.g. "Opus 4.8". */
  label: string;
  /** Raw model id persisted to container_configs.model. */
  id: string;
}

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  { alias: 'sonnet', label: 'Sonnet 5', id: 'claude-sonnet-5' },
  { alias: 'opus', label: 'Opus 4.8', id: 'claude-opus-4-8' },
  { alias: 'fable', label: 'Fable 5', id: 'claude-fable-5' },
] as const;

/** Comma-joined catalog aliases, e.g. "sonnet, opus, fable". For usage hints. */
export const MODEL_ALIASES = MODEL_CATALOG.map((m) => m.alias).join(', ');

/**
 * Raw-model-id escape hatch. Accepts anything that looks like a sane model id
 * so operators can pin an id not yet in the catalog, while rejecting obvious
 * garbage (spaces, uppercase, control chars, leading punctuation).
 */
export const RAW_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9.-]+$/;
export const RAW_MODEL_ID_MIN_LEN = 3;
export const RAW_MODEL_ID_MAX_LEN = 64;

/** A resolved model reference: the raw id plus a friendly label if catalogued. */
export interface ModelRef {
  id: string | null;
  /** Friendly label when `id` is in the catalog, else null. */
  label: string | null;
}

// --- Effort + compact window ---

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * Compact-window presets surfaced in the /config menu. Arbitrary positive
 * integers are also accepted (matching the ncl CLI, which only requires a
 * positive integer token count).
 */
export const COMPACT_WINDOW_PRESETS = [165000, 200000, 400000, 600000, 800000] as const;

// --- Activation (engage) config, written to the wiring row ---

/** The three engage modes settable from chat (subset == full EngageMode set). */
export const ACTIVATION_MODES = ['mention', 'mention-sticky', 'pattern'] as const;

/** True when `value` is a valid activation (engage) mode. */
export function isActivationMode(value: string): value is EngageMode {
  return (ACTIVATION_MODES as readonly string[]).includes(value);
}

// --- Config fields writable via chat ---

/**
 * The four scalar fields /config can write. Deliberately a subset of the full
 * container config: cli_scope, provider, image_tag, mounts, packages, and
 * mcp_servers are ncl-only (self-mod approval flow owns packages/mcp).
 */
export type ConfigField = 'model' | 'effort' | 'auto-compact-window' | 'max-messages-per-prompt';

export const CONFIG_FIELDS: readonly ConfigField[] = [
  'model',
  'effort',
  'auto-compact-window',
  'max-messages-per-prompt',
] as const;

// --- Command result union ---

export type CommandFailureReason = 'unauthorized' | 'unknown-agent' | 'invalid-value' | 'unknown-field';

/** Message-safe structured detail for a failed command (data, not prose). */
export interface CommandFailureDetail {
  field?: string;
  /** The rejected value, as typed. */
  value?: string;
  /** Accepted values or presets, when the failure is a bad enum/range. */
  allowed?: readonly (string | number)[];
  /** Free-form hint (e.g. a regex compile error for an invalid pattern). */
  message?: string;
}

export interface CommandFailure {
  ok: false;
  reason: CommandFailureReason;
  detail?: CommandFailureDetail;
}

export type CommandResult<V> = { ok: true; view: V } | CommandFailure;

// --- View models ---

/**
 * Per-chat activation (engage) config, read from the wiring row for one
 * (messaging group, agent group) pair. `engagePattern` is the regex source
 * when `engageMode==='pattern'` ('.' is the "match every message" sentinel;
 * see MessagingGroupAgent in src/types.ts); null otherwise.
 */
export interface ActivationView {
  engageMode: EngageMode;
  engagePattern: string | null;
  senderScope: SenderScope;
}

/**
 * Optional chat context for status/config reads: identifies which wiring row
 * (and which session) a card should reflect. Omitted for chat-less reads.
 */
export interface StatusChatContext {
  messagingGroupId: string;
  threadId: string | null;
}

export interface StatusView {
  agentName: string;
  agentGroupId: string;
  /** Raw model id as persisted, or null when unset (SDK default applies). */
  model: string | null;
  /** Friendly catalog label, or null when the id is not catalogued/unset. */
  modelLabel: string | null;
  effort: string | null;
  autoCompactWindow: number | null;
  maxMessagesPerPrompt: number | null;
  provider: string | null;
  cliScope: string;
  sessionCount: number;
  /** ISO timestamp of the last container-config write, or null. */
  configUpdatedAt: string | null;
  /** Per-chat engage config; null when no chat context or no wiring found. */
  activation?: ActivationView | null;
  /** Latest turn's context size (tokens), or null when no transcript. */
  contextTokens?: number | null;
  /** Context budget (== auto_compact_window), or null when unset. */
  contextWindow?: number | null;
  /** Cumulative output tokens over the session transcript, or null. */
  sessionOutputTokens?: number | null;
  /** Assistant turn count over the session transcript, or null. */
  sessionTurns?: number | null;
  /** Undelivered inbound (due) messages for the resolved session, or null. */
  queueDepth?: number | null;
  /** Active (non-cancelled) scheduled tasks for the agent group, or null. */
  taskCount?: number | null;
}

export interface ModelPickerOption extends ModelCatalogEntry {
  /** True when this catalog entry is the agent's current model. */
  active: boolean;
}

export interface ModelPickerView {
  agentName: string;
  agentGroupId: string;
  /** The agent's current model (may be a raw id outside the catalog). */
  current: ModelRef;
  options: readonly ModelPickerOption[];
}

export interface ConfigView {
  agentName: string;
  agentGroupId: string;
  model: ModelRef;
  effort: string | null;
  autoCompactWindow: number | null;
  maxMessagesPerPrompt: number | null;
  provider: string | null;
  cliScope: string;
  /** Per-chat engage config; null when no chat context or no wiring found. */
  activation?: ActivationView | null;
  /** Option catalogs for menu rendering. */
  modelOptions: readonly ModelCatalogEntry[];
  effortOptions: readonly EffortLevel[];
  compactWindowPresets: readonly number[];
}

export interface ModelChangeView {
  agentName: string;
  agentGroupId: string;
  previous: ModelRef;
  current: ModelRef;
  /** Running containers killed by the lazy-respawn apply. */
  containersKilled: number;
}

export interface ConfigChangeView {
  agentName: string;
  agentGroupId: string;
  field: ConfigField;
  /** Previous stored value (raw), or null when unset. */
  previous: string | number | null;
  /** New stored value (raw). */
  current: string | number;
  /** Set only for the `model` field: friendly labels for previous/current. */
  previousLabel?: string | null;
  currentLabel?: string | null;
  containersKilled: number;
}

export interface RestartView {
  agentName: string;
  agentGroupId: string;
  /** Number of running containers that were restarted. */
  restarted: number;
}

export interface ActivationChangeView {
  agentName: string;
  agentGroupId: string;
  mode: EngageMode;
  /** The regex source when mode==='pattern', else null. */
  pattern: string | null;
}

// --- Target resolution ---

export interface TargetAgent {
  agentGroupId: string;
  agentName: string;
}

/**
 * Outcome of resolving a chat context to wired agent group(s).
 *
 * - `single`: exactly one wired agent. Commands apply directly.
 * - `multiple`: more than one wired agent. Callers (Telegram picker, fallback
 *   reply) disambiguate. The `agents` list is DETERMINISTICALLY sorted (see
 *   resolveTargets); Telegram pickers index into this order.
 * - `none`: no wired agent for the chat.
 */
export type TargetResolution =
  | { kind: 'single'; agent: TargetAgent }
  | { kind: 'multiple'; agents: readonly TargetAgent[] }
  | { kind: 'none' };

// --- Model input resolution (pure) ---

export type ModelResolution = { ok: true; id: string; label: string | null } | { ok: false };

/** Friendly label for a raw model id, or null when not in the catalog. */
export function modelLabelFor(id: string): string | null {
  const entry = MODEL_CATALOG.find((m) => m.id === id);
  return entry ? entry.label : null;
}

/** A ModelRef ({ id, label }) for a stored model id (or null when unset). */
export function describeModel(id: string | null): ModelRef {
  if (!id) return { id: null, label: null };
  return { id, label: modelLabelFor(id) };
}

/**
 * Resolve a chat-typed model input (alias OR raw id) to a concrete model id.
 *
 * Aliases (case-insensitive) win first. Otherwise the input must match the
 * raw-model-id pattern within the length bounds. Whitespace is trimmed. The
 * returned label is the catalog label when the id is catalogued, else null.
 */
export function resolveModelInput(input: string): ModelResolution {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === '') return { ok: false };

  const byAlias = MODEL_CATALOG.find((m) => m.alias === trimmed);
  if (byAlias) return { ok: true, id: byAlias.id, label: byAlias.label };

  if (trimmed.length < RAW_MODEL_ID_MIN_LEN || trimmed.length > RAW_MODEL_ID_MAX_LEN) {
    return { ok: false };
  }
  if (!RAW_MODEL_ID_PATTERN.test(trimmed)) return { ok: false };

  return { ok: true, id: trimmed, label: modelLabelFor(trimmed) };
}

/** True when `value` is a recognized effort level. */
export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * Parse + validate a positive-integer config value. Shared by
 * auto-compact-window (token count) and max-messages-per-prompt, both of which
 * match the ncl CLI rule: a positive integer. For the compact window the
 * presets are just conveniences; any positive integer is accepted.
 */
export function parsePositiveInt(value: string | number): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}
