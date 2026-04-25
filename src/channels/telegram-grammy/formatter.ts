/**
 * Markdown → Telegram FormattedString renderer.
 *
 * The whole adapter's reliability story leans on this file: by producing
 * `{ text, entities }` directly instead of `parse_mode: 'MarkdownV2'`, we
 * eliminate the server-side-parser bug class entirely. Telegram never runs
 * a parser when `entities` are provided — the entity offsets ARE the
 * formatting, full stop.
 *
 * Telegram dialect deviations from strict CommonMark (matched to LLM /
 * Telegram-MarkdownV2 author intent — see also
 * `src/vendor/openclaw-markdown/README.md` `DEVIATION` notes and
 * https://core.telegram.org/bots/api#formatting-options for the entity model):
 *
 *  - `*X*`   → bold       (CommonMark says italic; LLMs and MarkdownV2 say bold)
 *  - `_X_`   → italic     (no change)
 *  - `**X**` → bold       (no change)
 *  - `__X__` → underline  (CommonMark says strong; MarkdownV2 has no other
 *                          shorthand for underline)
 *  - `~~X~~` → strike     (mdast-native)
 *  - `||X||` → spoiler    (Telegram extension)
 *
 * Note on user mentions: `[t](tg://user?id=N)` flows through the default
 * link path and produces a `text_link` entity with the `tg://user?id=N`
 * URL — Telegram clients render that as a clickable mention. We do *not*
 * special-case it: the only "richer" alternative is a real `text_mention`
 * entity, which requires the full `User` object (first_name, etc.) that
 * we don't have at render time. grammy's `FormattedString.mentionUser`
 * helper is itself just `a(\`tg://user?id=${id}\`)` — same output.
 *
 * Two opt-in conventions this renderer adds on top:
 *
 *  - `> [!fold]` (also `[!expand]`, `[!expandable]`) on the first line of a
 *    blockquote → renders as Telegram's collapsible `expandable_blockquote`.
 *  - GFM footnotes (`[^id]` + `[^id]: body`): if the definition body contains
 *    a URL, the *cited word* (the last word before `[^id]`) is wrapped in a
 *    link to that URL — web-citation convention, not breadcrumb-and-footer.
 *    Falls back to clickable breadcrumb / inline body / plain breadcrumb when
 *    word-attachment isn't structurally clean (see `inlineFootnoteRefs`).
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
  link as mdLink,
  paragraph as mdParagraph,
  parseMarkdown,
  strong as mdStrong,
  tableToAscii,
  text as mdText,
  toPlainText,
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
 * `strong`. `applyTelegramDialect` below replaces the `__`-sourced ones with
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

/**
 * Synthetic `expandableBlockquote` node — a blockquote whose first line was
 * `[!fold]` (or `[!expand]` / `[!expandable]`). The walker emits Telegram's
 * collapsible `expandable_blockquote` entity for these.
 */
interface ExpandableBlockquoteNode {
  readonly type: 'expandableBlockquote';
  readonly children: readonly MdContent[];
}

function isExpandableBlockquoteNode(node: unknown): node is ExpandableBlockquoteNode {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as { type?: string }).type === 'expandableBlockquote'
  );
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

type RenderableNode = MdContent | UnderlineNode | ExpandableBlockquoteNode;

/** Render an mdast node to a FormattedString. */
function renderNode(node: RenderableNode): FormattedString {
  if (isUnderlineNode(node)) {
    return FormattedString.u(renderChildren(node.children));
  }
  if (isExpandableBlockquoteNode(node)) {
    const body = joinFs(node.children.map(renderNode), NL());
    return FormattedString.expandableBlockquote(body);
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
  // Reference-style link: render visible label/children. The reference
  // resolution to a definition is lost (we drop `definition` nodes); at
  // least the visible text survives so the message isn't gappy.
  if (node.type === 'linkReference') {
    const ref = node as unknown as { children: MdContent[]; label?: string; identifier: string };
    if (ref.children && ref.children.length > 0) return renderChildren(ref.children);
    return PLAIN(ref.label ?? ref.identifier);
  }
  // Reference-style image: surface the alt/label/identifier as text.
  if (node.type === 'imageReference') {
    const ref = node as unknown as { alt?: string; label?: string; identifier: string };
    return PLAIN(ref.alt ?? ref.label ?? ref.identifier);
  }
  // Raw HTML — Telegram clients won't interpret it; render literally so
  // nothing is dropped silently.
  if (node.type === 'html') {
    const html = node as unknown as { value: string };
    return PLAIN(html.value);
  }
  // definition / yaml / footnoteDefinition — structural metadata, no
  // visible output. (footnoteDefinition is also dropped at AST level by
  // applyTelegramDialect; this is just a belt for the suspenders.)
  return EMPTY();
}

function renderChildren(children: readonly RenderableNode[]): FormattedString {
  if (children.length === 0) return EMPTY();
  return children.map(renderNode).reduce((acc, cur) => acc.concat(cur), EMPTY());
}

/* ----------------------------------------------------------------------- */
/*                          Telegram dialect pre-pass                       */
/* ----------------------------------------------------------------------- */

const FOLD_MARKER_RE = /^\[!(?:fold|expand|expandable)\][ \t]*\r?\n?/;

interface FootnoteDefinitionNode {
  type: 'footnoteDefinition';
  identifier: string;
  label?: string;
  children: MdContent[];
}

interface FootnoteReferenceNode {
  type: 'footnoteReference';
  identifier: string;
  label?: string;
}

function isFootnoteDefinitionNode(node: unknown): node is FootnoteDefinitionNode {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as { type?: string }).type === 'footnoteDefinition'
  );
}

