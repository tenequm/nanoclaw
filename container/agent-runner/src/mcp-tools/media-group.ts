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


const outboxRoot = (): string => process.env.NANOCLAW_OUTBOX_DIR ?? '/workspace/outbox';
export const sendMediaGroup: McpToolDefinition = {
  tool: {
    name: 'send_media_group',
    description:
      'Send 2-10 files as a single album (photos/videos as a gallery, documents as a grouped list). Telegram-first; other channels may fall back to individual sends.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name.' },
        items: {
          type: 'array',
          minItems: 2,
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path (relative to /workspace/agent/ or absolute)' },
              caption: { type: 'string', description: 'Optional per-item caption' },
            },
            required: ['path'],
          },
        },
      },
      required: ['to', 'items'],
    },
  },
  async handler(args) {
    const rawItems = args.items as Array<{ path: string; caption?: string }> | undefined;
    if (!Array.isArray(rawItems) || rawItems.length < 2 || rawItems.length > 10) {
      return err('items must contain between 2 and 10 files');
    }

    const to = args.to as string;
    if (!to) return err(`to is required. Options: ${destinationList()}`);

    const routing = resolveRouting(to);
    if ('error' in routing) return err(routing.error);

    const resolvedItems: Array<{ resolved: string; basename: string; caption?: string }> = [];
    for (const item of rawItems) {
      const filePath = item.path;
      if (!filePath) return err('each item must have a path');
      const resolved = path.isAbsolute(filePath) ? filePath : path.resolve('/workspace/agent', filePath);
      if (!fs.existsSync(resolved)) return err(`File not found: ${filePath}`);
      resolvedItems.push({ resolved, basename: path.basename(resolved), caption: item.caption });
    }

    const basenameCounts = new Map<string, number>();
    for (const item of resolvedItems) {
      basenameCounts.set(item.basename, (basenameCounts.get(item.basename) ?? 0) + 1);
    }

    const id = generateId();
    const outboxDir = path.join(outboxRoot(), id);
    fs.mkdirSync(outboxDir, { recursive: true });

    const items: Array<{ path: string; caption?: string }> = [];
    const filenames: string[] = [];
    for (const [index, item] of resolvedItems.entries()) {
      const filename = basenameCounts.get(item.basename) === 1 ? item.basename : `${index}-${item.basename}`;
      fs.copyFileSync(item.resolved, path.join(outboxDir, filename));
      items.push({ path: filename, caption: item.caption });
      filenames.push(filename);
    }

    await writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'send_media_group', items, files: filenames }),
    });

    log(`send_media_group: ${id} → ${routing.resolvedName} (${filenames.length} files)`);
    return ok(`Media group sent to ${routing.resolvedName} (id: ${id}, count: ${filenames.length})`);
  },
};


registerTools([sendMediaGroup]);
