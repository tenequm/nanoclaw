/**
 * Markdown → Telegram FormattedString renderer.
 *
 * The whole adapter's reliability story leans on this file: by producing
 * `{ text, entities }` directly instead of `parse_mode: 'MarkdownV2'`, we
 * eliminate the server-side-parser bug class entirely. Telegram never runs
 * a parser when `entities` are provided — the entity offsets ARE the
 * formatting, full stop.
 *
 * Pure functions only — no Effect, no IO. Kept plain TS so the walker is
 * easy to test and reason about in isolation.
 */
import type { Content as MdContent, Root as MdRoot } from 'chat';
import {
  isBlockquoteNode,
  isCodeNode,
  isDeleteNode,
  isEmphasisNode,
  isInlineCodeNode,
  isLinkNode,
  isListItemNode,
  isListNode,
  isParagraphNode,
  isStrongNode,
  isTableNode,
  isTextNode,
  parseMarkdown,
  tableToAscii,
  walkAst,
} from 'chat';
import { FormattedString } from '@grammyjs/parse-mode';

/** Telegram's absolute message body limit. */
export const TELEGRAM_TEXT_LIMIT = 4096;
/** Telegram's absolute caption limit for media. */
export const TELEGRAM_CAPTION_LIMIT = 1024;

const EMPTY = (): FormattedString => new FormattedString('');
const PLAIN = (s: string): FormattedString => new FormattedString(s);
const NL = (): FormattedString => new FormattedString('\n');
const NL2 = (): FormattedString => new FormattedString('\n\n');

/**
 * Join a list of FormattedStrings with a separator.
 * Mirrors Array.prototype.join but preserves entity offsets via `concat`.
 */
function joinFs(items: readonly FormattedString[], separator: FormattedString): FormattedString {
  if (items.length === 0) return EMPTY();
  let acc = items[0];
  for (let i = 1; i < items.length; i++) {
    acc = acc.concat(separator, items[i]);
  }
  return acc;
}

/**
 * Synthetic `underline` node we inject into the tree ahead of rendering.
 * mdast's parser can't distinguish `__x__` from `**x**` — both surface as
 * `strong`. `promoteUnderlines` below replaces the `__`-sourced ones with
 * this shape, which the walker picks up to emit a Telegram `underline`
 * entity via `FormattedString.u()`.
 */
interface UnderlineNode {
  readonly type: 'underline';
  readonly children: readonly MdContent[];
}

function isUnderlineNode(node: unknown): node is UnderlineNode {
  return typeof node === 'object' && node !== null && (node as { type?: string }).type === 'underline';
}

/** `||X||` inside a text node → FormattedString.spoiler(X) interleaved with plain text. */
const SPOILER_RE = /\|\|([^\n|][^\n]*?)\|\|/g;
function renderTextValue(value: string): FormattedString {
  if (!value.includes('||')) return PLAIN(value);
  const parts: FormattedString[] = [];
  let last = 0;
  SPOILER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SPOILER_RE.exec(value)) !== null) {
    if (m.index > last) parts.push(PLAIN(value.slice(last, m.index)));
    parts.push(FormattedString.spoiler(m[1]));
    last = m.index + m[0].length;
  }
  if (last < value.length) parts.push(PLAIN(value.slice(last)));
  if (parts.length === 0) return PLAIN(value);
  return parts.reduce((acc, cur) => acc.concat(cur), EMPTY());
}

type RenderableNode = MdContent | UnderlineNode;

/** Render an mdast node to a FormattedString. */
function renderNode(node: RenderableNode): FormattedString {
  if (isUnderlineNode(node)) {
    return FormattedString.u(renderChildren(node.children));
  }
  if (isTextNode(node)) {
    return renderTextValue(node.value);
  }
  if (isStrongNode(node)) {
    return FormattedString.b(renderChildren(node.children));
  }
  if (isEmphasisNode(node)) {
    return FormattedString.i(renderChildren(node.children));
  }
  if (isDeleteNode(node)) {
    return FormattedString.s(renderChildren(node.children));
  }
  if (isInlineCodeNode(node)) {
    return FormattedString.code(node.value);
  }
  if (isCodeNode(node)) {
    const lang = node.lang ?? undefined;
    return FormattedString.pre(node.value, lang);
  }
  if (isLinkNode(node)) {
    return FormattedString.a(renderChildren(node.children), node.url);
  }
  if (isBlockquoteNode(node)) {
    const body = joinFs(node.children.map(renderNode), NL());
    return FormattedString.blockquote(body);
  }
  if (node.type === 'heading') {
    // Telegram has no headings — fall back to bold.
    return FormattedString.b(renderChildren(node.children));
  }
  if (isParagraphNode(node)) {
    return renderChildren(node.children);
  }
  if (isListNode(node)) {
    const ordered = node.ordered === true;
    const startValue = typeof node.start === 'number' && Number.isFinite(node.start) ? node.start : 1;
    const items = node.children.map((item, i) => {
      const prefix = ordered ? `${startValue + i}. ` : '• ';
      const body = isListItemNode(item) ? joinFs(item.children.map(renderNode), NL()) : renderNode(item);
      return PLAIN(prefix).concat(body);
    });
    return joinFs(items, NL());
  }
  if (isListItemNode(node)) {
    return joinFs(node.children.map(renderNode), NL());
  }
  if (node.type === 'thematicBreak') {
    return PLAIN('———');
  }
  if (node.type === 'break') {
    return NL();
  }
  if (node.type === 'image') {
    const alt = node.alt ?? '';
    if (!alt) return FormattedString.a('(image)', node.url);
    return FormattedString.a(alt, node.url);
  }
  // html / yaml / definition / footnoteReference / footnoteDefinition / linkReference —
  // no meaningful rendering; drop quietly.
  return EMPTY();
}

