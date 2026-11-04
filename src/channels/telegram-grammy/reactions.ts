/**
 * Reaction emoji resolution for the outbound `add_reaction` path.
 *
 * Two layers, in order:
 *   1. `canonicalizeReactionEmoji` — exact match: a Telegram-allowed glyph
 *      (with or without VS-16) or a slug that names one.
 *   2. `resolveReactionEmoji` — layer 1, then a curated nearest-allowed
 *      fallback for input Telegram will never accept (`✅`, `🚀`, `x`, ...),
 *      reporting whether the glyph it returns is a substitution.
 *
 * Callers that can report back to the agent use `resolveReactionEmoji`, so a
 * reaction is never silently dropped: a substitution is delivered and named,
 * and unmappable input is reported as a drop.
 */
import type { ReactionTypeEmoji } from 'grammy/types';

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
 * grammY's union is VS-16-free too, so it type-pins this array directly:
 * `satisfies` below fails the build if a grammY bump drops or renames a glyph
 * we still list, instead of letting the hand-maintained copy drift into
 * REACTION_INVALID at runtime. The other direction (upstream gaining a glyph)
 * is asserted in reactions.test.ts, where an assignment can carry it.
 *
 * Source: https://core.telegram.org/bots/api#reactiontypeemoji
 */
export const ALLOWED_REACTION_GLYPHS = [
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
] as const satisfies readonly ReactionTypeEmoji['emoji'][];

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
 * Nearest-allowed fallbacks for input Telegram will never accept.
 *
 * This table maps INTENT, not codepoints. `✅` is not a legal reaction for
 * any chat member — not us, not a human — so there is no "correct" glyph to
 * translate it into; but the agent that reached for it meant *acknowledged /
 * done*, and `👌` is the closest thing the allowed set has. A hit here is a
 * substitution, and `resolveReactionEmoji` says so, so the caller can tell
 * the agent what actually went out instead of letting it believe otherwise.
 *
 * Deliberately small and hand-curated: input in neither this table nor the
 * allowed set still resolves to `null`. Reporting a drop beats inventing a
 * reaction that means something the agent never said.
 *
 * Keys are lowercase and VS-16-free — lookup normalizes input the same way.
 */
const NEAREST_ALLOWED_FALLBACK: Readonly<Record<string, TelegramReactionEmoji>> = {
  // Acknowledged / done — the live drop that prompted this table (an agent
  // reacted `white_check_mark` twice; both went nowhere, silently).
  '✅': '👌',
  '☑': '👌',
  '✔': '👌',
  white_check_mark: '👌',
  heavy_check_mark: '👌',
  check: '👌',
  check_mark: '👌',
  check_mark_button: '👌',
  ballot_box_with_check: '👌',
  done: '👌',
  approved: '👌',

  // Refused / wrong.
  '❌': '👎',
  '❎': '👎',
  '✖': '👎',
  x: '👎',
  cross_mark: '👎',
  no: '👎',
  rejected: '👎',

  // On it — 💪 and 🫡 are both "I've got this".
  '💪': '🫡',
  muscle: '🫡',
  flexed_biceps: '🫡',
  o7: '🫡',

  // Warmth. 😁 is the allowed set's only plain smile, so every friendlier
  // face lands on it (the `smile`/`smiley` slugs already resolve exactly).
  '😊': '😁',
  '🙂': '😁',
  '😄': '😁',
  '😃': '😁',
  '☺': '😁',
  blush: '😁',
  slightly_smiling_face: '😁',
  grin: '😁',
  happy: '😁',

  // Shipped / fast. ⚡ over 🎉 on purpose: 🚀 is speed and momentum, while 🎉
  // is celebration — which `party`/`tada` already resolve to exactly. Sending
  // 🚀 there would collapse two distinct intents onto one glyph.
  '🚀': '⚡',
  rocket: '⚡',
  shipit: '⚡',
  ship: '⚡',
  fast: '⚡',

  // Excellent / standout — 🏆 is the allowed set's "this is the good one".
  '⭐': '🏆',
  '🌟': '🏆',
  '✨': '🏆',
  star: '🏆',
  star2: '🏆',
  glowing_star: '🏆',
  sparkles: '🏆',

  // Seen / watching — variants of the allowed 👀.
  '👁': '👀',
  '👁‍🗨': '👀',
  eye: '👀',
  eyes_ok: '👀',
  seen: '👀',
  watching: '👀',
  looking: '👀',

  // Gratitude.
  '🫶': '🙏',
  '🤲': '🙏',
  thanks: '🙏',
  thank_you: '🙏',

  // Laughter beyond the exact `joy`/`rofl` slugs.
  '😂': '🤣',
  '😅': '🤣',
  '😆': '🤣',
  sweat_smile: '🤣',

  // Celebration variants.
  '🥳': '🎉',
  '🎊': '🎉',
  partying_face: '🎉',
  confetti_ball: '🎉',

  // Affection variants — ❤ is the allowed plain heart.
  '💖': '❤',
  '💕': '❤',
  '💗': '❤',
  sparkling_heart: '❤',
  two_hearts: '❤',

  // Disappointment — 😢 is the allowed set's mildest sad face.
  '🙁': '😢',
  '☹': '😢',
  '😞': '😢',
  disappointed: '😢',
  sad: '😢',
};

