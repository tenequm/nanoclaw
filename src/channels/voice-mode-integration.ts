/**
 * The voice channel's side of its core reach-ins: what src/router.ts, src/delivery.ts and
 * src/webhook-server.ts call (voiceModeStored, presentVoiceModeOutbound, handleVoiceModeRoot), and the
 * seams the channel fills in. Each is inert while no voice call needs it, and a failure in the
 * channel is logged here, never thrown into core.
 */
import type http from 'node:http';
import fs from 'node:fs';

import type { InboundEvent } from './adapter.js';
import { resolveThreadPolicy } from './channel-defaults.js';
import { getChannelAdapter, getChannelDefaults } from './channel-registry.js';
import { deliverSessionMessages } from '../delivery.js';
import { onHostShutdown, onHostStart } from '../host-lifecycle.js';
import { log } from '../log.js';
import { heartbeatPath } from '../session-manager.js';
import type { MessagingGroup, MessagingGroupAgent, Session } from '../types.js';

export interface VoiceModeInboundEvent extends InboundEvent {
  agentGroupId?: string;
  onStored?: (session: Session) => void;
}

export function wiringThreadsEnabled(wiring: Pick<MessagingGroupAgent, 'threads'>, mg: MessagingGroup): boolean {
  const key = mg.instance ?? mg.channel_type;
  return resolveThreadPolicy(
    wiring.threads ?? null,
    getChannelDefaults(key, mg.channel_type),
    mg.is_group === 1,
    getChannelAdapter(key)?.supportsThreads === true,
  );
}

/** Delivery hands a reply's in-reply-to over agent-scoped (`<id>:<agent group>`); this is the platform's id. */
export function platformMessageId(scopedId: string, agentGroupId: string): string {
  const suffix = `:${agentGroupId}`;
  return scopedId.endsWith(suffix) ? scopedId.slice(0, -suffix.length) : scopedId;
}

let hostRunning = false;
/** Whether the host has started its modules (and with them, taking inbound messages) and not shut down. */
export const voiceModeHostRunning = (): boolean => hostRunning;

// Upstream typing's timings (src/modules/typing), which it keeps private.
const TYPING_REFRESH_MS = 4_000;
const TYPING_GRACE_MS = 15_000;
const HEARTBEAT_FRESH_MS = 6_000;
const POST_DELIVERY_PAUSE_MS = 10_000;
/** Longest stretch shown as thinking with no reply delivered and no new turn: bounds a runner stuck working. */
const TYPING_CEILING_MS = 5 * 60_000;

export interface TypingTick {
  channelType: string;
  platformId: string;
  threadId: string | null;
  agentGroupId: string;
  /** The session's heartbeat moved since the message that started this stretch: the agent picked it up. */
  working: boolean;
}
type TypingObserver = (tick: TypingTick) => void;
const observers: Array<{ observe: TypingObserver; live: () => boolean }> = [];
interface Thinking {
  session: Session;
  event: InboundEvent;
  startedAt: number;
  /** Start of the stretch TYPING_CEILING_MS bounds: the last waking message or delivered reply. */
  typingSince: number;
  pausedUntil: number;
  timer: ReturnType<typeof setInterval>;
}
const thinking = new Map<string, Thinking>();

/** `live`: whether the observer has a live call to tell; while none has, no session is tracked. */
export function registerTypingObserver(observe: TypingObserver, live: () => boolean): void {
  observers.push({ observe, live });
}

function stopThinking(sessionId: string): void {
  clearInterval(thinking.get(sessionId)?.timer);
  thinking.delete(sessionId);
}

function heartbeatAt(session: Session): number {
  try {
    return fs.statSync(heartbeatPath(session.agent_group_id, session.id)).mtimeMs;
  } catch {
    return 0; // A not-yet-started container has no heartbeat.
  }
}

function thinkingTick(sessionId: string): void {
  const entry = thinking.get(sessionId);
  if (!entry) return;
  const now = Date.now();
  const beat = heartbeatAt(entry.session);
  const fresh = now - beat < HEARTBEAT_FRESH_MS;
  if (!fresh && now - entry.startedAt > TYPING_GRACE_MS) return stopThinking(sessionId);
  if (entry.pausedUntil > now || now - entry.typingSince >= TYPING_CEILING_MS) return;
  const tick: TypingTick = {
    channelType: entry.event.channelType,
    platformId: entry.event.platformId,
    threadId: entry.event.threadId,
    agentGroupId: entry.session.agent_group_id,
    working: fresh && beat >= entry.startedAt,
  };
  for (const { observe } of observers) {
    try {
      observe(tick);
    } catch (err) {
      log.warn('voice-mode: typing observer failed', { sessionId, err });
    }
  }
}

