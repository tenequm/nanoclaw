/**
 * Coverage for `canonicalizeReactionEmoji` (slug→glyph) — the
 * canonicalizer stops REACTION_INVALID errors at the wire — and for
 * `resolveReactionEmoji`, which adds the nearest-allowed fallback layer so a
 * reaction Telegram will not accept is substituted (and reported) instead of
 * silently dropped.
 */
import fs from 'fs';
import path from 'path';

import type { ReactionTypeEmoji } from 'grammy/types';
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_REACTION_GLYPHS,
  canonicalizeReactionEmoji,
  resolveReactionEmoji,
  type TelegramReactionEmoji,
} from './reactions.js';

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

describe('resolveReactionEmoji', () => {
  it('reports an exact match as not substituted', () => {
    expect(resolveReactionEmoji('thumbs_up')).toEqual({ glyph: '👍', substituted: false });
    expect(resolveReactionEmoji('👀')).toEqual({ glyph: '👀', substituted: false });
    expect(resolveReactionEmoji('❤️')).toEqual({ glyph: '❤', substituted: false });
  });

  it('substitutes the nearest allowed glyph for ✅ — the live silent drop', () => {
    // An agent reacted `white_check_mark` twice in one day; ✅ is not a legal
    // Telegram reaction for ANY chat member, so both went nowhere unreported.
    expect(resolveReactionEmoji('white_check_mark')).toEqual({ glyph: '👌', substituted: true });
    expect(resolveReactionEmoji('✅')).toEqual({ glyph: '👌', substituted: true });
    expect(resolveReactionEmoji('heavy_check_mark')).toEqual({ glyph: '👌', substituted: true });
    expect(resolveReactionEmoji('☑')).toEqual({ glyph: '👌', substituted: true });
  });

  it('substitutes for the other common non-allowed inputs', () => {
    expect(resolveReactionEmoji('x')).toEqual({ glyph: '👎', substituted: true });
    expect(resolveReactionEmoji('cross_mark')).toEqual({ glyph: '👎', substituted: true });
    expect(resolveReactionEmoji('❌')).toEqual({ glyph: '👎', substituted: true });
    expect(resolveReactionEmoji('💪')).toEqual({ glyph: '🫡', substituted: true });
    expect(resolveReactionEmoji('😊')).toEqual({ glyph: '😁', substituted: true });
    expect(resolveReactionEmoji('🙂')).toEqual({ glyph: '😁', substituted: true });
    // ⚡ over 🎉 for 🚀: speed, not celebration — `party`/`tada` already own 🎉.
    expect(resolveReactionEmoji('🚀')).toEqual({ glyph: '⚡', substituted: true });
    expect(resolveReactionEmoji('rocket')).toEqual({ glyph: '⚡', substituted: true });
    expect(resolveReactionEmoji('star')).toEqual({ glyph: '🏆', substituted: true });
    expect(resolveReactionEmoji('⭐')).toEqual({ glyph: '🏆', substituted: true });
    expect(resolveReactionEmoji('eyes_ok')).toEqual({ glyph: '👀', substituted: true });
  });

  it('normalizes fallback lookup the same way as exact lookup', () => {
    expect(resolveReactionEmoji('  White_Check_Mark  ')).toEqual({ glyph: '👌', substituted: true });
    expect(resolveReactionEmoji('❌️')).toEqual({ glyph: '👎', substituted: true });
  });

  it('every fallback lands on a glyph Telegram actually allows', () => {
    const allowed = new Set<string>(ALLOWED_REACTION_GLYPHS);
    for (const input of ['✅', '❌', '💪', '😊', '🚀', '⭐', '👁', '🫶', '😂', '🥳', '💖', '🙁']) {
      const { glyph, substituted } = resolveReactionEmoji(input);
      expect(substituted).toBe(true);
      expect(allowed.has(glyph as string)).toBe(true);
    }
  });

  it('still resolves to null for input no fallback covers', () => {
    // The table maps intent, so an emoji with no clear intent stays a drop —
    // better a reported drop than a reaction meaning something else.
    for (const input of ['🍕', '🦖', '🧊', 'rocket_ship', 'zzz_unknown', '', '   ']) {
      expect(resolveReactionEmoji(input)).toEqual({ glyph: null, substituted: false });
    }
  });

  it('does not reach Object.prototype through the lookup tables', () => {
    // Both tables are plain object literals, so a bare `[key]` read returned
    // the Object constructor for input `constructor` and the prototype itself
    // for `__proto__` — typed as a glyph, and truthy enough to be "resolved".
    for (const key of ['constructor', '__proto__', 'hasOwnProperty', 'toString']) {
      expect(canonicalizeReactionEmoji(key)).toBeNull();
      expect(resolveReactionEmoji(key)).toEqual({ glyph: null, substituted: false });
    }
  });

  it('stays pinned to grammY: every glyph upstream allows is in our list', () => {
    // The array declaration carries `satisfies readonly ReactionTypeEmoji['emoji'][]`,
    // which fails the build if we list a glyph upstream dropped. This is the
    // other direction — a grammY bump that ADDS a glyph breaks this assignment
    // instead of leaving the set quietly short.
    const upstream: TelegramReactionEmoji = '👍' as ReactionTypeEmoji['emoji'];
    expect(ALLOWED_REACTION_GLYPHS).toContain(upstream);
    expect(ALLOWED_REACTION_GLYPHS).toHaveLength(73);
  });
});

/**
 * The container package cannot import host src, so `add_reaction`'s schema
 * carries a copy of the glyph list. Pin the copy EQUAL, not merely containing:
 * a `toContain` on the joined host list still passes when the container copy
 * has extra glyphs appended, which is exactly the drift that would teach the
 * agent an illegal vocabulary. Same mechanism as
 * container-config.test.ts's host/container validation parity.
 */
describe('host/container reaction-vocabulary parity', () => {
  it('keeps the add_reaction schema glyph list identical to the host set', () => {
    const toolSrc = fs.readFileSync(path.join(process.cwd(), 'container/agent-runner/src/mcp-tools/core.ts'), 'utf8');
    const copied = toolSrc.match(/const TELEGRAM_REACTION_GLYPHS =\s*'([^']+)'/)?.[1];
    expect(copied).toBeDefined();
    expect(copied).toBe(ALLOWED_REACTION_GLYPHS.join(' '));
  });
});
