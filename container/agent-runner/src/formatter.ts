import { findByRouting } from './destinations.js';
import type { MessageInRow } from './db/messages-in.js';

/**
 * Command categories for messages starting with '/'.
 * - admin: sender must be in NANOCLAW_ADMIN_USER_IDS
 * - filtered: silently drop (mark completed without processing)
 * - passthrough: pass raw to the agent (no XML wrapping)
 * - none: not a command — format normally
 */
export type CommandCategory = 'admin' | 'filtered' | 'passthrough' | 'none';

const ADMIN_COMMANDS = new Set(['/remote-control', '/clear', '/compact', '/context', '/cost', '/files']);
const FILTERED_COMMANDS = new Set(['/help', '/login', '/logout', '/doctor', '/config']);

export interface CommandInfo {
  category: CommandCategory;
  command: string; // the command name (e.g., '/clear')
  text: string; // full original text
  senderId: string | null;
}

/**
 * Categorize a message as a command or not.
 * Only applies to chat/chat-sdk messages.
 *
 * The extracted `senderId` is compared against `NANOCLAW_ADMIN_USER_IDS`
 * which stores ids in the namespaced form `<channel_type>:<raw>` (see
 * src/db/users.ts). chat-sdk-bridge serializes `author.userId` as a raw
 * platform id with no prefix, so we prefix it here. If the id already
 * contains a `:` we assume it's pre-namespaced (non-chat-sdk adapters
 * that populate `senderId` directly) and leave it alone.
 */
export function categorizeMessage(msg: MessageInRow): CommandInfo {
  const content = parseContent(msg.content);
  const text = (content.text || '').trim();
  const senderId = extractSenderId(msg, content);

  if (!text.startsWith('/')) {
    return { category: 'none', command: '', text, senderId };
  }

  // Extract the command name (e.g., '/clear' from '/clear some args')
  const command = text.split(/\s/)[0].toLowerCase();

  if (ADMIN_COMMANDS.has(command)) {
    return { category: 'admin', command, text, senderId };
  }

  if (FILTERED_COMMANDS.has(command)) {
    return { category: 'filtered', command, text, senderId };
  }

  return { category: 'passthrough', command, text, senderId };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractSenderId(msg: MessageInRow, content: any): string | null {
  const raw: string | null = content?.senderId || content?.author?.userId || null;
  if (!raw) return null;
  // Already namespaced (e.g. "telegram:123") — use as-is.
  if (raw.includes(':')) return raw;
  // Raw platform id from chat-sdk serialization — prefix with channel type.
  if (!msg.channel_type) return raw;
  return `${msg.channel_type}:${raw}`;
}

/**
 * Routing context extracted from messages_in rows.
 * Copied to messages_out by default so responses go back to the sender.
 */
export interface RoutingContext {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  inReplyTo: string | null;
}

/**
 * Extract routing context from a batch of messages.
 * Uses the first message's routing fields.
 */
export function extractRouting(messages: MessageInRow[]): RoutingContext {
  const first = messages[0];
  return {
    platformId: first?.platform_id ?? null,
    channelType: first?.channel_type ?? null,
    threadId: first?.thread_id ?? null,
    inReplyTo: first?.id ?? null,
  };
}

/**
 * Format a batch of messages_in rows into a prompt string.
 * Strips routing fields — the agent never sees platform_id, channel_type, thread_id.
 */
export function formatMessages(messages: MessageInRow[]): string {
  if (messages.length === 0) return '';

  // Group by kind
  const chatMessages = messages.filter((m) => m.kind === 'chat' || m.kind === 'chat-sdk');
  const taskMessages = messages.filter((m) => m.kind === 'task');
  const webhookMessages = messages.filter((m) => m.kind === 'webhook');
  const systemMessages = messages.filter((m) => m.kind === 'system');

  const parts: string[] = [];

  if (chatMessages.length > 0) {
    parts.push(formatChatMessages(chatMessages));
  }
  if (taskMessages.length > 0) {
    parts.push(...taskMessages.map(formatTaskMessage));
  }
  if (webhookMessages.length > 0) {
    parts.push(...webhookMessages.map(formatWebhookMessage));
  }
  if (systemMessages.length > 0) {
    parts.push(...systemMessages.map(formatSystemMessage));
  }

  return parts.join('\n\n');
}

function formatChatMessages(messages: MessageInRow[]): string {
  if (messages.length === 1) {
    return formatSingleChat(messages[0]);
  }

  const lines = ['<messages>'];
  for (const msg of messages) {
    lines.push(formatSingleChat(msg));
  }
  lines.push('</messages>');
  return lines.join('\n');
}

function formatSingleChat(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const sender = content.sender || content.author?.fullName || content.author?.userName || 'Unknown';
  const time = formatTime(msg.timestamp);
  const text = content.text || '';
  const idAttr = msg.seq != null ? ` id="${msg.seq}"` : '';
  const replyPrefix = formatReplyContext(content.replyTo);
  const attachmentsSuffix = formatAttachments(content.attachments);

  // Look up the destination name for the origin (reverse map lookup).
  // If not found, fall back to a raw channel:platform_id marker so nothing
  // gets silently dropped — this should only happen if the destination was
  // removed between when the message was received and when it's being processed.
  const fromDest = findByRouting(msg.channel_type, msg.platform_id);
  const fromAttr = fromDest
    ? ` from="${escapeXml(fromDest.name)}"`
    : msg.channel_type || msg.platform_id
      ? ` from="unknown:${escapeXml(msg.channel_type || '')}:${escapeXml(msg.platform_id || '')}"`
      : '';

  return `<message${idAttr}${fromAttr} sender="${escapeXml(sender)}" time="${time}">${replyPrefix}${escapeXml(text)}${attachmentsSuffix}</message>`;
}

function formatTaskMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const parts = ['[SCHEDULED TASK]'];
  if (content.scriptOutput) {
    parts.push('', 'Script output:', JSON.stringify(content.scriptOutput, null, 2));
  }
  parts.push('', 'Instructions:', content.prompt || '');
  return parts.join('\n');
}

function formatWebhookMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  const source = content.source || 'unknown';
  const event = content.event || 'unknown';
  return `[WEBHOOK: ${source}/${event}]\n\n${JSON.stringify(content.payload || content, null, 2)}`;
}

function formatSystemMessage(msg: MessageInRow): string {
  const content = parseContent(msg.content);
  return `[SYSTEM RESPONSE]\n\nAction: ${content.action || 'unknown'}\nStatus: ${content.status || 'unknown'}\nResult: ${JSON.stringify(content.result || null)}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatReplyContext(replyTo: any): string {
  if (!replyTo) return '';
  const sender = replyTo.sender || 'Unknown';
  const text = replyTo.text || '';
  const preview = text.length > 100 ? text.slice(0, 100) + '…' : text;
  return `\n<reply-to sender="${escapeXml(sender)}">${escapeXml(preview)}</reply-to>\n`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatAttachments(attachments: any[] | undefined): string {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const parts = attachments.map((a) => {
    const name = a.name || a.filename || 'attachment';
    const type = a.type || 'file';
    const localPath = a.localPath ? `/workspace/${a.localPath}` : '';
    const url = a.url || '';
    const transcriptSuffix = a.transcript ? ` transcript: "${escapeXml(a.transcript)}"` : '';
    if (localPath) {
      return `[${type}: ${escapeXml(name)} — saved to ${escapeXml(localPath)}]${transcriptSuffix}`;
    }
    const base = url ? `[${type}: ${escapeXml(name)} (${escapeXml(url)})]` : `[${type}: ${escapeXml(name)}]`;
    return `${base}${transcriptSuffix}`;
  });
  return '\n' + parts.join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseContent(json: string): any {
  try {
    return JSON.parse(json);
  } catch {
    return { text: json };
  }
}

function formatTime(timestamp: string): string {
  try {
    const d = new Date(timestamp);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  } catch {
    return timestamp;
  }
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
