/**
 * Host-side command gate. Classifies inbound slash commands and gates
 * them before they reach the container.
 *
 * - Filtered commands: dropped silently (never reach the container)
 * - Admin commands: checked against user_roles; denied senders get a
 *   "Permission denied" response written directly to messages_out
 * - Host commands: admin-gated commands the HOST executes (config reads,
 *   model switching) — never written to the container's inbound DB
 * - Normal messages: pass through unchanged
 *
 * Bang prefix: on channels whose client intercepts '/' before it reaches
 * the bot (Slack shows "not a valid command" and never posts the message),
 * a known command may be typed as `!name`. The gate rewrites it to the
 * canonical `/name` BEFORE classification and before the row is stored, so
 * the container and the SDK only ever see canonical slash commands. An
 * unrecognized `!foo` is left untouched — '!' is common in prose, so only
 * exact known command names are claimed.
 */
import { hasAdminPrivilege } from './modules/permissions/db/user-roles.js';

export type GateResult =
  | { action: 'pass'; normalizedText?: string }
  | { action: 'filter' }
  | { action: 'deny'; command: string }
  | { action: 'host'; command: string; argText: string };

const FILTERED_COMMANDS = new Set(['/start', '/help', '/login', '/logout', '/doctor', '/remote-control']);
const ADMIN_COMMANDS = new Set(['/clear', '/compact', '/context', '/cost', '/files', '/upload-trace']);
/** Admin-gated commands executed by the host (src/host-commands.ts) — never stored inbound. */
const HOST_COMMANDS = new Set(['/config', '/model']);
/**
 * Known Claude Code commands passed raw to the SDK for ANY sender — the
 * pre-existing unknown-command behavior, listed here only so the bang
 * prefix can map them (`!status` on Slack). /status is the Claude CLI's
 * own status output (model, account, context/token usage) — the host has
 * none of that data, so it must not intercept.
 */
const SDK_PASSTHROUGH_COMMANDS = new Set(['/status']);
/** Typed name → canonical command. Applied on both prefixes, all channels. */
const COMMAND_ALIASES: Record<string, string> = { '/new': '/clear' };
/** Channels whose client eats '/' — '!' is accepted as a command prefix there. */
const BANG_PREFIX_CHANNELS = new Set(['slack']);

const KNOWN_COMMANDS = new Set([
  ...FILTERED_COMMANDS,
  ...ADMIN_COMMANDS,
  ...HOST_COMMANDS,
  ...SDK_PASSTHROUGH_COMMANDS,
]);

/**
 * Rewrite `!name` (bang channels) and aliased names to the canonical
 * `/name`, preserving everything after the first token. Returns null when
 * no rewrite applies — unknown `!foo` stays untouched by design.
 */
function normalizeCommandText(text: string, channelType: string | null): string | null {
  const match = text.match(/^\S+/);
  if (!match) return null;
  const token = match[0];

  let canonical: string | null = null;
  if (token.startsWith('!')) {
    if (!channelType || !BANG_PREFIX_CHANNELS.has(channelType)) return null;
    const slashed = `/${token.slice(1).toLowerCase()}`;
    const resolved = COMMAND_ALIASES[slashed] ?? slashed;
    if (KNOWN_COMMANDS.has(resolved)) canonical = resolved;
  } else if (token.startsWith('/')) {
    canonical = COMMAND_ALIASES[token.toLowerCase()] ?? null;
  }

  if (!canonical || canonical === token) return null;
  return canonical + text.slice(token.length);
}

/**
 * Classify a message and decide whether it should reach the container.
 * Returns 'pass' for normal messages and authorized admin commands
 * (with `normalizedText` set when a bang/alias rewrite applied — the
 * caller applies it via applyNormalizedText AFTER materialization, which
 * owns and may replace the content string), 'filter' for silently-dropped
 * commands, 'deny' for unauthorized admin/host commands, and 'host' for
 * authorized host-executed commands.
 */
export async function gateCommand(
  content: string,
  userId: string | null,
  agentGroupId: string,
  channelType: string | null = null,
): Promise<GateResult> {
  let text: string;
  try {
    const value = JSON.parse(content) as { text?: unknown } | null;
    text = String(value && typeof value === 'object' && !Array.isArray(value) ? (value.text ?? '') : '').trim();
  } catch {
    text = content.trim();
  }

  const normalizedText = normalizeCommandText(text, channelType);
  if (normalizedText !== null) text = normalizedText;

  if (!text.startsWith('/')) return { action: 'pass' };

  const command = text.split(/\s/)[0].toLowerCase();

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  if (SDK_PASSTHROUGH_COMMANDS.has(command)) {
    return normalizedText !== null ? { action: 'pass', normalizedText } : { action: 'pass' };
  }

  if (ADMIN_COMMANDS.has(command)) {
    if (await isAdmin(userId, agentGroupId)) {
      return normalizedText !== null ? { action: 'pass', normalizedText } : { action: 'pass' };
    }
    return { action: 'deny', command };
  }

  if (HOST_COMMANDS.has(command)) {
    if (await isAdmin(userId, agentGroupId)) {
      return { action: 'host', command, argText: text.slice(command.length).trim() };
    }
    return { action: 'deny', command };
  }

  // Unknown slash commands pass through (the agent/SDK handles them)
  return { action: 'pass' };
}

/**
 * Apply a gate-produced normalized text to a content string, preserving
 * chat-sdk JSON structure. Called by the router AFTER materialization —
 * materialize replaces `event.message.content` from its own copy of the
 * payload, so a whole-content rewrite at gate time would be clobbered.
 */
export function applyNormalizedText(content: string, normalizedText: string): string {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.text === 'string') {
      return JSON.stringify({ ...parsed, text: normalizedText });
    }
    return content; // JSON without a text field — nothing to rewrite
  } catch {
    return normalizedText;
  }
}

async function isAdmin(userId: string | null, agentGroupId: string): Promise<boolean> {
  if (!userId) return false;
  return hasAdminPrivilege(userId, agentGroupId);
}
