import { randomUUID } from 'node:crypto';
import type { ChannelAdapter } from '../adapter.js';
import { normalizeOptions, type RawOption } from '../ask-question.js';
import {
  CARD_LIMITS,
  cardProblems,
  emptyCardCounts,
  isCardPart,
  isRecord,
  type CardPart as ToolPart,
} from '../card-parts.js';
import { getDb, hasTable } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { getPendingQuestion } from '../../db/sessions.js';
import { log } from '../../log.js';
import { isHostWrittenOutbound } from '../../session-manager.js';
import type { Card, CardChart, CardPart, Message, Question } from './contract.js';
import type { MessageRow } from './db.js';
import { appTransaction, appendEvent, appHooks } from './log.js';
import { getConversation, messageEntity, itemChanged } from './conversations.js';
import { saveMessage } from './send.js';
import { CALLER_MARK, SPOKEN_MARK } from '../voice-mode-livekit.js';

function limitedText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.slice(0, max).replace(/[\uD800-\uDBFF]$/u, '');
  return text.trim() ? text : null;
}

function normalizePart(child: ToolPart): CardPart | null {
  const props = isRecord(child.props) ? child.props : {};
  switch (child.type) {
    case 'Text':
      return {
        type: 'text',
        content: props.content as string,
        style: props.style === 'bold' || props.style === 'muted' ? props.style : 'plain',
      };
    case 'Divider':
      return { type: 'divider' };
    case 'Fields': {
      const fields = child.children as { props: { label: string; value: string | number } }[];
      return { type: 'fields', fields: fields.map(({ props: { label, value } }) => ({ label, value: String(value) })) };
    }
    case 'Table': {
      const { headers, rows, align, caption } = props as {
        headers: string[];
        rows: (string | number)[][];
        align?: ('left' | 'center' | 'right')[];
        caption?: string;
      };
      return {
        type: 'table',
        headers,
        rows: rows.map((row) => row.map(String)),
        align: align ?? null,
        caption: caption ?? null,
      };
    }
    case 'Chart': {
      const title = props.title as string;
      const chart = props.chart as CardChart;
      if (chart.type === 'pie') {
        return {
          type: 'chart',
          title,
          chart: { type: 'pie', segments: chart.segments.map(({ label, value }) => ({ label, value })) },
        };
      }
      const series = chart.series.map(({ name, values }) => ({ name, values }));
      return { type: 'chart', title, chart: { type: chart.type, categories: chart.categories, series } };
    }
    default:
      return null;
  }
}

