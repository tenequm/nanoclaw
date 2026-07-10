/**
 * Channel-agnostic renderer for the host-command gate action.
 *
 * The router intercepts /model, /status, /config and /restart once per message
 * (see command-gate.classifyHostCommand + router.routeInbound) and hands them
 * here. This module turns the HostCommandService view-models into plain-text
 * replies (or, for the /model bare picker, an ask_question card) and writes
 * them straight to the session outbound DB via writeOutboundDirect, exactly as
 * the router's permission-deny path does. It never delivers anything to the
 * container.
 *
 * On channels with a native command binding (Telegram, Phase 3) these commands
 * are handled at the adapter and never reach here; this is the uniform backstop
 * for every other channel, and for Telegram when the native binding is absent.
 *
 * ---
 * Host-written ask_question card (the /model bare picker):
 *
 * A card written through writeOutboundDirect is a normal messages_out row. The
 * host delivery poll (delivery.deliverMessage) sees `type: 'ask_question'` and
 * persists a pending_questions row (delivery.ts, guarded by the interactive
 * module's table) before delivering the buttons, so the host-authored card
 * rides the exact same pipeline as a container-authored one. When a button is
 * tapped, dispatchResponse walks the response handlers in registration order.
 *
 * The generic interactive module would otherwise claim ANY pending_questions
 * row and route a question_response INTO the container, which would confuse a
 * container that never asked. It no longer can: the interactive handler skips
 * every 'hcmd-' questionId (see src/modules/interactive/index.ts), so those
 * rows are ours regardless of handler registration order. The up-front pending
 * row delete below is therefore NOT what makes ordering safe (an interactive
 * handler that ran first would still find the row present) - the namespace skip
 * is. The delete only guards against a duplicate tap double-applying.
 *
 * ---
 * Typography rule for this module: ASCII only in user-facing strings and
 * comments (no em-dash, en-dash, smart quotes, unicode ellipsis, arrows,
 * bullet chars, or non-breaking space). Emoji are allowed as UI glyphs (the
 * checkmark on the active model is intentional).
 */
import type { InboundEvent } from '../channels/adapter.js';
import { getDb, hasTable } from '../db/connection.js';
import { deletePendingQuestion, getPendingQuestion, getSession } from '../db/sessions.js';
import { log } from '../log.js';
import { hasAdminPrivilege } from '../modules/permissions/db/user-roles.js';
import { registerResponseHandler, type ResponsePayload } from '../response-registry.js';
import { resolveSession, writeOutboundDirect } from '../session-manager.js';
import type { MessagingGroup, MessagingGroupAgent, Session } from '../types.js';
import {
  activationChangeConfirmation,
  configChangeConfirmation,
  configRootLines,
  failureMessage,
  getConfigView,
  getModelPicker,
  getStatus,
  isActivationMode,
  modelChangeConfirmation,
  resolveTargets,
  restartAgent,
  restartConfirmation,
  setActivation,
  setConfigValue,
  setModel,
  statusAccess,
  statusCardLines,
  ACTIVATION_MODES,
  CONFIG_FIELDS,
  EFFORT_LEVELS,
  MODEL_ALIASES,
  PLAIN_FMT,
  type CommandName,
  type ConfigField,
  type ConfigView,
  type ModelPickerView,
  type ModelRef,
  type StatusChatContext,
  type StatusView,
  type TargetAgent,
  type TargetResolution,
} from './index.js';

/** Checkmark shown on the active model in the picker (emoji allowed). */
const ACTIVE_MARK = '✅'; // white heavy check mark

