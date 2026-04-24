/**
 * Supervised long-polling loop.
 *
 * `bot.start(opts)` resolves when `bot.stop()` is called or when the poll
 * loop throws (network outage, transient Telegram error). We wrap it in
 * `Effect.retry` with a bounded exponential schedule so transient failures
 * don't permanently kill the adapter, and so runaway failures eventually
 * give up instead of spinning forever.
 *
 * Teardown is handled by the BotService's `Effect.acquireRelease` in
 * layers.ts — disposing the ManagedRuntime interrupts this effect and
 * calls `bot.stop()` in the finalizer.
 */
import { Effect, Schedule } from 'effect';

import { BotService } from './services.js';

export interface PollingOpts {
  readonly allowedUpdates?: ReadonlyArray<string>;
}

/**
 * Run grammY's polling loop with bounded exponential backoff on failure.
 * Returns only when the loop shuts down cleanly (stop signal) or the
 * retry policy exhausts (5 consecutive failures).
 */
export const runSupervisedPolling = Effect.fn('telegram-grammy.runSupervisedPolling')(
  function* (opts: PollingOpts) {
    const { start } = yield* BotService;

    yield* start({
      allowed_updates: opts.allowedUpdates as never,
    }).pipe(
      Effect.retry({ schedule: Schedule.exponential('1 second'), times: 5 }),
      Effect.tapCause((cause) =>
        Effect.logError('telegram-grammy: polling gave up after retries', { cause }),
      ),
    );
  },
);
