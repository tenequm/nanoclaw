import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/connection.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { agentCandidates, authError, readSignedBody } from '../../modules/device-auth/verify.js';
import {
  parseAuthorization,
  type Conversation,
  type SetAgentResponse,
  type AgentsResponse,
  type Badge,
  type Message,
  type Question,
} from './contract.js';
import type { ConversationRow, MessageRow, QuestionRow } from './db.js';
import { appHooks, appTransaction, appendEvent, lastEventSeq, afterAppCommit } from './log.js';
import { json, type AppHandler, type AppRequest } from './http.js';

export const getConversation = (id: string): Promise<ConversationRow | undefined> =>
  getDb().get('SELECT * FROM app_conversations WHERE id = ?', id);
export async function conversationsFor(userId: string, agentIds: string[]): Promise<ConversationRow[]> {
  return (
    await getDb().all<ConversationRow>(
      'SELECT * FROM app_conversations WHERE user_id = ? ORDER BY created_at, id',
      userId,
    )
  ).filter((c) => agentIds.includes(c.agent_group_id));
}
const conversationForAgent = (userId: string, agentGroupId: string) =>
  getDb().get<ConversationRow>(
    'SELECT * FROM app_conversations WHERE user_id = ? AND agent_group_id = ?',
    userId,
    agentGroupId,
  );

