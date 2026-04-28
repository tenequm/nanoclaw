/**
 * ManagedRuntime construction.
 *
 * The adapter lives inside a Promise-based host, so the Effect world is
 * bounded to this module. `buildRuntime(config)` assembles every Layer
 * (Bot, Pairing, Transcription, GroupFolder, AdapterConfig) into one
 * composed Layer and wraps it in a `ManagedRuntime`. The adapter's public
 * methods call `runtime.runPromise(...)` at the boundary; errors are
 * caught inside the Effect world so nothing throws out.
 *
 * Disposing the runtime (on teardown) runs every `Effect.acquireRelease`
 * finalizer — stopping the bot, interrupting the polling fiber, etc.
 */
import path from 'path';
import { existsSync } from 'fs';

import { Effect, Layer, ManagedRuntime } from 'effect';

import type { ChannelSetup } from '../adapter.js';

import { GrammyNetworkError, TelegramConfigInvalid } from './errors.js';
import { BotLayer, GroupFolderLayer, PairingLayer, TranscriptionLayer } from './layers.js';
import {
  AdapterConfigService,
  CLOUD_MAX_BYTES,
  DEFAULT_API_ROOT,
  SELF_HOSTED_MAX_BYTES,
  type BotService,
  type GroupFolderService,
  type PairingService,
  type TranscriptionService,
} from './services.js';

export interface AdapterRuntimeConfig {
  readonly token: string;
  /** Raw `TELEGRAM_API_ROOT` from `.env`. Validated inside the layer. */
  readonly apiRootRaw: string | undefined;
  /** Raw `TELEGRAM_MAX_FILE_MB` from `.env`. Validated inside the layer. */
  readonly maxFileMbRaw: string | undefined;
  /** Raw `TELEGRAM_LOCAL_FILES_DIR` from `.env`. Validated inside the layer. */
  readonly localFilesDirRaw: string | undefined;
  readonly hostConfig: ChannelSetup;
}

type AdapterServices = BotService | PairingService | TranscriptionService | GroupFolderService | AdapterConfigService;

/**
 * Validate and normalize a user-supplied `apiRoot`. Returns the canonical
 * form (no trailing slash) or fails with `TelegramConfigInvalid`. Plain
 * `Effect.gen` rather than `Effect.fn` — this runs once at startup, span
 * tracing has no payoff.
 */
export function validateApiRoot(raw: string): Effect.Effect<string, TelegramConfigInvalid> {
  return Effect.gen(function* () {
    const trimmed = raw.trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return yield* Effect.fail(
        new TelegramConfigInvalid({
          field: 'TELEGRAM_API_ROOT',
          value: trimmed,
          reason: 'not a valid URL',
        }),
      );
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return yield* Effect.fail(
        new TelegramConfigInvalid({
          field: 'TELEGRAM_API_ROOT',
          value: trimmed,
          reason: `protocol must be http or https (got ${parsed.protocol})`,
        }),
      );
    }
    // Strip trailing slash so URL construction in attachments.ts can do
    // `${apiRoot}/file/bot...` without producing `//file/...`.
    return parsed.toString().replace(/\/$/, '');
  });
}

/**
 * Parse `TELEGRAM_MAX_FILE_MB` to bytes. Default lifts to 2 GB only when
 * the bot-api server is configured in `--local` mode (`isLocalMode = true`).
 * Cloud and non-`--local` self-hosted both keep the 20 MB protocol cap.
 */
export function validateMaxFileMb(
  raw: string | undefined,
  isLocalMode: boolean,
): Effect.Effect<number, TelegramConfigInvalid> {
  return Effect.gen(function* () {
    if (!raw) return isLocalMode ? SELF_HOSTED_MAX_BYTES : CLOUD_MAX_BYTES;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      return yield* Effect.fail(
        new TelegramConfigInvalid({
          field: 'TELEGRAM_MAX_FILE_MB',
          value: raw,
          reason: 'must be a positive number of megabytes',
        }),
      );
    }
    return Math.floor(n * 1_000_000);
  });
}