/**
 * The router stored `event` in `session`. A voice turn hears it stored (`onStored`); a message that
 * wakes the agent while a call is live starts the agent's thinking ticks for that chat.
 */
export function voiceModeStored(event: InboundEvent, session: Session, wake: boolean): void {
  try {
    (event as VoiceModeInboundEvent).onStored?.(session);
  } catch (err) {
    log.warn('voice-mode: stored-turn callback failed', { sessionId: session.id, err });
  }
  if (!wake || !observers.some(({ live }) => live())) return;
  const now = Date.now();
  const existing = thinking.get(session.id);
  if (existing) Object.assign(existing, { session, event, startedAt: now, typingSince: now, pausedUntil: 0 });
  else {
    const timer = setInterval(() => thinkingTick(session.id), TYPING_REFRESH_MS);
    timer.unref();
    thinking.set(session.id, { session, event, startedAt: now, typingSince: now, pausedUntil: 0, timer });
  }
  thinkingTick(session.id);
}

/** A reply from `session` reached its chat: thinking pauses as core typing does, and the ceiling restarts. */
export function voiceModeReplyDelivered(session: Session): void {
  const entry = thinking.get(session.id);
  if (!entry) return;
  entry.pausedUntil = Date.now() + POST_DELIVERY_PAUSE_MS;
  entry.typingSince = Date.now();
}

export interface VoiceModeOutboundAddress {
  id: string;
  kind: string;
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
  inReplyTo?: string | null;
}
type Presentation = (
  msg: VoiceModeOutboundAddress,
  content: Readonly<Record<string, unknown>>,
  session: Session,
) => Record<string, unknown> | null;
let presentation: Presentation | null = null;
export function setOutboundPresentation(transform: Presentation | null): void {
  presentation = transform;
}

/** What the platform is handed of an outbound message: its stored content, unless the voice channel restyles it. */
export function presentVoiceModeOutbound(
  msg: VoiceModeOutboundAddress & { content: string },
  session: Session,
): string {
  if (!presentation) return msg.content;
  try {
    const content: unknown = JSON.parse(msg.content);
    if (!content || typeof content !== 'object' || Array.isArray(content)) return msg.content;
    const shown = presentation(msg, Object.freeze(content as Record<string, unknown>), session);
    return shown ? JSON.stringify(shown) : msg.content;
  } catch (err) {
    log.warn('voice-mode: outbound presentation failed; delivering the message as stored', { id: msg.id, err });
    return msg.content;
  }
}

/** How often an expedited session's replies are polled; the host's own poll runs every second. */
const EXPEDITED_POLL_MS = 200;
const expedited = new Map<string, { session: Session; since: number; until: number }>();
let expediteTimer: ReturnType<typeof setInterval> | undefined;
function stopExpediting(): void {
  clearInterval(expediteTimer);
  expediteTimer = undefined;
  expedited.clear();
}

onHostStart(() => {
  hostRunning = true;
});
onHostShutdown(() => {
  hostRunning = false;
  stopExpediting();
  for (const id of [...thinking.keys()]) stopThinking(id);
});

/**
 * Deliver `session`'s replies every EXPEDITED_POLL_MS for up to `forMs`, so a call hears them at once.
 * The window closes early once the agent is idle: past the start-up grace with a stale heartbeat.
 */
export function expediteDelivery(session: Session, forMs: number): void {
  if (!hostRunning) return;
  const now = Date.now();
  expedited.set(session.id, { session, since: now, until: now + forMs });
  if (expediteTimer) return;
  expediteTimer = setInterval(() => {
    const t = Date.now();
    for (const [id, entry] of expedited) {
      const idle = t - entry.since > TYPING_GRACE_MS && t - heartbeatAt(entry.session) >= HEARTBEAT_FRESH_MS;
      if (entry.until <= t || idle) {
        expedited.delete(id);
        continue;
      }
      void deliverSessionMessages(entry.session).catch((err: unknown) =>
        log.warn('voice-mode: reply delivery failed', { sessionId: id, err }),
      );
    }
    if (expedited.size === 0) stopExpediting();
  }, EXPEDITED_POLL_MS);
  expediteTimer.unref();
}

let rootHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>) | null = null;
export function registerVoiceModeRootHandler(handler: typeof rootHandler): void {
  rootHandler = handler;
}
export async function handleVoiceModeRoot(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (!rootHandler || !/^\/voice(?:[/?]|$)/.test(req.url ?? '')) return false;
  /* eslint-disable no-catch-all/no-catch-all -- the shared webhook server has no other way to answer the browser */
  try {
    await rootHandler(req, res);
  } catch (err) {
    log.warn('voice-mode: browser route failed', { err });
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
  /* eslint-enable no-catch-all/no-catch-all */
  return true;
}