/**
 * Translate an `add_reaction` emoji argument — slug, glyph, or
 * glyph-with-VS16 — into the canonical Telegram-allowed glyph. Returns
 * `null` for anything Telegram won't accept; callers should log + drop
 * instead of forwarding (which would 400 with REACTION_INVALID).
 *
 * Exact matches only — `resolveReactionEmoji` layers the nearest-allowed
 * fallback table on top of this.
 */
export function canonicalizeReactionEmoji(input: string): TelegramReactionEmoji | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Slug hit (case-insensitive). `Object.hasOwn` because the table is a plain
  // object literal, so a bare `[key]` read reaches Object.prototype: input
  // `constructor` returned the Object constructor and `__proto__` the
  // prototype itself, both typed as a glyph.
  const slug = trimmed.toLowerCase();
  const slugHit = Object.hasOwn(SLUG_TO_REACTION_EMOJI, slug) ? SLUG_TO_REACTION_EMOJI[slug] : undefined;
  if (slugHit) return slugHit;

  // Already a canonical glyph.
  if (ALLOWED_GLYPH_SET.has(trimmed)) return trimmed as TelegramReactionEmoji;

  // Glyph with one or more VS-16 (U+FE0F) selectors — common in LLM output.
  // Telegram's server matches the bare codepoint sequence.
  const noVs16 = trimmed.replace(/\uFE0F/g, '');
  if (ALLOWED_GLYPH_SET.has(noVs16)) return noVs16 as TelegramReactionEmoji;

  return null;
}

export interface ReactionResolution {
  /** Glyph to send, or `null` when nothing allowed carries the intent. */
  glyph: TelegramReactionEmoji | null;
  /** `true` when `glyph` is a nearest-allowed stand-in, not what was asked for. */
  substituted: boolean;
}

/**
 * Resolve an `add_reaction` emoji argument all the way: exact match first,
 * then the curated nearest-allowed fallback. `substituted` is the point of
 * the shape — it lets the caller deliver the stand-in *and* tell the agent
 * its reaction was changed, instead of pretending the request went through
 * as written.
 */
export function resolveReactionEmoji(input: string): ReactionResolution {
  const exact = canonicalizeReactionEmoji(input);
  if (exact) return { glyph: exact, substituted: false };
  const key = input.trim().replace(/️/g, '').toLowerCase();
  const fallback = Object.hasOwn(NEAREST_ALLOWED_FALLBACK, key) ? NEAREST_ALLOWED_FALLBACK[key] : undefined;
  return fallback ? { glyph: fallback, substituted: true } : { glyph: null, substituted: false };
}