function rand(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Everything the router hands the fallback for one host command. */
export interface HostCommandContext {
  command: CommandName;
  args: string;
  mg: MessagingGroup;
  event: InboundEvent;
  /** Namespaced sender id (e.g. "telegram:123"), or null when unresolved. */
  userId: string | null;
  /** The messaging group's wirings, for session-mode lookup. */
  agents: readonly MessagingGroupAgent[];
  adapterSupportsThreads: boolean;
}

/**
 * Entry point. Classifies the target(s) and renders the requested command.
 * Runs exactly once per message. Catch-and-log is the caller's responsibility;
 * this function may throw on a genuinely broken DB, which the router logs.
 */
export function runHostCommand(ctx: HostCommandContext): void {
  const targets = resolveTargets(ctx.mg.id);
  switch (ctx.command) {
    case 'status':
      handleStatus(ctx, targets);
      return;
    case 'model':
      handleModel(ctx, targets);
      return;
    case 'config':
      handleConfig(ctx, targets);
      return;
    case 'restart':
      handleRestart(ctx, targets);
      return;
    default:
      log.warn('Unknown host command', { command: ctx.command });
  }
}

// --- Delivery helpers ---

function deliveryAddr(ctx: HostCommandContext): { channelType: string; platformId: string; threadId: string | null } {
  return (
    ctx.event.replyTo ?? {
      channelType: ctx.event.channelType,
      platformId: ctx.event.platformId,
      threadId: ctx.event.threadId,
    }
  );
}

/**
 * Resolve (find-or-create) a session for the target agent so we have an
 * outbound DB to write the reply into. The session merely carries the reply to
 * the chat; delivery routes by (channel_type, platform_id, thread_id), not by
 * which session the row rode. Returns null when the chat has no wiring for the
 * agent (should not happen given the router only calls us for wired chats).
 */
function sessionForAgent(ctx: HostCommandContext, agentGroupId: string): Session | null {
  const wiring = ctx.agents.find((a) => a.agent_group_id === agentGroupId);
  if (!wiring) return null;

  // Mirror deliverToAgent: a threaded adapter in a group chat forces a
  // per-thread session so the reply lands in the right topic.
  let mode = wiring.session_mode;
  if (ctx.adapterSupportsThreads && mode !== 'agent-shared' && ctx.mg.is_group !== 0) {
    mode = 'per-thread';
  }
  const { session } = resolveSession(agentGroupId, ctx.mg.id, ctx.event.threadId, mode);
  return session;
}

/** Where a plain-text reply lands: the delivery routes by this triple. */
interface ReplyAddr {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
}

/** Write a plain-text host-command reply straight to the session outbound DB. */
function writeTextReply(agentGroupId: string, sessionId: string, addr: ReplyAddr, text: string): void {
  writeOutboundDirect(agentGroupId, sessionId, {
    id: `hcmd-reply-${rand()}`,
    kind: 'chat',
    platformId: addr.platformId,
    channelType: addr.channelType,
    threadId: addr.threadId,
    content: JSON.stringify({ text }),
  });
}

function replyText(ctx: HostCommandContext, session: Session, text: string): void {
  writeTextReply(session.agent_group_id, session.id, deliveryAddr(ctx), text);
}

/** Resolve a session for the first target and reply, or log if none exists. */
function replyOnFirstTarget(ctx: HostCommandContext, targets: TargetResolution, text: string): void {
  const first = firstTarget(targets);
  if (!first) {
    log.warn('Host command has no target agent to reply through', {
      command: ctx.command,
      messagingGroupId: ctx.mg.id,
    });
    return;
  }
  const session = sessionForAgent(ctx, first.agentGroupId);
  if (!session) {
    log.warn('Host command could not resolve a session', { command: ctx.command, agentGroupId: first.agentGroupId });
    return;
  }
  replyText(ctx, session, text);
}

function firstTarget(targets: TargetResolution): TargetAgent | null {
  if (targets.kind === 'single') return targets.agent;
  if (targets.kind === 'multiple') return targets.agents[0];
  return null;
}

function agentNames(targets: TargetResolution): string {
  if (targets.kind === 'single') return targets.agent.agentName;
  if (targets.kind === 'multiple') return targets.agents.map((a) => a.agentName).join(', ');
  return '';
}

function isAdmin(userId: string | null, agentGroupId: string): boolean {
  return userId != null && hasAdminPrivilege(userId, agentGroupId);
}

/** Log-and-return for a host command typed in a chat with no wired agent. */
function logNoAgent(command: CommandName, ctx: HostCommandContext): void {
  log.info(`/${command} on a chat with no wired agent`, { messagingGroupId: ctx.mg.id });
}

/** Chat context (mg + thread) for status/config reads. */
function chatContext(ctx: HostCommandContext): StatusChatContext {
  return { messagingGroupId: ctx.mg.id, threadId: ctx.event.threadId };
}

/**
 * Reply used when a mutating command (model/config/restart) hits a chat with
 * more than one wired agent. Only the command word varies.
 */
function replyMultipleAgents(ctx: HostCommandContext, targets: TargetResolution, command: CommandName): void {
  replyOnFirstTarget(
    ctx,
    targets,
    `This chat has multiple agents wired (${agentNames(targets)}). Run /${command} in the agent's own topic, or use ncl from the host.`,
  );
}

// --- /status (member-runnable) ---

function handleStatus(ctx: HostCommandContext, targets: TargetResolution): void {
  if (targets.kind === 'none') {
    logNoAgent('status', ctx);
    return;
  }
  const agents = targets.kind === 'single' ? [targets.agent] : targets.agents;
  // Decide access once per agent (single scan), then partition on it.
  const decided = agents.map((a) => [a, statusAccess(ctx.userId, a.agentGroupId)] as const);
  const accessible = decided.filter(([, d]) => d === 'allowed').map(([a]) => a);
  if (accessible.length === 0) {
    if (decided.some(([, d]) => d === 'refuse')) {
      replyOnFirstTarget(ctx, targets, 'Permission denied: /status requires access to this agent.');
    } else {
      log.info('/status from unknown sender dropped', { messagingGroupId: ctx.mg.id, userId: ctx.userId });
    }
    return;
  }
  const chatCtx = chatContext(ctx);
  const blocks = accessible.map((a) => {
    const res = getStatus(a.agentGroupId, chatCtx);
    return res.ok ? renderStatus(res.view) : failureMessage(res);
  });
  replyOnFirstTarget(ctx, targets, blocks.join('\n\n'));
}

function renderStatus(v: StatusView): string {
  return statusCardLines(v, PLAIN_FMT).join('\n');
}

// --- /model (admin-only) ---

function handleModel(ctx: HostCommandContext, targets: TargetResolution): void {
  if (targets.kind === 'none') {
    logNoAgent('model', ctx);
    return;
  }
  if (targets.kind === 'multiple') {
    replyMultipleAgents(ctx, targets, 'model');
    return;
  }

  const agent = targets.agent;

  // Bare /model: admin-only picker. Self-gate the read (the service does not
  // gate reads).
  if (ctx.args === '') {
    if (!isAdmin(ctx.userId, agent.agentGroupId)) {
      replyOnFirstTarget(ctx, targets, `Permission denied: /model requires admin access for ${agent.agentName}.`);
      return;
    }
    const res = getModelPicker(agent.agentGroupId);
    if (!res.ok) {
      replyOnFirstTarget(ctx, targets, failureMessage(res));
      return;
    }
    emitModelPicker(ctx, res.view);
    return;
  }

  // /model <alias-or-id>: the service re-checks admin and returns 'unauthorized'
  // for non-admins, so a single call covers both auth and the write.
  const res = setModel(agent.agentGroupId, ctx.args, ctx.userId ?? '');
  replyOnFirstTarget(ctx, targets, res.ok ? modelChangeConfirmation(res.view, PLAIN_FMT) : failureMessage(res));
}

/**
 * Emit the /model picker as an ask_question card. Delivery persists the
 * pending_questions row; a tap flows back through handleHostCommandResponse.
 */
function emitModelPicker(ctx: HostCommandContext, view: ModelPickerView): void {
  const session = sessionForAgent(ctx, view.agentGroupId);
  if (!session) {
    log.warn('Cannot emit model picker without a session', { agentGroupId: view.agentGroupId });
    return;
  }
  const addr = deliveryAddr(ctx);
  // Keep the questionId compact so ncq:<qid>:<modelId> stays under Telegram's
  // 64-byte callback budget. 'hcmd-model-' is the prefix our handler claims.
  const questionId = `hcmd-model-${Math.random().toString(36).slice(2, 10)}`;
  const options = view.options.map((o) => ({
    label: o.active ? `${ACTIVE_MARK} ${o.label}` : o.label,
    value: o.id,
  }));

  writeOutboundDirect(session.agent_group_id, session.id, {
    id: questionId,
    kind: 'chat-sdk',
    platformId: addr.platformId,
    channelType: addr.channelType,
    threadId: addr.threadId,
    content: JSON.stringify({
      type: 'ask_question',
      questionId,
      title: `Pick a model for ${view.agentName}`,
      question: `Current: ${modelRefText(view.current)}. Tap a model to switch; it applies from ${view.agentName}'s next reply.`,
      options,
    }),
  });
}

// --- /config (admin-only) ---

function handleConfig(ctx: HostCommandContext, targets: TargetResolution): void {
  if (targets.kind === 'none') {
    logNoAgent('config', ctx);
    return;
  }
  if (targets.kind === 'multiple') {
    replyMultipleAgents(ctx, targets, 'config');
    return;
  }

  const agent = targets.agent;

  // Bare /config: admin-only view.
  if (ctx.args === '') {
    if (!isAdmin(ctx.userId, agent.agentGroupId)) {
      replyOnFirstTarget(ctx, targets, `Permission denied: /config requires admin access for ${agent.agentName}.`);
      return;
    }
    const res = getConfigView(agent.agentGroupId, chatContext(ctx));
    replyOnFirstTarget(ctx, targets, res.ok ? renderConfigView(res.view) : failureMessage(res));
    return;
  }

  // /config set <field> <value>
  const parsed = parseConfigSet(ctx.args);
  if (!parsed) {
    const res = getConfigView(agent.agentGroupId, chatContext(ctx));
    // Non-admins still get the usage hint, but never the current values.
    if (!isAdmin(ctx.userId, agent.agentGroupId)) {
      replyOnFirstTarget(ctx, targets, `Permission denied: /config requires admin access for ${agent.agentName}.`);
      return;
    }
    replyOnFirstTarget(ctx, targets, res.ok ? renderConfigView(res.view) : failureMessage(res));
    return;
  }

  // Activation ('activation' | 'pattern') lives on the wiring row and applies
  // immediately; the scalar fields go through container config.
  if (parsed.field === 'activation' || parsed.field === 'pattern') {
    let res;
    if (parsed.field === 'pattern') {
      res = setActivation(ctx.mg.id, agent.agentGroupId, 'pattern', parsed.value, ctx.userId ?? '');
    } else if (!isActivationMode(parsed.value)) {
      replyOnFirstTarget(
        ctx,
        targets,
        failureMessage({
          ok: false,
          reason: 'invalid-value',
          detail: { field: 'activation', value: parsed.value, allowed: ACTIVATION_MODES },
        }),
      );
      return;
    } else {
      res = setActivation(ctx.mg.id, agent.agentGroupId, parsed.value, null, ctx.userId ?? '');
    }
    replyOnFirstTarget(ctx, targets, res.ok ? activationChangeConfirmation(res.view, PLAIN_FMT) : failureMessage(res));
    return;
  }

  const res = setConfigValue(agent.agentGroupId, parsed.field, parsed.value, ctx.userId ?? '');
  replyOnFirstTarget(ctx, targets, res.ok ? configChangeConfirmation(res.view, PLAIN_FMT) : failureMessage(res));
}

/** Parse "set <field> <value>" into a settable field + raw value. */
function parseConfigSet(args: string): { field: ConfigField | 'activation' | 'pattern'; value: string } | null {
  const m = args.match(/^set\s+(\S+)\s+([\s\S]+)$/i);
  if (!m) return null;
  const field = m[1].toLowerCase();
  if (field === 'activation' || field === 'pattern') return { field, value: m[2].trim() };
  if (!(CONFIG_FIELDS as readonly string[]).includes(field)) return null;
  return { field: field as ConfigField, value: m[2].trim() };
}

function renderConfigView(v: ConfigView): string {
  // The Hermes config card, minus the menu-only trailing 'Pick a setting...'
  // line, plus a fallback-specific set-command cheat sheet.
  const lines = configRootLines(v, PLAIN_FMT).slice(0, -2);
  lines.push(
    '',
    'Change a value with:',
    `/config set model <${MODEL_ALIASES}|raw-id>`,
    `/config set effort <${EFFORT_LEVELS.join('|')}>`,
    '/config set auto-compact-window <tokens, e.g. 400000>',
    '/config set max-messages-per-prompt <count>',
    '/config set activation <mention|mention-sticky|pattern>',
    '/config set pattern <regex>',
  );
  return lines.join('\n');
}

// --- /restart (admin-only) ---

function handleRestart(ctx: HostCommandContext, targets: TargetResolution): void {
  if (targets.kind === 'none') {
    logNoAgent('restart', ctx);
    return;
  }
  if (targets.kind === 'multiple') {
    replyMultipleAgents(ctx, targets, 'restart');
    return;
  }

  const agent = targets.agent;
  // The service re-checks admin and returns 'unauthorized' for non-admins.
  const res = restartAgent(agent.agentGroupId, ctx.userId ?? '');
  replyOnFirstTarget(ctx, targets, res.ok ? restartConfirmation(res.view, PLAIN_FMT) : failureMessage(res));
}

// --- Card response handler ('hcmd-' taps) ---

function namespacedUserId(payload: ResponsePayload): string | null {
  if (!payload.userId) return null;
  return payload.userId.includes(':') ? payload.userId : `${payload.channelType}:${payload.userId}`;
}

/**
 * Claim taps on host-command cards. Only 'hcmd-' questionIds are ours; every
 * such id is a model-picker choice today. Re-checks admin for the pressing
 * user (NOT the original requester) and applies the model change.
 */
async function handleHostCommandResponse(payload: ResponsePayload): Promise<boolean> {
  if (!payload.questionId.startsWith('hcmd-')) return false;
  if (!hasTable(getDb(), 'pending_questions')) return true; // ours, but nowhere to land

  const pq = getPendingQuestion(payload.questionId);
  if (!pq) return true; // already resolved, expired, or a duplicate tap

  const session = getSession(pq.session_id);
  // Delete up front: a duplicate tap must not double-apply, and no other
  // handler (e.g. the interactive module) should ever route this row.
  deletePendingQuestion(payload.questionId);

  if (!session) {
    log.warn('Host-command card lost its session', { questionId: payload.questionId, sessionId: pq.session_id });
    return true;
  }

  const reply = (text: string): void =>
    writeTextReply(
      session.agent_group_id,
      session.id,
      { platformId: pq.platform_id, channelType: pq.channel_type, threadId: pq.thread_id },
      text,
    );

  const actor = namespacedUserId(payload);
  const agentGroupId = session.agent_group_id;

  if (!actor || !hasAdminPrivilege(actor, agentGroupId)) {
    log.warn('Non-admin tapped a host-command card', { questionId: payload.questionId, userId: payload.userId });
    reply('Permission denied: switching models requires admin access.');
    return true;
  }

  const res = setModel(agentGroupId, payload.value, actor);
  reply(res.ok ? modelChangeConfirmation(res.view, PLAIN_FMT) : failureMessage(res));
  return true;
}

registerResponseHandler(handleHostCommandResponse);

// --- Shared rendering ---

function modelText(id: string | null, label: string | null): string {
  if (!id) return '(default)';
  return label ? `${label} (${id})` : id;
}

function modelRefText(ref: ModelRef): string {
  return modelText(ref.id, ref.label);
}