/**
 * Validate `TELEGRAM_LOCAL_FILES_DIR`. Must be an absolute path that
 * exists at startup — this is the host-side bind-mount target for the
 * bot-api server's `/var/lib/telegram-bot-api`. We don't try to verify
 * it's actually mounted (would race startup ordering); we just confirm
 * the directory is there. Trailing slash stripped.
 */
export function validateLocalFilesDir(raw: string): Effect.Effect<string, TelegramConfigInvalid> {
  return Effect.gen(function* () {
    const trimmed = raw.trim();
    if (!path.isAbsolute(trimmed)) {
      return yield* Effect.fail(
        new TelegramConfigInvalid({
          field: 'TELEGRAM_LOCAL_FILES_DIR',
          value: trimmed,
          reason: 'must be an absolute path',
        }),
      );
    }
    if (!existsSync(trimmed)) {
      return yield* Effect.fail(
        new TelegramConfigInvalid({
          field: 'TELEGRAM_LOCAL_FILES_DIR',
          value: trimmed,
          reason: 'directory does not exist (start the bot-api server with the bind-mount first)',
        }),
      );
    }
    return trimmed.replace(/\/$/, '');
  });
}

/**
 * `BotLayer` fails with `GrammyNetworkError` when cold-start `getMe` can't
 * reach Telegram after retries. `AdapterConfigService` fails with
 * `TelegramConfigInvalid` if the user's env vars don't parse. Both surface
 * as a rejection from `runtime.runPromise` during `setup()`, which the
 * host's retry policy in channel-registry.ts handles.
 */
export type AdapterLayerError = GrammyNetworkError | TelegramConfigInvalid;

/** Build the full layer tree used by the adapter runtime. */
export function buildAdapterLayer(config: AdapterRuntimeConfig): Layer.Layer<AdapterServices, AdapterLayerError> {
  const configLayer = Layer.effect(
    AdapterConfigService,
    Effect.gen(function* () {
      const apiRoot = config.apiRootRaw ? yield* validateApiRoot(config.apiRootRaw) : DEFAULT_API_ROOT;
      const localFilesDir = config.localFilesDirRaw ? yield* validateLocalFilesDir(config.localFilesDirRaw) : null;
      // `--local` mode = self-hosted server with the file-path bind-mount
      // wired through. Just `apiRoot` set without `localFilesDir` is "proxy
      // mode" — same 20 MB cap as cloud, no real benefit.
      const isLocalMode = localFilesDir !== null;
      const maxFileSizeBytes = yield* validateMaxFileMb(config.maxFileMbRaw, isLocalMode);

      return {
        token: config.token,
        apiRoot,
        maxFileSizeBytes,
        localFilesDir,
        // Host callbacks are Promise | void. Wrap them so the rest of the
        // module never sees a raw Promise — Effect.promise swallows errors
        // as defects, but the host callbacks are expected to be resilient
        // themselves and we don't want a host-side throw to kill the
        // inbound fiber.
        onInbound: (platformId, threadId, message) =>
          Effect.tryPromise({
            try: () => Promise.resolve(config.hostConfig.onInbound(platformId, threadId, message)),
            catch: (cause) => cause,
          }).pipe(Effect.catchCause(() => Effect.void)),
        onMetadata: config.hostConfig.onMetadata,
        onAction: config.hostConfig.onAction,
      };
    }),
  );

  // BotLayer depends on AdapterConfigService, PairingLayer has no deps,
  // others are flat. Provide config to the ones that need it.
  const botProvided = BotLayer.pipe(Layer.provide(configLayer));

  return Layer.mergeAll(configLayer, botProvided, PairingLayer, TranscriptionLayer, GroupFolderLayer);
}

export type AdapterRuntime = ManagedRuntime.ManagedRuntime<AdapterServices, AdapterLayerError>;

export function buildRuntime(config: AdapterRuntimeConfig): AdapterRuntime {
  return ManagedRuntime.make(buildAdapterLayer(config));
}
