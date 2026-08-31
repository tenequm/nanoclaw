/**
 * The @grammyjs/commands CommandGroup that HANDLES the four chat commands
 * (/status /model /config /restart) inside the telegram-grammy adapter.
 *
 * Design note (deviation from a naive plugin reading): each command carries a
 * DEFAULT handler, so it is handled in ANY chat the bot sees. The plugin ties
 * a command's popup SCOPE to its handler scope, but we need /status runnable
 * by non-admin members (who are in no admin scope) while keeping members out
 * of the popup. Those two requirements cannot coexist in a single plugin
 * Command, so popup registration is done separately by the direct-API scope
 * janitor (scope-sync.ts) and this group is used ONLY for handling. The
 * plugin's structural scoping is therefore not relied upon - every handler
 * re-derives the target and re-checks nanoclaw auth (defense in depth).
 *
 * Async boundary: the host DB layer is async, so DB-touching calls are folded
 * into the Effect world via Effect.promise. A rejection there is a defect and
 * surfaces through the bot.catch installed in commands/index.ts.
 *
 * Typography: ASCII only ('-', '...', '->'); emoji allowed as UI glyphs.
 */
import { Effect } from 'effect';
import type { Context } from 'grammy';
import { CommandGroup } from '@grammyjs/commands';

import {
  ACTIVATION_MODES,
  COMMANDS,
  CONFIG_FIELDS,
  getConfigView,
  getModelPicker,
  getStatus,
  isActivationMode,
  restartAgent,
  setActivation,
  setConfigValue,
  setModel,
  statusAccess,
  type ConfigField,
  type StatusChatContext,
  type TargetAgent,
} from '../../../commands/index.js';
import { log } from '../../../log.js';
import { hasAdminPrivilege } from '../../../modules/permissions/db/user-roles.js';
import type { AdapterRuntime } from '../runtime.js';

import { actorUserId, contextMessagingGroupId, resolveTargetsForContext } from './context.js';
import type { CommandMenus } from './menus.js';
import {
  activationChangeConfirmation,
  agentPickerPrompt,
  configChangeConfirmation,
  configRootPrompt,
  failureMessage,
  modelChangeConfirmation,
  modelPickerPrompt,
  reply,
  restartConfirmation,
  statusCard,
} from './render.js';

/** The telegram adapter is thread-less, so status/config chat context uses a null thread. */
async function chatContext(ctx: Context): Promise<StatusChatContext | undefined> {
  const mgId = await contextMessagingGroupId(ctx);
  return mgId ? { messagingGroupId: mgId, threadId: null } : undefined;
}

const ADMINS_ONLY = 'Admins only.';

async function isAdminOfAny(actor: string, agents: readonly TargetAgent[]): Promise<boolean> {
  for (const a of agents) {
    if (await hasAdminPrivilege(actor, a.agentGroupId)) return true;
  }
  return false;
}

/**
 * Silent drop for commands typed in chats with no wired agent. The router
 * deliberately stays silent in channels the bot merely sits in; replying here
 * would leak the bot's presence to arbitrary chats, so we only log.
 */
const dropNoAgent = (command: string, ctx: Context): Effect.Effect<void> =>
  Effect.sync(() => log.debug('telegram-grammy: command in unwired chat dropped', { command, chatId: ctx.chat?.id }));

function commandArg(ctx: Context): string {
  return typeof ctx.match === 'string' ? ctx.match.trim() : '';
}

