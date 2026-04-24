/**
 * Service declarations for the telegram-grammy adapter.
 *
 * v4 beta.52 pattern: `class Foo extends Context.Service<Foo, Shape>()("id") {}`.
 * (The skill's `ServiceMap` naming is planned for a later beta; in beta.52
 * the same API lives on `Context.Service`.) Each service is wired to a
 * concrete implementation by a Layer in layers.ts. Effects that need a
 * service declare it via the R (requirements) channel — the compiler
 * refuses to run until every requirement has a matching layer.
 */
import type { Effect, HashMap, HashSet, Ref } from 'effect';
import { Context } from 'effect';
import type { Bot, PollingOptions } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';

import type { ChannelSetup, InboundMessage } from '../adapter.js';
import type { PairingRecord, ConsumeInput } from '../telegram-pairing.js';
import type { GrammyNetworkError, PairingFailed } from './errors.js';

/**
 * BotService — grammY `Bot` instance + getMe result + lifecycle hooks.
 * The `start`/`stop` effects wrap `bot.start`/`bot.stop` so the polling
 * lifetime sits inside `Effect.acquireRelease` and is cleaned up on
 * runtime dispose.
 */
export class BotService extends Context.Service<
  BotService,
  {
    readonly bot: Bot;
    readonly me: UserFromGetMe;
    readonly start: (opts: PollingOptions) => Effect.Effect<void, GrammyNetworkError>;
    readonly stop: () => Effect.Effect<void>;
    /**
     * In-memory tracker for the 👀 seen-reaction — keyed by
     * `threadId ?? platformId`, value is a set of compound `chatId:msgId`
     * strings we've reacted to and still need to clear on next outbound.
     */
    readonly pendingSeen: Ref.Ref<HashMap.HashMap<string, HashSet.HashSet<string>>>;
  }
>()('telegram-grammy/BotService') {}

/** PairingService — Effect-flavored wrapper around `tryConsume` + DB persistence. */
export class PairingService extends Context.Service<
  PairingService,
  {
    readonly tryConsume: (input: ConsumeInput) => Effect.Effect<PairingRecord | null, PairingFailed>;
    /**
     * Persist the pairing result: upsert messaging_group, upsert user, grant
     * owner role if none exists. Swallows errors as `PairingFailed` — callers
     * log + continue (the inbound message still reaches the host).
     */
    readonly persistConsumed: (record: PairingRecord, platformId: string) => Effect.Effect<void, PairingFailed>;
  }
>()('telegram-grammy/PairingService') {}

/** TranscriptionService — best-effort voice-to-text via OpenAI Whisper. */
export class TranscriptionService extends Context.Service<
  TranscriptionService,
  {
    readonly transcribe: (filePath: string) => Effect.Effect<string | null>;
  }
>()('telegram-grammy/TranscriptionService') {}

/** GroupFolderService — messaging_group → agent_group folder name lookup. */
export class GroupFolderService extends Context.Service<
  GroupFolderService,
  {
    readonly resolveForPlatformId: (platformId: string) => Effect.Effect<string | null>;
  }
>()('telegram-grammy/GroupFolderService') {}

/**
 * AdapterConfigService — holds the bot token plus the three Promise-shaped
 * callbacks the host hands us via `ChannelSetup`. They are wrapped into
 * Effect-returning functions so the rest of the module never sees raw
 * Promises.
 */
export class AdapterConfigService extends Context.Service<
  AdapterConfigService,
  {
    readonly token: string;
    readonly onInbound: (
      platformId: string,
      threadId: string | null,
      message: InboundMessage,
    ) => Effect.Effect<void>;
    readonly onMetadata: ChannelSetup['onMetadata'];
    readonly onAction: ChannelSetup['onAction'];
  }
>()('telegram-grammy/AdapterConfigService') {}
