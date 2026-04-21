/**
 * Markdown → Telegram HTML chunks.
 *
 * Wraps the vendored openclaw pipeline with a local pre-processor that makes
 * a per-table decision: flatten wide pipe-tables in place (to nested bullets),
 * leave narrow ones as GFM so openclaw renders them as `<pre><code>` grids.
 *
 * Openclaw itself takes a single `tableMode` for the whole message — so when
 * a message mixes narrow + wide tables, picking one mode is wrong for the
 * other. Pre-flattening per table sidesteps that: after this pass the only
 * remaining pipe-tables are narrow ones, and openclaw's `tableMode: 'code'`
 * does the right thing for them.
 *
 * Upstream rejected a width-based heuristic as "too fragile" (openclaw#1495);
 * users in openclaw#36323 have kept asking for it. Our 48-char threshold is
 * empirically measured against a real mobile client, not picked from a hat.
 */
import { parseFenceSpans } from '../vendor/openclaw-markdown/fences.js';
import { markdownToTelegramChunks } from '../vendor/openclaw-markdown/format.js';

/** Empirical mobile-client break point — measured against the user's phone. */
const TABLE_WIDTH_LIMIT = 48;

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
 * ASCII-rendered width of `| cell | cell | cell |` after openclaw's
 * `renderTableAsCode` pads each column to its widest cell.
 * Formula: sum(colWidths) + 3*(cols-1) + 4 (leading "| " + trailing " |" + " | " between cells).
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
  return total + 3 * (colCount - 1) + 4;
}

/**
 * Rewrite a wide table as nested bullets in source markdown form. Mirrors
 * openclaw's `renderTableAsBullets` output but emitted as raw markdown
 * (`**label**` + `- key: value`) so the downstream parse treats it as a
 * normal bullet list.
 */
function renderTableAsBulletsMarkdown(headers: string[], rows: string[][]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    const primary = (row[0] ?? '').trim();
    if (primary) out.push(`**${primary}**`);
    for (let k = 1; k < row.length; k++) {
      const label = (headers[k] ?? '').trim();
      const value = (row[k] ?? '').trim();
      if (!label && !value) continue;
      if (label && value) out.push(`- ${label}: ${value}`);
      else out.push(`- ${label || value}`);
    }
    out.push('');
  }
  return out;
}

/**
 * Walk the markdown line-by-line, flattening only wide pipe-tables. Fenced
 * code blocks are skipped entirely via `parseFenceSpans` so tables inside
 * ```fences``` stay verbatim.
 */
function flattenWideTablesInPlace(markdown: string): string {
  const fences = parseFenceSpans(markdown);
  const fenceBreaks = new Set<number>();
  for (const span of fences) {
    // Mark every line-start index inside a fence as untouchable.
    for (let i = span.start; i < span.end; i++) fenceBreaks.add(i);
  }

  const lines = markdown.split('\n');
  const out: string[] = [];
  let charCursor = 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const lineStart = charCursor;

    if (fenceBreaks.has(lineStart)) {
      out.push(line);
      charCursor += line.length + 1;
      i++;
      continue;
    }

    const next = lines[i + 1];
    const isTableStart = line.includes('|') && next !== undefined && TABLE_SEPARATOR_PATTERN.test(next);

    if (!isTableStart) {
      out.push(line);
      charCursor += line.length + 1;
      i++;
      continue;
    }

    // Collect the table: header (i), separator (i+1), then consecutive
    // pipe-lines outside fences until a non-pipe line.
    const headers = parseTableRow(line);
    let j = i + 2;
    let cursor = charCursor + line.length + 1 + (lines[i + 1]?.length ?? 0) + 1;
    const rows: string[][] = [];
    while (j < lines.length && lines[j].includes('|') && !fenceBreaks.has(cursor)) {
      rows.push(parseTableRow(lines[j]));
      cursor += lines[j].length + 1;
      j++;
    }

    const width = computeRenderedTableWidth(headers, rows);

    if (width <= TABLE_WIDTH_LIMIT) {
      // Narrow: pass through unchanged; openclaw renders as <pre><code>.
      for (let k = i; k < j; k++) out.push(lines[k]);
    } else {
      // Wide: rewrite as bullets; openclaw renders as a normal bullet list.
      out.push(...renderTableAsBulletsMarkdown(headers, rows));
    }

    charCursor = cursor;
    i = j;
  }

  return out.join('\n');
}

/**
 * Render markdown to one or more HTML chunks, each ≤ `safeLimit` chars,
 * suitable for direct send with `parse_mode: 'HTML'`. Inline tags never
 * split across chunks.
 */
export function renderTelegramHtmlChunks(markdown: string, safeLimit: number): string[] {
  if (!markdown) return [];
  const preFlattened = flattenWideTablesInPlace(markdown);
  return markdownToTelegramChunks(preFlattened, safeLimit, { tableMode: 'code' }).map((c) => c.html);
}
