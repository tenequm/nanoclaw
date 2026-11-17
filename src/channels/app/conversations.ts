import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/connection.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { readSignedBody } from '../../modules/device-auth/verify.js';
import { parseAuthorization, type Conversation, type Badge, type Message, type Question } from './contract.js';
import type { ConversationRow, MessageRow, QuestionRow } from './db.js';
import { appHooks, appTransaction, appendEvent, lastEventSeq, afterAppCommit } from './log.js';
import { json, type AppHandler, type AppRequest } from './routes.js';

export const getConversation = (id: string): Promise<ConversationRow | undefined> =>
  getDb().get('SELECT * FROM app_conversations WHERE id = ?', id);
export const getConversationByPlatformId = getConversation;
export async function conversationsFor(userId: string, agentIds: string[]): Promise<ConversationRow[]> {
  return (
    await getDb().all<ConversationRow>(
      'SELECT * FROM app_conversations WHERE user_id = ? ORDER BY created_at, id',
      userId,
    )
  ).filter((c) => agentIds.includes(c.agent_group_id));
}
export async function ensureConversation(userId: string, agentGroupId: string): Promise<ConversationRow> {
  return appTransaction(async () => {
    const db = getDb();
    const existing = await db.get<ConversationRow>(
      'SELECT * FROM app_conversations WHERE user_id = ? AND agent_group_id = ?',
      userId,
      agentGroupId,
    );
    if (existing) return existing;
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
    const c = (await getConversation(id))!;
    await conversationEvent(c);
    return (await getConversation(id))!;
  });
}
export function plainPreview(text: string): string {
  return text
    .replace(/```[^\n]*\n?/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/(^|\n)\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/g, '$1')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}
export async function conversationEntity(c: ConversationRow): Promise<Conversation> {
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
  return {
    kind: 'conversation',
    id: c.id,
    seq: c.seq,
    agent: { id: c.agent_group_id, name: (await getAgentGroup(c.agent_group_id))?.name ?? c.agent_group_id },
    lastMessage: c.last_message_json ? JSON.parse(c.last_message_json) : null,
    unread,
    readOrder,
    ...(await appHooks.callAvailability(c.user_id, c.agent_group_id)),
    createdAt: c.created_at,
  };
}
export async function conversationEvent(c: ConversationRow): Promise<Conversation> {
  const entity = await conversationEntity(c);
  await appendEvent(getDb(), c.user_id, c.agent_group_id, entity);
  await getDb().run('UPDATE app_conversations SET seq = ? WHERE id = ?', entity.seq, c.id);
  return entity;
}
const badgeListeners = new Set<(userId: string) => void>();
export function onBadgeChanged(listener: (userId: string) => void): () => void {
  badgeListeners.add(listener);
  return () => {
    badgeListeners.delete(listener);
  };
}
export async function bumpBadge(userId: string): Promise<void> {
  await getDb().run(
    'INSERT INTO app_badge_revisions (user_id,rev) VALUES (?,1) ON CONFLICT (user_id) DO UPDATE SET rev = app_badge_revisions.rev + 1',
    userId,
  );
  afterAppCommit(() => {
    for (const listener of badgeListeners) listener(userId);
  });
}
export async function badgeFor(userId: string, agentIds: string[]): Promise<Badge> {
  let unreadTotal = 0;
  for (const c of await conversationsFor(userId, agentIds)) unreadTotal += (await conversationEntity(c)).unread;
  return {
    kind: 'badge',
    rev:
      (await getDb().get<{ rev: number }>('SELECT rev FROM app_badge_revisions WHERE user_id = ?', userId))?.rev ?? 0,
    unreadTotal,
  };
}
export async function itemChanged(c: ConversationRow, item: Message | Question, created: boolean): Promise<void> {
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
    await conversationEvent(c);
  }
  if (created && role === 'agent') await bumpBadge(c.user_id);
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
  hideForbidden = false,
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
export async function requestBody(ctx: AppRequest): Promise<Record<string, unknown> | undefined> {
  const auth = parseAuthorization(ctx.req.headers.authorization);
  if (!auth) {
    json(ctx.res, 401, { error: 'bad_signature', message: 'The request signature is not valid.' });
    return;
  }
  const bytes = await readSignedBody(ctx.req, auth.bodyHash, 256 * 1024);
  let body: unknown;
  try {
    body = JSON.parse(bytes.toString('utf8'));
  } catch {
    json(ctx.res, 400, { error: 'bad_request', message: 'The request is malformed.' });
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    json(ctx.res, 400, { error: 'bad_request', message: 'The request is malformed.' });
    return;
  }
  return body as Record<string, unknown>;
}
export const listConversations: AppHandler = async (ctx) => {
  if (!ctx.identity) {
    json(ctx.res, 401, { error: 'unknown_device', message: 'This device is not paired.' });
    return;
  }
  const seq = await lastEventSeq();
  for (const id of ctx.identity.agentIds) await ensureConversation(ctx.identity.userId, id);
  const rows = await conversationsFor(ctx.identity.userId, ctx.identity.agentIds);
  const conversations = [];
  for (const row of rows) conversations.push(await conversationEntity(row));
  json(ctx.res, 200, {
    conversations,
    statuses: await appHooks.statuses(rows.map((c) => c.id)),
    badge: await badgeFor(ctx.identity.userId, ctx.identity.agentIds),
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
  const bounds = await db.all<{ id: string; item_order: number; kind: string }>(
    `SELECT id,item_order,'message' AS kind FROM app_messages WHERE conversation_id = ? UNION ALL SELECT id,item_order,'question' AS kind FROM app_questions WHERE conversation_id = ? ORDER BY item_order`,
    c.id,
    c.id,
  );
  const eligible = bounds.filter(
    (r) => (before === null || r.item_order < before) && (after === null || r.item_order > after),
  );
  const page = after === null ? eligible.slice(-limit) : eligible.slice(0, limit);
  const items = [];
  for (const r of page)
    items.push(
      r.kind === 'message'
        ? messageEntity((await db.get<MessageRow>('SELECT * FROM app_messages WHERE id = ?', r.id))!)
        : questionEntity((await db.get<QuestionRow>('SELECT * FROM app_questions WHERE id = ?', r.id))!),
    );
  json(ctx.res, 200, {
    items,
    hasMoreBefore: bounds.some((r) => r.item_order < (page[0]?.item_order ?? before ?? after ?? 0)),
    hasMoreAfter: bounds.some((r) => r.item_order > (page.at(-1)?.item_order ?? after ?? before ?? Infinity)),
  });
};
export const markRead: AppHandler = async (ctx) => {
  const c = await accessibleConversation(ctx);
  if (!c) return;
  const body = await requestBody(ctx);
  if (!body) return;
  const { order } = body;
  if (typeof order !== 'number' || !Number.isSafeInteger(order) || order < 0) {
    json(ctx.res, 400, { error: 'bad_request', message: 'The request is malformed.' });
    return;
  }
  const conversation = await appTransaction(async () => {
    const db = getDb();
    const newest =
      (
        await db.get<{ n: number }>(
          'SELECT MAX(item_order) AS n FROM (SELECT item_order FROM app_messages WHERE conversation_id = ? UNION ALL SELECT item_order FROM app_questions WHERE conversation_id = ?)',
          c.id,
          c.id,
        )
      )?.n ?? 0;
    const result = await db.run(
      'INSERT INTO app_read_state (user_id,conversation_id,read_order) VALUES (?,?,?) ON CONFLICT (user_id,conversation_id) DO UPDATE SET read_order = excluded.read_order WHERE app_read_state.read_order < excluded.read_order',
      c.user_id,
      c.id,
      Math.min(order, newest),
    );
    if (result.changes && (await conversationEntity(c)).readOrder > 0) {
      await bumpBadge(c.user_id);
      return conversationEvent((await getConversation(c.id))!);
    }
    return conversationEntity((await getConversation(c.id))!);
  });
  json(ctx.res, 200, { conversation, badge: await badgeFor(c.user_id, ctx.identity!.agentIds) });
};
