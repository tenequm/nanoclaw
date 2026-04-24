/**
 * Pairing interceptor.
 *
 * On every inbound text, check whether it's a pending 4-digit pairing code
 * (optionally prefixed by `@botname`). On match:
 *   1. Mark the pairing consumed (tryConsume),
 *   2. Persist messaging_group + user + optional owner grant,
 *   3. Send a welcome reply,
 *   4. Short-circuit — do NOT forward to the router.
 *
 * On miss: return false so the caller dispatches to the router normally.
 * Any failure in this chain is logged and treated as a non-match so a
 * broken pairing never silently eats a user message.
 */
import { Effect } from 'effect';

import type { InboundMessage } from '../adapter.js';

import type { InboundContent } from './inbound.js';
import { mapGrammyError } from './errors.js';
import { BotService, PairingService } from './services.js';

function isInboundContent(value: unknown): value is InboundContent {
  return typeof value === 'object' && value !== null && 'text' in (value as Record<string, unknown>);
}

/** Best-effort welcome reply after a successful pairing. Failures logged, swallowed. */
const sendWelcome = Effect.fn('telegram-grammy.sendWelcome')(function* (chatId: number) {
  const { bot } = yield* BotService;
  yield* Effect.tryPromise({
    try: () =>
      bot.api.sendMessage(
        chatId,
        "Pairing success! I'm spinning up the agent now, you'll get a message from them shortly.",
      ),
    catch: (err) => mapGrammyError(err, 'sendMessage-welcome', String(chatId)),
  }).pipe(Effect.catch((err) => Effect.logWarning('telegram-grammy: pairing welcome failed', err)));
});

/**
 * Try to consume an inbound message as a pairing code.
 * Returns true iff the message was consumed and should NOT be forwarded to the router.
 */
export const tryPair = Effect.fn('telegram-grammy.tryPair')(function* (
  chatId: number,
  platformId: string,
  isGroup: boolean,
  chatName: string | null,
  message: InboundMessage,
) {
  const pairing = yield* PairingService;
  const { me } = yield* BotService;

  if (!isInboundContent(message.content)) return false;
  const text = message.content.text;
  const authorUserId = message.content.author.userId;
  const adminUserIdBare = authorUserId.startsWith('telegram:') ? authorUserId.slice('telegram:'.length) : authorUserId;
  if (!text || !me.username) return false;

  const record = yield* pairing
    .tryConsume({
      text,
      botUsername: me.username,
      platformId,
      isGroup,
      name: chatName,
      adminUserId: adminUserIdBare,
    })
    .pipe(Effect.catch((err) => Effect.as(Effect.logError('telegram-grammy: tryConsume failed', err), null)));

  if (!record) return false;

  yield* pairing
    .persistConsumed(record, platformId)
    .pipe(Effect.catch((err) => Effect.logError('telegram-grammy: persistConsumed failed', err)));

  yield* Effect.logInfo('telegram-grammy: pairing accepted', {
    platformId,
    intent: record.intent,
  });

  yield* sendWelcome(chatId);
  return true;
});