export function buildCommandGroup(runtime: AdapterRuntime, menus: CommandMenus): CommandGroup<Context> {
  const group = new CommandGroup<Context>();

  // /status - member-runnable (agent_group_members gate), read-only.
  const onStatus = (ctx: Context): Effect.Effect<void> =>
    Effect.gen(function* () {
      const actor = actorUserId(ctx);
      const res = yield* Effect.promise(() => resolveTargetsForContext(ctx));
      if (res.kind === 'none') return yield* dropNoAgent('status', ctx);
      const agents = res.kind === 'single' ? [res.agent] : res.agents;
      // Decide access once per agent (single scan), then partition on it.
      const decided = yield* Effect.promise(() =>
        Promise.all(agents.map(async (a) => [a, await statusAccess(actor, a.agentGroupId)] as const)),
      );
      const accessible = decided.filter(([, d]) => d === 'allowed').map(([a]) => a);
      if (accessible.length === 0) {
        if (decided.some(([, d]) => d === 'refuse')) return yield* reply(ctx, 'No access.');
        return yield* dropNoAgent('status', ctx);
      }
      const chatCtx = yield* Effect.promise(() => chatContext(ctx));
      const cards = yield* Effect.promise(() =>
        Promise.all(
          accessible.map(async (a) => {
            const s = await getStatus(a.agentGroupId, chatCtx);
            return s.ok ? statusCard(s.view) : `**${a.agentName}**: ${failureMessage(s)}`;
          }),
        ),
      );
      yield* reply(ctx, cards.join('\n\n'));
    });

  // /model [alias-or-id] - admin only.
  const onModel = (ctx: Context): Effect.Effect<void> =>
    Effect.gen(function* () {
      const actor = actorUserId(ctx);
      const arg = commandArg(ctx);
      const res = yield* Effect.promise(() => resolveTargetsForContext(ctx));
      if (res.kind === 'none') return yield* dropNoAgent('command', ctx);
      if (res.kind === 'single') {
        const ag = res.agent.agentGroupId;
        const isAdmin = yield* Effect.promise(() => hasAdminPrivilege(actor, ag));
        if (!isAdmin) return yield* reply(ctx, ADMINS_ONLY);
        if (arg) {
          const r = yield* Effect.promise(() => setModel(ag, arg, actor));
          return yield* reply(ctx, r.ok ? modelChangeConfirmation(r.view) : failureMessage(r));
        }
        const picker = yield* Effect.promise(() => getModelPicker(ag));
        const prompt = picker.ok ? modelPickerPrompt(picker.view) : failureMessage(picker);
        return yield* reply(ctx, prompt, menus.model);
      }
      const anyAdmin = yield* Effect.promise(() => isAdminOfAny(actor, res.agents));
      if (!anyAdmin) return yield* reply(ctx, ADMINS_ONLY);
      yield* reply(ctx, agentPickerPrompt('model', res.agents), menus.pickModel);
    });

  // /config [set <field> <value>] - admin only.
  const onConfig = (ctx: Context): Effect.Effect<void> =>
    Effect.gen(function* () {
      const actor = actorUserId(ctx);
      const arg = commandArg(ctx);
      const res = yield* Effect.promise(() => resolveTargetsForContext(ctx));
      if (res.kind === 'none') return yield* dropNoAgent('command', ctx);

      const isSet = /^set(\s|$)/i.test(arg);
      if (isSet) {
        if (res.kind === 'multiple') {
          return yield* reply(
            ctx,
            "This chat has multiple agents. Set config in the agent's own topic, or via /config.",
          );
        }
        const ag = res.agent.agentGroupId;
        const isAdmin = yield* Effect.promise(() => hasAdminPrivilege(actor, ag));
        if (!isAdmin) return yield* reply(ctx, ADMINS_ONLY);
        const tokens = arg.split(/\s+/);
        const field = (tokens[1] ?? '').toLowerCase();
        const value = tokens.slice(2).join(' ');
        if (!field || !value) {
          return yield* reply(
            ctx,
            `Usage: /config set <field> <value>. Fields: ${CONFIG_FIELDS.join(', ')}, activation, pattern`,
          );
        }

        // Activation lives on the wiring row, not container config, and applies
        // immediately (no container kill).
        if (field === 'activation' || field === 'pattern') {
          const mgId = yield* Effect.promise(() => contextMessagingGroupId(ctx));
          if (!mgId) return yield* reply(ctx, failureMessage({ ok: false, reason: 'unknown-agent' }));
          if (field === 'pattern') {
            const r = yield* Effect.promise(() => setActivation(mgId, ag, 'pattern', value, actor));
            return yield* reply(ctx, r.ok ? activationChangeConfirmation(r.view) : failureMessage(r));
          }
          if (!isActivationMode(value)) {
            return yield* reply(
              ctx,
              failureMessage({
                ok: false,
                reason: 'invalid-value',
                detail: { field: 'activation', value, allowed: ACTIVATION_MODES },
              }),
            );
          }
          const r = yield* Effect.promise(() => setActivation(mgId, ag, value, null, actor));
          return yield* reply(ctx, r.ok ? activationChangeConfirmation(r.view) : failureMessage(r));
        }

        if (!(CONFIG_FIELDS as readonly string[]).includes(field)) {
          return yield* reply(ctx, `Unknown field ${field}. Fields: ${CONFIG_FIELDS.join(', ')}, activation, pattern`);
        }
        const r = yield* Effect.promise(() => setConfigValue(ag, field as ConfigField, value, actor));
        return yield* reply(ctx, r.ok ? configChangeConfirmation(r.view) : failureMessage(r));
      }

      if (res.kind === 'single') {
        const ag = res.agent.agentGroupId;
        const isAdmin = yield* Effect.promise(() => hasAdminPrivilege(actor, ag));
        if (!isAdmin) return yield* reply(ctx, ADMINS_ONLY);
        const chatCtx = yield* Effect.promise(() => chatContext(ctx));
        const view = yield* Effect.promise(() => getConfigView(ag, chatCtx));
        const prompt = view.ok ? configRootPrompt(view.view) : failureMessage(view);
        return yield* reply(ctx, prompt, menus.configRoot);
      }
      const anyAdmin = yield* Effect.promise(() => isAdminOfAny(actor, res.agents));
      if (!anyAdmin) return yield* reply(ctx, ADMINS_ONLY);
      yield* reply(ctx, agentPickerPrompt('config', res.agents), menus.pickConfig);
    });

  // /restart - admin only, typed = immediate (no confirm).
  const onRestart = (ctx: Context): Effect.Effect<void> =>
    Effect.gen(function* () {
      const actor = actorUserId(ctx);
      const res = yield* Effect.promise(() => resolveTargetsForContext(ctx));
      if (res.kind === 'none') return yield* dropNoAgent('command', ctx);
      if (res.kind === 'single') {
        const ag = res.agent.agentGroupId;
        const isAdmin = yield* Effect.promise(() => hasAdminPrivilege(actor, ag));
        if (!isAdmin) return yield* reply(ctx, ADMINS_ONLY);
        const r = yield* Effect.promise(() => restartAgent(ag, actor));
        return yield* reply(ctx, r.ok ? restartConfirmation(r.view) : failureMessage(r));
      }
      const anyAdmin = yield* Effect.promise(() => isAdminOfAny(actor, res.agents));
      if (!anyAdmin) return yield* reply(ctx, ADMINS_ONLY);
      yield* reply(ctx, 'This chat has multiple agents. Restart each from its own topic, or via /config -> Restart.');
    });

  group.command('status', COMMANDS.status.description, (ctx) => runtime.runPromise(onStatus(ctx)));
  group.command('model', COMMANDS.model.description, (ctx) => runtime.runPromise(onModel(ctx)));
  group.command('config', COMMANDS.config.description, (ctx) => runtime.runPromise(onConfig(ctx)));
  group.command('restart', COMMANDS.restart.description, (ctx) => runtime.runPromise(onRestart(ctx)));

  return group;
}
