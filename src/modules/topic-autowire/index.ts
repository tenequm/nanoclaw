/**
 * Topic auto-wire — makes freshly created forum topics instantly usable.
 *
 * The telegram-grammy adapter keys each forum topic as its own platform id
 * (`telegram:<chatId>:<topicId>`), so a new topic has no messaging_groups
 * row and would need a mention + owner-approval round-trip before any agent
 * engages. This module removes that friction: when a message arrives from an
 * unknown topic of a chat whose BASE id is already wired, it clones the base
 * chat's wiring(s) onto a new per-topic messaging group and lets routing
 * continue — the sender talks to the same agent(s) as the base chat, in a
 * fresh per-topic session, with no approval card.
 *
 * Registered as a pre-route interceptor that never claims the message
 * (always returns false); it only fabricates the rows routing is about to
 * look up. Topics that already have their own row (e.g. explicitly wired to
 * a different agent) are untouched — exact match wins.
 */
import { randomUUID } from 'crypto';

import type { InboundEvent } from '../../channels/adapter.js';
import { parseTopicId } from '../../channels/telegram-grammy/inbound.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { registerMessageInterceptor } from '../../router.js';

export async function autowireTopic(event: InboundEvent): Promise<boolean> {
  if (event.channelType !== 'telegram') return false;
  // The adapter owns the per-topic id grammar — reuse its parser rather than
  // keeping a second validator here (this module is telegram-only by design).
  const topicId = parseTopicId(event.platformId);
  if (topicId === undefined) return false;
  const baseId = event.platformId.slice(0, event.platformId.lastIndexOf(':'));

  const instance = event.instance ?? event.channelType;
  if (getMessagingGroupByPlatform(event.channelType, event.platformId, instance)) return false;

  const base = getMessagingGroupByPlatform(event.channelType, baseId, instance);
  if (!base || base.denied_at) return false;
  const wirings = getMessagingGroupAgents(base.id);
  if (wirings.length === 0) return false;

  const now = new Date().toISOString();
  const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createMessagingGroup({
    id: mgId,
    channel_type: event.channelType,
    platform_id: event.platformId,
    instance,
    name: `${base.name ?? baseId} · topic ${topicId}`,
    is_group: 1,
    unknown_sender_policy: base.unknown_sender_policy,
    created_at: now,
  });
  for (const w of wirings) {
    createMessagingGroupAgent({
      id: randomUUID(),
      messaging_group_id: mgId,
      agent_group_id: w.agent_group_id,
      engage_mode: w.engage_mode,
      engage_pattern: w.engage_pattern,
      sender_scope: w.sender_scope,
      ignored_message_policy: w.ignored_message_policy,
      session_mode: w.session_mode,
      priority: w.priority,
      created_at: now,
    });
  }
  log.info('Auto-wired new forum topic from base chat', {
    platformId: event.platformId,
    baseMessagingGroupId: base.id,
    messagingGroupId: mgId,
    wirings: wirings.length,
  });
  return false;
}

registerMessageInterceptor(autowireTopic);