function renderChildren(children: readonly RenderableNode[]): FormattedString {
  if (children.length === 0) return EMPTY();
  return children.map(renderNode).reduce((acc, cur) => acc.concat(cur), EMPTY());
}

/**
 * Rewrite `strong` nodes whose source token is `__` into synthetic
 * `underline` nodes. mdast's GFM parser collapses `**x**` and `__x__` into
 * the same `strong` shape, but Telegram has separate `bold` and `underline`
 * entities — we recover the distinction from `position.start.offset` by
 * peeking at the original markdown text.
 */
function promoteUnderlines(ast: MdRoot, source: string): MdRoot {
  return walkAst(ast, (n: MdContent) => {
    if (!isStrongNode(n)) return n;
    const offset = n.position?.start.offset;
    if (typeof offset !== 'number') return n;
    if (source.charCodeAt(offset) === 0x5f && source.charCodeAt(offset + 1) === 0x5f) {
      const replacement: UnderlineNode = { type: 'underline', children: n.children };
      return replacement as unknown as MdContent;
    }
    return n;
  });
}

/**
 * Pre-pass: collapse mdast tables into fenced ASCII code blocks so Telegram
 * (which has no native table support) shows them in monospace instead of
 * silently flattening every row into one line.
 */
function collapseTables(ast: MdRoot): MdRoot {
  return walkAst(ast, (n: MdContent) => {
    if (isTableNode(n)) {
      const ascii = tableToAscii(n);
      const replacement: MdContent = { type: 'code', lang: null, meta: null, value: ascii };
      return replacement;
    }
    return n;
  });
}

/** Render a markdown string to a Telegram FormattedString. */
export function renderFS(markdown: string): FormattedString {
  const ast = parseMarkdown(markdown);
  // structuredClone preserves node `position` data we need for the
  // __bold__ vs **bold** discrimination in `promoteUnderlines`.
  const promoted = promoteUnderlines(structuredClone(ast), markdown);
  const collapsed = collapseTables(promoted);
  return joinFs(collapsed.children.map(renderNode), NL2());
}

/**
 * Length-aware splitter — preserves entities across chunk boundaries by
 * using FormattedString.slice (which recomputes entity offsets). Prefers
 * to break on a newline within the last ~200 chars of the limit, falls
 * through to space, then hard cut.
 */
function splitAt(fs: FormattedString, limit: number): FormattedString[] {
  if (fs.rawText.length <= limit) return [fs];

  const out: FormattedString[] = [];
  let cursor = 0;
  const total = fs.rawText.length;

  while (cursor < total) {
    const remaining = total - cursor;
    if (remaining <= limit) {
      out.push(fs.slice(cursor, total));
      break;
    }

    const windowStart = cursor + Math.max(0, limit - 200);
    const windowEnd = cursor + limit;
    const chunkText = fs.rawText.slice(cursor, windowEnd);

    let cut = chunkText.lastIndexOf('\n\n');
    if (cut === -1 || cursor + cut <= windowStart - cursor) cut = chunkText.lastIndexOf('\n');
    if (cut === -1 || cursor + cut <= windowStart - cursor) cut = chunkText.lastIndexOf(' ');
    if (cut === -1) cut = limit;

    const absCut = cursor + cut;
    out.push(fs.slice(cursor, absCut));
    cursor = absCut;
    // Skip any leading whitespace that only served as a break.
    while (cursor < total && (fs.rawText[cursor] === '\n' || fs.rawText[cursor] === ' ')) cursor++;
  }

  return out.filter((c) => c.rawText.length > 0);
}

export const splitForBody = (fs: FormattedString): FormattedString[] => splitAt(fs, TELEGRAM_TEXT_LIMIT);
export const splitForCaption = (fs: FormattedString): FormattedString[] => splitAt(fs, TELEGRAM_CAPTION_LIMIT);
