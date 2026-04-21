// Trimmed from upstream `src/auto-reply/chunk.ts`. Only `chunkText` is consumed
// by `ir.ts` here; the provider/config-aware helpers (`resolveChunkMode`,
// `chunkByParagraph`, markdown-fence-aware chunking) and their openclaw-specific
// dependency graph are intentionally omitted.

import { chunkTextByBreakResolver } from './text-chunking.js';

function resolveChunkEarlyReturn(text: string, limit: number): string[] | undefined {
  if (!text) {
    return [];
  }
  if (limit <= 0) {
    return [text];
  }
  if (text.length <= limit) {
    return [text];
  }
  return undefined;
}

export function chunkText(text: string, limit: number): string[] {
  const early = resolveChunkEarlyReturn(text, limit);
  if (early) {
    return early;
  }
  return chunkTextByBreakResolver(text, limit, (window) => {
    const { lastNewline, lastWhitespace } = scanParenAwareBreakpoints(window, 0, window.length);
    return lastNewline > 0 ? lastNewline : lastWhitespace;
  });
}

function scanParenAwareBreakpoints(
  text: string,
  start: number,
  end: number,
): { lastNewline: number; lastWhitespace: number } {
  let lastNewline = -1;
  let lastWhitespace = -1;
  let depth = 0;

  for (let i = start; i < end; i++) {
    const char = text[i];
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')' && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (char === '\n') {
      lastNewline = i;
    } else if (/\s/.test(char)) {
      lastWhitespace = i;
    }
  }

  return { lastNewline, lastWhitespace };
}
