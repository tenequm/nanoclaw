/**
 * How a caller's turn reaches the agent: handed to the router's own engaged-message delivery
 * (`deliverToAgent`: thread policy, session, backfill, command gate, session-created hooks, typing,
 * wake, fan-out) for the one agent the line belongs to, in the call chat, as a message from the
 * line's caller. `routeInbound` is not used because a turn is addressed to that agent whatever
 * else is wired to the chat and whatever its trigger; the caller's access to the agent and the
 * call chat's wiring are checked by the voice engine before every turn. The call hears the agent
 * thinking through the channel's typing observer (src/channels/voice-mode-integration.ts).
 */
import {
  voiceModeHostRunning,
  wiringThreadsEnabled,
  type VoiceModeInboundEvent as InboundEvent,
} from './voice-mode-integration.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { getMessagingGroupAgentByPair, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { log } from '../log.js';
import { deliverToAgent } from '../router.js';
import type { MessagingGroup } from '../types.js';

/** What the voice engine knows of a turn besides its event. */
export interface VoiceModeTurn {
  /** The line's caller, who the turn is from. */
  callerId: string;
  /** The call chat as the engine just resolved it; null to look it up from the event. */
  chat: MessagingGroup | null;
}

/**
 * Store a turn in the session of the agent the event names (`agentGroupId`) for the event's chat and
 * wake the agent. Resolves true once stored, false when the chat or its wiring to that agent is gone;
 * rejects when storing threw.
 */
export async function routeVoiceModeTurn(event: InboundEvent, turn: VoiceModeTurn): Promise<boolean> {
  // The host takes inbound messages only once running sessions are adopted (src/index.ts), right
  // before host modules start; the page can take a call before that, or after shutdown began.
  if (!voiceModeHostRunning()) throw new Error('the host is not running');
  const { agentGroupId } = event;
  if (!agentGroupId) throw new Error('a voice turn must name its agent');
  const mg =
    turn.chat ??
    (await getMessagingGroupByPlatform(event.channelType, event.platformId, event.instance ?? event.channelType));
  const wiring = mg && !mg.denied_at ? await getMessagingGroupAgentByPair(mg.id, agentGroupId) : undefined;
  const agentGroup = wiring ? await getAgentGroup(agentGroupId) : undefined;
  if (!mg || !wiring || !agentGroup) {
    log.warn('livekit-voice-mode: the turn has no wired chat to go to', {
      channelType: event.channelType,
      agentGroupId,
    });
    return false;
  }

  // The router's own thread policy and engaged-message delivery, for this one wiring.
  const threadsEnabled = wiringThreadsEnabled(wiring, mg);
  const threadId = threadsEnabled ? event.threadId : null;
  let stored = false;
  const routed: InboundEvent = {
    ...event,
    onStored: (session) => {
      stored = true;
      event.onStored?.(session);
    },
  };
  await deliverToAgent(wiring, agentGroup, mg, routed, turn.callerId, threadsEnabled, threadId, true);
  return stored;
}