function isFootnoteReferenceNode(node: unknown): node is FootnoteReferenceNode {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as { type?: string }).type === 'footnoteReference'
  );
}

/**
 * Apply Telegram-specific dialect rules to an mdast tree:
 *
 *  1. Collect footnote definitions, then drop them from the tree (their
 *     body is captured by the reference rewrite below).
 *  2. Walk: rewrite `**` strong nodes whose source delimiter is `__` into
 *     synthetic `underline` nodes; rewrite `_` emphasis nodes whose source
 *     delimiter is `*` into `strong` nodes. Both peeks rely on
 *     `position?.start.offset`, which mdast preserves on parsed-from-source
 *     nodes (synthetic nodes have no position and fall through unchanged).
 *  3. Walk: rewrite blockquotes whose first text starts with
 *     `[!fold]`/`[!expand]`/`[!expandable]` into synthetic
 *     `expandableBlockquote` nodes (marker stripped).
 *  4. Walk paragraph children list-by-list and rewrite `footnoteReference`
 *     nodes per the four-tier inline-citation rule. See
 *     `inlineFootnoteRefs` below.
 */
function applyTelegramDialect(ast: MdRoot, source: string): MdRoot {
  const defs = new Map<string, FootnoteDefinitionNode>();
  for (const child of ast.children) {
    if (isFootnoteDefinitionNode(child)) {
      defs.set(child.identifier, child);
    }
  }

  const transformed = walkAst(ast, (n: MdContent) => {
    // Drop footnote definitions — their bodies are captured by the
    // reference rewrite step that runs after this walk.
    if (isFootnoteDefinitionNode(n)) return null;

    // strong: `__X__` → underline; `**X**` stays strong/bold (default).
    if (isStrongNode(n)) {
      const offset = n.position?.start.offset;
      if (
        typeof offset === 'number' &&
        source.charCodeAt(offset) === 0x5f /* _ */ &&
        source.charCodeAt(offset + 1) === 0x5f
      ) {
        const replacement: UnderlineNode = { type: 'underline', children: n.children };
        return replacement as unknown as MdContent;
      }
      return n;
    }

    // emphasis: `*X*` → strong/bold; `_X_` stays emphasis/italic.
    if (isEmphasisNode(n)) {
      const offset = n.position?.start.offset;
      if (typeof offset === 'number' && source.charCodeAt(offset) === 0x2a /* * */) {
        return mdStrong(n.children);
      }
      return n;
    }

    // blockquote: `[!fold]` / `[!expand]` / `[!expandable]` first-line marker
    // → synthetic expandableBlockquote (marker stripped).
    if (isBlockquoteNode(n)) {
      const stripped = stripFoldMarker(n.children as MdContent[]);
      if (stripped) {
        const replacement: ExpandableBlockquoteNode = { type: 'expandableBlockquote', children: stripped };
        return replacement as unknown as MdContent;
      }
      return n;
    }

    return n;
  });

  if (defs.size > 0) {
    inlineFootnoteRefs(transformed, defs);
  }

  return transformed;
}

/**
 * If the first paragraph of a blockquote begins with a `[!fold]`-style
 * marker, return the children with the marker stripped. Returns null when
 * no marker is present so the caller can leave the node untouched.
 */
function stripFoldMarker(children: MdContent[]): MdContent[] | null {
  const firstBlock = children[0];
  if (!firstBlock || !isParagraphNode(firstBlock)) return null;
  const firstInline = firstBlock.children[0];
  if (!firstInline || !isTextNode(firstInline)) return null;
  const m = firstInline.value.match(FOLD_MARKER_RE);
  if (!m) return null;

  const trimmedValue = firstInline.value.slice(m[0].length);
  const remainingInlines = firstBlock.children.slice(1);

  // If the first paragraph is now empty (marker was its entire content
  // and there were no subsequent inline siblings), drop it. Otherwise
  // rebuild it with the trimmed text node.
  if (trimmedValue.length === 0 && remainingInlines.length === 0) {
    return children.slice(1);
  }
  const rebuiltPara = mdParagraph([
    mdText(trimmedValue),
    ...(remainingInlines as MdContent[]),
  ]);
  return [rebuiltPara as unknown as MdContent, ...children.slice(1)];
}

