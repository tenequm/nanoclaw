/**
 * View rendering + grammY IO for the chat-command binding.
 *
 * Two halves:
 *  1. Pure text builders that turn host command-service view-models into a
 *     markdown string. They emit the SAME markdown dialect the outbound path
 *     already renders (`renderFS`), so bold/code/etc. become Telegram entities
 *     rather than a server-parsed parse_mode - the island's whole reliability
 *     story (no GrammyEntityError class) is preserved.
 *  2. Effect helpers that actually call grammY (reply / edit / answer),
 *     wrapped in `Effect.tryPromise` per the island rule (no bare try/catch).
 *     Every helper is total - errors are logged and swallowed so a transient
 *     Telegram failure never rejects a menu tap.
 *
 * Typography: ASCII only ('-', '...', '->'); emoji allowed as UI glyphs.
 */
import { Effect } from 'effect';
import type { Context } from 'grammy';
import { GrammyError } from 'grammy';

import * as cards from '../../../commands/cards.js';
import { MD_FMT } from '../../../commands/cards.js';
import type {
  ActivationChangeView,
  CommandFailure,
  CommandName,
  ConfigChangeView,
  ConfigView,
  ModelChangeView,
  ModelPickerView,
  RestartView,
  StatusView,
  TargetAgent,
} from '../../../commands/index.js';
import { renderFS } from '../formatter.js';

// --- grammY IO (Effect-wrapped, total) ---

interface Renderable {
  readonly text: string;
  readonly entities: unknown[];
}

function render(markdown: string): Renderable {
  const fs = renderFS(markdown);
  return { text: fs.text, entities: fs.entities as unknown[] };
}

/** Reply to the triggering message, optionally attaching a menu keyboard. */
export const reply = (ctx: Context, markdown: string, replyMarkup?: unknown): Effect.Effect<void> => {
  const r = render(markdown);
  return Effect.tryPromise({
    try: () =>
      ctx.reply(r.text, {
        entities: r.entities as never,
        link_preview_options: { is_disabled: true },
        ...(replyMarkup ? { reply_markup: replyMarkup as never } : {}),
      }),
    catch: (err) => err,
  }).pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.logWarning('telegram-grammy: command reply failed', { cause })),
  );
};

/**
 * Edit the current message text. Guards Telegram's "message is not modified"
 * 400 (identical content) as a no-op, which happens when a user taps the
 * already-selected option twice. Any menu keyboard is re-injected by the menu
 * plugin's transformer when this runs inside a menu handler.
 */
export const editText = (ctx: Context, markdown: string): Effect.Effect<void> => {
  const r = render(markdown);
  return Effect.tryPromise({
    try: () => ctx.editMessageText(r.text, { entities: r.entities as never }),
    catch: (err) => err,
  }).pipe(
    Effect.asVoid,
    Effect.catch((err) => {
      if (err instanceof GrammyError && /message is not modified/i.test(err.description)) {
        return Effect.void;
      }
      return Effect.logWarning('telegram-grammy: command editText failed', { err: String(err) });
    }),
  );
};

/** Answer a callback query (empty for success, or an alert toast for denial). */
export const answer = (ctx: Context, opts?: { text: string; show_alert?: boolean }): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => ctx.answerCallbackQuery(opts),
    catch: (err) => err,
  }).pipe(
    Effect.asVoid,
    Effect.catchCause(() => Effect.void),
  );

// --- Text builders (Telegram markdown; delegate to the shared card builders) ---

/** Compact status card (Hermes-style). */
export function statusCard(v: StatusView): string {
  return cards.statusCardLines(v, MD_FMT).join('\n');
}

/** Prompt shown above the model picker keyboard. */
export function modelPickerPrompt(v: ModelPickerView): string {
  return cards.modelPickerPrompt(v, MD_FMT);
}

/** Confirmation after a model switch. */
export function modelChangeConfirmation(v: ModelChangeView): string {
  return cards.modelChangeConfirmation(v, MD_FMT);
}

/** Prompt above the /config root menu. */
export function configRootPrompt(v: ConfigView): string {
  return cards.configRootLines(v, MD_FMT).join('\n');
}

/** Confirmation after a /config scalar change. */
export function configChangeConfirmation(v: ConfigChangeView): string {
  return cards.configChangeConfirmation(v, MD_FMT);
}

/** Confirmation after an activation change (applies immediately). */
export function activationChangeConfirmation(v: ActivationChangeView): string {
  return cards.activationChangeConfirmation(v, MD_FMT);
}

/** Submenu prompt for effort / window / activation pickers. */
export function submenuPrompt(agentName: string, what: 'effort' | 'window' | 'activation'): string {
  return cards.submenuPrompt(agentName, what, MD_FMT);
}

/** Prompt for the restart confirm submenu. */
export function restartPrompt(agentName: string): string {
  return cards.restartPrompt(agentName, MD_FMT);
}

/** Confirmation after a restart. */
export function restartConfirmation(v: RestartView): string {
  return cards.restartConfirmation(v, MD_FMT);
}

/** Prompt above the multi-agent picker. */
export function agentPickerPrompt(command: CommandName, agents: readonly TargetAgent[]): string {
  return cards.agentPickerPrompt(command, agents, MD_FMT);
}

/** Human-readable message for a command failure (data -> prose). */
export function failureMessage(failure: CommandFailure): string {
  return cards.failureMessage(failure);
}
