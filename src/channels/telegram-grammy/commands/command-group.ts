/**
 * The @grammyjs/commands CommandGroup that HANDLES the chat commands
 * (/status /model /config /restart /voice) inside the telegram-grammy adapter.
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
import type { Api, Context } from 'grammy';
import type { Message } from 'grammy/types';
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
import { getChannelAdapterExact } from '../../channel-registry.js';
import type { InboundEvent } from '../../adapter.js';
import { mapGrammyError } from '../errors.js';
import { log } from '../../../log.js';
import { hasAdminPrivilege } from '../../../modules/permissions/db/user-roles.js';
import type { AdapterRuntime } from '../runtime.js';

import {
  actorUserId,
  CHANNEL,
  contextPlatformId,
  contextMessagingGroupId,
  resolveTargetsForContext,
} from './context.js';
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

/** A sender-only reply in the command's chat (see sendEphemeralReply). */
type PrivateReply = (text: string) => Promise<'sent' | 'unavailable' | 'public'>;
/** The voice-mode adapter's `/voice` handler (src/channels/voice-mode.ts), typed here so this file builds without the skill. */
type VoiceCommandHandler = (event: InboundEvent, privateReply: PrivateReply) => Promise<boolean>;
/** The voice-mode skill's command module, named by a variable so this file builds after REMOVE.md deletes it. */
const VOICE_COMMAND_MODULE = '../../voice-mode-command.js';

function commandArg(ctx: Context): string {
  return typeof ctx.match === 'string' ? ctx.match.trim() : '';
}

/**
 * Send `text` to the command's sender only, as a Telegram ephemeral message in the command's chat and
 * topic, answering the incoming ephemeral command when it was one (that reply is allowed for 15 s).
 * A response that is not ephemeral to the sender may have been seen by others: it is deleted at once
 * and reported as `public`. Errors are logged by kind and description only: the request holds the text.
 */
async function sendEphemeralReply(
  api: Api,
  msg: Pick<Message, 'chat' | 'ephemeral_message_id' | 'is_topic_message' | 'message_thread_id'>,
  receiverId: number,
  text: string,
): ReturnType<PrivateReply> {
  const chatId = msg.chat.id;
  const failed = (method: string, err: unknown) => {
    const mapped = mapGrammyError(err, method, String(chatId));
    return { error: mapped._tag, description: 'description' in mapped ? mapped.description : undefined };
  };
  let sent: Message.TextMessage;
  try {
    sent = await api.sendMessage(chatId, text, {
      ephemeral_message_parameters: { receiver_user_id: receiverId },
      ...(msg.ephemeral_message_id !== undefined
        ? { reply_parameters: { ephemeral_message_id: msg.ephemeral_message_id } }
        : {}),
      ...(msg.is_topic_message && msg.message_thread_id !== undefined
        ? { message_thread_id: msg.message_thread_id }
        : {}),
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    log.warn('telegram-grammy: ephemeral reply not sent', failed('sendMessage-ephemeral', err));
    return 'unavailable';
  }
  if (sent.message_id === 0 && sent.receiver_user?.id === receiverId && sent.ephemeral_message_id !== undefined) {
    return 'sent';
  }
  // An ephemeral message shown to someone else has no message id: it is deleted by its ephemeral id.
  const { ephemeral_message_id: ephemeralId, receiver_user: receiver } = sent;
  const method = ephemeralId !== undefined && receiver ? 'deleteEphemeralMessage' : 'deleteMessage';
  const removal =
    ephemeralId !== undefined && receiver
      ? api.deleteEphemeralMessage(chatId, receiver.id, ephemeralId)
      : api.deleteMessage(chatId, sent.message_id);
  await removal.catch((err: unknown) =>
    log.error('telegram-grammy: a private reply went public and could not be deleted', failed(method, err)),
  );
  return 'public';
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

  // /voice - answered by the voice-mode command (src/channels/voice-mode-command.ts), which checks
  // the sender's role; in a group its reply goes out ephemeral, so only the sender sees the link.
  const onVoice = (ctx: Context): Effect.Effect<void> =>
    Effect.promise(async () => {
      const platformId = contextPlatformId(ctx);
      const msg = ctx.msg;
      const from = ctx.from;
      if (!platformId || !msg || !from) return;
      const event: InboundEvent = {
        channelType: CHANNEL,
        instance: CHANNEL,
        platformId,
        threadId: null,
        message: {
          id: String(msg.message_id),
          kind: 'chat',
          content: JSON.stringify({ text: `/voice ${commandArg(ctx)}`, senderId: actorUserId(ctx) }),
          timestamp: new Date(msg.date * 1000).toISOString(),
        },
      };
      const privateReply = (text: string) => sendEphemeralReply(ctx.api, msg, from.id, text);
      const voice = getChannelAdapterExact('voice-mode') as { handleVoiceCommand?: VoiceCommandHandler } | undefined;
      if (voice?.handleVoiceCommand) return void (await voice.handleVoiceCommand(event, privateReply));
      // No voice-mode channel running: the skill's command module says calls are off, if the skill is installed.
      const skill = (await import(VOICE_COMMAND_MODULE).catch(() => undefined)) as
        | { handleVoiceCommand?: (event: InboundEvent, callUrl: null, reply: PrivateReply) => Promise<boolean> }
        | undefined;
      if (skill?.handleVoiceCommand) await skill.handleVoiceCommand(event, null, privateReply);
    });

  group.command('status', COMMANDS.status.description, (ctx) => runtime.runPromise(onStatus(ctx)));
  group.command('model', COMMANDS.model.description, (ctx) => runtime.runPromise(onModel(ctx)));
  group.command('config', COMMANDS.config.description, (ctx) => runtime.runPromise(onConfig(ctx)));
  group.command('restart', COMMANDS.restart.description, (ctx) => runtime.runPromise(onRestart(ctx)));
  group.command('voice', COMMANDS.voice.description, (ctx) => runtime.runPromise(onVoice(ctx)));

  return group;
}
