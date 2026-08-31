/**
 * Reaction emoji canonicalization (slug → glyph) for the outbound
 * `add_reaction` path.
 */

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
