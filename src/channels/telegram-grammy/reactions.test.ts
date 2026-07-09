/**
 * Coverage for `canonicalizeReactionEmoji` (slug→glyph) — the
 * canonicalizer stops REACTION_INVALID errors at the wire.
 */
import { describe, expect, it } from 'vitest';

import { canonicalizeReactionEmoji } from './reactions.js';

describe('canonicalizeReactionEmoji', () => {
  it('translates documented slugs to glyphs', () => {
    expect(canonicalizeReactionEmoji('thumbs_up')).toBe('👍');
    expect(canonicalizeReactionEmoji('thumbs_down')).toBe('👎');
    expect(canonicalizeReactionEmoji('heart')).toBe('❤');
    expect(canonicalizeReactionEmoji('fire')).toBe('🔥');
    expect(canonicalizeReactionEmoji('party')).toBe('🎉');
    expect(canonicalizeReactionEmoji('eyes')).toBe('👀');
    expect(canonicalizeReactionEmoji('ok_hand')).toBe('👌');
  });

  it('accepts common LLM-output aliases', () => {
    expect(canonicalizeReactionEmoji('+1')).toBe('👍');
    expect(canonicalizeReactionEmoji('-1')).toBe('👎');
    expect(canonicalizeReactionEmoji('like')).toBe('👍');
    expect(canonicalizeReactionEmoji('tada')).toBe('🎉');
    expect(canonicalizeReactionEmoji('joy')).toBe('🤣');
    expect(canonicalizeReactionEmoji('100')).toBe('💯');
  });

  it('is case-insensitive on slug lookup', () => {
    expect(canonicalizeReactionEmoji('Thumbs_Up')).toBe('👍');
    expect(canonicalizeReactionEmoji('FIRE')).toBe('🔥');
  });

  it('passes through canonical glyphs unchanged', () => {
    expect(canonicalizeReactionEmoji('👍')).toBe('👍');
    expect(canonicalizeReactionEmoji('❤')).toBe('❤');
    expect(canonicalizeReactionEmoji('🤷‍♀')).toBe('🤷‍♀');
  });

  it('strips VS-16 (U+FE0F) and matches the canonical bare codepoint', () => {
    // Agents commonly emit `❤️` (with VS-16) where Telegram wants `❤`.
    expect(canonicalizeReactionEmoji('❤️')).toBe('❤');
    expect(canonicalizeReactionEmoji('🕊️')).toBe('🕊');
    expect(canonicalizeReactionEmoji('✍️')).toBe('✍');
  });

  it('trims surrounding whitespace', () => {
    expect(canonicalizeReactionEmoji('  thumbs_up  ')).toBe('👍');
    expect(canonicalizeReactionEmoji('\t👍\n')).toBe('👍');
  });

  it('returns null for emojis Telegram does not allow', () => {
    expect(canonicalizeReactionEmoji('✅')).toBeNull();
    expect(canonicalizeReactionEmoji('🚀')).toBeNull();
    expect(canonicalizeReactionEmoji('🍕')).toBeNull();
  });

  it('returns null for unknown slugs', () => {
    expect(canonicalizeReactionEmoji('rocket_ship')).toBeNull();
    expect(canonicalizeReactionEmoji('check')).toBeNull();
    expect(canonicalizeReactionEmoji('approved')).toBeNull();
  });

  it('returns null for empty / whitespace input', () => {
    expect(canonicalizeReactionEmoji('')).toBeNull();
    expect(canonicalizeReactionEmoji('   ')).toBeNull();
    expect(canonicalizeReactionEmoji('\n')).toBeNull();
  });
});