/* ----------------------------------------------------------------------- */
/*                       Footnote reference inlining                        */
/* ----------------------------------------------------------------------- */

const URL_RE = /(https?:\/\/[^\s)>\]]+)/;

function extractFirstUrl(text: string): string | null {
  const m = text.match(URL_RE);
  if (!m) return null;
  // Strip trailing sentence punctuation that isn't part of the URL.
  return m[1].replace(/[.,;:!?]+$/, '') || null;
}

function getDefBodyText(def: FootnoteDefinitionNode): string {
  // `toPlainText` accepts a Root; wrap the definition's children.
  const root: MdRoot = { type: 'root', children: def.children };
  return toPlainText(root).trim();
}

interface SlicedWord {
  lead: string;
  word: string;
  trail: string;
}

/**
 * Carve the last word out of a text-node value so it can be wrapped in a
 * link. Strips trailing whitespace and sentence punctuation; the caller
 * keeps `lead` (everything before the word) and `trail` (the stripped
 * tail) in the surrounding text. Returns null if there's no clean word
 * boundary (e.g. the text is pure whitespace/punctuation).
 */
function sliceLastWord(value: string): SlicedWord | null {
  let endIdx = value.length;
  while (endIdx > 0 && /[\s.,;:!?]/.test(value[endIdx - 1]!)) {
    endIdx--;
  }
  if (endIdx === 0) return null;

  let startIdx = endIdx;
  while (startIdx > 0 && !/\s/.test(value[startIdx - 1]!)) {
    startIdx--;
  }
  if (startIdx === endIdx) return null;

  return {
    lead: value.slice(0, startIdx),
    word: value.slice(startIdx, endIdx),
    trail: value.slice(endIdx),
  };
}

/**
 * Walk the tree and rewrite every `footnoteReference` per the four tiers:
 *
 *   1. URL-in-def + preceding plain-text word → wrap word in link, drop ref.
 *   2. URL-in-def + preceding non-text token  → clickable `[^id]` breadcrumb.
 *   3. No URL in def                          → inline body in parens.
 *   4. Orphan reference                       → plain `[^id]` text.
 *
 * Mutates `node.children` in place. Recurses into every container node so
 * footnotes nested inside lists, blockquotes, etc. are handled too.
 */
function inlineFootnoteRefs(
  node: MdRoot | MdContent,
  defs: Map<string, FootnoteDefinitionNode>,
): void {
  if (!('children' in node) || !Array.isArray(node.children)) return;

  const newChildren: MdContent[] = [];
  for (const child of node.children as MdContent[]) {
    if (isFootnoteReferenceNode(child)) {
      const id = child.identifier;
      const def = defs.get(id);
      const bodyText = def ? getDefBodyText(def) : '';
      const url = bodyText ? extractFirstUrl(bodyText) : null;

      const prevIdx = newChildren.length - 1;
      const prev = prevIdx >= 0 ? newChildren[prevIdx] : undefined;

      // Tier 1: word-attach.
      if (url && prev && isTextNode(prev)) {
        const sliced = sliceLastWord(prev.value);
        if (sliced) {
          newChildren[prevIdx] = mdText(sliced.lead) as MdContent;
          newChildren.push(mdLink(url, [mdText(sliced.word)]) as MdContent);
          if (sliced.trail) newChildren.push(mdText(sliced.trail) as MdContent);
          continue;
        }
      }

      // Tier 2: clickable breadcrumb.
      if (url) {
        newChildren.push(mdLink(url, [mdText(`[^${id}]`)]) as MdContent);
        continue;
      }

      // Tier 3: inline body (no URL but def exists).
      if (def && bodyText) {
        newChildren.push(mdText(`[^${id}] (${bodyText})`) as MdContent);
        continue;
      }

      // Tier 4: orphan reference.
      newChildren.push(mdText(`[^${id}]`) as MdContent);
      continue;
    }

    newChildren.push(child);
    inlineFootnoteRefs(child, defs);
  }

  (node as { children: MdContent[] }).children = newChildren;
}

/* ----------------------------------------------------------------------- */
/*                              Table pre-pass                              */
/* ----------------------------------------------------------------------- */

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
  // __bold__ vs **bold** and *X* vs _X_ source-delimiter peeks in
  // `applyTelegramDialect`.
  const dialected = applyTelegramDialect(structuredClone(ast), markdown);
  const collapsed = collapseTables(dialected);
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
