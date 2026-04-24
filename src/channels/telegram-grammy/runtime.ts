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
import { Effect, Layer, ManagedRuntime } from 'effect';

import type { ChannelSetup } from '../adapter.js';

import type { GrammyNetworkError } from './errors.js';
import { BotLayer, GroupFolderLayer, PairingLayer, TranscriptionLayer } from './layers.js';
import {
  AdapterConfigService,
  type BotService,
  type GroupFolderService,
  type PairingService,
  type TranscriptionService,
} from './services.js';

export interface AdapterRuntimeConfig {
  readonly token: string;
  readonly hostConfig: ChannelSetup;
}

type AdapterServices = BotService | PairingService | TranscriptionService | GroupFolderService | AdapterConfigService;

/**
 * `BotLayer` fails with `GrammyNetworkError` when cold-start `getMe` can't
 * reach Telegram after retries. That surfaces as a rejection from
 * `runtime.runPromise` during `setup()`, which the host's retry policy in
 * channel-registry.ts handles. No need to suppress it at the layer level.
 */
export type AdapterLayerError = GrammyNetworkError;

/** Build the full layer tree used by the adapter runtime. */
export function buildAdapterLayer(config: AdapterRuntimeConfig): Layer.Layer<AdapterServices, AdapterLayerError> {
  const configLayer = Layer.succeed(AdapterConfigService, {
    token: config.token,
    // Host callbacks are Promise | void. Wrap them so the rest of the module
    // never sees a raw Promise — Effect.promise swallows errors as defects,
    // but the host callbacks are expected to be resilient themselves and we
    // don't want a host-side throw to kill the inbound fiber.
    onInbound: (platformId, threadId, message) =>
      Effect.tryPromise({
        try: () => Promise.resolve(config.hostConfig.onInbound(platformId, threadId, message)),
        catch: (cause) => cause,
      }).pipe(Effect.catchCause(() => Effect.void)),
    onMetadata: config.hostConfig.onMetadata,
    onAction: config.hostConfig.onAction,
  });

  // BotLayer depends on AdapterConfigService, PairingLayer has no deps,
  // others are flat. Provide config to the ones that need it.
  const botProvided = BotLayer.pipe(Layer.provide(configLayer));

  return Layer.mergeAll(configLayer, botProvided, PairingLayer, TranscriptionLayer, GroupFolderLayer);
}

export type AdapterRuntime = ManagedRuntime.ManagedRuntime<AdapterServices, AdapterLayerError>;

export function buildRuntime(config: AdapterRuntimeConfig): AdapterRuntime {
  return ManagedRuntime.make(buildAdapterLayer(config));
}