function linkUrl(raw: unknown): string | null {
  if (
    typeof raw !== 'string' ||
    raw.length > 2048 ||
    !/^https?:\/\/[^/?#@\\\s\p{Cc}]+(?:[/?#][^\s\p{Cc}]*)?$/iu.test(raw)
  )
    return null;
  const url = URL.parse(raw);
  if (!url || url.username || url.password || url.href.length > 2048) return null;
  return url.href;
}

function normalizeCard(raw: unknown): Card | null {
  if (!isRecord(raw)) return null;
  const counts = emptyCardCounts();
  function takeText(value: unknown, max: number): string | null {
    const text = limitedText(value, max);
    return text && !cardProblems({ children: [text] }, counts).length ? text : null;
  }
  const title = takeText(raw.title, 200);
  const description = takeText(raw.description, CARD_LIMITS.text);
  const parts: CardPart[] = [];
  let plainChildren = 0;
  for (const child of Array.isArray(raw.children) ? raw.children : []) {
    if (!isCardPart(child)) {
      if (plainChildren === 20) continue;
      const content = takeText(isRecord(child) ? child.text : child, CARD_LIMITS.text);
      if (content) {
        parts.push({ type: 'text', content, style: 'plain' });
        plainChildren++;
      }
      continue;
    }
    if (counts.parts === CARD_LIMITS.parts) continue;
    const candidate =
      child.type === 'Fields' && Array.isArray(child.children)
        ? { ...child, children: child.children.slice(0, CARD_LIMITS.fields - counts.fields) }
        : child;
    try {
      if (cardProblems({ children: [candidate] }, counts).length) continue;
    } catch {
      // Malformed JSON values can throw during coercion in validator diagnostics.
      continue;
    }
    const part = normalizePart(candidate);
    if (part) parts.push(part);
  }
  const actions: Card['actions'] = [];
  for (const action of Array.isArray(raw.actions) ? raw.actions : []) {
    if (!isRecord(action)) continue;
    const label = limitedText(action.label, 80);
    const url = linkUrl(action.url);
    if (!label || !url || cardProblems({ actions: [{ label, url }] }, counts).length) continue;
    const { style } = action;
    actions.push({ label, url, style: style === 'primary' || style === 'danger' ? style : 'default' });
    if (actions.length === 10) break;
  }
  return title || description || parts.length || actions.length ? { title, description, parts, actions } : null;
}

function cardFallback(card: Card): string {
  const lines = [card.title, card.description];
  for (const part of card.parts) {
    switch (part.type) {
      case 'text':
        lines.push(part.content);
        break;
      case 'fields':
        lines.push(...part.fields.slice(0, 3).map(({ label, value }) => `${label}: ${value}`));
        break;
      case 'table':
        lines.push(part.caption || part.headers.join(' | ').trim() || 'Table');
        break;
      case 'chart':
        lines.push(part.title);
        break;
    }
  }
  return lines.filter(Boolean).join('\n') || card.actions[0]?.label || 'Card';
}

function outboundText(content: Record<string, unknown>, card: Card | null | undefined): string {
  if (content.type === 'ask_question') return [content.title, content.question].filter(Boolean).join('\n\n');
  if (card !== undefined) {
    for (const value of [content.fallbackText, content.text]) {
      if (typeof value === 'string' && value.trim()) return value;
    }
    return card ? cardFallback(card) : '';
  }
  const raw = isRecord(content.card) ? content.card : {};
  return String(
    content.fallbackText ||
      content.text ||
      (typeof raw.description === 'string' && raw.description) ||
      (typeof raw.title === 'string' && raw.title) ||
      '',
  );
}

// An app answer goes to the interactive handler only, so a card must not reuse an id a host approval waits on.
const HOST_APPROVALS = [
  ['pending_approvals', 'approval_id'],
  ['pending_sender_approvals', 'id'],
  ['pending_channel_approvals', 'messaging_group_id'],
] as const;
async function heldByHostApproval(db: DbDriver, id: string): Promise<boolean> {
  for (const [table, column] of HOST_APPROVALS)
    if ((await hasTable(db, table)) && (await db.get(`SELECT 1 FROM ${table} WHERE ${column}=?`, id))) return true;
  return false;
}
export const deliver: ChannelAdapter['deliver'] = async (platformId, _threadId, message) => {
  const db = getDb();
  const c = await getConversation(platformId);
  if (!c) {
    log.warn('App delivery has no conversation');
    return undefined;
  }
  const content = (
    typeof message.content === 'object' && message.content !== null ? message.content : { text: message.content }
  ) as Record<string, unknown>;
  const source = message.sourceId ?? null;
  // Direct host deliveries carry no source; a container's outbox row always does, under an id it chose.
  const hostWritten = !source || isHostWrittenOutbound(source);
  const previous = source
    ? await db.get<{ entity_id: string }>(
        'SELECT entity_id FROM app_applied_sources WHERE conversation_id=? AND source_id=?',
        c.id,
        source,
      )
    : undefined;
  if (previous) return previous.entity_id;
  const id = `msg_${randomUUID()}`;
  const files = await appHooks.storeOutboundFiles({
    userId: c.user_id,
    conversationId: c.id,
    messageId: id,
    files: message.files ?? [],
  });
  const availability = await appHooks.callAvailability(c.user_id, c.agent_group_id);
  return appTransaction(async () => {
    if (source) {
      const applied = await db.get<{ entity_id: string }>(
        'SELECT entity_id FROM app_applied_sources WHERE conversation_id=? AND source_id=?',
        c.id,
        source,
      );
      if (applied) return applied.entity_id;
    }
    const current = (await getConversation(c.id))!;
    let entityId: string;
    if (content.operation === 'edit' || content.operation === 'reaction') {
      let row = await db.get<MessageRow>(
        'SELECT * FROM app_messages WHERE id=? AND conversation_id=?',
        content.messageId,
        c.id,
      );
      row ??= await db.get<MessageRow>(
        'SELECT m.* FROM app_messages m JOIN app_applied_sources s ON s.entity_id=m.id AND s.conversation_id=m.conversation_id WHERE s.source_id=? AND m.conversation_id=?',
        content.messageId,
        c.id,
      );
      if (!row) {
        log.warn('App delivery target unresolved', {
          messageId: content.messageId,
          conversationId: c.id,
          sourceId: source,
        });
        throw new Error('App delivery target unresolved');
      }
      if (content.operation === 'edit' && (row.role === 'user' || (row.role === 'host' && !hostWritten)))
        return undefined;
      const entity = messageEntity(row);
      if (content.operation === 'edit') {
        entity.text = String(content.text ?? '');
        entity.card = null;
        entity.editedAt = Date.now();
      } else if (
        typeof content.emoji === 'string' &&
        !entity.reactions.some((r) => r.emoji === content.emoji && r.by === 'agent')
      )
        entity.reactions.push({ emoji: content.emoji, by: 'agent' });
      await saveMessage(entity, c.user_id, c.agent_group_id);
      if (content.operation === 'edit') await itemChanged(current, entity, false, availability);
      entityId = entity.id;
    } else {
      const hostCard = [source, content.questionId].some((v) => typeof v === 'string' && /^(hcmd-|appr-)/.test(v));
      const questionId = content.type === 'ask_question' && !hostCard ? String(content.questionId) : null;
      const pending = questionId ? await getPendingQuestion(questionId) : undefined;
      if (
        questionId &&
        pending?.channel_type === 'app' &&
        pending.platform_id === c.id &&
        !(await heldByHostApproval(db, questionId))
      ) {
        const entity: Question = {
          kind: 'question',
          id: `q_${randomUUID()}`,
          conversationId: c.id,
          order: 0,
          seq: 0,
          title: String(content.title ?? ''),
          text: String(content.question ?? ''),
          options: normalizeOptions((content.options ?? []) as RawOption[]).map((o) => ({
            ...o,
            style: o.style ?? null,
          })),
          state: 'open',
          answer: null,
          createdAt: Date.now(),
          expiresAt: typeof content.expiresAt === 'number' ? content.expiresAt : null,
        };
        await appendEvent(db, c.user_id, c.agent_group_id, entity);
        await db.run(
          `INSERT INTO app_questions (id,conversation_id,item_order,seq,source_id,session_id,question_id,title,text,options_json,state,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,'open',?,?)`,
          entity.id,
          c.id,
          entity.order,
          entity.seq,
          source,
          pending.session_id,
          questionId,
          entity.title,
          entity.text,
          JSON.stringify(entity.options),
          entity.createdAt,
          entity.expiresAt,
        );
        await itemChanged(current, entity, true, availability);
        entityId = entity.id;
      } else {
        const voice = (content.voice === 'caller' && hostWritten) || content.voice === 'spoken' ? content.voice : null;
        const role = voice === 'caller' ? 'user' : voice === 'spoken' ? 'agent' : hostWritten ? 'host' : 'agent';
        const card = content.type === 'card' && !hostWritten && !hostCard ? normalizeCard(content.card) : undefined;
        let text = outboundText(content, card);
        const mark = voice === 'caller' ? CALLER_MARK : SPOKEN_MARK;
        if (voice && text.startsWith(mark)) text = text.slice(mark.length);
        const replyTo =
          message.inReplyTo &&
          (await db.get(
            'SELECT id FROM app_messages WHERE id=? AND conversation_id=? UNION ALL SELECT id FROM app_questions WHERE id=? AND conversation_id=?',
            message.inReplyTo,
            c.id,
            message.inReplyTo,
            c.id,
          ))
            ? message.inReplyTo
            : null;
        const entity: Message = {
          kind: 'message',
          id,
          conversationId: c.id,
          order: 0,
          seq: 0,
          role,
          text,
          card: card ?? null,
          files,
          reactions: [],
          voice,
          replyTo,
          clientId: null,
          delivery: null,
          deliveryError: null,
          createdAt: Date.now(),
          editedAt: null,
        };
        await saveMessage(entity, c.user_id, c.agent_group_id, source);
        await itemChanged(current, entity, true, availability);
        entityId = entity.id;
      }
    }
    if (source)
      await db.run(
        'INSERT INTO app_applied_sources (conversation_id,source_id,entity_id) VALUES (?,?,?)',
        c.id,
        source,
        entityId,
      );
    return entityId;
  });
};
