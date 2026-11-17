import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { getDb, initSqliteTestDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { deliver } from './deliver.js';
import {
  ensureConversation,
  getConversation,
  messageEntity,
  questionEntity,
  history,
  markRead,
  listConversations,
  badgeFor,
} from './conversations.js';
import { appTransaction, appendEvent, lastEventSeq, onEventAppended, readEventsAfter, setAppHooks } from './log.js';
import { sendMessage, drainRoutingJobs, recoverRoutingJobs, saveMessage, setDelivery } from './send.js';
import { answerQuestion, expireQuestions, recoverAnswers } from './questions.js';
import type { AppHandler } from './routes.js';
import type { MessageRow, QuestionRow } from './db.js';
import type { Message } from './contract.js';
import fixtures from './app-contract.fixtures.json' with { type: 'json' };

const mocks = vi.hoisted(() => ({ bodies: new WeakMap<IncomingMessage, Buffer>(), response: vi.fn() }));
vi.mock('../../modules/device-auth/verify.js', () => ({
  readSignedBody: (req: IncomingMessage) => Promise.resolve(mocks.bodies.get(req)!),
}));
vi.mock('../../response-registry.js', () => ({ getResponseHandlers: () => [mocks.response] }));
vi.mock('../../router.js', () => ({ routeInbound: vi.fn(), registerMessageInterceptor: vi.fn() }));
vi.mock('../voice-mode-command.js', () => ({
  parseVoiceCommand: (text: string) => (/^\s*\/voice(?:@\S*)?(?!\S)/i.test(text) ? {} : null),
}));
let conversationId: string;
beforeEach(async () => {
  const db = await initSqliteTestDb();
  await runMigrations(db);
  await db.run("INSERT INTO agent_groups (id,name,folder,created_at) VALUES ('ag_stan','Stan','stan','2026-11-17')");
  conversationId = (await ensureConversation('telegram:owner', 'ag_stan')).id;
  setAppHooks({
    claimFiles: async (_db, c) => (c.fileIds.length ? { ok: false, fileId: c.fileIds[0] } : { ok: true, files: [] }),
    callAvailability: async () => ({ canCall: true, callRefusal: null }),
  });
  mocks.response.mockReset().mockResolvedValue(true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
});
async function request(
  handler: AppHandler,
  body: unknown = {},
  id = conversationId,
  userId = 'telegram:owner',
  agentIds = ['ag_stan'],
  query = '',
) {
  const req = new IncomingMessage(new Socket());
  mocks.bodies.set(req, Buffer.from(JSON.stringify(body)));
  req.url = `/app/conversations/${id}/messages${query}`;
  req.headers.authorization = `HeyDan-Sig v=1,p=1,d=dev_test,t=1,n=${Buffer.alloc(16).toString('base64url')},bh=${'0'.repeat(64)},s=eA`;
  const res = new ServerResponse(req);
  let output = '';
  vi.spyOn(res, 'end').mockImplementation(((b: string) => {
    output = b;
    return res;
  }) as typeof res.end);
  await handler({ req, res, params: { id }, identity: { deviceId: 'dev_test', userId, agentIds } });
  return { status: res.statusCode, body: JSON.parse(output) };
}
async function message(id: string) {
  return messageEntity((await getDb().get<MessageRow>('SELECT * FROM app_messages WHERE id=?', id))!);
}
async function question(id: string) {
  return questionEntity((await getDb().get<QuestionRow>('SELECT * FROM app_questions WHERE id=?', id))!);
}
async function ask(expiresAt: number | null = null) {
  const db = getDb();
  await db.run(
    "INSERT OR IGNORE INTO sessions (id,agent_group_id,messaging_group_id,created_at) VALUES ('session','ag_stan',?,'2026-11-17')",
    conversationId,
  );
  const questionId = randomUUID();
  await db.run(
    "INSERT INTO pending_questions (question_id,session_id,message_out_id,title,options_json,created_at) VALUES (?,'session',?,'Deploy','[]','2026-11-17')",
    questionId,
    questionId,
  );
  return (await deliver(conversationId, null, {
    kind: 'chat-sdk',
    sourceId: questionId,
    content: {
      type: 'ask_question',
      questionId,
      title: fixtures.questions.open.title,
      question: fixtures.questions.open.text,
      options: fixtures.questions.open.options,
      expiresAt,
    },
  }))!;
}
it('publishes only committed full snapshots and preserves every version', async () => {
  const seen: number[] = [];
  const off = onEventAppended((e) => seen.push(e.seq));
  const c = (await getConversation(conversationId))!;
  const m = { ...fixtures.messages.send.stored, conversationId, seq: 0, order: 0 } as Message;
  await expect(
    appTransaction(async () => {
      await appendEvent(getDb(), c.user_id, c.agent_group_id, m);
      throw new Error('rollback');
    }),
  ).rejects.toThrow('rollback');
  expect(seen).toEqual([]);
  await appTransaction(() => saveMessage(m, c.user_id, c.agent_group_id));
  await setDelivery(m.id, 'routed');
  await setDelivery(m.id, 'reached');
  const events = (await readEventsAfter(1, 100)).map((e) => JSON.parse(e.entity_json));
  expect(events.map((e) => e.delivery)).toEqual(['stored', 'routed', 'reached']);
  expect(events.map((e) => e.order)).toEqual([m.order, m.order, m.order]);
  expect(seen).toEqual(events.map((e) => e.seq));
  off();
});
it('sends once even when the retry names consumed files, and conflicts on changed content', async () => {
  const claim = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, files: [fixtures.messages.userWithFile.files[0]] })
    .mockResolvedValue({ ok: false, fileId: 'file' });
  setAppHooks({ claimFiles: claim });
  const body = { clientId: randomUUID(), text: 'hello', fileIds: ['file'] };
  const first = await request(sendMessage, body),
    second = await request(sendMessage, body);
  expect(first.status).toBe(200);
  expect(second).toEqual(first);
  expect(claim).toHaveBeenCalledTimes(1);
  expect((await request(sendMessage, { ...body, text: 'changed' })).status).toBe(409);
  const route = vi.fn(async (event) => {
    event.onStored({});
  });
  await drainRoutingJobs(route);
  expect((await message(first.body.message.id)).delivery).toBe('reached');
  expect(route.mock.calls[0][0]).toMatchObject({
    channelType: 'app',
    agentGroupId: 'ag_stan',
    message: { id: first.body.message.id, isMention: true, isGroup: false },
  });
});
it.each(['drop', 'throw', 'restart'] as const)('routing handles %s without replay', async (mode) => {
  const response = await request(sendMessage, { clientId: randomUUID(), text: 'hello', fileIds: [] });
  const id = response.body.message.id;
  const route = vi.fn(async () => {
    if (mode === 'throw') throw new Error('route failed');
  });
  if (mode === 'restart') {
    await getDb().run('UPDATE app_routing_jobs SET started_at=1 WHERE message_id=?', id);
    await recoverRoutingJobs();
  }
  await drainRoutingJobs(route);
  expect((await message(id)).delivery).toBe(mode === 'drop' ? 'routed' : mode === 'throw' ? 'failed' : 'unknown');
  if (mode === 'restart') expect(route).not.toHaveBeenCalled();
  await drainRoutingJobs(route);
  expect(route).toHaveBeenCalledTimes(mode === 'restart' ? 0 : 1);
});
it('refuses commands without storing and distinguishes ownership from access', async () => {
  for (const [text, error] of [
    ['/voice new', 'use_call_screen'],
    ['/pair', 'use_pairing_screen'],
  ])
    expect((await request(sendMessage, { clientId: randomUUID(), text, fileIds: [] })).body.error).toBe(error);
  expect((await getDb().all('SELECT * FROM app_messages')).length).toBe(0);
  expect((await request(history, {}, conversationId, 'telegram:other')).status).toBe(404);
  expect((await request(history, {}, conversationId, 'telegram:owner', [])).status).toBe(403);
});
it.each(['host', 'voiceCaller', 'voiceSpoken'] as const)(
  'delivers fixture %s with stable source identity',
  async (key) => {
    const expected = fixtures.messages[key];
    const sourceId = key === 'host' ? 'hcmd-reply-1' : key;
    const content = {
      text: (key === 'voiceCaller' ? '🎙️ ' : key === 'voiceSpoken' ? '🔊 ' : '') + expected.text,
      voice: expected.voice,
    };
    const id = (await deliver(conversationId, null, { kind: 'chat', sourceId, content }))!;
    const seq = await lastEventSeq();
    expect(await deliver(conversationId, null, { kind: 'chat', sourceId, content })).toBe(id);
    expect(await lastEventSeq()).toBe(seq);
    expect(await message(id)).toEqual({
      ...expected,
      id,
      conversationId,
      seq: expect.any(Number),
      order: expect.any(Number),
      createdAt: expect.any(Number),
    });
  },
);
it('edits and reacts in place, deduplicating operation sources', async () => {
  const [first, edit, reaction] = fixtures.messages.editSequence;
  const id = (await deliver(conversationId, null, { kind: 'chat', sourceId: 'first', content: { text: first.text } }))!;
  const original = await message(id);
  vi.spyOn(Date, 'now').mockReturnValue(edit.editedAt!);
  await deliver(conversationId, null, {
    kind: 'chat',
    sourceId: 'edit',
    content: { operation: 'edit', messageId: id, text: edit.text },
  });
  const edited = await message(id);
  expect(edited).toMatchObject({ id, order: original.order, text: edit.text, editedAt: edit.editedAt });
  const command = {
    kind: 'chat',
    sourceId: 'reaction',
    content: { operation: 'reaction', messageId: id, emoji: reaction.reactions[0].emoji },
  };
  await deliver(conversationId, null, command);
  const seq = await lastEventSeq();
  await deliver(conversationId, null, command);
  expect(await lastEventSeq()).toBe(seq);
  expect((await message(id)).reactions).toEqual(reaction.reactions);
});
it('questions normalize options and keep a null deadline', async () => {
  const id = await ask();
  expect(await question(id)).toEqual({
    ...fixtures.questions.noDeadline,
    id,
    conversationId,
    seq: expect.any(Number),
    order: expect.any(Number),
    createdAt: expect.any(Number),
  });
});
it('answers first-wins across devices, retries the same answer and rejects conflicts', async () => {
  const id = await ask(Date.now() + 300000);
  const results = await Promise.all([
    request(answerQuestion, { value: 'staging' }, id),
    request(answerQuestion, { value: 'production' }, id),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(mocks.response).toHaveBeenCalledTimes(1);
  const q = await question(id);
  expect(q.state).toBe('answered');
  expect((await request(answerQuestion, { value: q.answer!.value }, id)).status).toBe(200);
  expect(mocks.response).toHaveBeenCalledTimes(1);
});
it('undoes failed answer handoff and returns the fixture error', async () => {
  const id = await ask();
  mocks.response.mockRejectedValue(new Error('unavailable'));
  expect(await request(answerQuestion, { value: 'staging' }, id)).toEqual(fixtures.errors.answerNotDelivered);
  expect((await question(id)).state).toBe('open');
});
it('recovers a claimed answer once on boot', async () => {
  const id = await ask();
  await getDb().run(
    "UPDATE app_questions SET state='answered',answer_json=?,answer_user_id='telegram:owner',handoff_state='pending' WHERE id=?",
    JSON.stringify(fixtures.questions.answered.answer),
    id,
  );
  await recoverAnswers();
  await recoverAnswers();
  expect(mocks.response).toHaveBeenCalledTimes(1);
});
it.each(['deadline', 'pending', 'session'])('expires when %s is gone', async (cause) => {
  const id = await ask(cause === 'deadline' ? Date.now() - 1 : null);
  if (cause === 'pending') await getDb().run('DELETE FROM pending_questions');
  if (cause === 'session') {
    await getDb().run('DELETE FROM pending_questions');
    await getDb().run('DELETE FROM sessions');
  }
  await expireQuestions();
  expect((await question(id)).state).toBe('expired');
  expect((await request(answerQuestion, { value: 'staging' }, id)).status).toBe(409);
});
it('host cards are messages, never answerable', async () => {
  for (const prefix of ['hcmd-', 'appr-']) {
    const id = (await deliver(conversationId, null, {
      kind: 'chat-sdk',
      sourceId: prefix + 'source',
      content: {
        type: 'ask_question',
        questionId: prefix + 'question',
        title: 'Host',
        question: 'Card',
        options: ['yes'],
      },
    }))!;
    expect((await message(id)).role).toBe('host');
    expect((await request(answerQuestion, { value: 'yes' }, id)).status).toBe(404);
  }
});
it('lists from a safe cursor, pages by order and clamps monotone read state and badges', async () => {
  const ids = [];
  for (let i = 0; i < 3; i++)
    ids.push(
      (await deliver(conversationId, null, {
        kind: 'chat',
        sourceId: `a${i}`,
        content: { text: `**Message ${i}**` },
      }))!,
    );
  const list = await request(listConversations);
  expect(list.body.conversations[0]).toMatchObject({ unread: 3, lastMessage: { preview: 'Message 2' }, canCall: true });
  expect(list.body.seq).toBe(await lastEventSeq());
  const page = await request(history, {}, conversationId, 'telegram:owner', ['ag_stan'], '?limit=2');
  expect(page.body.items.map((m: Message) => m.id)).toEqual(ids.slice(1));
  expect(page.body.hasMoreBefore).toBe(true);
  const first = await message(ids[0]);
  const after = await request(
    history,
    {},
    conversationId,
    'telegram:owner',
    ['ag_stan'],
    `?after=${first.order}&limit=1`,
  );
  expect(after.body.items[0].id).toBe(ids[1]);
  expect(after.body.hasMoreAfter).toBe(true);
  await request(markRead, { order: 999999 });
  const seq = await lastEventSeq();
  await request(markRead, { order: 0 });
  expect(await lastEventSeq()).toBe(seq);
  expect(await badgeFor('telegram:owner', ['ag_stan'])).toMatchObject({ unreadTotal: 0, rev: 4 });
});
it.each(Object.entries(fixtures.messages).filter(([key]) => ['userFailed', 'userUnknown'].includes(key)))(
  'matches delivery error fixture %s',
  async (_key, expected) => {
    const e = expected as Message;
    const c = (await getConversation(conversationId))!;
    await appTransaction(() =>
      saveMessage(
        { ...e, conversationId, order: 0, seq: 0, delivery: 'stored', deliveryError: null },
        c.user_id,
        c.agent_group_id,
      ),
    );
    await setDelivery(e.id, e.delivery!);
    expect((await message(e.id)).deliveryError).toEqual(e.deliveryError);
  },
);
it('rolls back partial file claims on refusal', async () => {
  setAppHooks({
    claimFiles: async (db) => {
      await db.run("INSERT INTO app_badge_revisions (user_id,rev) VALUES ('partial',1)");
      return { ok: false, fileId: 'bad' };
    },
  });
  expect((await request(sendMessage, { clientId: randomUUID(), text: 'file', fileIds: ['bad'] })).status).toBe(400);
  expect(await getDb().get("SELECT * FROM app_badge_revisions WHERE user_id='partial'")).toBeUndefined();
});
it('emits external transaction events only after commit and never after rollback', async () => {
  const seen: number[] = [];
  const off = onEventAppended((e) => seen.push(e.seq));
  const c = (await getConversation(conversationId))!;
  await getDb().transaction(async () => {
    await appendEvent(getDb(), c.user_id, c.agent_group_id, { ...fixtures.messages.host, order: 0, seq: 0 });
    expect(seen).toEqual([]);
  });
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  await expect(
    getDb().transaction(async () => {
      await appendEvent(getDb(), c.user_id, c.agent_group_id, {
        ...fixtures.messages.host,
        id: 'rolled-back',
        order: 0,
        seq: 0,
      });
      throw new Error('abort');
    }),
  ).rejects.toThrow('abort');
  await new Promise((resolve) => setImmediate(resolve));
  expect(seen).toHaveLength(1);
  off();
});
it('returns fixture question states, response and conflict shapes', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(fixtures.questions.open.createdAt);
  const id = await ask(fixtures.questions.open.expiresAt);
  const open = await question(id);
  expect(open).toEqual({ ...fixtures.questions.open, id, conversationId, seq: open.seq, order: open.order });
  vi.spyOn(Date, 'now').mockReturnValue(fixtures.questions.answered.answer.at);
  const answer = await request(answerQuestion, { value: 'staging' }, id);
  const expected = {
    ...fixtures.answerResponse.question,
    id,
    conversationId,
    order: open.order,
    seq: answer.body.question.seq,
  };
  expect(answer.body).toEqual({ question: expected });
  expect(await request(answerQuestion, { value: 'production' }, id)).toEqual({
    ...fixtures.answerConflict,
    body: { ...fixtures.answerConflict.body, question: expected },
  });
  const expiring = await ask(fixtures.questions.expired.expiresAt);
  vi.spyOn(Date, 'now').mockReturnValue(fixtures.questions.expired.expiresAt);
  await expireQuestions();
  expect((await question(expiring)).state).toBe(fixtures.questions.expired.state);
});
