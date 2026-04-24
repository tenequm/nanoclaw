/**
 * Smoke coverage for the mdast → FormattedString walker.
 *
 * The whole adapter's reliability story rests on this file: entities
 * produced here are what we send via Telegram's `entities[]` parameter
 * (no server-side parser → no parse-error 400s). These tests verify that
 * the walker produces the expected entities for every node type we
 * render, that table → code ASCII pre-pass fires, and that chunked output
 * preserves entity offsets across slice boundaries.
 */
import { describe, expect, it } from 'vitest';

import { renderFS, splitForBody, TELEGRAM_TEXT_LIMIT } from './formatter.js';

describe('renderFS', () => {
  it('emits bold/italic/code/link entities', () => {
    const fs = renderFS('**bold** _italic_ `code` [link](https://example.com)');
    const types = fs.entities.map((e) => e.type).sort();
    expect(types).toContain('bold');
    expect(types).toContain('italic');
    expect(types).toContain('code');
    expect(types).toContain('text_link');
  });

  it('emits pre for fenced code blocks with language', () => {
    const fs = renderFS('```ts\nconst x = 1\n```');
    const pre = fs.entities.find((e) => e.type === 'pre');
    expect(pre).toBeDefined();
    expect((pre as { language?: string }).language).toBe('ts');
  });

  it('emits blockquote for > prefix', () => {
    const fs = renderFS('> quoted\n> continued');
    expect(fs.entities.some((e) => e.type === 'blockquote')).toBe(true);
  });

  it('collapses tables to ASCII code blocks', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |';
    const fs = renderFS(md);
    // Table becomes a `pre` code block whose text contains the original
    // cell values and a row separator. Exact formatting is owned by
    // `chat.tableToAscii` — we only assert the structural contract.
    expect(fs.entities.some((e) => e.type === 'pre')).toBe(true);
    expect(fs.text).toContain('a');
    expect(fs.text).toContain('b');
    expect(fs.text).toContain('1');
    expect(fs.text).toContain('2');
  });

  it('renders a heading as bold (Telegram has no heading support)', () => {
    const fs = renderFS('# Title\n\nbody');
    const bold = fs.entities.find((e) => e.type === 'bold');
    expect(bold).toBeDefined();
    expect(
      fs.text.slice(
        (bold as { offset: number }).offset,
        (bold as { offset: number; length: number }).offset + (bold as { length: number }).length,
      ),
    ).toBe('Title');
  });

  it('renders unordered list with bullets', () => {
    const fs = renderFS('- one\n- two');
    expect(fs.text).toContain('• one');
    expect(fs.text).toContain('• two');
  });

  it('renders ordered list with numeric prefix starting at `start`', () => {
    const fs = renderFS('1. one\n2. two');
    expect(fs.text).toContain('1. one');
    expect(fs.text).toContain('2. two');
  });

  it('emits underline for __X__ (distinct from **bold**)', () => {
    const fs = renderFS('__under__');
    expect(fs.text).toBe('under');
    expect(fs.entities.some((e) => e.type === 'underline')).toBe(true);
    expect(fs.entities.some((e) => e.type === 'bold')).toBe(false);
  });

  it('emits spoiler for ||X||', () => {
    const fs = renderFS('||hidden||');
    expect(fs.text).toBe('hidden');
    expect(fs.entities.some((e) => e.type === 'spoiler')).toBe(true);
  });

  it('leaves __X__ inside inline code as plain code text', () => {
    const fs = renderFS('`__not under__`');
    expect(fs.text).toBe('__not under__');
    expect(fs.entities.some((e) => e.type === 'code')).toBe(true);
    expect(fs.entities.some((e) => e.type === 'underline')).toBe(false);
  });

  it('leaves __X__ inside fenced code as plain pre text', () => {
    const fs = renderFS('```py\n__main__\n```');
    expect(fs.text).toBe('__main__');
    expect(fs.entities.some((e) => e.type === 'pre')).toBe(true);
    expect(fs.entities.some((e) => e.type === 'underline')).toBe(false);
  });
});

describe('splitForBody', () => {
  it('returns a single chunk for short input', () => {
    const fs = renderFS('short message');
    const chunks = splitForBody(fs);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('short message');
  });

  it('respects the Telegram 4096 limit', () => {
    const big = 'word '.repeat(1000); // 5000 chars
    const fs = renderFS(big);
    const chunks = splitForBody(fs);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    }
  });

  it('preserves entities across chunk boundaries', () => {
    // Build a message where a bold span straddles the split.
    const segment = '**bold chunk** and plain text. ';
    const fs = renderFS(segment.repeat(300)); // ~9000 chars → multiple chunks
    const chunks = splitForBody(fs);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk should keep well-formed entities: no negative offsets,
    // no spans extending beyond chunk text.
    for (const chunk of chunks) {
      for (const entity of chunk.entities) {
        expect(entity.offset).toBeGreaterThanOrEqual(0);
        expect(entity.offset + entity.length).toBeLessThanOrEqual(chunk.text.length);
      }
    }
  });
});
