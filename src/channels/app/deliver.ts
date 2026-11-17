import { randomUUID } from 'node:crypto';
import type { ChannelAdapter } from '../adapter.js';
import { normalizeOptions, type RawOption } from '../ask-question.js';
import { getDb } from '../../db/connection.js';
import { getPendingQuestion } from '../../db/sessions.js';
import { registerMigration } from '../../db/migrations/index.js';
import { log } from '../../log.js';
import type { Message, Question } from './contract.js';
import type { MessageRow } from './db.js';
import { appTransaction, appendEvent, appHooks } from './log.js';
import { getConversationByPlatformId, getConversation, messageEntity, itemChanged } from './conversations.js';
import { saveMessage } from './send.js';

registerMigration({
  version: 1,
  name: 'module:app:n2a-applied-sources',
  async up(db) {
    await db.exec(
      'CREATE TABLE IF NOT EXISTS app_applied_sources (source_id TEXT PRIMARY KEY, entity_id TEXT NOT NULL)',
    );
  },
});
export const deliver: ChannelAdapter['deliver'] = async (platformId, _threadId, message) => {
  let db;
  try {
    db = getDb();
  } catch {
    log.warn('App delivery has no database');
    return undefined;
  }
  const c = await getConversationByPlatformId(platformId);
  if (!c) {
    log.warn('App delivery has no conversation');
    return undefined;
  }
  const content = (
    typeof message.content === 'object' && message.content !== null ? message.content : { text: message.content }
  ) as Record<string, unknown>;
  const source = message.sourceId ?? null;
  const previous = source
    ? await db.get<{ entity_id: string }>('SELECT entity_id FROM app_applied_sources WHERE source_id=?', source)
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
        'SELECT entity_id FROM app_applied_sources WHERE source_id=?',
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
        'SELECT m.* FROM app_messages m JOIN app_applied_sources s ON s.entity_id=m.id WHERE s.source_id=? AND m.conversation_id=?',
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
      if (content.operation === 'edit' && row.role === 'user') return undefined;
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
      if (content.type === 'ask_question' && !hostCard) {
        const questionId = String(content.questionId);
        const pending = await getPendingQuestion(questionId);
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
          pending?.session_id ?? '',
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
        const hostOrigin = !source || source.startsWith('hcmd-');
        const voice = (content.voice === 'caller' && hostOrigin) || content.voice === 'spoken' ? content.voice : null;
        const role =
          voice === 'caller'
            ? 'user'
            : voice === 'spoken'
              ? 'agent'
              : (content.host === true && hostOrigin) || hostCard || !source
                ? 'host'
                : 'agent';
        const card = content.card as { description?: string; title?: string } | undefined;
        let text =
          content.type === 'ask_question'
            ? [content.title, content.question].filter(Boolean).join('\n\n')
            : String(content.fallbackText || content.text || card?.description || card?.title || '');
        if (voice) text = text.replace(/^[\u{1F399}\u{1F50A}]\uFE0F? /u, '');
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
    if (source) await db.run('INSERT INTO app_applied_sources (source_id,entity_id) VALUES (?,?)', source, entityId);
    return entityId;
  });
};
