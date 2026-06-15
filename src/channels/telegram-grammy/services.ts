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
import type { FileApiFlavor } from '@grammyjs/files';
import type { Api, Bot, Context as GrammyContext, PollingOptions } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';

/**
 * Bot type with the `@grammyjs/files` API flavor applied. Hoists
 * `download()` / `getUrl()` onto `bot.api.getFile` results in the type
 * system so callers in `attachments.ts` don't need a cast.
 */
export type HydratedBot = Bot<GrammyContext, FileApiFlavor<Api>>;

import type { ChannelSetup, InboundMessage } from '../adapter.js';
import type { PairingRecord, ConsumeInput } from '../telegram-pairing.js';
import type { GrammyNetworkError, PairingFailed } from './errors.js';

/**
 * Cloud Bot API root. The default `apiRoot` in `AdapterConfigService`,
 * and the value `BotLayer` checks against to detect self-hosted mode.
 * Lives here (not runtime.ts) to avoid a runtime ↔ layers circular
 * import — `services.ts` has no inbound deps from this module.
 */
export const DEFAULT_API_ROOT = 'https://api.telegram.org';

/** Cloud Bot API hard caps. Telegram won't serve files past these. */
export const CLOUD_MAX_BYTES = 20_000_000;
/** Self-hosted Bot API server cap. 2 GB matches Telegram's documented limit. */
export const SELF_HOSTED_MAX_BYTES = 2_000_000_000;

/**
 * Bot-api server's working directory inside the aiogram container. The
 * `aiogram/telegram-bot-api` image's docker-entrypoint always passes
 * `--dir=/var/lib/telegram-bot-api`, so absolute `file_path` values
 * returned by `getFile` in `--local` mode start with this prefix. Used
 * by `remapTrustedLocalPath` as the only allowed root.
 */
export const CONTAINER_LOCAL_ROOT = '/var/lib/telegram-bot-api';

/**
 * BotService — grammY `Bot` instance + getMe result + lifecycle hooks.
 * The `start`/`stop` effects wrap `bot.start`/`bot.stop` so the polling
 * lifetime sits inside `Effect.acquireRelease` and is cleaned up on
 * runtime dispose.
 */
export class BotService extends Context.Service<
  BotService,
  {
    readonly bot: HydratedBot;
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

/**
 * GroupFolderService — messaging_group → absolute on-disk attachment dir
 * for the wired primary agent group. Returns the full resolved path
 * (under `GROUPS_DIR`) so callers don't have to combine the central-DB
 * folder lookup with a path-resolution helper. Returns `null` when the
 * platformId isn't paired yet.
 */
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
    /**
     * Telegram Bot API root. Defaults to the cloud `https://api.telegram.org`.
     * When the user runs a self-hosted Bot API server, this points at it
     * (e.g. `http://localhost:8081`) — lifts the cloud's 20 MB download /
     * 50 MB upload caps to 2 GB. See `/add-telegram-bot-api-server` skill.
     */
    readonly apiRoot: string;
    /**
     * Inbound attachment cap. 20 MB on cloud or non-`--local` self-hosted
     * (Telegram Bot API hard limit); up to 2 GB when self-hosted in
     * `--local` mode (`localFilesDir` set). `TELEGRAM_MAX_FILE_MB` overrides.
     */
    readonly maxFileSizeBytes: number;
    /**
     * Host-side absolute path where the bot-api server's
     * `/var/lib/telegram-bot-api` is bind-mounted. When set, `--local` mode
     * handling activates: `getFile` returns absolute container paths,
     * `buildFilePath` remaps them into this host directory, and the
     * `@grammyjs/files` plugin reads bytes via `fs.copyFile` instead of HTTP.
     * Unset = HTTP-only mode (cloud or non-`--local` self-hosted).
     */
    readonly localFilesDir: string | null;
    readonly onInbound: (platformId: string, threadId: string | null, message: InboundMessage) => Effect.Effect<void>;
    readonly onMetadata: ChannelSetup['onMetadata'];
    readonly onAction: ChannelSetup['onAction'];
  }
>()('telegram-grammy/AdapterConfigService') {}
