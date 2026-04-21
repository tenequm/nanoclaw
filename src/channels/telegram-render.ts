/**
 * Markdown → Telegram HTML chunks.
 *
 * Thin wrapper over the vendored openclaw pipeline. One decision: pick
 * `tableMode: 'code'` (ASCII grid in <pre><code>) when the widest GFM table in
 * the message would render ≤ TABLE_WIDTH_LIMIT chars; otherwise `'bullets'`
 * (row-labelled nested bullets). Openclaw itself defaults to `'code'` always;
 * this gate is local (see plan virtual-sprouting-wind.md and their issue
 * openclaw/openclaw#36323, where the author rejected the heuristic as "too
 * fragile" but users have continued asking for it).
 */
import { markdownToIRWithMeta } from '../vendor/openclaw-markdown/ir.js';
import { markdownToTelegramChunks } from '../vendor/openclaw-markdown/format.js';

/** Empirical mobile-client break point — measured against the user's phone. */
const TABLE_WIDTH_LIMIT = 48;

/**
 * Compute the wire-rendered width (per `renderTableAsCode` in vendored ir.ts):
 * `| cell | cell | cell |` = sum(colWidths) + 3*(cols-1) + 4.
 */
function computeRenderedTableWidth(table: { headers: string[]; rows: string[][] }): number {
  const colCount = Math.max(table.headers.length, ...table.rows.map((r) => r.length));
  if (colCount === 0) return 0;
  let total = 0;
  for (let c = 0; c < colCount; c++) {
    let maxWidth = (table.headers[c] ?? '').length;
    for (const row of table.rows) {
      const w = (row[c] ?? '').length;
      if (w > maxWidth) maxWidth = w;
    }
    total += maxWidth;
  }
  return total + 3 * (colCount - 1) + 4;
}

function pickTableMode(markdown: string): 'code' | 'bullets' {
  // Parse in 'block' mode — that's the only mode that populates
  // `collectedTables` with usable header/row data for width measurement
  // without actually rendering. Render mode is decided after.
  const { tables } = markdownToIRWithMeta(markdown, { tableMode: 'block' });
  for (const t of tables) {
    if (computeRenderedTableWidth(t) > TABLE_WIDTH_LIMIT) return 'bullets';
  }
  return 'code';
}

/**
 * Render markdown to one or more HTML chunks, each ≤ `safeLimit` chars,
 * suitable for direct send with `parse_mode: 'HTML'`. Inline tags
 * (`<b>`, `<i>`, `<a>`, `<code>`) never split across chunks.
 */
export function renderTelegramHtmlChunks(markdown: string, safeLimit: number): string[] {
  if (!markdown) return [];
  const tableMode = pickTableMode(markdown);
  return markdownToTelegramChunks(markdown, safeLimit, { tableMode }).map((c) => c.html);
}
