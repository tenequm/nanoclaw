/**
 * Coverage for `canonicalizeReactionEmoji` (slug→glyph) and the
 * `trackSeen`/`untrackSeen` pendingSeen state primitives. The
 * canonicalizer stops REACTION_INVALID errors at the wire; the
 * track/untrack pair makes "only clear messages where the bot's
 * reaction is still 👀" expressible without an extra Bot API roundtrip.
 */
import { Effect, HashMap, HashSet, Ref } from 'effect';
import { describe, expect, it } from 'vitest';

import { canonicalizeReactionEmoji, makePendingSeenRef, trackSeen, untrackSeen } from './reactions.js';

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

describe('pendingSeen track/untrack', () => {
  const KEY = 'telegram:95307956';
  const A = '95307956:1827:ag-x';
  const B = '95307956:1829:ag-x';

  it('tracks a compound under its reactionKey', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* makePendingSeenRef();
        yield* trackSeen(ref, KEY, A);
        const map = yield* Ref.get(ref);
        const set = HashMap.get(map, KEY);
        expect(set._tag).toBe('Some');
        if (set._tag === 'Some') expect(HashSet.has(set.value, A)).toBe(true);
      }),
    );
  });

  it('untrack removes the compound; sibling entries survive', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* makePendingSeenRef();
        yield* trackSeen(ref, KEY, A);
        yield* trackSeen(ref, KEY, B);
        yield* untrackSeen(ref, KEY, A);

        const map = yield* Ref.get(ref);
        const set = HashMap.get(map, KEY);
        expect(set._tag).toBe('Some');
        if (set._tag === 'Some') {
          expect(HashSet.has(set.value, A)).toBe(false);
          expect(HashSet.has(set.value, B)).toBe(true);
        }
      }),
    );
  });

  it('untrack drops the reactionKey entry when its set becomes empty', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* makePendingSeenRef();
        yield* trackSeen(ref, KEY, A);
        yield* untrackSeen(ref, KEY, A);
        const map = yield* Ref.get(ref);
        expect(HashMap.get(map, KEY)._tag).toBe('None');
      }),
    );
  });

  it('untrack on an empty / missing key is a no-op', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* makePendingSeenRef();
        // Untrack before any track — must not throw.
        yield* untrackSeen(ref, KEY, A);
        const map = yield* Ref.get(ref);
        expect(HashMap.get(map, KEY)._tag).toBe('None');
      }),
    );
  });

  it('untrack on a missing compound under an existing key leaves siblings intact', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* makePendingSeenRef();
        yield* trackSeen(ref, KEY, B);
        yield* untrackSeen(ref, KEY, A); // A was never tracked
        const map = yield* Ref.get(ref);
        const set = HashMap.get(map, KEY);
        expect(set._tag).toBe('Some');
        if (set._tag === 'Some') expect(HashSet.has(set.value, B)).toBe(true);
      }),
    );
  });

  // Regression: reactToMessage receives the 3-part `<chat>:<msg>:<agentGroup>`
  // compound (router-wrapped), but fireSeenReaction stores the 2-part
  // `<chat>:<msg>` form. If we untrack with the 3-part form, the lookup
  // misses and clearPendingSeen later wipes the agent's reaction.
  // reactToMessage must normalize to 2-part before calling untrack.
  it('untrack normalized 2-part form clears entry tracked by fireSeenReaction', async () => {
    const SEEN_KEY = '95307956:1827'; // what fireSeenReaction stores
    const AGENT_COMPOUND = '95307956:1827:ag-1776438126500-du9io3'; // what add_reaction emits
    const normalized = AGENT_COMPOUND.split(':').slice(0, 2).join(':');
    expect(normalized).toBe(SEEN_KEY); // sanity

    await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* makePendingSeenRef();
        yield* trackSeen(ref, KEY, SEEN_KEY); // fireSeenReaction stored 2-part
        yield* untrackSeen(ref, KEY, normalized); // reactToMessage strips agentGroup
        const map = yield* Ref.get(ref);
        // Key entry should drop entirely — set drained to zero.
        expect(HashMap.get(map, KEY)._tag).toBe('None');
      }),
    );
  });
});
