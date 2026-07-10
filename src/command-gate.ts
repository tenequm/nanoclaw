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
 * Typography rule for this module: ASCII only in user-facing strings and
 * comments (no em-dash, en-dash, smart quotes, unicode ellipsis, arrows,
 * bullet chars, or non-breaking space). Emoji are allowed as UI glyphs.
 */
import { COMMANDS, type CommandName } from './commands/types.js';
import { hasAdminPrivilege } from './modules/permissions/db/user-roles.js';

export type GateResult =
  | { action: 'pass' }
  | { action: 'filter' }
  | { action: 'deny'; command: string }
  | { action: 'host'; command: CommandName; args: string };

const FILTERED_COMMANDS = new Set(['/start', '/help', '/login', '/logout', '/doctor', '/remote-control']);
const ADMIN_COMMANDS = new Set(['/clear', '/compact', '/context', '/cost', '/files', '/upload-trace']);

/** Bare command names the host claims (/model, /status, /config, /restart). */
const HOST_COMMANDS = new Set<string>(Object.keys(COMMANDS));

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
 * Pure classifier for host chat-commands. Returns the resolved command name
 * and its argument string when the message is one of /model, /status, /config,
 * /restart (in any casing, with or without an "@botname" suffix), else null.
 *
 * Deliberately independent of any agent group: classification is text-only, so
 * the router can intercept the command once per message before the per-agent
 * fan-out. Admin authorization is enforced later, in the command service.
 */
export function classifyHostCommandFromText(text: string): { command: CommandName; args: string } | null {
  const token = commandToken(text);
  if (!token) return null;
  const name = token.slice(1);
  if (!HOST_COMMANDS.has(name)) return null;
  return { command: name as CommandName, args: commandArgs(text) };
}

/** Router-facing wrapper: classify from a raw content envelope (JSON or plain). */
export function classifyHostCommand(content: string): { command: CommandName; args: string } | null {
  return classifyHostCommandFromText(extractText(content));
}

/**
 * Classify a message and decide whether it should reach the container.
 * Returns 'host' for the four host-owned commands, 'pass' for normal messages
 * and authorized admin commands, 'filter' for silently-dropped commands, and
 * 'deny' for unauthorized admin commands.
 */
export function gateCommand(content: string, userId: string | null, agentGroupId: string): GateResult {
  const text = extractText(content);
  if (!text.startsWith('/')) return { action: 'pass' };

  const host = classifyHostCommandFromText(text);
  if (host) return { action: 'host', command: host.command, args: host.args };

  const command = commandToken(text);

  if (FILTERED_COMMANDS.has(command)) return { action: 'filter' };

  if (ADMIN_COMMANDS.has(command)) {
    if (isAdmin(userId, agentGroupId)) {
      return { action: 'pass' };
    }
    return { action: 'deny', command };
  }

  // Unknown slash commands pass through (the agent/SDK handles them)
  return { action: 'pass' };
}

function isAdmin(userId: string | null, agentGroupId: string): boolean {
  if (!userId) return false;
  return hasAdminPrivilege(userId, agentGroupId);
}
