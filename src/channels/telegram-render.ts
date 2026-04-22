/**
 * Markdown → Telegram HTML chunks.
 *
 * Strategy: segment-split + per-table mode.
 *
 * Openclaw's `markdownToTelegramHtml` takes a single `tableMode` for the
 * whole input — which means when a message mixes narrow + wide tables, any
 * single choice is wrong for the other. We sidestep that by splitting the
 * source at each pipe-table boundary:
 *
 *   - Prose between tables → renders through openclaw with `tableMode: 'off'`.
 *   - Each individual table → renders through openclaw with its own decision:
 *     `'code'` (ASCII grid in `<pre><code>`) if the rendered width ≤ 48,
 *     `'bullets'` (openclaw's native row-labelled nested bullets) if wider.
 *
 * Then we concat the HTML fragments and hand the combined string to
 * `splitTelegramHtmlChunks` for chunk-safe splitting (tags never split).
 *
 * Upstream rejected a width-based heuristic as "too fragile" (openclaw#1495);
 * users in openclaw#36323 have kept asking for it. Our 48-char threshold is
 * empirically measured against a real mobile client.
 */
import { parseFenceSpans } from '../vendor/openclaw-markdown/fences.js';
import { markdownToTelegramHtml, splitTelegramHtmlChunks } from '../vendor/openclaw-markdown/format.js';

/**
 * Max rendered-table width before we flatten to bullets. Derived from the
 * Telegram-iOS layout formula: `bubble = screenWidth - 36pt`; code block uses
 * `fixedFont` (~SF Mono 15pt ≈ 9pt/char) with ~20pt internal padding, so
 * per-line capacity on an iPhone 14 (390pt) is roughly
 * `(390 - 36 - 20) / 9 ≈ 37` chars.
 *
 * 38 is one char above that floor — middle-ground coverage for iPhone 14+
 * class devices. Plus/Pro Max (screen ≥ 428pt) fit ~41+ chars comfortably;
 * iPhone SE (375pt) capacity is ~35 so it may wrap at this limit. If iPhone
 * 14 users report wrap, drop to 37.
 */
const TABLE_WIDTH_LIMIT = 38;

const TABLE_SEPARATOR_PATTERN = /^\s*\|?\s*:?-{2,}:?(\s*\|\s*:?-{2,}:?)+\s*\|?\s*$/;

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * ASCII-rendered width of `cell | cell | cell` after our (patched) openclaw
 * `renderTableAsCode` pads each column and joins with ` | ` (no outer pipes).
 * Formula: sum(colWidths) + 3*(cols-1).
 */
function computeRenderedTableWidth(headers: string[], rows: string[][]): number {
  const colCount = Math.max(headers.length, ...rows.map((r) => r.length));
  if (colCount === 0) return 0;
  let total = 0;
  for (let c = 0; c < colCount; c++) {
    let maxWidth = (headers[c] ?? '').length;
    for (const row of rows) {
      const w = (row[c] ?? '').length;
      if (w > maxWidth) maxWidth = w;
    }
    total += maxWidth;
  }
  return total + 3 * (colCount - 1);
}

type TableRegion = {
  /** char offset in source markdown, inclusive */
  start: number;
  /** char offset in source markdown, exclusive */
  end: number;
  width: number;
};

/**
 * Scan markdown line-by-line; for each GFM pipe-table, record its char range
 * and computed width. Tables inside fenced code blocks are ignored.
 */
function findTableRegions(markdown: string): TableRegion[] {
  const fences = parseFenceSpans(markdown);
  const isInFence = (offset: number) => fences.some((f) => offset >= f.start && offset < f.end);

  const regions: TableRegion[] = [];
  const lines = markdown.split('\n');
  let cursor = 0;
  let i = 0;

  while (i < lines.length) {
    const lineStart = cursor;
    const line = lines[i];
    const lineLen = line.length;
    const afterLine = cursor + lineLen + 1; // +1 for \n (approximate for last line)

    if (isInFence(lineStart)) {
      cursor = afterLine;
      i++;
      continue;
    }

    const next = lines[i + 1];
    const isTableStart = line.includes('|') && next !== undefined && TABLE_SEPARATOR_PATTERN.test(next);

    if (!isTableStart) {
      cursor = afterLine;
      i++;
      continue;
    }

    const headers = parseTableRow(line);
    let j = i + 2;
    // Advance cursor past header and separator lines
    let tableEndCursor = afterLine + lines[i + 1].length + 1;
    const rows: string[][] = [];
    while (j < lines.length && lines[j].includes('|') && !isInFence(tableEndCursor)) {
      rows.push(parseTableRow(lines[j]));
      tableEndCursor += lines[j].length + 1;
      j++;
    }

    regions.push({
      start: lineStart,
      // trim the final \n off so we stop right at end of last table line
      end: Math.min(tableEndCursor - 1, markdown.length),
      width: computeRenderedTableWidth(headers, rows),
    });
    cursor = tableEndCursor;
    i = j;
  }

  return regions;
}

/**
 * Render markdown to one or more HTML chunks, each ≤ `safeLimit` chars,
 * suitable for direct send with `parse_mode: 'HTML'`. Inline tags never
 * split across chunks.
 */
export function renderTelegramHtmlChunks(markdown: string, safeLimit: number): string[] {
  if (!markdown) return [];

  const tables = findTableRegions(markdown);
  if (tables.length === 0) {
    // No tables — single render, chunk via HTML-aware splitter.
    const html = markdownToTelegramHtml(markdown, { tableMode: 'off' });
    return splitTelegramHtmlChunks(html, safeLimit);
  }

  // Compose: prose[0] + table[0] + prose[1] + table[1] + ... + prose[n]
  const parts: string[] = [];
  let cursor = 0;
  for (const t of tables) {
    const prose = markdown.slice(cursor, t.start);
    if (prose.trim()) {
      parts.push(markdownToTelegramHtml(prose, { tableMode: 'off' }));
    }
    const tableSource = markdown.slice(t.start, t.end);
    const mode = t.width <= TABLE_WIDTH_LIMIT ? 'code' : 'bullets';
    parts.push(markdownToTelegramHtml(tableSource, { tableMode: mode }));
    cursor = t.end;
  }
  const tail = markdown.slice(cursor);
  if (tail.trim()) {
    parts.push(markdownToTelegramHtml(tail, { tableMode: 'off' }));
  }

  // Glue fragments with a blank line so consecutive segments read as
  // separate paragraphs. `\n\n` matches openclaw's own paragraph-separator
  // convention; each segment already trims its trailing whitespace in
  // `markdownToIRWithMeta`, so this never stacks to triple newlines.
  const html = expandLongBlockquotes(parts.join('\n\n'));
  return splitTelegramHtmlChunks(html, safeLimit);
}

/**
 * Telegram's `<blockquote expandable>` renders with a tap-to-expand toggle,
 * saving vertical scroll on long quotes. Applied post-render so the decision
 * stays outside the vendored renderer and is cheap to tune.
 *
 * Threshold is on text length with tags stripped — empirically, quotes under
 * ~300 chars feel natural displayed fully; longer ones crowd the screen.
 */
const BLOCKQUOTE_EXPAND_THRESHOLD = 300;
function expandLongBlockquotes(html: string): string {
  return html.replace(/<blockquote>([\s\S]*?)<\/blockquote>/g, (match, inner: string) => {
    const textLength = inner.replace(/<[^>]+>/g, '').length;
    return textLength > BLOCKQUOTE_EXPAND_THRESHOLD ? `<blockquote expandable>${inner}</blockquote>` : match;
  });
}