async function createConversation(userId: string, agentGroupId: string): Promise<ConversationRow> {
  const db = getDb();
  const agent = await getAgentGroup(agentGroupId);
  if (!agent) throw new Error('Agent not found');
  const id = `conv_${randomUUID()}`,
    now = Date.now();
  await createMessagingGroup({
    id,
    channel_type: 'app',
    instance: 'app',
    platform_id: id,
    name: `${agent.name} (app)`,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: new Date(now).toISOString(),
  });
  await createMessagingGroupAgent({
    id: randomUUID(),
    messaging_group_id: id,
    agent_group_id: agentGroupId,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    threads: 0,
    created_at: new Date(now).toISOString(),
  });
  await db.run(
    'INSERT INTO app_conversations (id,user_id,agent_group_id,messaging_group_id,seq,created_at) VALUES (?,?,?,?,0,?)',
    id,
    userId,
    agentGroupId,
    id,
    now,
  );
  return (await getConversation(id))!;
}
export async function ensureConversation(userId: string, agentGroupId: string): Promise<ConversationRow> {
  const found = await conversationForAgent(userId, agentGroupId);
  if (found) return found;
  const availability = await appHooks.callAvailability(userId, agentGroupId);
  return appTransaction(async () => {
    const existing = await conversationForAgent(userId, agentGroupId);
    if (existing) return existing;
    const c = await createConversation(userId, agentGroupId);
    c.seq = (await conversationEvent(c, availability)).seq;
    return c;
  });
}
export function plainPreview(text: string): string {
  let input = text.slice(0, 2000);
  const last = input.charCodeAt(input.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) input = input.slice(0, -1);
  const plain = input
    .replace(/```[^\n]*\n?/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/(^|\n)\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/g, '$1')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(plain).slice(0, 160).join('');
}
type CallAvailability = Pick<Conversation, 'canCall' | 'callRefusal'>;
async function readCounts(c: ConversationRow): Promise<{ readOrder: number; unread: number }> {
  const db = getDb();
  const readOrder =
    (
      await db.get<{ read_order: number }>(
        'SELECT read_order FROM app_read_state WHERE user_id = ? AND conversation_id = ?',
        c.user_id,
        c.id,
      )
    )?.read_order ?? 0;
  const unread = (await db.get<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM app_messages WHERE conversation_id = ? AND role = 'agent' AND item_order > ?) + (SELECT COUNT(*) FROM app_questions WHERE conversation_id = ? AND item_order > ?) AS n`,
    c.id,
    readOrder,
    c.id,
    readOrder,
  ))!.n;
  return { readOrder, unread };
}
export async function conversationEntity(c: ConversationRow, availability?: CallAvailability): Promise<Conversation> {
  const { readOrder, unread } = await readCounts(c);
  return {
    kind: 'conversation',
    id: c.id,
    seq: c.seq,
    agent: { id: c.agent_group_id, name: (await getAgentGroup(c.agent_group_id))?.name ?? c.agent_group_id },
    lastMessage: c.last_message_json ? JSON.parse(c.last_message_json) : null,
    unread,
    readOrder,
    ...(availability ?? (await appHooks.callAvailability(c.user_id, c.agent_group_id))),
    createdAt: c.created_at,
  };
}
export async function conversationEvent(
  c: ConversationRow,
  availability: CallAvailability,
  hidden?: boolean,
): Promise<Conversation> {
  const entity = await conversationEntity(c, availability);
  if (hidden !== undefined) entity.hidden = hidden;
  await appendEvent(getDb(), c.user_id, c.agent_group_id, entity);
  await getDb().run('UPDATE app_conversations SET seq = ? WHERE id = ?', entity.seq, c.id);
  return entity;
}
type BadgeListener = (userId: string, agentId?: string) => void;
const badgeListeners = new Set<BadgeListener>();
export function onBadgeChanged(listener: BadgeListener): () => void {
  badgeListeners.add(listener);
  return () => {
    badgeListeners.delete(listener);
  };
}
async function bumpBadge(userId: string, agentId?: string): Promise<void> {
  await getDb().run(
    'INSERT INTO app_badge_revisions (user_id,rev) VALUES (?,1) ON CONFLICT (user_id) DO UPDATE SET rev = app_badge_revisions.rev + 1',
    userId,
  );
  afterAppCommit(() => {
    for (const listener of badgeListeners) listener(userId, agentId);
  });
}
export async function badgeFor(userId: string, agentIds: string[]): Promise<Badge> {
  let unreadTotal = 0;
  for (const c of await conversationsFor(userId, agentIds)) unreadTotal += (await readCounts(c)).unread;
  return {
    kind: 'badge',
    rev:
      (await getDb().get<{ rev: number }>('SELECT rev FROM app_badge_revisions WHERE user_id = ?', userId))?.rev ?? 0,
    unreadTotal,
  };
}
export async function itemChanged(
  c: ConversationRow,
  item: Message | Question,
  created: boolean,
  availability: CallAvailability,
): Promise<void> {
  const role = 'role' in item ? item.role : 'agent';
  const previous = c.last_message_json ? JSON.parse(c.last_message_json) : null;
  if (created || previous?.id === item.id) {
    c.last_message_json = JSON.stringify({
      id: item.id,
      role,
      preview: plainPreview(item.text),
      at: ('editedAt' in item ? item.editedAt : null) ?? item.createdAt,
    });
    await getDb().run('UPDATE app_conversations SET last_message_json = ? WHERE id = ?', c.last_message_json, c.id);
    await conversationEvent(c, availability);
  }
  if (created && role === 'agent') await bumpBadge(c.user_id, c.agent_group_id);
}
export function messageEntity(r: MessageRow): Message {
  return {
    kind: 'message',
    id: r.id,
    conversationId: r.conversation_id,
    order: r.item_order,
    seq: r.seq,
    role: r.role,
    text: r.text,
    card: r.card_json ? JSON.parse(r.card_json) : null,
    files: JSON.parse(r.files_json),
    reactions: JSON.parse(r.reactions_json),
    voice: r.voice,
    replyTo: r.reply_to,
    clientId: r.client_id,
    delivery: r.delivery,
    deliveryError: r.delivery_error_json ? JSON.parse(r.delivery_error_json) : null,
    createdAt: r.created_at,
    editedAt: r.edited_at,
  };
}
export function questionEntity(r: QuestionRow): Question {
  return {
    kind: 'question',
    id: r.id,
    conversationId: r.conversation_id,
    order: r.item_order,
    seq: r.seq,
    title: r.title,
    text: r.text,
    options: JSON.parse(r.options_json),
    state: r.state,
    answer: r.answer_json ? JSON.parse(r.answer_json) : null,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}
export async function accessibleConversation(
  ctx: AppRequest,
  id = ctx.params.id,
  hideForbidden = true,
): Promise<ConversationRow | undefined> {
  const c = await getConversation(id);
  if (!ctx.identity || !c || c.user_id !== ctx.identity.userId) {
    json(ctx.res, 404, { error: 'not_found', message: 'Not found.' });
    return;
  }
  if (!ctx.identity.agentIds.includes(c.agent_group_id)) {
    json(ctx.res, hideForbidden ? 404 : 403, {
      error: hideForbidden ? 'not_found' : 'forbidden',
      message: hideForbidden ? 'Not found.' : 'This device cannot reach that agent.',
    });
    return;
  }
  return c;
}
export async function requestBody(ctx: AppRequest, maxBytes = 256 * 1024): Promise<Record<string, unknown>> {
  const auth = parseAuthorization(ctx.req.headers.authorization);
  if (!auth) throw authError(401, 'bad_signature', 'The request signature is not valid.');
  const bytes = await readSignedBody(ctx.req, auth.bodyHash, maxBytes);
  let body: unknown = null;
  try {
    body = JSON.parse(bytes.toString('utf8'));
  } catch {
    /* Malformed JSON is the same refusal as a non-object. */
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw authError(400, 'bad_request', 'The request is malformed.');
  return body as Record<string, unknown>;
}
export const listAgents: AppHandler = async ({ res, identity }) => {
  json(res, 200, { agents: await agentCandidates(identity!.deviceId) } satisfies AgentsResponse);
};
async function publishVisibility(c: ConversationRow, shown: boolean): Promise<void> {
  const availability = await appHooks.callAvailability(c.user_id, c.agent_group_id);
  await conversationEvent(c, availability, !shown);
  await bumpBadge(c.user_id);
}

// Pairing leaves first-time conversation creation to the device's first list request.
export async function showAppAgent(userId: string, id: string, source: 'pairing' | 'settings', now = Date.now()) {
  const inserted = await getDb().run(
    'INSERT INTO device_auth_user_agents (user_id,agent_group_id,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING',
    userId,
    id,
    now,
  );
  if (!inserted.changes && source === 'pairing') return;
  const existing = await conversationForAgent(userId, id);
  if (existing) {
    if (inserted.changes) await publishVisibility(existing, true);
  } else if (source === 'settings') {
    await publishVisibility(await createConversation(userId, id), true);
  }
}
export const setAgentShown: AppHandler = async (ctx) => {
  const { shown } = await requestBody(ctx);
  if (typeof shown !== 'boolean') throw authError(400, 'bad_request', 'The request is malformed.');
  const { deviceId, userId } = ctx.identity!;
  const id = ctx.params.id;
  const agent = await appTransaction(async () => {
    const [candidate] = await agentCandidates(deviceId, id);
    if (!candidate) throw authError(404, 'not_found', 'Not found.');
    if (shown) {
      await showAppAgent(userId, id, 'settings');
    } else if (candidate.shown) {
      await getDb().run('DELETE FROM device_auth_user_agents WHERE user_id = ? AND agent_group_id = ?', userId, id);
      const existing = await conversationForAgent(userId, id);
      if (existing) await publishVisibility(existing, false);
    }
    return { ...candidate, shown };
  });
  json(ctx.res, 200, { agent } satisfies SetAgentResponse);
};
export const listConversations: AppHandler = async (ctx) => {
  const { userId, agentIds } = ctx.identity!;
  const seq = await lastEventSeq();
  for (const id of agentIds) await ensureConversation(userId, id);
  const rows = await conversationsFor(userId, agentIds);
  const conversations = [];
  for (const row of rows) conversations.push(await conversationEntity(row));
  json(ctx.res, 200, {
    conversations,
    statuses: await appHooks.statuses(rows.map((c) => c.id)),
    badge: await badgeFor(userId, agentIds),
    seq,
  });
};
export const history: AppHandler = async (ctx) => {
  const c = await accessibleConversation(ctx);
  if (!c) return;
  const query = new URL(ctx.req.url!, 'http://app').searchParams;
  const before = query.has('before') ? Number(query.get('before')) : null,
    after = query.has('after') ? Number(query.get('after')) : null,
    limit = query.has('limit') ? Number(query.get('limit')) : 50;
  if (
    (before !== null && after !== null) ||
    [before, after].some((v) => v !== null && (!Number.isSafeInteger(v) || v < 0)) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    json(ctx.res, 400, { error: 'bad_request', message: 'The request is malformed.' });
    return;
  }
  const db = getDb();
  // Without `after` the page is the newest `limit` items before `before` (or the end).
  const newest = after === null;
  const window = newest ? 'item_order < ? ORDER BY item_order DESC' : 'item_order > ? ORDER BY item_order';
  const bound = newest ? (before ?? Number.MAX_SAFE_INTEGER) : after;
  const messages = await db.all<MessageRow>(
    `SELECT * FROM app_messages WHERE conversation_id = ? AND ${window} LIMIT ?`,
    c.id,
    bound,
    limit,
  );
  const questions = await db.all<QuestionRow>(
    `SELECT * FROM app_questions WHERE conversation_id = ? AND ${window} LIMIT ?`,
    c.id,
    bound,
    limit,
  );
  const merged = [...messages.map(messageEntity), ...questions.map(questionEntity)].sort((a, b) => a.order - b.order);
  const items = newest ? merged.slice(-limit) : merged.slice(0, limit);
  const any = async (comparison: '<' | '>', order: number) =>
    Number.isFinite(order) &&
    !!(await db.get(
      `SELECT 1 FROM app_messages WHERE conversation_id = ? AND item_order ${comparison} ? UNION ALL SELECT 1 FROM app_questions WHERE conversation_id = ? AND item_order ${comparison} ? LIMIT 1`,
      c.id,
      order,
      c.id,
      order,
    ));
  json(ctx.res, 200, {
    items,
    hasMoreBefore: await any('<', items[0]?.order ?? before ?? after ?? 0),
    hasMoreAfter: await any('>', items.at(-1)?.order ?? after ?? before ?? Infinity),
  });
};
export const markRead: AppHandler = async (ctx) => {
  const c = await accessibleConversation(ctx);
  if (!c) return;
  const body = await requestBody(ctx);
  const { order } = body;
  if (typeof order !== 'number' || !Number.isSafeInteger(order) || order < 0) {
    json(ctx.res, 400, { error: 'bad_request', message: 'The request is malformed.' });
    return;
  }
  await updateReadOrder(ctx, c, order);
};
export const markUnread: AppHandler = async (ctx) => {
  const c = await accessibleConversation(ctx);
  if (!c) return;
  const auth = parseAuthorization(ctx.req.headers.authorization)!;
  await readSignedBody(ctx.req, auth.bodyHash, 0);
  await updateReadOrder(ctx, c, 'unread');
};
async function updateReadOrder(ctx: AppRequest, c: ConversationRow, order: number | 'unread'): Promise<void> {
  const availability = await appHooks.callAvailability(c.user_id, c.agent_group_id);
  const conversation = await appTransaction(async () => {
    const db = getDb();
    const unread = order === 'unread';
    const newest =
      (
        await db.get<{ n: number | null }>(
          `SELECT MAX(item_order) AS n FROM (SELECT item_order FROM app_messages WHERE conversation_id = ? ${unread ? "AND role = 'agent'" : ''}
      UNION ALL SELECT item_order FROM app_questions WHERE conversation_id = ?)`,
          c.id,
          c.id,
        )
      )?.n ?? 0;
    if (unread && !newest)
      throw authError(409, 'nothing_unread', 'There is no agent message or question to mark unread.');
    const target = unread ? newest - 1 : Math.min(order, newest);
    const result = unread
      ? await db.run(
          'UPDATE app_read_state SET read_order = ? WHERE user_id = ? AND conversation_id = ? AND read_order > ?',
          target,
          c.user_id,
          c.id,
          target,
        )
      : await db.run(
          'INSERT INTO app_read_state (user_id,conversation_id,read_order) VALUES (?,?,?) ON CONFLICT (user_id,conversation_id) DO UPDATE SET read_order = excluded.read_order WHERE app_read_state.read_order < excluded.read_order',
          c.user_id,
          c.id,
          target,
        );
    if (result.changes && (unread || target > 0)) {
      await bumpBadge(c.user_id, c.agent_group_id);
      return conversationEvent((await getConversation(c.id))!, availability);
    }
    return conversationEntity((await getConversation(c.id))!, availability);
  });
  json(ctx.res, 200, { conversation, badge: await badgeFor(c.user_id, ctx.identity!.agentIds) });
}
