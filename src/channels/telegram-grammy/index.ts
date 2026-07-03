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

import { materializeAll } from './attachments.js';
import { parseCallbackData } from './ask-question.js';
import { toInboundMessage, toReactionInbound, type InboundContent, type ReactionUpdatePayload } from './inbound.js';
import { tryPair } from './pairing-interceptor.js';
import { dispatchOutbound } from './outbound.js';
import { fireSeenReaction } from './reactions.js';
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
    private readonly noSeenChats: ReadonlySet<number> = new Set(),
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
    const noSeenChats = this.noSeenChats;

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

          // Fire 👀 best-effort in a detached fiber — doesn't block
          // materialization or the router handoff. Suppressed for chats in
          // TELEGRAM_NO_SEEN_CHATS: in busy groups the eyes only clear on a
          // bot reply (outbound.ts), so on non-targeted messages they pile up.
          if (!noSeenChats.has(chatId)) {
            yield* Effect.forkDetach(fireSeenReaction(chatId, ctx.msg.message_id, threadId ?? platformId, message.id));
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
          const user = ctx.from;
          onAction(parsed.questionId, parsed.value, user ? String(user.id) : '');
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
          void runtime.runPromise(
            onInbound(envelope.platformId, envelope.threadId, envelope.message).pipe(
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
        const chatId = Number(platformId.split(':').slice(1).join(':'));
        if (!Number.isFinite(chatId)) return;
        const threadPart = threadId?.split(':').pop();
        const messageThreadId = threadPart ? Number(threadPart) : undefined;
        yield* Effect.tryPromise({
          try: () =>
            bot.api.sendChatAction(chatId, 'typing', {
              message_thread_id: Number.isFinite(messageThreadId) ? (messageThreadId as number) : undefined,
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

/**
 * Parse `TELEGRAM_NO_SEEN_CHATS` — a comma-separated list of chat ids where
 * the 👀 "seen" reaction is suppressed. Non-numeric entries are dropped.
 */
function parseNoSeenChats(raw: string | undefined): ReadonlySet<number> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n)),
  );
}

registerChannelAdapter(CHANNEL_TYPE, {
  factory: () => {
    const env = readEnvFile([
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_API_ROOT',
      'TELEGRAM_MAX_FILE_MB',
      'TELEGRAM_LOCAL_FILES_DIR',
      'TELEGRAM_NO_SEEN_CHATS',
    ]);
    if (!env.TELEGRAM_BOT_TOKEN) return null;
    return new TelegramGrammyAdapter(
      env.TELEGRAM_BOT_TOKEN,
      env.TELEGRAM_API_ROOT,
      env.TELEGRAM_MAX_FILE_MB,
      env.TELEGRAM_LOCAL_FILES_DIR,
      parseNoSeenChats(env.TELEGRAM_NO_SEEN_CHATS),
    );
  },
});

export { TelegramGrammyAdapter };
