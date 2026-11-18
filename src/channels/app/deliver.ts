import { randomUUID } from 'node:crypto';
import type { ChannelAdapter } from '../adapter.js';
import { normalizeOptions, type RawOption } from '../ask-question.js';
import { cardProblems, isCardPart, isRecord } from '../card-parts.js';
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

function normalizePart(child: unknown): CardPart | null {
  if (typeof child === 'string') return { type: 'text', content: child, style: 'plain' };
  if (isRecord(child) && typeof child.text === 'string') return { type: 'text', content: child.text, style: 'plain' };
  if (!isCardPart(child)) return null;
  try {
    if (cardProblems({ children: [child] }).length) return null;
  } catch {
    // Some malformed JSON values cannot be coerced to strings for the validator's diagnostics.
    return null;
  }
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

function normalizeCard(raw: unknown): Card | null {
  if (!isRecord(raw)) return null;
  const parts: CardPart[] = [];
  for (const child of Array.isArray(raw.children) ? raw.children : []) {
    const part = normalizePart(child);
    if (part) parts.push(part);
    if (parts.length === 10) break;
  }
  const actions: Card['actions'] = [];
  for (const action of Array.isArray(raw.actions) ? raw.actions : []) {
    if (!isRecord(action)) continue;
    const { label, url, style } = action;
    if (
      typeof label !== 'string' ||
      !label.trim() ||
      typeof url !== 'string' ||
      !/^https?:\/\/[^/?#\s][^\s]*$/i.test(url) ||
      !URL.canParse(url)
    )
      continue;
    actions.push({ label, url, style: style === 'primary' || style === 'danger' ? style : 'default' });
  }
  return {
    title: typeof raw.title === 'string' ? raw.title : null,
    description: typeof raw.description === 'string' ? raw.description : null,
    parts,
    actions,
  };
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
        const card = content.card as { description?: string; title?: string } | undefined;
        let text =
          content.type === 'ask_question'
            ? [content.title, content.question].filter(Boolean).join('\n\n')
            : String(content.fallbackText || content.text || card?.description || card?.title || '');
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
          card: content.type === 'card' && !hostWritten && !hostCard ? normalizeCard(content.card) : null,
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
