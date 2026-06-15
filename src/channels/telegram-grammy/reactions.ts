/**
 * pendingSeen state — tracks 👀 reactions we've added to inbound messages
 * so we can clear them once the bot replies.
 *
 * Keyed by `threadId ?? platformId` so forum topics stay isolated — a
 * reply in topic-B won't clear a 👀 left in topic-A. In-memory only:
 * a host crash between add and clear leaves the eyeballs sticky, which
 * is a cosmetic regression, not a correctness bug.
 *
 * Also exports `canonicalizeReactionEmoji` — the slug-or-glyph translator
 * the outbound `add_reaction` path uses. Lives here because the
 * Telegram-allowed reaction list is the same load-bearing constant as
 * `SEEN_EMOJI` and we want one source of truth.
 */
import { Effect, Exit, HashMap, HashSet, Ref } from 'effect';

import { BotService } from './services.js';
import { mapGrammyError } from './errors.js';
import { extractTelegramMessageId } from './inbound.js';

export const SEEN_EMOJI = '👀';

/* ----------------------------------------------------------------------- */
/*                Reaction emoji canonicalization (slug → glyph)            */
/* ----------------------------------------------------------------------- */

/**
 * Telegram's `setMessageReaction` accepts only this fixed allowlist of
 * Unicode glyphs (see `ReactionTypeEmoji.emoji` in `@grammyjs/types`).
 * Any other input — semantic slugs (`thumbs_up`), random emoji
 * (`✅`, `🚀`), variation-selector tweaks — is rejected server-side as
 * `Bad Request: REACTION_INVALID`.
 *
 * This list mirrors the upstream union character-for-character, *without*
 * VS-16 (U+FE0F). Telegram's server matches the bare codepoint sequence;
 * VS-16 in input is stripped by `canonicalizeReactionEmoji` before lookup.
 *
 * Source: https://core.telegram.org/bots/api#reactiontypeemoji
 */
const ALLOWED_REACTION_GLYPHS = [
  '👍',
  '👎',
  '❤',
  '🔥',
  '🥰',
  '👏',
  '😁',
  '🤔',
  '🤯',
  '😱',
  '🤬',
  '😢',
  '🎉',
  '🤩',
  '🤮',
  '💩',
  '🙏',
  '👌',
  '🕊',
  '🤡',
  '🥱',
  '🥴',
  '😍',
  '🐳',
  '❤‍🔥',
  '🌚',
  '🌭',
  '💯',
  '🤣',
  '⚡',
  '🍌',
  '🏆',
  '💔',
  '🤨',
  '😐',
  '🍓',
  '🍾',
  '💋',
  '🖕',
  '😈',
  '😴',
  '😭',
  '🤓',
  '👻',
  '👨‍💻',
  '👀',
  '🎃',
  '🙈',
  '😇',
  '😨',
  '🤝',
  '✍',
  '🤗',
  '🫡',
  '🎅',
  '🎄',
  '☃',
  '💅',
  '🤪',
  '🗿',
  '🆒',
  '💘',
  '🙉',
  '🦄',
  '😘',
  '💊',
  '🙊',
  '😎',
  '👾',
  '🤷‍♂',
  '🤷',
  '🤷‍♀',
  '😡',
] as const;

export type TelegramReactionEmoji = (typeof ALLOWED_REACTION_GLYPHS)[number];

const ALLOWED_GLYPH_SET: ReadonlySet<string> = new Set(ALLOWED_REACTION_GLYPHS);

/**
 * Slug → glyph map for the agent-facing `add_reaction` MCP tool, whose
 * schema documents semantic names like `thumbs_up`. We map every
 * Telegram-allowed glyph to at least one obvious slug, plus a handful of
 * common LLM-output aliases (`+1`, `like`, `tada`, etc.). Unmapped input
 * returns `null` from `canonicalizeReactionEmoji` so the caller can log
 * and drop instead of pushing junk to the wire.
 *
 * Keep keys lowercase — lookup normalizes input to lowercase before hit.
 */
