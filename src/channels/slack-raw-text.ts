/**
 * Recover content from a raw Slack event that the Chat SDK adapter leaves
 * only in `message.raw`, which the host deliberately drops before
 * persistence:
 *
 * - Pasted tables: Slack sends them as attachment blocks instead of message
 *   text or files.
 * - User ids of mentions: the adapter renders `<@U123>` as `@Display Name`,
 *   so without the raw text the agent cannot mention that person back.
 */
import type { InboundTextRewriter } from './chat-sdk-bridge.js';

const MAX_TABLE_CHARS = 100_000;
const USER_MENTION_RE = /<@([A-Z0-9_]+)(?:\|[^<>]*)?>/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Collect the text leaves in a Slack cell's raw_text/rich_text subtree. */
function cellText(value: unknown): string {
  const parts: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRecord(node)) return;
    if (typeof node.text === 'string') parts.push(node.text);
    Object.values(node).forEach(visit);
  };
  visit(value);
  return parts.join(' ').trim();
}

export function extractSlackRawText(raw: Record<string, unknown>): string | null {
  const attachments = Array.isArray(raw.attachments) ? raw.attachments : [];
  const lines: string[] = [];

  for (const attachment of attachments) {
    if (!isRecord(attachment)) continue;
    const blocks = Array.isArray(attachment.blocks) ? attachment.blocks : [];
    for (const block of blocks) {
      if (!isRecord(block) || block.type !== 'table' || !Array.isArray(block.rows)) continue;
      for (const row of block.rows) {
        if (!Array.isArray(row)) continue;
        lines.push(row.map(cellText).join(' | '));
      }
    }
  }

  if (lines.length === 0) return null;
  const text = lines.join('\n');
  if (text.length <= MAX_TABLE_CHARS) return text;
  return `${text.slice(0, MAX_TABLE_CHARS - 20)}\n[table truncated]`;
}

/** User ids mentioned in the raw event text, deduplicated, in first-mention order. */
export function slackMentionedUserIds(raw: Record<string, unknown>): string[] {
  if (typeof raw.text !== 'string') return [];
  return [...new Set(Array.from(raw.text.matchAll(USER_MENTION_RE), (m) => m[1]!))];
}

/**
 * Re-attach the user id to each `@Display Name` the adapter rendered from a
 * mention: `@Boris` becomes `@Boris (<@U123>)`. `names` maps id to the display
 * name the adapter used, in mention order, so ids sharing one display name
 * pair up with its occurrences in order. A longer name wins over its prefix,
 * and an already annotated mention is left alone.
 */
export function annotateSlackMentions(text: string, names: ReadonlyMap<string, string>): string {
  const idsByName = new Map<string, string[]>();
  for (const [id, name] of names) idsByName.set(name, [...(idsByName.get(name) ?? []), id]);
  if (idsByName.size === 0) return text;
  const alternation = [...idsByName.keys()]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const mention = new RegExp(`@(${alternation})(?![\\p{L}\\p{N}_]| \\(<@)`, 'gu');
  const used = new Map<string, number>();
  return text.replace(mention, (match, name: string) => {
    const ids = idsByName.get(name)!;
    const n = used.get(name) ?? 0;
    used.set(name, n + 1);
    return `${match} (<@${ids[Math.min(n, ids.length - 1)]}>)`;
  });
}

/**
 * The Slack bridge's InboundTextRewriter. `displayName` must resolve the same
 * cached name the adapter rendered. The bot's own mention is skipped: the
 * adapter leaves it unresolved as `@U…`, which already carries the id.
 */
export function createSlackMentionRewriter(
  displayName: (userId: string) => Promise<string | null | undefined>,
  selfUserId: () => string | undefined,
): InboundTextRewriter {
  return async (raw) => {
    const self = selfUserId();
    const ids = slackMentionedUserIds(raw).filter((id) => id !== self);
    if (ids.length === 0) return null;
    const resolved = await Promise.all(ids.map(async (id) => [id, await displayName(id)] as const));
    const names = new Map<string, string>();
    for (const [id, name] of resolved) if (name && name !== id) names.set(id, name);
    return names.size > 0 ? (text) => annotateSlackMentions(text, names) : null;
  };
}
