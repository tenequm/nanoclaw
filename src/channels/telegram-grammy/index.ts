/**
 * telegram-grammy channel adapter.
 *
 * Effect-TS v4 island inside the Promise-based host. All internal logic is
 * Effect-native; the public `ChannelAdapter` methods bridge Effect→Promise
 * at the boundary via `ManagedRuntime.runPromise`/`runFork`. Errors are
 * caught before the runPromise call so nothing throws out — matches the
 * host's `delivery.ts` expectation that `deliver` never throws.
 *
 * Activated only when `TELEGRAM_GRAMMY_BOT_TOKEN` is set. Coexists with
 * the legacy `telegram` adapter — channel_type is distinct so wirings
 * don't collide. Switching between them is `unset`+restart; no DB
 * migration needed.
 *
 * This folder is Effect-TS v4. Use `Effect.gen`/`Effect.fn`. No try/catch
 * outside of `Effect.tryPromise`. All errors typed via
 * `Schema.TaggedErrorClass`. See ~/.claude/skills/effect-ts/SKILL.md.
 */
import { Effect } from 'effect';
import type { Context } from 'grammy';

import type { ChannelAdapter, ChannelSetup, ConversationInfo, OutboundMessage } from '../adapter.js';
import { registerChannelAdapter } from '../channel-registry.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';

import { getAskQuestionRender } from '../../db/sessions.js';

import { materializeAll } from './attachments.js';
import { composeSelectedCard, parseCallbackData } from './ask-question.js';
import { renderFS } from './formatter.js';
import {
  parseChatId,
  parseTopicId,
  resolveMessageThreadId,
  toInboundMessage,
  toReactionInbound,
  type InboundContent,
  type ReactionUpdatePayload,
} from './inbound.js';
import { rememberTopicMessage, resolveTopicPlatformId } from './topic-map.js';
import { tryPair } from './pairing-interceptor.js';
import { dispatchOutbound } from './outbound.js';
import { runSupervisedPolling } from './supervise.js';
import { buildRuntime, type AdapterRuntime } from './runtime.js';
import { AdapterConfigService, BotService } from './services.js';

const CHANNEL_TYPE = 'telegram';

function isInboundContent(value: unknown): value is InboundContent {
  return typeof value === 'object' && value !== null && 'text' in (value as Record<string, unknown>);
}

class TelegramGrammyAdapter implements ChannelAdapter {
  readonly name = CHANNEL_TYPE;
  readonly channelType = CHANNEL_TYPE;
  readonly supportsThreads = false;

  private runtime: AdapterRuntime | null = null;
  private connected = false;

  constructor(
    private readonly token: string,
    private readonly apiRootRaw: string | undefined,
    private readonly maxFileMbRaw: string | undefined,
    private readonly localFilesDirRaw: string | undefined,
  ) {}

