/**
 * Host-side command gate. Classifies inbound slash commands and gates
 * them before they reach the container.
 *
 * - Host commands (/model, /status, /config, /restart): claimed by the host.
 *   The router answers these via the fallback renderer (or, on channels with a
 *   native binding, the adapter). They must NOT leak to the container: the
 *   Claude SDK ships native /model + /status handlers that would shadow ours
 *   (and whose effects are not persisted, so they vanish on the next respawn).
 * - Filtered commands: dropped silently (never reach the container)
 * - Admin commands: checked against user_roles; denied senders get a
 *   "Permission denied" response written directly to messages_out
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

export type GateResult =
  | { action: 'pass'; normalizedText?: string }
  | { action: 'filter' }
  | { action: 'deny'; command: string }
  | { action: 'host'; command: CommandName; args: string };

const FILTERED_COMMANDS = new Set(['/start', '/help', '/login', '/logout', '/doctor', '/remote-control']);
const ADMIN_COMMANDS = new Set(['/clear', '/compact', '/context', '/cost', '/files', '/upload-trace']);

/** Bare command names the host claims (/model, /status, /config, /restart). */
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

function extractText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    return (parsed.text || '').trim();
  } catch {
    return content.trim();
  }
}

/**
 * The normalized command token WITH its leading slash, lowercased and with a
 * Telegram-style "@botname" suffix stripped (so "/model@opx_cc_bl_bot" matches
 * "/model"). Returns '' when the text is not a slash command.
 */
function commandToken(text: string): string {
  if (!text.startsWith('/')) return '';
  const raw = text.split(/\s/)[0].toLowerCase();
  const at = raw.indexOf('@');
  return at === -1 ? raw : raw.slice(0, at);
}

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
    canonical = COMMAND_ALIASES[commandToken(text)] ?? null;
  }

  if (!canonical || canonical === token) return null;
  return canonical + text.slice(token.length);
}

/**
 * Host-command classification from a bare text (already extracted). Split so
 * the router can intercept the command once per message before the per-agent
 * fan-out. Admin authorization is enforced later, in the command service.
 */
export function classifyHostCommandFromText(
  text: string,
  channelType: string | null = null,
): { command: CommandName; args: string } | null {
  const normalized = normalizeCommandText(text, channelType) ?? text;
  const token = commandToken(normalized);
  if (!token) return null;
  const name = token.slice(1);
  if (!HOST_COMMANDS.has(name)) return null;
  return { command: name as CommandName, args: commandArgs(normalized) };
}

/** Router-facing wrapper: classify from a raw content envelope (JSON or plain). */
export function classifyHostCommand(
  content: string,
  channelType: string | null = null,
): { command: CommandName; args: string } | null {
  return classifyHostCommandFromText(extractText(content), channelType);
}

/**
 * Classify a message and decide whether it should reach the container.
 * Returns 'host' for the four host-owned commands, 'pass' for normal messages
 * and authorized admin commands (with `normalizedText` set when a bang/alias
 * rewrite applied - the caller applies it via applyNormalizedText AFTER
 * materialization, which owns and may replace the content string), 'filter'
 * for silently-dropped commands, and 'deny' for unauthorized admin commands.
 */
export async function gateCommand(
  content: string,
  userId: string | null,
  agentGroupId: string,
  channelType: string | null = null,
): Promise<GateResult> {
  let text = extractText(content);

  const normalizedText = normalizeCommandText(text, channelType);
  if (normalizedText !== null) text = normalizedText;

  if (!text.startsWith('/')) return { action: 'pass' };

  const host = classifyHostCommandFromText(text);
  if (host) return { action: 'host', command: host.command, args: host.args };

  const command = commandToken(text);

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  if (ADMIN_COMMANDS.has(command)) {
    if (await isAdmin(userId, agentGroupId)) {
      return normalizedText !== null ? { action: 'pass', normalizedText } : { action: 'pass' };
    }
    return { action: 'deny', command };
  }

  // Unknown slash commands pass through (the agent/SDK handles them)
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
