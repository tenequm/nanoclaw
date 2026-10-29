/**
 * The raw-text recovery hook.
 *
 * The bridge drops `message.raw` before persisting, so content a platform
 * adapter did not project into `Message.toJSON()` is gone at that point with
 * no way to get it back. `extractRawText` is the one chance to rescue it.
 *
 * The property that matters most here is the absent case: a bridge with no
 * extractor, or an extractor that finds nothing, must leave the serialized
 * body byte-identical. Every channel that does not opt in goes through this
 * code path on every inbound message.
 */
import { describe, expect, it } from 'vitest';

import { appendRawText, applyTextRewrite } from './chat-sdk-bridge.js';

describe('appendRawText', () => {
  it('leaves the body untouched when no extractor is configured', () => {
    const serialized: Record<string, unknown> = { text: 'hello' };
    appendRawText(serialized, { anything: true }, undefined);
    expect(serialized).toEqual({ text: 'hello' });
  });

  it('leaves the body untouched when the extractor finds nothing', () => {
    const serialized: Record<string, unknown> = { text: 'hello' };
    appendRawText(serialized, { anything: true }, () => null);
    expect(serialized).toEqual({ text: 'hello' });
  });

  it('leaves the body untouched when the extractor returns an empty string', () => {
    const serialized: Record<string, unknown> = { text: 'hello' };
    appendRawText(serialized, {}, () => '');
    expect(serialized).toEqual({ text: 'hello' });
  });

  it('appends recovered text after the existing body, blank line between', () => {
    const serialized: Record<string, unknown> = { text: 'see the table' };
    appendRawText(serialized, {}, () => 'a | b\n1 | 2');
    expect(serialized.text).toBe('see the table\n\na | b\n1 | 2');
  });

  it('uses the recovered text alone when the message had no body', () => {
    const serialized: Record<string, unknown> = {};
    appendRawText(serialized, {}, () => 'a | b');
    expect(serialized.text).toBe('a | b');

    const empty: Record<string, unknown> = { text: '' };
    appendRawText(empty, {}, () => 'a | b');
    expect(empty.text).toBe('a | b');
  });

  it('ignores a non-string body rather than concatenating onto it', () => {
    const serialized: Record<string, unknown> = { text: 42 };
    appendRawText(serialized, {}, () => 'recovered');
    expect(serialized.text).toBe('recovered');
  });

  it('hands the extractor the raw payload it was given', () => {
    const seen: unknown[] = [];
    appendRawText({ text: 'x' }, { blocks: [{ type: 'table' }] }, (raw) => {
      seen.push(raw);
      return null;
    });
    expect(seen).toEqual([{ blocks: [{ type: 'table' }] }]);
  });
});

describe('applyTextRewrite', () => {
  const upper = (t: string): string => t.toUpperCase();

  it('rewrites text and every text node of formatted, leaving other nodes alone', () => {
    const formatted = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'hi ' },
            { type: 'strong', children: [{ type: 'text', value: 'there' }] },
            { type: 'inlineCode', value: 'code' },
          ],
        },
      ],
    };
    const serialized: Record<string, unknown> = { text: 'hi there', formatted };

    applyTextRewrite(serialized, () => upper);

    expect(serialized.text).toBe('HI THERE');
    expect(serialized.formatted).toEqual({
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'HI ' },
            { type: 'strong', children: [{ type: 'text', value: 'THERE' }] },
            { type: 'inlineCode', value: 'code' },
          ],
        },
      ],
    });
  });

  it('leaves the AST it was given untouched (toJSON shares it with the live message)', () => {
    const formatted = { type: 'root', children: [{ type: 'text', value: 'hi' }] };
    const serialized: Record<string, unknown> = { text: 'hi', formatted };

    applyTextRewrite(serialized, () => upper);

    expect(formatted.children[0]!.value).toBe('hi');
  });

  it('tolerates a body with no text or formatted', () => {
    const serialized: Record<string, unknown> = {};
    applyTextRewrite(serialized, () => upper);
    expect(serialized).toEqual({});
  });
});
