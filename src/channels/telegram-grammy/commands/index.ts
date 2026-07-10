/**
 * Chat-command binding entrypoint for the telegram-grammy adapter.
 *
 * `installChatCommands` wires the native binding into the bot in the exact
 * order the menu + commands plugins require, and runs the startup scope
 * janitor. It MUST be called during adapter setup BEFORE the adapter's own
 * message / callback_query handlers are registered, so:
 *
 *   1. bot.catch is set FIRST. grammY's default error handler rethrows, which
 *      STOPS bot.start(); the island had no bot.catch because every existing
 *      handler is Effect-wrapped. The command / menu plugins are plain grammY
 *      middleware, so an uncaught throw there would otherwise kill polling.
 *   2. bot.use(menu) runs before any middleware that reads callback_query data
 *      (the menu plugin claims + auto-answers its own callbacks, then calls
 *      next for everything else, so the island's `ncq:` catch-all stays last
 *      and never double-answers a menu tap).
 *   3. bot.use(commandGroup) handles /status /model /config /restart; non-command
 *      messages fall through to the existing message handler unchanged.
 *
 * Typography: ASCII only ('-', '...', '->').
 */
import { Effect } from 'effect';

import { log } from '../../../log.js';
import type { HydratedBot } from '../services.js';
import type { AdapterRuntime } from '../runtime.js';

import { buildCommandGroup } from './command-group.js';
import { buildMenus } from './menus.js';
import { syncCommandScopes } from './scope-sync.js';

/**
 * Install the four chat commands + their menus, then kick off the startup
 * scope janitor. Total: the janitor cannot throw out, and the sync wiring is
 * plain grammY registration.
 *
 * The janitor is FORKED (not awaited): its Telegram round-trips are slow and
 * unrelated to handler registration, so blocking setup on them would delay
 * polling. It runs as a detached fiber that lives for the runtime's scope, and
 * is already catch-all-logged so a failure only shows up in the log.
 */
export const installChatCommands = (bot: HydratedBot, runtime: AdapterRuntime): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      bot.catch((err) => {
        log.error('telegram-grammy: uncaught bot error', {
          error: String(err.error),
          update_id: err.ctx?.update?.update_id,
        });
      });
    });

    const menus = buildMenus(runtime);
    const commandGroup = buildCommandGroup(runtime, menus);

    yield* Effect.sync(() => {
      bot.use(menus.root);
      bot.use(commandGroup);
    });

    yield* Effect.forkDetach(syncCommandScopes(bot.api));
  });
