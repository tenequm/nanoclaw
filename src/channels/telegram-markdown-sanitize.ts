/**
 * Sanitize outbound text for Telegram's legacy `Markdown` parse mode.
 *
 * WORKAROUND: The @chat-adapter/telegram adapter hardcodes parse_mode=Markdown
 * (legacy) but its converter emits CommonMark. Messages with `**bold**`, odd
 * delimiter counts, or malformed links are rejected by Telegram and dropped
 * after retries. Remove this once upstream ships real mode-aware conversion
 * (vercel/chat PR #367 adds the knob; a follow-up is needed for the converter).
 *
 * Also flattens GFM pipe-tables into nested bullet lists. Telegram has no
 * native table support in any parse_mode, and the SDK's default of wrapping
 * tables as `tableToAscii` inside a code fence produces an ASCII grid that
 * line-wraps catastrophically on narrow mobile viewports. See vercel/chat
 * `packages/adapter-telegram/src/markdown.ts` — the `isTableNode → code`
 * rewrite is preserved even in the MarkdownV2 refactor (PR #407).
 */

const CODE_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;
const PLACEHOLDER_PREFIX = '\x00CODE';
const PLACEHOLDER_SUFFIX = '\x00';

const TABLE_SEPARATOR_PATTERN = /^\s*\|?\s*:?-{2,}:?(\s*\|\s*:?-{2,}:?)+\s*\|?\s*$/;
const FENCE_PATTERN = /^\s*```/;

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function flattenMarkdownTables(input: string): string {
  const lines = input.split('\n');
  const out: string[] = [];
  let inFence = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (FENCE_PATTERN.test(line)) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }
    if (inFence) {
      out.push(line);
      i++;
      continue;
    }

    const next = lines[i + 1];
    const isTableStart = line.includes('|') && next !== undefined && TABLE_SEPARATOR_PATTERN.test(next);

    if (!isTableStart) {
      out.push(line);
      i++;
      continue;
    }

    const headers = parseTableRow(line);
    let j = i + 2;
    const rows: string[][] = [];
    while (j < lines.length && lines[j].includes('|') && !FENCE_PATTERN.test(lines[j])) {
      rows.push(parseTableRow(lines[j]));
      j++;
    }

    for (const row of rows) {
      const primary = (row[0] ?? '').trim();
      if (primary) {
        out.push(`- **${primary}**`);
      }
      for (let k = 1; k < row.length; k++) {
        const label = (headers[k] ?? '').trim();
        const value = (row[k] ?? '').trim();
        if (!label && !value) continue;
        if (label && value) {
          out.push(`  - ${label}: ${value}`);
        } else {
          out.push(`  - ${label || value}`);
        }
      }
    }
    out.push('');
    i = j;
  }

  return out.join('\n');
}

export function sanitizeTelegramLegacyMarkdown(input: string): string {
  if (!input) return input;

  let text = flattenMarkdownTables(input);

  const codeSegments: string[] = [];
  text = text.replace(CODE_PATTERN, (m) => {
    codeSegments.push(m);
    return `${PLACEHOLDER_PREFIX}${codeSegments.length - 1}${PLACEHOLDER_SUFFIX}`;
  });

  // Strip CommonMark thematic breaks (---, ***, ___ on their own line, 3+
  // repeats, with optional spaces). The adapter's markdown re-stringifier
  // canonicalizes `---` to `***` before sending, which Telegram's legacy
  // parser treats as an unclosed bold marker.
  text = text.replace(/^[ \t]*(?:-[ \t]*){3,}[ \t]*$/gm, '');
  text = text.replace(/^[ \t]*(?:\*[ \t]*){3,}[ \t]*$/gm, '');
  text = text.replace(/^[ \t]*(?:_[ \t]*){3,}[ \t]*$/gm, '');

  // The adapter re-parses and re-stringifies markdown before sending, which
  // rewrites `- item` list bullets into `* item` — injecting unbalanced
  // asterisks that Telegram's legacy Markdown parser then rejects. Replace
  // list bullets with a plain Unicode bullet so the adapter treats the line
  // as prose.
  text = text.replace(/^(\s*)[-+]\s+/gm, '$1• ');

  text = text.replace(/\*\*([^*\n]+?)\*\*/g, '*$1*');
  text = text.replace(/__([^_\n]+?)__/g, '_$1_');

  const starCount = (text.match(/\*/g) ?? []).length;
  const underCount = (text.match(/_/g) ?? []).length;
  if (starCount % 2 !== 0 || underCount % 2 !== 0) {
    text = text.replace(/[*_]/g, '');
  }

  const openBrackets = (text.match(/\[/g) ?? []).length;
  const closeBrackets = (text.match(/\]/g) ?? []).length;
  if (openBrackets !== closeBrackets) {
    text = text.replace(/[[\]]/g, '');
  }

  return text.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, 'g'),
    (_, i) => codeSegments[Number(i)],
  );
}