const SLUG_TO_REACTION_EMOJI: Readonly<Record<string, TelegramReactionEmoji>> = {
  // primary slugs
  thumbs_up: '👍',
  thumbs_down: '👎',
  heart: '❤',
  fire: '🔥',
  smiling_face_with_hearts: '🥰',
  clap: '👏',
  grinning: '😁',
  thinking: '🤔',
  exploding_head: '🤯',
  scream: '😱',
  swearing: '🤬',
  cry: '😢',
  party: '🎉',
  star_struck: '🤩',
  vomiting: '🤮',
  poop: '💩',
  pray: '🙏',
  ok_hand: '👌',
  dove: '🕊',
  clown: '🤡',
  yawn: '🥱',
  woozy: '🥴',
  heart_eyes: '😍',
  whale: '🐳',
  heart_on_fire: '❤‍🔥',
  new_moon: '🌚',
  hot_dog: '🌭',
  hundred: '💯',
  rofl: '🤣',
  zap: '⚡',
  banana: '🍌',
  trophy: '🏆',
  broken_heart: '💔',
  raised_eyebrow: '🤨',
  neutral: '😐',
  strawberry: '🍓',
  champagne: '🍾',
  kiss: '💋',
  middle_finger: '🖕',
  smiling_devil: '😈',
  sleeping: '😴',
  loud_cry: '😭',
  nerd: '🤓',
  ghost: '👻',
  technologist: '👨‍💻',
  eyes: '👀',
  jack_o_lantern: '🎃',
  see_no_evil: '🙈',
  innocent: '😇',
  fearful: '😨',
  handshake: '🤝',
  writing: '✍',
  hugging: '🤗',
  salute: '🫡',
  santa: '🎅',
  christmas_tree: '🎄',
  snowman: '☃',
  nail_polish: '💅',
  zany: '🤪',
  moai: '🗿',
  cool: '🆒',
  heart_arrow: '💘',
  hear_no_evil: '🙉',
  unicorn: '🦄',
  blowing_kiss: '😘',
  pill: '💊',
  speak_no_evil: '🙊',
  sunglasses: '😎',
  alien: '👾',
  shrug_man: '🤷‍♂',
  shrug: '🤷',
  shrug_woman: '🤷‍♀',
  angry: '😡',

  // common aliases LLMs reach for (best-effort)
  '+1': '👍',
  '-1': '👎',
  like: '👍',
  dislike: '👎',
  red_heart: '❤',
  clapping: '👏',
  beaming: '😁',
  mind_blown: '🤯',
  cursing: '🤬',
  crying: '😢',
  tada: '🎉',
  party_popper: '🎉',
  ok: '👌',
  yawning: '🥱',
  joy: '🤣',
  laugh: '🤣',
  laughing: '🤣',
  rolling: '🤣',
  lightning: '⚡',
  '100': '💯',
  bottle_with_popping_cork: '🍾',
  kiss_mark: '💋',
  smiling_imp: '😈',
  sob: '😭',
  man_technologist: '👨‍💻',
  writing_hand: '✍',
  saluting_face: '🫡',
  cupid: '💘',
  kissing_heart: '😘',
  cool_face: '😎',
  alien_monster: '👾',
  rage: '😡',
  smile: '😁',
  smiley: '😁',
};

/**
 * Translate an `add_reaction` emoji argument — slug, glyph, or
 * glyph-with-VS16 — into the canonical Telegram-allowed glyph. Returns
 * `null` for anything Telegram won't accept; callers should log + drop
 * instead of forwarding (which would 400 with REACTION_INVALID).
 */
export function canonicalizeReactionEmoji(input: string): TelegramReactionEmoji | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Slug hit (case-insensitive).
  const slugHit = SLUG_TO_REACTION_EMOJI[trimmed.toLowerCase()];
  if (slugHit) return slugHit;

  // Already a canonical glyph.
  if (ALLOWED_GLYPH_SET.has(trimmed)) return trimmed as TelegramReactionEmoji;

  // Glyph with one or more VS-16 (U+FE0F) selectors — common in LLM output.
  // Telegram's server matches the bare codepoint sequence.
  const noVs16 = trimmed.replace(/️/g, '');
  if (ALLOWED_GLYPH_SET.has(noVs16)) return noVs16 as TelegramReactionEmoji;

  return null;
}

