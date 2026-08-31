/**
 * Channel-agnostic text builders for the Hermes-style command cards and
 * confirmations. Both renderers consume these so the Telegram (markdown) and
 * fallback (plain) surfaces stay byte-for-byte identical in CONTENT, differing
 * only in emphasis markup.
 *
 * A `CardFmt` supplies the two emphasis primitives: `bold` and `code`. The
 * markdown formatter wraps with `**`/`` ` `` (which the island's renderFS turns
 * into Telegram entities); the plain formatter is identity. All other glyphs
 * (emoji, separators) are literal and shared.
 *
 * Typography rule for this module: ASCII only in strings and comments (no
 * em-dash, en-dash, smart quotes, unicode ellipsis, arrows, bullet chars,
 * middle dot, or non-breaking space). Separators are '|' and ','. Emoji are
 * allowed as UI glyphs.
 */
import { formatDateRel, formatTokens } from './format.js';
import type {
  ActivationChangeView,
  ActivationView,
  CommandFailure,
  CommandName,
  ConfigChangeView,
  ConfigView,
  ModelChangeView,
  ModelPickerView,
  ModelRef,
  RestartView,
  StatusView,
  TargetAgent,
} from './types.js';
import { MODEL_ALIASES } from './types.js';

/** Emphasis primitives a renderer supplies (markdown or plain identity). */
export interface CardFmt {
  bold(s: string): string;
  code(s: string): string;
}

/** Plain formatter (no markup) for channels without rich entities. */
export const PLAIN_FMT: CardFmt = {
  bold: (s) => s,
  code: (s) => s,
};

/** Markdown formatter: '**bold**' and '`code`' (renderFS -> Telegram entities). */
export const MD_FMT: CardFmt = {
  bold: (s) => `**${s}**`,
  code: (s) => `\`${s}\``,
};

/** The model text alone: 'Fable 5 (`claude-fable-5`)', bare id, or '(default)'. */
function modelText(id: string | null, label: string | null, fmt: CardFmt): string {
  if (!id) return '(default)';
  return label ? `${label} (${fmt.code(id)})` : fmt.code(id);
}

/** 'Fable 5 (`id`), high effort' - the effort segment only when set. */
function modelEffortLine(id: string | null, label: string | null, effort: string | null, fmt: CardFmt): string {
  const effortPart = effort ? `, ${effort} effort` : '';
  return `${fmt.bold('Model:')} ${modelText(id, label, fmt)}${effortPart}`;
}

/** The engage part of an activation summary ('mention', 'always on', 'pattern /x/'). */
function engageSummary(a: ActivationView): string {
  if (a.engageMode !== 'pattern') return a.engageMode;
  if (!a.engagePattern || a.engagePattern === '.') return 'always on';
  return `pattern /${a.engagePattern}/`;
}

/** Full activation summary, e.g. 'mention, known senders'. */
export function activationSummary(a: ActivationView): string {
  const scope = a.senderScope === 'known' ? 'known senders' : 'all senders';
  return `${engageSummary(a)}, ${scope}`;
}

/** The status card as an array of lines (join with '\n'). Omit-empty rendering. */
export function statusCardLines(v: StatusView, fmt: CardFmt): string[] {
  const lines: string[] = [`📊 ${fmt.bold(v.agentName)}`, ''];
  lines.push(modelEffortLine(v.model, v.modelLabel, v.effort, fmt));

  if (v.contextTokens != null) {
    if (v.contextWindow) {
      const pct = Math.round((v.contextTokens / v.contextWindow) * 100);
      lines.push(
        `${fmt.bold('Context:')} ${formatTokens(v.contextTokens)} / ${formatTokens(v.contextWindow)} (${pct}%)`,
      );
    } else {
      lines.push(`${fmt.bold('Context:')} ${formatTokens(v.contextTokens)}`);
    }
  }

  if (v.sessionTurns != null) {
    lines.push(`${fmt.bold('Session:')} ${formatTokens(v.sessionOutputTokens ?? 0)} out over ${v.sessionTurns} turns`);
  }

  if (v.activation) lines.push(`${fmt.bold('Activation:')} ${activationSummary(v.activation)}`);

  if (v.provider && v.provider !== 'claude') lines.push(`${fmt.bold('Provider:')} ${v.provider}`);
  if (v.cliScope && v.cliScope !== 'group') lines.push(`${fmt.bold('CLI scope:')} ${v.cliScope}`);
  if (v.maxMessagesPerPrompt != null) lines.push(`${fmt.bold('Max messages:')} ${v.maxMessagesPerPrompt}`);

  let counts = `${fmt.bold('Sessions:')} ${v.sessionCount}`;
  if (v.queueDepth && v.queueDepth > 0) counts += ` | ${fmt.bold('Queue:')} ${v.queueDepth}`;
  if (v.taskCount && v.taskCount > 0) counts += ` | ${fmt.bold('Tasks:')} ${v.taskCount}`;
  lines.push(counts);

  if (v.configUpdatedAt) lines.push(`${fmt.bold('Updated:')} ${formatDateRel(v.configUpdatedAt)}`);
  return lines;
}

