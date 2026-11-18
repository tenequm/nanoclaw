import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../../db/connection.js';
import { onHostStart, onHostShutdown } from '../../host-lifecycle.js';
import { routeInbound } from '../../router.js';
import { parseVoiceCommand } from '../voice-mode-command.js';
import { log } from '../../log.js';
import type { Message, Delivery } from './contract.js';
import type { MessageRow, RoutingJobRow } from './db.js';
import { appTransaction, appHooks, appendEvent } from './log.js';
import { accessibleConversation, requestBody, messageEntity, itemChanged, getConversation } from './conversations.js';
import { json, type AppHandler } from './routes.js';

export async function saveMessage(
  message: Message,
  userId: string,
  agentId: string,
  sourceId: string | null = null,
  hash: string | null = null,
): Promise<void> {
  const db = getDb();
  await appendEvent(db, userId, agentId, message);
  await db.run(
    `INSERT INTO app_messages (id,conversation_id,user_id,item_order,seq,role,text,files_json,reactions_json,voice,reply_to,client_id,request_hash,source_id,delivery,delivery_error_json,created_at,edited_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO UPDATE SET seq=excluded.seq,text=excluded.text,reactions_json=excluded.reactions_json,delivery=excluded.delivery,delivery_error_json=excluded.delivery_error_json,edited_at=excluded.edited_at`,
    message.id,
    message.conversationId,
    userId,
    message.order,
    message.seq,
    message.role,
    message.text,
    JSON.stringify(message.files),
    JSON.stringify(message.reactions),
    message.voice,
    message.replyTo,
    message.clientId,
    hash,
    sourceId,
    message.delivery,
    message.deliveryError ? JSON.stringify(message.deliveryError) : null,
    message.createdAt,
    message.editedAt,
  );
}
class BadFileClaim extends Error {
  constructor(readonly fileId: string) {
    super('Attachment claim failed');
  }
}
export const sendMessage: AppHandler = async (ctx) => {
  const c = await accessibleConversation(ctx, ctx.params.id, false);
  if (!c) return;
  const body = await requestBody(ctx);
  const { clientId, text, fileIds } = body;
  if (
    typeof clientId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId) ||
    typeof text !== 'string' ||
    Buffer.byteLength(text) > 32768 ||
    !Array.isArray(fileIds) ||
    fileIds.length > 10 ||
    fileIds.some((id) => typeof id !== 'string') ||
    new Set(fileIds).size !== fileIds.length
  ) {
    json(ctx.res, 400, { error: 'bad_request', message: 'The request is malformed.' });
    return;
  }
  if (parseVoiceCommand(text, 'app')) {
    json(ctx.res, 409, { error: 'use_call_screen', message: 'Start a call with the call button.' });
    return;
  }
  if (/^\s*\/pair(?:@\S*)?(?!\S)/i.test(text)) {
    json(ctx.res, 409, { error: 'use_pairing_screen', message: 'Add agents from Telegram with /pair.' });
    return;
  }
  const hash = createHash('sha256').update(JSON.stringify({ text, fileIds })).digest('hex');
  const availability = await appHooks.callAvailability(c.user_id, c.agent_group_id);
  const result = await appTransaction(async () => {
    const db = getDb();
    const existing = await db.get<MessageRow>(
      'SELECT * FROM app_messages WHERE user_id = ? AND conversation_id = ? AND client_id = ?',
      c.user_id,
      c.id,
      clientId,
    );
    if (existing)
      return existing.request_hash === hash
        ? { status: 200, body: { message: messageEntity(existing) } }
        : {
            status: 409,
            body: { error: 'client_id_conflict', message: 'This message was already sent with different content.' },
          };
    const id = `msg_${randomUUID()}`;
    const claimed = await appHooks.claimFiles(db, { userId: c.user_id, conversationId: c.id, messageId: id, fileIds });
    if (!claimed.ok) throw new BadFileClaim(claimed.fileId);
    const message: Message = {
      kind: 'message',
      id,
      conversationId: c.id,
      seq: 0,
      order: 0,
      role: 'user',
      text,
      files: claimed.files,
      reactions: [],
      voice: null,
      replyTo: null,
      clientId,
      delivery: 'stored',
      deliveryError: null,
      createdAt: Date.now(),
      editedAt: null,
    };
    await saveMessage(message, c.user_id, c.agent_group_id, null, hash);
    await itemChanged((await getConversation(c.id))!, message, true, availability);
    await db.run(
      "INSERT INTO app_routing_jobs (message_id,state,created_at) VALUES (?,'pending',?)",
      id,
      message.createdAt,
    );
    return { status: 200, body: { message } };
  }).catch((error: unknown) => {
    if (!(error instanceof BadFileClaim)) throw error;
    return {
      status: 400,
      body: { error: 'bad_file', message: 'An attachment is missing or was already sent.', fileId: error.fileId },
    };
  });
  json(ctx.res, result.status, result.body);
  if (started) void drainRoutingJobs().catch(() => log.warn('App routing worker failed'));
};
export async function setDelivery(id: string, delivery: Delivery): Promise<void> {
  await appTransaction(async () => {
    const row = await getDb().get<MessageRow>('SELECT * FROM app_messages WHERE id = ?', id);
    if (
      !row ||
      row.delivery === delivery ||
      row.delivery === 'reached' ||
      row.delivery === 'failed' ||
      row.delivery === 'unknown'
    )
      return;
    const c = (await getConversation(row.conversation_id))!;
    const message = messageEntity(row);
    message.delivery = delivery;
    message.deliveryError =
      delivery === 'failed'
        ? { error: 'not_routed', message: 'This message did not reach the agent. You can send it again.' }
        : delivery === 'unknown'
          ? {
              error: 'outcome_unknown',
              message:
                'The host restarted while sending this, so it may or may not have reached the agent. Check before you send it again.',
            }
          : null;
    await saveMessage(message, c.user_id, c.agent_group_id);
  });
}
let started = false;
let timer: ReturnType<typeof setInterval> | undefined;
let draining: Promise<void> | undefined;
export async function recoverRoutingJobs(): Promise<void> {
  for (const job of await getDb().all<RoutingJobRow>(
    'SELECT * FROM app_routing_jobs WHERE started_at IS NOT NULL AND finished_at IS NULL',
  )) {
    await appTransaction(async () => {
      await setDelivery(job.message_id, 'unknown');
      await getDb().run(
        "UPDATE app_routing_jobs SET state='unknown',finished_at=? WHERE message_id=?",
        Date.now(),
        job.message_id,
      );
    });
  }
}
export async function drainRoutingJobs(route = routeInbound): Promise<void> {
  if (draining) return draining;
  draining = (async () => {
    for (const job of await getDb().all<RoutingJobRow>(
      "SELECT * FROM app_routing_jobs WHERE state = 'pending' AND started_at IS NULL ORDER BY created_at, rowid",
    )) {
      const claimed = await getDb().run(
        "UPDATE app_routing_jobs SET started_at=?,state='started',attempts=attempts+1 WHERE message_id=? AND started_at IS NULL",
        Date.now(),
        job.message_id,
      );
      if (!claimed.changes) continue;
      const row = (await getDb().get<MessageRow>('SELECT * FROM app_messages WHERE id=?', job.message_id))!;
      const c = (await getConversation(row.conversation_id))!;
      let stored: Promise<void> | undefined;
      try {
        const attachments = await appHooks.stageFiles(row.id);
        await setDelivery(row.id, 'routed');
        const sender = await getDb().get<{ display_name: string }>(
          'SELECT display_name FROM users WHERE id=?',
          c.user_id,
        );
        await route({
          channelType: 'app',
          instance: 'app',
          platformId: c.id,
          threadId: null,
          agentGroupId: c.agent_group_id,
          message: {
            id: row.id,
            kind: 'chat',
            timestamp: new Date(row.created_at).toISOString(),
            isMention: true,
            isGroup: false,
            content: JSON.stringify({
              text: row.text,
              senderId: c.user_id,
              sender: sender?.display_name ?? c.user_id,
              attachments,
            }),
          },
          onStored: () => {
            stored = setDelivery(row.id, 'reached');
            void stored.catch(() => undefined);
          },
        });
        await stored;
        await getDb().run(
          "UPDATE app_routing_jobs SET state='finished',finished_at=? WHERE message_id=?",
          Date.now(),
          row.id,
        );
      } catch {
        await stored?.catch(() => undefined);
        await setDelivery(row.id, 'failed');
        await getDb().run(
          "UPDATE app_routing_jobs SET state='failed',finished_at=? WHERE message_id=?",
          Date.now(),
          row.id,
        );
      }
    }
  })();
  try {
    await draining;
  } finally {
    draining = undefined;
  }
}
onHostStart(async () => {
  try {
    await recoverRoutingJobs();
  } catch {
    log.warn('App routing recovery failed');
  }
  started = true;
  timer = setInterval(() => {
    void drainRoutingJobs().catch(() => log.warn('App routing worker failed'));
  }, 1000);
  timer.unref();
  void drainRoutingJobs().catch(() => log.warn('App routing worker failed'));
});
onHostShutdown(async () => {
  started = false;
  clearInterval(timer);
  await draining;
});
