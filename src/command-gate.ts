/**
 * Host-side command gate. Classifies inbound slash commands and gates
 * them before they reach the container.
 *
 * - Host commands (/model, /status, /config, /restart, /voice): claimed by the host.
 *   The router answers these via the fallback renderer (or, on channels with a
 *   native binding, the adapter). They must NOT leak to the container: the
 *   Claude SDK ships native /model + /status handlers that would shadow ours
 *   (and whose effects are not persisted, so they vanish on the next respawn).
 * - Filtered commands: dropped silently (never reach the container)
 * - Admin commands: checked against user_roles; denied senders get a
 *   "Permission denied" reply delivered straight to the chat by the router
 * - Normal messages: pass through unchanged
 *
 * Bang prefix: on channels whose client intercepts '/' before it reaches the
 * bot (Slack shows "not a valid command" and never posts the message), a KNOWN
 * command may be typed as `!name`. It normalizes to the canonical `/name`
 * before classification; for pass-through admin commands the router stores the
 * rewritten text so the container and SDK only ever see canonical slash
 * commands. An unrecognized `!foo` stays untouched - '!' is common in prose.
 *
 * Typography rule for this module: ASCII only in user-facing strings and
 * comments (no em-dash, en-dash, smart quotes, unicode ellipsis, arrows,
 * bullet chars, or non-breaking space). Emoji are allowed as UI glyphs.
 */
import { COMMANDS, type CommandName } from './commands/types.js';
import { hasAdminPrivilege } from './modules/permissions/db/user-roles.js';
import './provider-contracts/index.js';
import { listProviderHostContracts } from './provider-contracts/registry.js';
import { commandText, slashCommandName } from './slash-command.js';

export type GateResult =
  | { action: 'pass'; normalizedText?: string }
  | { action: 'filter' }
  | { action: 'deny'; command: string }
  | { action: 'host'; command: CommandName; args: string };

const FILTERED_COMMANDS = new Set(
  listProviderHostContracts().flatMap((contract) => contract.commands?.nativeFiltered ?? []),
);
const ADMIN_COMMANDS = new Set([
  '/clear',
  '/upload-trace',
  ...listProviderHostContracts().flatMap((contract) => contract.commands?.nativeAdmin ?? []),
]);

/** Bare command names the host claims (/model, /status, /config, /restart, /voice). */
const HOST_COMMANDS = new Set<string>(Object.keys(COMMANDS));

/** Typed name -> canonical command. Applied on both prefixes, all channels. */
const COMMAND_ALIASES: Record<string, string> = { '/new': '/clear' };

/** Channels whose client eats '/' - '!' is accepted as a command prefix there. */
const BANG_PREFIX_CHANNELS = new Set(['slack']);

const KNOWN_COMMANDS = new Set([
  ...FILTERED_COMMANDS,
  ...ADMIN_COMMANDS,
  ...[...HOST_COMMANDS].map((name) => `/${name}`),
]);

/** Everything after the first whitespace run, trimmed. '' when there is none. */
function commandArgs(text: string): string {
  const m = text.match(/^\S+\s+([\s\S]*)$/);
  return m ? m[1].trim() : '';
}

/**
 * Rewrite `!name` (bang channels) and aliased names to the canonical `/name`,
 * preserving everything after the first token. Returns null when no rewrite
 * applies - unknown `!foo` stays untouched by design.
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
    canonical = COMMAND_ALIASES[slashCommandName(text) ?? ''] ?? null;
  }

  if (!canonical || canonical === token) return null;
  return canonical + text.slice(token.length);
}

/** Host-command classification from bare text, split out so the router can claim it before the fan-out. */
export function classifyHostCommandFromText(
  text: string,
  channelType: string | null = null,
): { command: CommandName; args: string } | null {
  const normalized = normalizeCommandText(text, channelType) ?? text;
  const name = slashCommandName(normalized)?.slice(1);
  if (!name || !HOST_COMMANDS.has(name)) return null;
  return { command: name as CommandName, args: commandArgs(normalized) };
}

/** Router-facing wrapper: classify from a raw content envelope (JSON or plain). */
export function classifyHostCommand(
  content: string,
  channelType: string | null = null,
): { command: CommandName; args: string } | null {
  return classifyHostCommandFromText(commandText(content), channelType);
}

export async function gateCommand(
  content: string,
  userId: string | null,
  agentGroupId: string,
  channelType: string | null = null,
): Promise<GateResult> {
  let text = commandText(content);
  const normalizedText = normalizeCommandText(text, channelType);
  if (normalizedText !== null) text = normalizedText;

  // The runner names commands with the same parse, so what is gated here is
  // exactly what it executes.
  const command = slashCommandName(text);
  if (command === null) return { action: 'pass' };

  const host = classifyHostCommandFromText(text);
  if (host) return { action: 'host', command: host.command, args: host.args };

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  if (ADMIN_COMMANDS.has(command)) {
    if (await isAdmin(userId, agentGroupId)) {
      return normalizedText !== null ? { action: 'pass', normalizedText } : { action: 'pass' };
    }
    return { action: 'deny', command };
  }

  return { action: 'pass' };
}

/**
 * Apply a gate-produced normalized text to a content string, preserving
 * chat-sdk JSON structure. Called by the router AFTER materialization -
 * materialize replaces `event.message.content` from its own copy of the
 * payload, so a whole-content rewrite at gate time would be clobbered.
 */
export function applyNormalizedText(content: string, normalizedText: string): string {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.text === 'string') {
      return JSON.stringify({ ...parsed, text: normalizedText });
    }
    return content; // JSON without a text field - nothing to rewrite
  } catch {
    return normalizedText;
  }
}

async function isAdmin(userId: string | null, agentGroupId: string): Promise<boolean> {
  if (!userId) return false;
  return hasAdminPrivilege(userId, agentGroupId);
}
