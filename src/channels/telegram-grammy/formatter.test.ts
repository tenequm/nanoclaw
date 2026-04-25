/**
 * Smoke coverage for the mdast → FormattedString walker.
 *
 * The whole adapter's reliability story rests on this file: entities
 * produced here are what we send via Telegram's `entities[]` parameter
 * (no server-side parser → no parse-error 400s). These tests verify that
 * the walker produces the expected entities for every node type we
 * render, that table → code ASCII pre-pass fires, that the Telegram
 * dialect deviations from CommonMark hold, and that chunked output
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

describe('Telegram dialect: *X* / _X_ split', () => {
  it('emits bold for *X* (deviation from CommonMark italic)', () => {
    const fs = renderFS('*Архітектура*');
    expect(fs.text).toBe('Архітектура');
    expect(fs.entities.some((e) => e.type === 'bold')).toBe(true);
    expect(fs.entities.some((e) => e.type === 'italic')).toBe(false);
  });

  it('emits italic for _X_', () => {
    const fs = renderFS('_X_');
    expect(fs.text).toBe('X');
    expect(fs.entities.some((e) => e.type === 'italic')).toBe(true);
    expect(fs.entities.some((e) => e.type === 'bold')).toBe(false);
  });

  it('emits bold for **X** (no change)', () => {
    const fs = renderFS('**X**');
    expect(fs.text).toBe('X');
    expect(fs.entities.some((e) => e.type === 'bold')).toBe(true);
  });

  it('renders nested *outer _inner_* as bold containing italic', () => {
    const fs = renderFS('*outer _inner_*');
    expect(fs.text).toBe('outer inner');
    expect(fs.entities.some((e) => e.type === 'bold')).toBe(true);
    expect(fs.entities.some((e) => e.type === 'italic')).toBe(true);
  });

  it('renders nested _outer *inner*_ as italic containing bold', () => {
    const fs = renderFS('_outer *inner*_');
    expect(fs.text).toBe('outer inner');
    expect(fs.entities.some((e) => e.type === 'italic')).toBe(true);
    expect(fs.entities.some((e) => e.type === 'bold')).toBe(true);
  });

  it('keeps bold + code overlap intact for *prose `code`*', () => {
    // Documents the spec-intentional behavior: bold/italic/underline can
    // overlap with code per Telegram entity nesting rules.
    const fs = renderFS('*через `sendMessageDraft`*');
    expect(fs.entities.some((e) => e.type === 'bold')).toBe(true);
    expect(fs.entities.some((e) => e.type === 'code')).toBe(true);
  });
});

describe('Surfaced node types (linkReference / imageReference / html)', () => {
  it('surfaces a reference-style link as visible label text', () => {
    const md = 'See [the docs][1] for details.\n\n[1]: https://example.com';
    const fs = renderFS(md);
    expect(fs.text).toContain('the docs');
  });

  it('surfaces an orphan reference (no definition) as label text', () => {
    const fs = renderFS('Click [missing][nope] please.');
    expect(fs.text).toContain('missing');
  });

  it('surfaces a reference-style image as alt text', () => {
    const md = '![alt text][img]\n\n[img]: https://example.com/x.png';
    const fs = renderFS(md);
    expect(fs.text).toContain('alt text');
  });

  it('surfaces raw HTML as literal text', () => {
    const fs = renderFS('a <b>literal</b> tag');
    expect(fs.text).toContain('<b>literal</b>');
  });
});

describe('User mention links (tg://user?id=N)', () => {
  // Telegram renders text_link with `tg://user?id=N` as a clickable user
  // mention. A real `text_mention` entity would also work but requires the
  // full User object (first_name, etc.) — we don't have it at render time.
  // grammy's `FormattedString.mentionUser(text, id)` is itself just
  // `a(\`tg://user?id=${id}\`)`, so the default link path is sufficient.
  it('preserves tg://user?id=N as a text_link entity', () => {
    const fs = renderFS('Hi [Misha](tg://user?id=12345)');
    const link = fs.entities.find((e) => e.type === 'text_link');
    expect(link).toBeDefined();
    expect((link as { url: string }).url).toBe('tg://user?id=12345');
    expect(fs.text).toContain('Misha');
  });

  it('emits regular text_link for normal URLs', () => {
    const fs = renderFS('See [docs](https://example.com)');
    const link = fs.entities.find((e) => e.type === 'text_link');
    expect(link).toBeDefined();
    expect((link as { url: string }).url).toBe('https://example.com');
  });
});

describe('Expandable blockquote ([!fold] marker)', () => {
  it('emits expandable_blockquote for > [!fold] first line', () => {
    const fs = renderFS('> [!fold]\n> long quoted body\n> continues');
    expect(fs.entities.some((e) => e.type === 'expandable_blockquote')).toBe(true);
    expect(fs.entities.some((e) => e.type === 'blockquote')).toBe(false);
    // Marker is stripped from the rendered text.
    expect(fs.text).not.toContain('[!fold]');
    expect(fs.text).toContain('long quoted body');
  });

  it('accepts [!expand] alias', () => {
    const fs = renderFS('> [!expand]\n> body');
    expect(fs.entities.some((e) => e.type === 'expandable_blockquote')).toBe(true);
    expect(fs.text).not.toContain('[!expand]');
  });

  it('accepts [!expandable] alias', () => {
    const fs = renderFS('> [!expandable]\n> body');
    expect(fs.entities.some((e) => e.type === 'expandable_blockquote')).toBe(true);
    expect(fs.text).not.toContain('[!expandable]');
  });

  it('plain blockquote without marker stays as blockquote', () => {
    const fs = renderFS('> just a quote\n> on two lines');
    expect(fs.entities.some((e) => e.type === 'blockquote')).toBe(true);
    expect(fs.entities.some((e) => e.type === 'expandable_blockquote')).toBe(false);
  });

  it('does not match [!note] or other GFM alert names', () => {
    const fs = renderFS('> [!note]\n> body');
    expect(fs.entities.some((e) => e.type === 'expandable_blockquote')).toBe(false);
    expect(fs.entities.some((e) => e.type === 'blockquote')).toBe(true);
  });
});

describe('Footnotes — word-attached citations', () => {
  it('Tier 1: wraps the cited word in a link when def has a URL', () => {
    const md = 'The new API supports streaming[^1].\n\n[^1]: https://docs.example.com/streaming';
    const fs = renderFS(md);
    // Cited word "streaming" should be wrapped in a text_link entity.
    const link = fs.entities.find((e) => e.type === 'text_link');
    expect(link).toBeDefined();
    expect((link as { url: string }).url).toBe('https://docs.example.com/streaming');
    const startOffset = (link as { offset: number }).offset;
    const length = (link as { length: number }).length;
    expect(fs.text.slice(startOffset, startOffset + length)).toBe('streaming');
    // No breadcrumb in the rendered text.
    expect(fs.text).not.toContain('[^1]');
  });

  it('Tier 1: handles repeated reference (same id, two cites, two links)', () => {
    const md =
      'The Bot API documents this pattern[^api] and the limits page reinforces it[^api].\n\n[^api]: https://core.telegram.org/bots/api#formatting-options';
    const fs = renderFS(md);
    const links = fs.entities.filter((e) => e.type === 'text_link');
    expect(links).toHaveLength(2);
    for (const l of links) {
      expect((l as { url: string }).url).toBe('https://core.telegram.org/bots/api#formatting-options');
    }
    expect(fs.text).not.toContain('[^api]');
  });

  it('Tier 1: drops surrounding prose, keeps URL anchored to the word', () => {
    const md =
      "Telegram's parse_mode has edge cases[^1].\n\n[^1]: See bug class at https://github.com/grammyjs/grammy/issues/123 — particularly nested entities.";
    const fs = renderFS(md);
    const link = fs.entities.find((e) => e.type === 'text_link');
    expect(link).toBeDefined();
    expect((link as { url: string }).url).toBe('https://github.com/grammyjs/grammy/issues/123');
    const startOffset = (link as { offset: number }).offset;
    const length = (link as { length: number }).length;
    expect(fs.text.slice(startOffset, startOffset + length)).toBe('cases');
    // Surrounding prose from the def body must NOT leak into rendered text.
    expect(fs.text).not.toContain('See bug class');
  });

  it('Tier 3: inline body in parens when def has no URL', () => {
    const md =
      'The MarkdownV2 parser has subtle escaping rules[^note].\n\n[^note]: This only applies to messages sent via parse_mode; entity-based messages bypass it entirely.';
    const fs = renderFS(md);
    expect(fs.text).toContain('[^note]');
    expect(fs.text).toContain('(This only applies to messages sent via parse_mode');
    // No link entity — there was no URL to anchor.
    expect(fs.entities.some((e) => e.type === 'text_link')).toBe(false);
  });

  it('Tier 4: orphan reference renders as plain [^id] breadcrumb', () => {
    const fs = renderFS('Some claim[^missing] here.');
    expect(fs.text).toContain('[^missing]');
    expect(fs.entities.some((e) => e.type === 'text_link')).toBe(false);
  });

  it('drops the footnoteDefinition body from rendered output', () => {
    const md = 'Cited[^1].\n\n[^1]: https://example.com';
    const fs = renderFS(md);
    // Definition body should not appear separately in the rendered text.
    expect(fs.text.match(/example\.com/g) ?? []).toHaveLength(0);
  });

  it('handles trailing punctuation between word and reference', () => {
    // Agent writes "pattern,[^1]" — comma BEFORE the ref. Slicer must
    // strip the comma off the word and keep it in the surrounding text.
    const md = 'The pattern,[^1] which appears often, is documented.\n\n[^1]: https://example.com';
    const fs = renderFS(md);
    const link = fs.entities.find((e) => e.type === 'text_link');
    expect(link).toBeDefined();
    const offset = (link as { offset: number }).offset;
    const length = (link as { length: number }).length;
    expect(fs.text.slice(offset, offset + length)).toBe('pattern');
    expect(fs.text).toContain('pattern,');
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
