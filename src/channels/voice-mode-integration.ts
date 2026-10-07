import { platformMessageId } from './voice-mode-platform-id.js';
import type http from 'node:http';
import fs from 'node:fs';

import type { OutboundMessage, InboundEvent } from './adapter.js';
import { resolveThreadPolicy } from './channel-defaults.js';
import { getChannelAdapter, getChannelDefaults } from './channel-registry.js';
import { deliverSessionMessages } from '../delivery.js';
import { onHostShutdown, onHostStart } from '../host-lifecycle.js';
import { log } from '../log.js';
import { heartbeatPath } from '../session-manager.js';
import type { MessagingGroup, MessagingGroupAgent, Session } from '../types.js';

export interface VoiceModeOutboundMessage extends OutboundMessage {
  inReplyTo?: string | null;
}

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

type TypingObserver = (tick: {
  channelType: string;
  platformId: string;
  threadId: string | null;
  agentGroupId: string;
  working: boolean;
}) => void;
const observers: TypingObserver[] = [];
const thinking = new Map<
  string,
  { session: Session; event: InboundEvent; startedAt: number; timer: ReturnType<typeof setInterval> }
>();
export function registerTypingObserver(observer: TypingObserver): void {
  observers.push(observer);
}

function thinkingTick(sessionId: string): void {
  const entry = thinking.get(sessionId);
  if (!entry) return;
  let working = false;
  try {
    working = Date.now() - fs.statSync(heartbeatPath(entry.session.agent_group_id, sessionId)).mtimeMs < 6_000;
  } catch {
    /* A not-yet-started container has no heartbeat. */
  }
  if (!working && Date.now() - entry.startedAt > 15_000) {
    clearInterval(entry.timer);
    thinking.delete(sessionId);
    return;
  }
  for (const observer of observers)
    observer({
      channelType: entry.event.channelType,
      platformId: entry.event.platformId,
      threadId: entry.event.threadId,
      agentGroupId: entry.session.agent_group_id,
      working,
    });
}

export function voiceModeStored(event: InboundEvent, session: Session): void {
  const existing = thinking.get(session.id);
  if (existing) {
    existing.session = session;
    existing.event = event;
    existing.startedAt = Date.now();
  } else {
    const timer = setInterval(() => thinkingTick(session.id), 4_000);
    timer.unref();
    thinking.set(session.id, { session, event, startedAt: Date.now(), timer });
  }
  thinkingTick(session.id);
  (event as VoiceModeInboundEvent).onStored?.(session);
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
export function presentVoiceModeOutbound(msg: VoiceModeOutboundAddress, session: Session): string {
  const original = (msg as VoiceModeOutboundAddress & { content: string }).content;
  if (!presentation) return original;
  try {
    const content = JSON.parse(original) as Record<string, unknown>;
    const shown = presentation(msg, Object.freeze(content), session) ?? content;
    return JSON.stringify(
      msg.channelType === 'voice-mode' && msg.inReplyTo
        ? { ...shown, voiceModeInReplyTo: platformMessageId(msg.inReplyTo, session.agent_group_id) }
        : shown,
    );
  } catch {
    return original;
  }
}

let running = false;
const expedited = new Map<string, { session: Session; until: number }>();
let timer: ReturnType<typeof setInterval> | undefined;
function stopExpediting(): void {
  clearInterval(timer);
  timer = undefined;
  expedited.clear();
}
let initialized = false;
export function initializeVoiceModeIntegration(): void {
  if (initialized) return;
  initialized = true;
  onHostStart(() => {
    running = true;
  });
  onHostShutdown(() => {
    running = false;
    stopExpediting();
    for (const entry of thinking.values()) clearInterval(entry.timer);
    thinking.clear();
  });
}

export function expediteDelivery(session: Session, forMs: number): void {
  if (!running) return;
  expedited.set(session.id, { session, until: Date.now() + forMs });
  if (timer) return;
  timer = setInterval(() => {
    for (const [id, entry] of expedited) {
      if (entry.until <= Date.now()) {
        expedited.delete(id);
        continue;
      }
      void deliverSessionMessages(entry.session).catch((err: unknown) =>
        log.warn('voice-mode: reply delivery failed', { sessionId: id, err }),
      );
    }
    if (expedited.size === 0) stopExpediting();
  }, 200);
  timer.unref();
}

let rootHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>) | null = null;
export function registerVoiceModeRootHandler(handler: typeof rootHandler): void {
  rootHandler = handler;
}
export async function handleVoiceModeRoot(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  if (!rootHandler || !/^\/voice(?:[/?]|$)/.test(req.url ?? '')) return false;
  try {
    await rootHandler(req, res);
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
  return true;
}
