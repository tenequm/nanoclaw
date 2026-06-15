/**
 * Coverage for the id-shape decoder used by outbound edit/reaction ops.
 *
 * The agent-runner's `getMessageIdBySeq` hands us three formats depending
 * on where the id came from (bare numeric for delivered outbound, 2-part
 * for legacy inbound, 3-part for inbound wrapped by `messageIdForAgent`),
 * and the adapter has to decode all of them without losing the chat id.
 */
import { describe, expect, it } from 'vitest';
import type { MessageEntity } from 'grammy/types';

import { entitiesToMarkdown, extractTelegramMessageId } from './inbound.js';

const e = (obj: unknown): MessageEntity[] => obj as MessageEntity[];

describe('extractTelegramMessageId', () => {
  it('accepts bare numeric id and uses fallback chatId', () => {
    expect(extractTelegramMessageId('1710', 95307956)).toEqual({ chatId: 95307956, messageId: 1710 });
  });

  it('accepts 2-part compound and prefers the embedded chatId', () => {
    expect(extractTelegramMessageId('95307956:1710', 99)).toEqual({ chatId: 95307956, messageId: 1710 });
  });

  it('accepts 3-part compound (agent-wrapped inbound id)', () => {
    expect(extractTelegramMessageId('95307956:1716:ag-1776438126500-du9io3', 99)).toEqual({
      chatId: 95307956,
      messageId: 1716,
    });
  });

  it('returns null for a UUID-style id that is not a number', () => {
    expect(extractTelegramMessageId('msg-abc-def', 99)).toBeNull();
  });
});

describe('entitiesToMarkdown', () => {
  it('returns text unchanged when no entities', () => {
    expect(entitiesToMarkdown('hello world', [])).toBe('hello world');
    expect(entitiesToMarkdown('hello world', undefined)).toBe('hello world');
  });

  it('wraps bold / italic / strikethrough / code with markdown delimiters', () => {
    const text = 'a b c d';
    const entities = [
      { type: 'bold', offset: 0, length: 1 },
      { type: 'italic', offset: 2, length: 1 },
      { type: 'strikethrough', offset: 4, length: 1 },
      { type: 'code', offset: 6, length: 1 },
    ];
    expect(entitiesToMarkdown(text, e(entities))).toBe('**a** _b_ ~~c~~ `d`');
  });

  it('emits `__X__` for underline and `||X||` for spoiler (matches the outbound renderer)', () => {
    const text = 'secret hidden';
    const entities = [
      { type: 'underline', offset: 0, length: 6 },
      { type: 'spoiler', offset: 7, length: 6 },
    ];
    expect(entitiesToMarkdown(text, e(entities))).toBe('__secret__ ||hidden||');
  });

  it('renders text_link as `[label](url)`', () => {
    const text = 'click here';
    const entities = [{ type: 'text_link', offset: 6, length: 4, url: 'https://example.com' }];
    expect(entitiesToMarkdown(text, e(entities))).toBe('click [here](https://example.com)');
  });

  it('renders pre with language tag when present', () => {
    const text = 'x = 1';
    const entities = [{ type: 'pre', offset: 0, length: 5, language: 'ts' }];
    expect(entitiesToMarkdown(text, e(entities))).toBe('```ts\nx = 1\n```');
  });

  it('skips unknown entity types and still preserves the text', () => {
    const text = '@alice hey';
    const entities = [{ type: 'mention', offset: 0, length: 6 }];
    expect(entitiesToMarkdown(text, e(entities))).toBe('@alice hey');
  });

  it('closes before opening at the same position so adjacent spans do not interleave', () => {
    const text = 'ab';
    const entities = [
      { type: 'bold', offset: 0, length: 1 },
      { type: 'italic', offset: 1, length: 1 },
    ];
    // Close `bold` at pos 1 before opening `italic` at pos 1.
    expect(entitiesToMarkdown(text, e(entities))).toBe('**a**_b_');
  });
});
