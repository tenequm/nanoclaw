/**
 * Core MCP tools: send_message, send_file, edit_message, add_reaction.
 *
 * All outbound tools resolve destinations via the local destination map
 * (see destinations.ts). Agents reference destinations by name; the map
 * translates name → routing tuple. Permission enforcement happens on
 * the host side in delivery.ts via the agent_destinations table.
 */
import fs from 'fs';
import path from 'path';

import { findByName, getAllDestinations } from '../destinations.js';
import { getMessageIdBySeq, getRoutingBySeq, writeMessageOut } from '../db/messages-out.js';
import { getCurrentInReplyTo, getCurrentReplyRoute } from '../db/session-state.js';
import { resolveDestinationThread } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function destinationList(): string {
  const all = getAllDestinations();
  if (all.length === 0) return '(none)';
  return all.map((d) => d.name).join(', ');
}

/**
 * Resolve a destination name to routing fields.
 *
 * A channel destination is threaded like the poll loop's explicit deliveries:
 * the thread of the message being answered (the published reply stamp) when it
 * came from that channel, else that channel's latest inbound thread. An agent
 * destination never carries a thread.
 */
function resolveRouting(
  to: string,
): { channel_type: string; platform_id: string; thread_id: string | null; resolvedName: string } | { error: string } {
  const dest = findByName(to);
  if (!dest) return { error: `Unknown destination "${to}". Known: ${destinationList()}` };
  if (dest.type === 'channel') {
    return {
      channel_type: dest.channelType!,
      platform_id: dest.platformId!,
      thread_id:
        resolveDestinationThread(dest.channelType!, dest.platformId!, getCurrentReplyRoute())?.threadId ?? null,
      resolvedName: to,
    };
  }
  return { channel_type: 'agent', platform_id: dest.agentGroupId!, thread_id: null, resolvedName: to };
}

/** The platform id and routing of a message the agent names by its seq. */
function resolveSeqTarget(
  seq: number,
):
  | { messageId: string; routing: { channel_type: string; platform_id: string; thread_id: string | null } }
  | { error: string } {
  const messageId = seq ? getMessageIdBySeq(seq) : null;
  if (!messageId) return { error: `Message #${seq} not found` };
  const routing = getRoutingBySeq(seq);
  if (!routing?.channel_type || !routing.platform_id)
    return { error: `Cannot determine destination for message #${seq}` };
  return { messageId, routing: { ...routing, channel_type: routing.channel_type, platform_id: routing.platform_id } };
}

const MAX_QUOTE_LENGTH = 1024;

const TELEGRAM_CHANNEL = 'telegram';
const RICH_MAX_CHARS = 32768;
const RICH_MAX_TABLE_COLUMNS = 20;
const RICH_MAX_LINES = 500;

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isTableDelimiter(line: string): boolean {
  return line.includes('|') && tableCells(line).every((cell) => /^:?-+:?$/.test(cell));
}

/** Simple upper bounds on Telegram's Rich Message limits; whatever slips through hits the adapter's fallback. */
function richLimitError(text: string): string | null {
  const chars = [...text].length;
  if (chars > RICH_MAX_CHARS) return `rich text is ${chars} characters; the limit is ${RICH_MAX_CHARS}`;
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (!isTableDelimiter(lines[i])) continue;
    const columns = tableCells(lines[i - 1]).length;
    if (columns > RICH_MAX_TABLE_COLUMNS) {
      return `a rich table has ${columns} columns; the limit is ${RICH_MAX_TABLE_COLUMNS}`;
    }
  }
  const nonEmpty = lines.filter((line) => line.trim()).length;
  if (nonEmpty > RICH_MAX_LINES) return `rich text has ${nonEmpty} non-empty lines; the limit is ${RICH_MAX_LINES}`;
  return null;
}