  async setup(hostConfig: ChannelSetup): Promise<void> {
    const runtime = buildRuntime({
      token: this.token,
      apiRootRaw: this.apiRootRaw,
      maxFileMbRaw: this.maxFileMbRaw,
      localFilesDirRaw: this.localFilesDirRaw,
      hostConfig,
    });
    this.runtime = runtime;

    await runtime.runPromise(
      Effect.gen(function* () {
        const { bot, me } = yield* BotService;
        const botUsername = me.username ?? null;
        const botUserId = me.id;

        const { onInbound, onAction } = yield* AdapterConfigService;

        const handleInbound = Effect.fn('telegram-grammy.handleInbound')(function* (ctx: Context) {
          const envelope = toInboundMessage(ctx, botUsername, botUserId);
          if (!envelope) return;

          const { platformId, threadId, message } = envelope;
          const chat = ctx.chat;
          if (!chat || !ctx.msg) return;
          const chatId = chat.id;

          // Forum topic → remember which topic this message lives in so a
          // later `message_reaction` update (which carries no topic id) can
          // be attributed to the right per-topic messaging group.
          if (parseTopicId(platformId) !== undefined) {
            rememberTopicMessage(chatId, ctx.msg.message_id, platformId);
          }

          // Materialize attachment bytes to the group folder (await so the
          // agent-runner sees them in the same inbound dispatch).
          if (isInboundContent(message.content) && message.content.attachments.length > 0) {
            yield* materializeAll(message.content.attachments, message.id, platformId);
          }

          const isGroup = chat.type !== 'private';
          const chatName = chat.type === 'private' ? null : ((chat as { title?: string }).title ?? null);

          const paired = yield* tryPair(chatId, platformId, isGroup, chatName, message);
          if (paired) return;

          yield* onInbound(platformId, threadId, message);
        });

        // grammY handlers are sync/void; we fork inbound handling into the
        // runtime so errors go through the Effect error channel.
        const dispatchFromHandler = (ctx: Context): void => {
          void runtime.runPromise(
            handleInbound(ctx).pipe(
              Effect.catchCause((cause) => Effect.logError('telegram-grammy: inbound handler failed', { cause })),
            ),
          );
        };

        const handleCallbackQuery = Effect.fn('telegram-grammy.handleCallbackQuery')(function* (ctx: Context) {
          const data = ctx.callbackQuery?.data;
          if (!data) return;
          const parsed = parseCallbackData(data);
          yield* Effect.tryPromise({
            try: () => ctx.answerCallbackQuery(),
            catch: (err) => err,
          }).pipe(Effect.catchCause(() => Effect.void));
          if (!parsed) return;

          // Resolve render metadata BEFORE dispatching onAction — registered
          // handlers delete the pending row, and the selected-state labels go
          // with it. Mirrors chat-sdk-bridge's ordering.
          const render = getAskQuestionRender(parsed.questionId);
          const user = ctx.from;
          onAction(parsed.questionId, parsed.value, user ? String(user.id) : '');

          // Reflect the choice on the card: rewrite the body to the selected
          // state and drop the keyboard, so the approver can see the tap
          // registered. Best-effort — the action above already dispatched.
          const cbMsg = ctx.callbackQuery?.message;
          if (!cbMsg) return;
          const actorName = user?.first_name ?? user?.username ?? '';
          const currentText = 'text' in cbMsg && typeof cbMsg.text === 'string' ? cbMsg.text : '';
          const body = composeSelectedCard(render, parsed.value, currentText, actorName);
          const fs = renderFS(body);
          yield* Effect.tryPromise({
            try: () => ctx.api.editMessageText(cbMsg.chat.id, cbMsg.message_id, fs.text, { entities: fs.entities }),
            catch: (err) => err,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning('telegram-grammy: failed to update card after action', { cause }),
            ),
          );
        });

        bot.on('message', (ctx) => {
          dispatchFromHandler(ctx);
        });
        bot.on('edited_message', (ctx) => {
          dispatchFromHandler(ctx);
        });
        bot.on('callback_query:data', (ctx) => {
          void runtime.runPromise(
            handleCallbackQuery(ctx).pipe(
              Effect.catchCause((cause) =>
                Effect.logError('telegram-grammy: callback_query handler failed', { cause }),
              ),
            ),
          );
        });
        bot.on('message_reaction', (ctx) => {
          const upd = (ctx.update as { message_reaction?: ReactionUpdatePayload }).message_reaction;
          if (!upd) return;
          const envelope = toReactionInbound(upd);
          if (!envelope) return;
          // Reaction updates carry no topic id — attribute via the message
          // map recorded on inbound/outbound; fall back to the base chat id.
          const reactionPlatformId = resolveTopicPlatformId(upd.chat.id, upd.message_id) ?? envelope.platformId;
          void runtime.runPromise(
            onInbound(reactionPlatformId, envelope.threadId, envelope.message).pipe(
              Effect.catchCause((cause) =>
                Effect.logError('telegram-grammy: message_reaction handler failed', { cause }),
              ),
            ),
          );
        });

        // Fork supervised polling as a detached fiber — lives for the
        // ManagedRuntime's scope and gets interrupted on dispose.
        yield* Effect.forkDetach(
          runSupervisedPolling({
            allowedUpdates: ['message', 'edited_message', 'callback_query', 'message_reaction'],
          }),
        );
      }),
    );

    this.connected = true;
  }

  async teardown(): Promise<void> {
    this.connected = false;
    const rt = this.runtime;
    if (!rt) return;
    this.runtime = null;
    await rt.dispose().catch((err: unknown) => {
      log.warn('telegram-grammy: runtime dispose failed', { err });
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  async deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
    const rt = this.runtime;
    if (!rt) return undefined;
    return rt.runPromise(
      dispatchOutbound(platformId, threadId, message).pipe(
        Effect.catch((err) =>
          Effect.as(Effect.logError('telegram-grammy: deliver failed', { err }), undefined as string | undefined),
        ),
      ),
    );
  }

  async setTyping(platformId: string, threadId: string | null): Promise<void> {
    const rt = this.runtime;
    if (!rt) return;
    await rt.runPromise(
      Effect.gen(function* () {
        const { bot } = yield* BotService;
        let chatId: number;
        try {
          chatId = parseChatId(platformId);
        } catch {
          return; // typing is best-effort; a malformed id is not worth a log storm
        }
        const messageThreadId = resolveMessageThreadId(platformId, threadId);
        yield* Effect.tryPromise({
          try: () =>
            bot.api.sendChatAction(chatId, 'typing', {
              message_thread_id: messageThreadId,
            }),
          catch: (err) => err,
        }).pipe(
          Effect.catch((err) =>
            Effect.sync(() => log.warn('telegram-grammy: setTyping failed', { chatId, err: String(err) })),
          ),
        );
      }),
    );
  }

  async syncConversations(): Promise<ConversationInfo[]> {
    // Telegram bots cannot enumerate their chats via the Bot API — conversations
    // are discovered organically via inbound messages + pairing. Return empty
    // so the host doesn't mistake "no known chats" for an unreachable channel.
    return [];
  }
}

registerChannelAdapter(CHANNEL_TYPE, {
  factory: () => {
    const env = readEnvFile([
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_API_ROOT',
      'TELEGRAM_MAX_FILE_MB',
      'TELEGRAM_LOCAL_FILES_DIR',
    ]);
    if (!env.TELEGRAM_BOT_TOKEN) return null;
    return new TelegramGrammyAdapter(
      env.TELEGRAM_BOT_TOKEN,
      env.TELEGRAM_API_ROOT,
      env.TELEGRAM_MAX_FILE_MB,
      env.TELEGRAM_LOCAL_FILES_DIR,
    );
  },
});

export { TelegramGrammyAdapter };
