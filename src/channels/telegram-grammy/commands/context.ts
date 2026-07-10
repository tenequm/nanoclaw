/**
 * Shared, pure-ish helpers that map a grammY Context to the host command
 * service's world: which chat/topic the update belongs to, which messaging
 * group that is, which agent group(s) are wired, and a stable menu
 * fingerprint.
 *
 * Everything here is synchronous (the command service is synchronous) and does
 * only DB reads, so it is safe to call from a menu fingerprint function or a
 * dynamic range factory, both of which the menu plugin requires to be pure and
 * stable (no side effects, no fast-changing data).
 *
 * Typography: ASCII only in strings/comments. Emoji allowed as UI glyphs.
 */
import type { Context } from 'grammy';

import { getConfigView, resolveTargets, type TargetAgent, type TargetResolution } from '../../../commands/index.js';
import { getMessagingGroupByPlatform } from '../../../db/messaging-groups.js';
import { platformIdFor } from '../inbound.js';

const CHANNEL = 'telegram';

/** The authoritative presser / sender id as a namespaced user id. */
export function actorUserId(ctx: Context): string {
  const id = ctx.from?.id;
  return id != null ? `${CHANNEL}:${id}` : '';
}

/**
 * The per-chat platform id (with any forum-topic suffix) for this update.
 *
 * Works for both command messages (`ctx.msg` is the incoming command) and
 * menu taps (`ctx.msg` resolves to `callbackQuery.message`). Matches the
 * inbound platform-id convention exactly (`platformIdFor`) so the messaging
 * group lookup hits the same row the router created.
 */
export function contextPlatformId(ctx: Context): string | null {
  const chatId = ctx.chat?.id;
  if (chatId == null) return null;
  return platformIdFor(chatId, ctx.msg);
}

/** Resolve this update's messaging group id, or null when the chat is unknown. */
export function contextMessagingGroupId(ctx: Context): string | null {
  const platformId = contextPlatformId(ctx);
  if (!platformId) return null;
  const mg = getMessagingGroupByPlatform(CHANNEL, platformId);
  return mg ? mg.id : null;
}

/** Resolve the wired agent group(s) for this update's chat/topic. */
export function resolveTargetsForContext(ctx: Context): TargetResolution {
  const mgId = contextMessagingGroupId(ctx);
  if (!mgId) return { kind: 'none' };
  return resolveTargets(mgId);
}

/**
 * The agent-picker index carried in a menu button payload. Non-negative
 * integer; defaults to 0 (the single-agent case and the first send-render of
 * a menu, where there is no payload yet).
 */
export function readAgentIndex(ctx: Context): number {
  const raw = typeof ctx.match === 'string' ? ctx.match.trim() : '';
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** Pick a target agent out of a resolution by the (possibly threaded) index. */
export function agentAtIndex(res: TargetResolution, index: number): TargetAgent | null {
  if (res.kind === 'single') return index === 0 ? res.agent : null;
  if (res.kind === 'multiple') return res.agents[index] ?? null;
  return null;
}

/** The target agent for the current menu context (chat/topic + threaded index). */
export function contextTargetAgent(ctx: Context): TargetAgent | null {
  return agentAtIndex(resolveTargetsForContext(ctx), readAgentIndex(ctx));
}

/** The wired agent-group ids for a resolution, in resolveTargets' sorted order. */
function wiringIds(res: TargetResolution): string[] {
  if (res.kind === 'single') return [res.agent.agentGroupId];
  if (res.kind === 'multiple') return res.agents.map((a) => a.agentGroupId);
  return [];
}

/**
 * Stable fingerprint for a menu render. The menu plugin re-renders a menu
 * once on send and once on tap; this string must change if and only if the
 * menu should be considered outdated. We fold in the wiring set of the chat
 * (so wiring a new agent invalidates open pickers) plus the selected agent's
 * mutable config scalars (so a model/effort/window change made elsewhere
 * self-detects a stale menu). cli_scope is included because it gates whether
 * config surfaces make sense at all.
 */
export function menuFingerprint(ctx: Context): string {
  const res = resolveTargetsForContext(ctx);
  const ids = wiringIds(res);
  const idx = readAgentIndex(ctx);
  const target = agentAtIndex(res, idx);
  const mgId = contextMessagingGroupId(ctx);
  let cfgPart = 'none';
  if (target) {
    // Fold in the chat's activation wiring (threadId is irrelevant: activation
    // is keyed by the (mg, agent) pair) so an activation change made elsewhere
    // self-detects an open menu as stale.
    const view = getConfigView(target.agentGroupId, mgId ? { messagingGroupId: mgId, threadId: null } : undefined);
    if (view.ok) {
      const v = view.view;
      const act = v.activation
        ? `${v.activation.engageMode}:${v.activation.engagePattern ?? ''}:${v.activation.senderScope}`
        : '';
      cfgPart = [
        v.model.id ?? '',
        v.effort ?? '',
        v.autoCompactWindow ?? '',
        v.maxMessagesPerPrompt ?? '',
        v.cliScope,
        act,
      ].join(',');
    }
  }
  return `${ids.join('|')}#${idx}#${target?.agentGroupId ?? ''}#${cfgPart}`;
}

/**
 * Fingerprint for the multi-agent PICKER menus. Deliberately independent of
 * the pressed-button index: a picker's buttons each carry a DIFFERENT index
 * payload, so folding the index into the fingerprint would make every picker
 * tap look outdated (send-render sees index 0, the tap sees the pressed
 * button's index). Only the wiring set matters here - if an agent is
 * wired/unwired the picker should re-render.
 */
export function pickerFingerprint(ctx: Context): string {
  return `pick#${wiringIds(resolveTargetsForContext(ctx)).join('|')}`;
}
