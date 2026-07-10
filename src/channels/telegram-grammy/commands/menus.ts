/**
 * Inline-keyboard menus for the chat-command binding.
 *
 * Hard plugin rules honored here:
 *  - ALL menus are created once (in `buildMenus`, called once per adapter
 *    setup) and registered into a single pool before `bot.use`. No menu is
 *    ever created inside a handler (that leaks memory).
 *  - Dynamic ranges are built by pure, stable factories: they only READ the
 *    DB and never mutate anything, so the send-render and the tap-render agree
 *    and the plugin can match the pressed button to its handler.
 *  - Mutable state (model / effort / window / cli_scope / wiring set) is folded
 *    into the menu FINGERPRINT (`menuFingerprint`), so a menu left open while
 *    the config changes elsewhere self-detects as outdated (default
 *    `onMenuOutdated` behavior: notify + re-render).
 *
 * Auth is re-checked on EVERY tap via the host service (setModel /
 * setConfigValue / restartAgent each re-run hasAdminPrivilege internally). A
 * denied tap gets an explicit "Admins only" alert - never silent. All menus
 * run `autoAnswer: false` so the denial alert is the ONLY answerCallbackQuery
 * for that tap (the plugin's default fork-answer would otherwise race it).
 *
 * The target agent is derived at TAP time from the callback message's chat id
 * + forum topic, threaded through an INDEX payload so multi-agent chats (none
 * exist today) pick the right agent without exceeding the 64-byte callback
 * budget.
 *
 * Typography: ASCII only ('-', '...', '->'); emoji allowed as UI glyphs.
 */
import { Effect } from 'effect';
import type { Context } from 'grammy';
import { Menu } from '@grammyjs/menu';

import {
  ACTIVATION_MODES,
  COMPACT_WINDOW_PRESETS,
  EFFORT_LEVELS,
  MODEL_CATALOG,
  getConfigView,
  getModelPicker,
  restartAgent,
  setActivation,
  setConfigValue,
  setModel,
  type CommandResult,
} from '../../../commands/index.js';
import type { AdapterRuntime } from '../runtime.js';

import {
  actorUserId,
  contextMessagingGroupId,
  contextTargetAgent,
  menuFingerprint,
  pickerFingerprint,
  readAgentIndex,
  resolveTargetsForContext,
} from './context.js';
import {
  activationChangeConfirmation,
  answer,
  configChangeConfirmation,
  configRootPrompt,
  editText,
  failureMessage,
  modelChangeConfirmation,
  modelPickerPrompt,
  restartConfirmation,
  restartPrompt,
  submenuPrompt,
} from './render.js';

// Menu ids. Kept short: they ride in every button's callback data.
export const MENU_ID = {
  configRoot: 'nc-cfg',
  model: 'nc-cfg-model',
  effort: 'nc-cfg-effort',
  window: 'nc-cfg-window',
  activation: 'nc-cfg-act',
  restart: 'nc-cfg-restart',
  pickModel: 'nc-pick-model',
  pickConfig: 'nc-pick-config',
} as const;

export interface CommandMenus {
  /** The pool root - pass ONLY this to `bot.use`. */
  root: Menu;
  configRoot: Menu;
  model: Menu;
  pickModel: Menu;
  pickConfig: Menu;
}