export type PendingSeenRef = Ref.Ref<HashMap.HashMap<string, HashSet.HashSet<string>>>;

export const makePendingSeenRef = (): Effect.Effect<PendingSeenRef> =>
  Ref.make(HashMap.empty<string, HashSet.HashSet<string>>());

/**
 * Add `compoundId` to the set under `reactionKey`. Pure state mutation —
 * does NOT send the reaction to Telegram. Callers fire the API call and
 * only call this on the success branch.
 */
export const trackSeen = (ref: PendingSeenRef, reactionKey: string, compoundId: string): Effect.Effect<void> =>
  Ref.update(ref, (map) => {
    const existing = HashMap.get(map, reactionKey);
    const next = existing._tag === 'Some' ? HashSet.add(existing.value, compoundId) : HashSet.make(compoundId);
    return HashMap.set(map, reactionKey, next);
  });

/**
 * Remove `compoundId` from the set under `reactionKey` (idempotent — no-op
 * if missing). Used by the agent's `add_reaction` path: when the bot
 * replaces its own 👀 with an explicit reaction, the seen-ack obligation is
 * discharged AND the post-delivery `clearPendingSeen` sweep must skip this
 * message — otherwise it'd wipe the agent's intentional reaction (Telegram
 * bots have at most one reaction slot per message; "clear all" is the only
 * remove verb available, so the only way to "clear only 👀" is to keep this
 * tracking set honest about which messages still bear the bot's 👀).
 */
export const untrackSeen = (ref: PendingSeenRef, reactionKey: string, compoundId: string): Effect.Effect<void> =>
  Ref.update(ref, (map) => {
    const existing = HashMap.get(map, reactionKey);
    if (existing._tag !== 'Some') return map;
    const next = HashSet.remove(existing.value, compoundId);
    return HashSet.size(next) === 0 ? HashMap.remove(map, reactionKey) : HashMap.set(map, reactionKey, next);
  });

/**
 * Fire 👀 on a message, tracking the id on success so we can clear later.
 * Errors (blocked bot, message deleted, etc.) are logged at warn and
 * swallowed — the reaction is cosmetic.
 */
export const fireSeenReaction = Effect.fn('telegram-grammy.fireSeenReaction')(function* (
  chatId: number,
  messageId: number,
  reactionKey: string,
  compoundId: string,
) {
  const { bot, pendingSeen } = yield* BotService;
  const apply = Effect.tryPromise({
    try: () => bot.api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: SEEN_EMOJI }]),
    catch: (err) => mapGrammyError(err, 'setMessageReaction', String(chatId)),
  });
  const outcome = yield* Effect.exit(apply);
  if (Exit.isSuccess(outcome)) {
    yield* trackSeen(pendingSeen, reactionKey, compoundId);
  } else {
    yield* Effect.logWarning('telegram-grammy: setMessageReaction(👀) failed', outcome.cause);
  }
});

/**
 * Drain every tracked 👀 for the given reactionKey and fire best-effort
 * clears. Called after a successful outbound delivery. Errors are logged
 * and swallowed.
 */
export const clearPendingSeen = Effect.fn('telegram-grammy.clearPendingSeen')(function* (
  chatId: number,
  reactionKey: string,
) {
  const { bot, pendingSeen } = yield* BotService;

  const drained = yield* Ref.modify(pendingSeen, (map) => {
    const existing = HashMap.get(map, reactionKey);
    if (existing._tag !== 'Some') return [[] as string[], map] as const;
    const ids = Array.from(existing.value);
    return [ids, HashMap.remove(map, reactionKey)] as const;
  });

  if (drained.length === 0) return;

  yield* Effect.forEach(
    drained,
    (compound) => {
      const parsed = extractTelegramMessageId(compound, chatId);
      if (!parsed) return Effect.void;
      return Effect.tryPromise({
        try: () => bot.api.setMessageReaction(parsed.chatId, parsed.messageId, []),
        catch: (err) => mapGrammyError(err, 'setMessageReaction-clear', String(chatId)),
      }).pipe(Effect.catch((err) => Effect.logWarning('telegram-grammy: clear 👀 failed', err)));
    },
    { concurrency: 'inherit', discard: true },
  );
});