export const sendMessage: McpToolDefinition = {
  tool: {
    name: 'send_message',
    description:
      'Send a message to a named destination. By default it answers the message you are replying to, shown as a reply only when newer messages came in after it. Pass reply_to to answer a specific earlier message, and quote to highlight the exact part you answer.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Destination name (e.g., "family", "worker-1").',
        },
        text: { type: 'string', description: 'Message content' },
        reply_to: {
          type: 'integer',
          description: 'Message ID to reply to (the numeric id shown in messages); always shown as a reply.',
        },
        quote: {
          type: 'string',
          description: `Part of the replied message to highlight, copied verbatim from its text (max ${MAX_QUOTE_LENGTH} chars). Dropped if it does not match.`,
        },
        rich: {
          type: 'boolean',
          description: `Telegram only: send as a Rich Message, with real tables, headings, task lists and collapsible <details> blocks. Limits: ${RICH_MAX_CHARS} characters, ${RICH_MAX_TABLE_COLUMNS} table columns, ${RICH_MAX_LINES} non-empty lines; a message over them is refused, so split it or drop rich. Single line breaks collapse there, so separate lines with a blank line. Leave it off for normal chat; other channels ignore it.`,
        },
      },
      required: ['to', 'text'],
    },
  },
  async handler(args) {
    const to = args.to as string;
    const text = args.text as string;
    if (!to) return err(`to is required. Options: ${destinationList()}`);
    if (!text) return err('text is required');

    const routing = resolveRouting(to);
    if ('error' in routing) return err(routing.error);

    const rich = args.rich === true && routing.channel_type === TELEGRAM_CHANNEL;
    if (rich) {
      const limit = richLimitError(text);
      if (limit) return err(`${limit}. Split the message, or send it without rich.`);
    }

    // An explicit reply_to or quote always shows as a reply; the channel
    // adapter decides for the default one.
    let inReplyTo = getCurrentInReplyTo();
    const quote = typeof args.quote === 'string' && args.quote ? args.quote : undefined;
    if (quote && quote.length > MAX_QUOTE_LENGTH) return err(`quote is longer than ${MAX_QUOTE_LENGTH} characters`);
    if (args.reply_to != null) {
      const replySeq = Number(args.reply_to);
      const target = resolveSeqTarget(replySeq);
      if ('error' in target) return err(target.error);
      if (target.routing.channel_type !== routing.channel_type || target.routing.platform_id !== routing.platform_id) {
        return err(`Message #${replySeq} is not in ${routing.resolvedName}`);
      }
      inReplyTo = target.messageId;
    }
    const explicit = args.reply_to != null || quote !== undefined;

    const id = generateId();
    const seq = await writeMessageOut({
      id,
      in_reply_to: inReplyTo,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({
        text,
        ...(rich ? { rich: true } : {}),
        ...(explicit ? { replyIntent: quote ? { quote } : {} } : {}),
      }),
    });

    log(`send_message: #${seq} → ${routing.resolvedName}`);
    return ok(`Message sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

export const sendFile: McpToolDefinition = {
  tool: {
    name: 'send_file',
    description: 'Send a file to a named destination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name.' },
        path: { type: 'string', description: 'File path (relative to /workspace/agent/ or absolute)' },
        text: { type: 'string', description: 'Optional accompanying message' },
        filename: { type: 'string', description: 'Display name (default: basename of path)' },
      },
      required: ['to', 'path'],
    },
  },
  async handler(args) {
    const to = args.to as string;
    const filePath = args.path as string;
    if (!to) return err(`to is required. Options: ${destinationList()}`);
    if (!filePath) return err('path is required');

    const routing = resolveRouting(to);
    if ('error' in routing) return err(routing.error);

    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve('/workspace/agent', filePath);
    if (!fs.existsSync(resolvedPath)) return err(`File not found: ${filePath}`);

    const id = generateId();
    const filename = (args.filename as string) || path.basename(resolvedPath);

    const outboxDir = path.join('/workspace/outbox', id);
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.copyFileSync(resolvedPath, path.join(outboxDir, filename));

    await writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text: (args.text as string) || '', files: [filename] }),
    });

    log(`send_file: ${id} → ${routing.resolvedName} (${filename})`);
    return ok(`File sent to ${routing.resolvedName} (id: ${id}, filename: ${filename})`);
  },
};

export const editMessage: McpToolDefinition = {
  tool: {
    name: 'edit_message',
    description: 'Edit a previously sent message. Targets the same destination the original message was sent to.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        text: { type: 'string', description: 'New message content' },
      },
      required: ['messageId', 'text'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const text = args.text as string;
    if (!seq || !text) return err('messageId and text are required');

    const target = resolveSeqTarget(seq);
    if ('error' in target) return err(target.error);
    const { messageId: platformId, routing } = target;

    const id = generateId();
    await writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'edit', messageId: platformId, text }),
    });

    log(`edit_message: #${seq} → ${platformId}`);
    return ok(`Message edit queued for #${seq}`);
  },
};

const TELEGRAM_REACTION_GLYPHS =
  '👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡';

const TELEGRAM_REACTION_SET = new Set(TELEGRAM_REACTION_GLYPHS.split(' '));

/** Slug names (ASCII) pass through: the adapter resolves them, nearest-matching silently. */
function isAllowedTelegramReaction(emoji: string): boolean {
  const trimmed = emoji.trim();
  if ([...trimmed].every((char) => char.codePointAt(0)! <= 0x7f)) return true;
  return TELEGRAM_REACTION_SET.has(trimmed.replace(/\uFE0F/g, ''));
}

export const addReaction: McpToolDefinition = {
  tool: {
    name: 'add_reaction',
    description: 'Add an emoji reaction to a message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        emoji: {
          type: 'string',
          description:
            'Reaction emoji. Pick one of the glyphs below — Telegram allows a FIXED reaction set for everyone in the chat, bots and humans alike, and rejects anything else. ' +
            `On Telegram the legal set is: ${TELEGRAM_REACTION_GLYPHS}. ` +
            'Semantic slugs naming one of those work too (thumbs_up, thumbs_down, heart, fire, party, eyes, ok_hand, salute, trophy, zap, rofl, pray, clap, ...), as do the same glyphs with a variation selector. ' +
            'On Telegram a glyph outside the set (✅, 🚀, ❌, 💪, ⭐, ...) is refused with an error; pick an allowed one instead. Channels with no fixed set forward your emoji untouched.',
        },
      },
      required: ['messageId', 'emoji'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const emoji = args.emoji as string;
    if (!seq || !emoji) return err('messageId and emoji are required');

    const target = resolveSeqTarget(seq);
    if ('error' in target) return err(target.error);
    const { messageId: platformId, routing } = target;
    if (routing.channel_type === TELEGRAM_CHANNEL && !isAllowedTelegramReaction(emoji)) {
      return err(`"${emoji}" is not an allowed Telegram reaction. Allowed: ${TELEGRAM_REACTION_GLYPHS}`);
    }

    const id = generateId();
    await writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'reaction', messageId: platformId, emoji }),
    });

    log(`add_reaction: #${seq} → ${emoji} on ${platformId}`);
    return ok(`Reaction queued for #${seq}`);
  },
};

registerTools([sendMessage, sendFile, editMessage, addReaction]);
