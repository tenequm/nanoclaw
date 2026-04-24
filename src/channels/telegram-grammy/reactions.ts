/**
 * pendingSeen state — tracks 👀 reactions we've added to inbound messages
 * so we can clear them once the bot replies.
 *
 * Keyed by `threadId ?? platformId` so forum topics stay isolated — a
 * reply in topic-B won't clear a 👀 left in topic-A. In-memory only:
 * a host crash between add and clear leaves the eyeballs sticky, which
 * is a cosmetic regression, not a correctness bug.
 */
import { Effect, Exit, HashMap, HashSet, Ref } from 'effect';

import { BotService } from './services.js';
import { mapGrammyError } from './errors.js';
import { extractTelegramMessageId } from './inbound.js';

export const SEEN_EMOJI = '👀';

export type PendingSeenRef = Ref.Ref<HashMap.HashMap<string, HashSet.HashSet<string>>>;

export const makePendingSeenRef = (): Effect.Effect<PendingSeenRef> =>
  Ref.make(HashMap.empty<string, HashSet.HashSet<string>>());

/**
 * Add `compoundId` to the set under `reactionKey`. Pure state mutation —
 * does NOT send the reaction to Telegram. Callers fire the API call and
 * only call this on the success branch.
 */
export const trackSeen = (
  ref: PendingSeenRef,
  reactionKey: string,
  compoundId: string,
): Effect.Effect<void> =>
  Ref.update(ref, (map) => {
    const existing = HashMap.get(map, reactionKey);
    const next = existing._tag === 'Some' ? HashSet.add(existing.value, compoundId) : HashSet.make(compoundId);
    return HashMap.set(map, reactionKey, next);
  });

/**
 * Fire 👀 on a message, tracking the id on success so we can clear later.
 * Errors (blocked bot, message deleted, etc.) are logged at warn and
 * swallowed — the reaction is cosmetic.
 */
export const fireSeenReaction = Effect.fn('telegram-grammy.fireSeenReaction')(
  function* (chatId: number, messageId: number, reactionKey: string, compoundId: string) {
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
  },
);

/**
 * Drain every tracked 👀 for the given reactionKey and fire best-effort
 * clears. Called after a successful outbound delivery. Errors are logged
 * and swallowed.
 */
export const clearPendingSeen = Effect.fn('telegram-grammy.clearPendingSeen')(
  function* (chatId: number, reactionKey: string) {
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
  },
);