/** Compact-window preset -> "165k" style label. */
function windowLabel(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

/** Current-index payload for the button being emitted (threads multi-agent choice). */
function idxPayload(ctx: Context): string {
  return String(readAgentIndex(ctx));
}

export function buildMenus(runtime: AdapterRuntime): CommandMenus {
  const options = { autoAnswer: false as const, fingerprint: (ctx: Context): string => menuFingerprint(ctx) };
  const pickerOptions = { autoAnswer: false as const, fingerprint: (ctx: Context): string => pickerFingerprint(ctx) };

  // --- Leaf actions (Effect-wrapped, total) ---

  // Chat context for the current tap: activation config is keyed by the
  // (messaging group, agent) pair, so threadId is irrelevant here.
  const chatCtxOf = (ctx: Context): { messagingGroupId: string; threadId: string | null } | undefined => {
    const mgId = contextMessagingGroupId(ctx);
    return mgId ? { messagingGroupId: mgId, threadId: null } : undefined;
  };

  // Shared apply-and-confirm for the TERMINAL taps (model / effort / window /
  // activation mode / restart confirm). Resolves the target agent, runs the
  // host-service write, and on success COLLAPSES the menu (menu.close() is
  // lazy: it injects an empty keyboard into the next editMessageText), edits
  // the message to the confirmation, and answers with a lightweight toast. On
  // failure it keeps the keyboard and shows an alert toast.
  const applyChange = <V>(
    ctx: Context,
    run: (agentGroupId: string, actor: string) => CommandResult<V>,
    confirm: (view: V) => string,
    toast: string,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const target = contextTargetAgent(ctx);
      if (!target) return yield* answer(ctx, { text: 'No agent here', show_alert: true });
      const res = run(target.agentGroupId, actorUserId(ctx));
      if (!res.ok) return yield* answer(ctx, { text: failureMessage(res), show_alert: true });
      yield* Effect.sync(() => (ctx as Context & { menu: { close: () => void } }).menu.close());
      yield* editText(ctx, confirm(res.view));
      yield* answer(ctx, { text: toast });
    });

  // The Activation submenu's 'pattern' button cannot carry a typed regex, so it
  // does NOT write: it just tells the user how to set one via a typed command.
  const onPatternHint = (ctx: Context): Effect.Effect<void> =>
    answer(ctx, { text: 'To use a regex, type: /config set pattern <regex>', show_alert: true });

  // A navigation button's own answer (autoAnswer is off), plus an optional
  // text refresh so the submenu prompt matches its buttons.
  const navRefresh = (ctx: Context, markdown: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* editText(ctx, markdown);
      yield* answer(ctx);
    });

  const promptFor = (
    ctx: Context,
    kind: 'model' | 'effort' | 'window' | 'activation' | 'restart' | 'config',
  ): string => {
    const target = contextTargetAgent(ctx);
    const name = target?.agentName ?? 'agent';
    if (kind === 'model') {
      const picker = target ? getModelPicker(target.agentGroupId) : null;
      return picker && picker.ok ? modelPickerPrompt(picker.view) : `Pick a model for **${name}**`;
    }
    if (kind === 'effort') return submenuPrompt(name, 'effort');
    if (kind === 'window') return submenuPrompt(name, 'window');
    if (kind === 'activation') return submenuPrompt(name, 'activation');
    if (kind === 'restart') return restartPrompt(name);
    const view = target ? getConfigView(target.agentGroupId, chatCtxOf(ctx)) : null;
    return view && view.ok ? configRootPrompt(view.view) : `**${name}** config`;
  };

  // --- Menus ---

  const modelMenu = new Menu(MENU_ID.model, options);
  modelMenu.dynamic((ctx, range) => {
    const idx = idxPayload(ctx);
    const target = contextTargetAgent(ctx);
    const picker = target ? getModelPicker(target.agentGroupId) : null;
    const opts = picker && picker.ok ? picker.view.options : MODEL_CATALOG.map((m) => ({ ...m, active: false }));
    for (const opt of opts) {
      const label = `${opt.active ? '✅ ' : ''}${opt.label}`;
      range.text({ text: label, payload: idx }, (c) =>
        runtime.runPromise(
          applyChange(c, (ag, actor) => setModel(ag, opt.id, actor), modelChangeConfirmation, 'Model switched'),
        ),
      );
      range.row();
    }
    range.back({ text: 'Back', payload: idx }, (c) => runtime.runPromise(navRefresh(c, promptFor(c, 'config'))));
  });

  const effortMenu = new Menu(MENU_ID.effort, options);
  effortMenu.dynamic((ctx, range) => {
    const idx = idxPayload(ctx);
    const target = contextTargetAgent(ctx);
    const view = target ? getConfigView(target.agentGroupId) : null;
    const current = view && view.ok ? view.view.effort : null;
    for (const level of EFFORT_LEVELS) {
      const label = `${current === level ? '✅ ' : ''}${level}`;
      range.text({ text: label, payload: idx }, (c) =>
        runtime.runPromise(
          applyChange(
            c,
            (ag, actor) => setConfigValue(ag, 'effort', level, actor),
            configChangeConfirmation,
            'Effort set',
          ),
        ),
      );
      range.row();
    }
    range.back({ text: 'Back', payload: idx }, (c) => runtime.runPromise(navRefresh(c, promptFor(c, 'config'))));
  });

  const windowMenu = new Menu(MENU_ID.window, options);
  windowMenu.dynamic((ctx, range) => {
    const idx = idxPayload(ctx);
    const target = contextTargetAgent(ctx);
    const view = target ? getConfigView(target.agentGroupId) : null;
    const current = view && view.ok ? view.view.autoCompactWindow : null;
    for (const preset of COMPACT_WINDOW_PRESETS) {
      const label = `${current === preset ? '✅ ' : ''}${windowLabel(preset)}`;
      range.text({ text: label, payload: idx }, (c) =>
        runtime.runPromise(
          applyChange(
            c,
            (ag, actor) => setConfigValue(ag, 'auto-compact-window', String(preset), actor),
            configChangeConfirmation,
            'Compact window set',
          ),
        ),
      );
      range.row();
    }
    range.back({ text: 'Back', payload: idx }, (c) => runtime.runPromise(navRefresh(c, promptFor(c, 'config'))));
  });

  // Activation submenu: mention / mention-sticky apply immediately; 'pattern'
  // cannot ride a button (it needs a typed regex) so it only hints.
  const activationMenu = new Menu(MENU_ID.activation, options);
  activationMenu.dynamic((ctx, range) => {
    const idx = idxPayload(ctx);
    const target = contextTargetAgent(ctx);
    const view = target ? getConfigView(target.agentGroupId, chatCtxOf(ctx)) : null;
    const current = view && view.ok ? (view.view.activation?.engageMode ?? null) : null;
    for (const mode of ACTIVATION_MODES) {
      const label = `${current === mode ? '✅ ' : ''}${mode}`;
      if (mode === 'pattern') {
        range.text({ text: label, payload: idx }, (c) => runtime.runPromise(onPatternHint(c)));
      } else {
        range.text({ text: label, payload: idx }, (c) =>
          runtime.runPromise(
            applyChange(
              c,
              (ag, actor) => setActivation(contextMessagingGroupId(c) ?? '', ag, mode, null, actor),
              activationChangeConfirmation,
              'Activation updated',
            ),
          ),
        );
      }
      range.row();
    }
    range.back({ text: 'Back', payload: idx }, (c) => runtime.runPromise(navRefresh(c, promptFor(c, 'config'))));
  });

  const restartMenu = new Menu(MENU_ID.restart, options);
  restartMenu
    .text({ text: 'Yes, restart now', payload: idxPayload }, (c) =>
      runtime.runPromise(applyChange(c, (ag, actor) => restartAgent(ag, actor), restartConfirmation, 'Restarting')),
    )
    .row()
    .back({ text: 'Cancel', payload: idxPayload }, (c) => runtime.runPromise(navRefresh(c, promptFor(c, 'config'))));

  const configRoot = new Menu(MENU_ID.configRoot, options);
  configRoot
    .submenu({ text: 'Model', payload: idxPayload }, MENU_ID.model, (c) =>
      runtime.runPromise(navRefresh(c, promptFor(c, 'model'))),
    )
    .row()
    .submenu({ text: 'Effort', payload: idxPayload }, MENU_ID.effort, (c) =>
      runtime.runPromise(navRefresh(c, promptFor(c, 'effort'))),
    )
    .row()
    .submenu({ text: 'Compact window', payload: idxPayload }, MENU_ID.window, (c) =>
      runtime.runPromise(navRefresh(c, promptFor(c, 'window'))),
    )
    .row()
    .submenu({ text: 'Activation', payload: idxPayload }, MENU_ID.activation, (c) =>
      runtime.runPromise(navRefresh(c, promptFor(c, 'activation'))),
    )
    .row()
    .submenu({ text: 'Restart', payload: idxPayload }, MENU_ID.restart, (c) =>
      runtime.runPromise(navRefresh(c, promptFor(c, 'restart'))),
    );

  // Multi-agent pickers. One button per wired agent; payload = INDEX into the
  // deterministically-sorted resolveTargets list. Tapping navigates into the
  // requested flow for that agent (index threads onward via the payload).
  const pickModel = new Menu(MENU_ID.pickModel, pickerOptions);
  pickModel.dynamic((ctx, range) => {
    const res = resolveTargetsForContext(ctx);
    const agents = res.kind === 'multiple' ? res.agents : [];
    agents.forEach((a, i) => {
      range.submenu({ text: a.agentName, payload: String(i) }, MENU_ID.model, (c) =>
        runtime.runPromise(navRefresh(c, promptFor(c, 'model'))),
      );
      range.row();
    });
  });

  const pickConfig = new Menu(MENU_ID.pickConfig, pickerOptions);
  pickConfig.dynamic((ctx, range) => {
    const res = resolveTargetsForContext(ctx);
    const agents = res.kind === 'multiple' ? res.agents : [];
    agents.forEach((a, i) => {
      range.submenu({ text: a.agentName, payload: String(i) }, MENU_ID.configRoot, (c) =>
        runtime.runPromise(navRefresh(c, promptFor(c, 'config'))),
      );
      range.row();
    });
  });

  // Single pool: register every menu under the config root, then bot.use(root).
  configRoot.register(modelMenu);
  configRoot.register(effortMenu);
  configRoot.register(windowMenu);
  configRoot.register(activationMenu);
  configRoot.register(restartMenu);
  configRoot.register(pickModel);
  configRoot.register(pickConfig);

  return { root: configRoot, configRoot, model: modelMenu, pickModel, pickConfig };
}