/** The /config root card as lines. */
export function configRootLines(v: ConfigView, fmt: CardFmt): string[] {
  const window = v.autoCompactWindow != null ? formatTokens(v.autoCompactWindow) : '(default)';
  const lines: string[] = [
    `⚙️ ${fmt.bold(v.agentName)}`,
    '',
    modelEffortLine(v.model.id, v.model.label, v.effort, fmt),
    `${fmt.bold('Compact window:')} ${window}`,
  ];
  if (v.activation) lines.push(`${fmt.bold('Activation:')} ${activationSummary(v.activation)}`);
  lines.push('', 'Pick a setting to change.');
  return lines;
}

// --- Confirmations + prompts (shared strings) ---

/** The friendly model label when catalogued, else the raw id. */
function modelFriendly(ref: ModelRef): string {
  return ref.label ?? ref.id ?? '(default)';
}

/** Confirmation after a /model or /config model switch. */
export function modelChangeConfirmation(v: ModelChangeView, fmt: CardFmt): string {
  return `✅ ${fmt.bold(v.agentName)} now runs ${modelFriendly(v.current)}\nApplies from her next reply.`;
}

/** Confirmation after any /config scalar change (model/effort/window/max). */
export function configChangeConfirmation(v: ConfigChangeView, fmt: CardFmt): string {
  const name = fmt.bold(v.agentName);
  switch (v.field) {
    case 'model': {
      const shown = v.currentLabel ?? String(v.current);
      return `✅ ${name} now runs ${shown}\nApplies from her next reply.`;
    }
    case 'effort':
      return `✅ ${name} effort set to ${v.current}\nApplies from her next reply.`;
    case 'auto-compact-window':
      return `✅ ${name} compact window set to ${formatTokens(Number(v.current))}\nApplies from her next reply.`;
    case 'max-messages-per-prompt':
      return `✅ ${name} max messages set to ${v.current}\nApplies from her next reply.`;
    default:
      return `✅ ${name} updated\nApplies from her next reply.`;
  }
}

/** Confirmation after an activation change (applies immediately, no respawn). */
export function activationChangeConfirmation(v: ActivationChangeView, fmt: CardFmt): string {
  const how = v.mode === 'pattern' ? `pattern /${v.pattern ?? ''}/` : v.mode;
  return `✅ ${fmt.bold(v.agentName)} activates on ${how} now\nApplies immediately in this chat.`;
}

/** Prompt shown above the model picker keyboard. */
export function modelPickerPrompt(v: ModelPickerView, fmt: CardFmt): string {
  return `🧠 ${fmt.bold(v.agentName)}, pick a model\n${fmt.bold('Current:')} ${modelFriendly(v.current)}`;
}

const SUBMENU_PHRASE = {
  effort: 'an effort level',
  window: 'a compact window',
  activation: 'activation',
} as const;

/** Submenu prompt, e.g. '**Emma**, pick an effort level'. */
export function submenuPrompt(agentName: string, what: keyof typeof SUBMENU_PHRASE, fmt: CardFmt): string {
  return `${fmt.bold(agentName)}, pick ${SUBMENU_PHRASE[what]}`;
}

/** Prompt for the restart confirm submenu. */
export function restartPrompt(agentName: string, fmt: CardFmt): string {
  return `🔄 Restart ${fmt.bold(agentName)} now? Kills the running container and respawns it immediately.`;
}

/** Confirmation after a restart (idle vs restarted, singular vs plural). */
export function restartConfirmation(v: RestartView, fmt: CardFmt): string {
  const name = fmt.bold(v.agentName);
  if (v.restarted === 0) {
    return `💤 ${name} was already idle. She starts on the current config with the next message.`;
  }
  const noun = v.restarted === 1 ? 'container' : 'containers';
  return `🔄 ${name} is restarting (${v.restarted} ${noun}). She'll check in when back.`;
}

/** Prompt above the multi-agent picker. */
export function agentPickerPrompt(command: CommandName, agents: readonly TargetAgent[], fmt: CardFmt): string {
  return `${fmt.bold(`This chat has ${agents.length} agents.`)} Pick one for /${command}.`;
}

/** Human-readable message for a command failure (data -> prose). */
export function failureMessage(failure: CommandFailure): string {
  switch (failure.reason) {
    case 'unauthorized':
      return '🚫 Admins only.';
    case 'unknown-agent':
      return 'No agent is configured for this chat.';
    case 'unknown-field': {
      const field = failure.detail?.field ?? '';
      return `Unknown config field ${field}. Try: model, effort, auto-compact-window, max-messages-per-prompt, activation, pattern.`;
    }
    case 'invalid-value': {
      const field = failure.detail?.field ?? '';
      const value = failure.detail?.value ?? '';
      let hint: string;
      if (field === 'pattern') {
        hint = failure.detail?.message ? ` ${failure.detail.message}` : ' Provide a valid regular expression.';
      } else if (field === 'model') {
        hint = ` Try an alias (${MODEL_ALIASES}) or a raw model id.`;
      } else {
        const allowed = failure.detail?.allowed;
        hint = allowed && allowed.length > 0 ? ` Allowed: ${allowed.join(', ')}.` : '';
      }
      return `❌ Invalid ${field} value "${value}".${hint}`;
    }
    default:
      return 'That did not work.';
  }
}
