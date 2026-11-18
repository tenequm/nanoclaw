import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { getDb, initSqliteTestDb, closeDb } from '../../db/connection.js';
import { getRegisteredMigrations, runMigrations } from '../../db/migrations/index.js';
import { getHostStartCallbacks, stopHostModules } from '../../host-lifecycle.js';
import { deliver } from './deliver.js';
import { configureFiles } from './files.js';
import { CALLER_MARK, SPOKEN_MARK } from '../voice-mode-livekit.js';
import {
  ensureConversation,
  getConversation,
  messageEntity,
  questionEntity,
  history,
  markRead,
  listConversations,
  badgeFor,
  onBadgeChanged,
  plainPreview,
} from './conversations.js';
import { appTransaction, appendEvent, lastEventSeq, onEventAppended, readEventsAfter, setAppHooks } from './log.js';
import { sendMessage, drainRoutingJobs, recoverRoutingJobs, saveMessage, setDelivery } from './send.js';
import { answerQuestion, expireQuestions, recoverAnswers } from './questions.js';
import type { AppHandler } from './routes.js';
import type { MessageRow, QuestionRow } from './db.js';
import type { Message } from './contract.js';
import fixtures from './app-contract.fixtures.json' with { type: 'json' };

const mocks = vi.hoisted(() => ({
  bodies: new WeakMap<IncomingMessage, Buffer>(),
  response: vi.fn(),
  hostWritten: new Set<string>(),
}));
vi.mock('../../modules/device-auth/verify.js', async (original) => ({
  ...(await original<typeof import('../../modules/device-auth/verify.js')>()),
  readSignedBody: (req: IncomingMessage) => Promise.resolve(mocks.bodies.get(req)!),
}));
vi.mock('../../modules/interactive/index.js', () => ({ handleInteractiveResponse: mocks.response }));
vi.mock('../../session-manager.js', async (original) => ({
  ...(await original<typeof import('../../session-manager.js')>()),
  isHostWrittenOutbound: (id: string) => mocks.hostWritten.has(id),
}));
vi.mock('../../router.js', () => ({ routeInbound: vi.fn(), registerMessageInterceptor: vi.fn() }));
vi.mock('../voice-mode-command.js', async (original) => ({
  ...(await original<typeof import('../voice-mode-command.js')>()),
  parseVoiceCommand: (text: string) => (/^\s*\/voice(?:@\S*)?(?!\S)/i.test(text) ? {} : null),
}));
let conversationId: string;
let fileRoot: string;
beforeEach(async () => {
  fileRoot = mkdtempSync(join(tmpdir(), 'app-conversations-'));
  configureFiles({ root: fileRoot });
  const db = await initSqliteTestDb();
  await runMigrations(db);
  await db.run(
    "INSERT INTO agent_groups (id,name,folder,created_at) VALUES ('ag_taylor','Taylor','taylor','2026-11-17')",
  );
  conversationId = (await ensureConversation('telegram:owner', 'ag_taylor')).id;
  setAppHooks({
    statuses: async (ids) =>
      ids.map((conversationId) => ({
        kind: 'status',
        conversationId,
        rev: 0,
        state: 'idle',
        label: null,
        at: Date.now(),
      })),
    claimFiles: async (_db, c) => (c.fileIds.length ? { ok: false, fileId: c.fileIds[0] } : { ok: true, files: [] }),
    callAvailability: async () => ({ canCall: true, callRefusal: null }),
  });
  mocks.response.mockReset().mockResolvedValue(true);
  mocks.hostWritten.clear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
  configureFiles();
  rmSync(fileRoot, { recursive: true, force: true });
});
async function request(
  handler: AppHandler,
  body: unknown = {},
  id = conversationId,
  userId = 'telegram:owner',
  agentIds = ['ag_taylor'],
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

async function deliverCard(card: unknown, fallbackText = '') {
  const id = await deliver(conversationId, null, {
    kind: 'chat-sdk',
    sourceId: randomUUID(),
    content: { type: 'card', card, fallbackText },
  });
  return message(id!);
}

it('drops malformed children independently and counts only typed parts toward ten', async () => {
  const pie = { type: 'pie', segments: [{ label: 'Passed', value: 2 }] };
  const dividers = Array.from({ length: 8 }, () => ({ type: 'Divider' }));
  const strings = Array.from({ length: 19 }, (_, i) => String(i));
  const delivered = await deliverCard({
    children: [
      null,
      { type: 'Future' },
      { type: 'Fields', children: [{}] },
      {
        type: 'Chart',
        props: {
          title: 'Invalid',
          chart: { type: 'bar', categories: ['a'], series: [{ name: { toString: null }, values: [] }] },
        },
      },
      'First',
      { type: 'Table', text: 'Second' },
      ...strings,
      { type: 'Chart', props: { title: 'Checks', chart: pie } },
      { type: 'Table', props: { headers: ['Passed', 'Suite'], rows: [[2, 'Unit']], align: ['right'] } },
      ...dividers,
      { type: 'Text', props: { content: 'Excess' } },
    ],
  });
  expect(delivered.card?.parts).toEqual([
    ...['First', 'Second', ...strings.slice(0, 18)].map((content) => ({ type: 'text', content, style: 'plain' })),
    { type: 'chart', title: 'Checks', chart: pie },
    { type: 'table', headers: ['Passed', 'Suite'], rows: [['2', 'Unit']], align: ['right'], caption: null },
    ...dividers.map(() => ({ type: 'divider' })),
  ]);
});

it('keeps an explicit fallback when the card has no usable content', async () => {
  for (const card of [
    null,
    'card',
    {},
    { children: {}, actions: {} },
    {
      title: ' ',
      description: '\t',
      children: [
        '',
        '  ',
        { text: '' },
        { type: 'Future' },
        { type: 'Chart', props: { title: 'X', chart: { type: 'pie', segments: [{ label: 'X', value: Infinity }] } } },
      ],
      actions: [
        { label: 'Skip', url: '#' },
        { label: '   ', url: 'http://example.com' },
      ],
    },
  ]) {
    expect(await deliverCard(card, 'Plain fallback')).toMatchObject({ card: null, text: 'Plain fallback' });
  }
});

it('keeps up to one table, two charts and ten fields across groups', async () => {
  const table = { type: 'Table', props: { headers: ['Checks'], rows: [[2]] } };
  const chart = {
    type: 'Chart',
    props: { title: 'Chart', chart: { type: 'pie', segments: [{ label: 'Pass', value: 2 }] } },
  };
  const fields = (start: number) => ({
    type: 'Fields',
    children: Array.from({ length: 6 }, (_, i) => ({ type: 'Field', props: { label: 'Result', value: i + start } })),
  });
  const { card } = await deliverCard({
    children: [table, table, chart, chart, chart, fields(0), fields(6), fields(12), 'End'],
  });
  expect(card?.parts.map((p) => p.type)).toEqual(['table', 'chart', 'chart', 'fields', 'fields', 'text']);
  expect(card?.parts.flatMap((p) => (p.type === 'fields' ? p.fields.map((f) => f.value) : []))).toEqual(
    Array.from({ length: 10 }, (_, i) => String(i)),
  );
});

it('bounds titles, descriptions, plain text children and link buttons', async () => {
  const long = 'x'.repeat(3000);
  const { card } = await deliverCard({
    title: 'x'.repeat(199) + '🎉',
    description: long,
    children: [long, { text: long }],
    actions: Array.from({ length: 11 }, () => ({ label: long, url: 'http://example.com' })),
  });
  expect(card).toEqual({
    title: 'x'.repeat(199),
    description: long.slice(0, 2500),
    parts: Array.from({ length: 2 }, () => ({ type: 'text', content: long.slice(0, 2500), style: 'plain' })),
    actions: Array.from({ length: 10 }, () => ({
      label: long.slice(0, 80),
      url: 'http://example.com/',
      style: 'default',
    })),
  });
});

it('charges escaped text and normalized URLs to the same 12000-character budget', async () => {
  const url = 'https://example.com/';
  const description = '"'.repeat(2500);
  const chunk = 'a'.repeat(2500);
  const remainder = 12000 - 1 - 5000 - 5000 - url.length - 1;
  const { card } = await deliverCard({
    title: 'T',
    description,
    children: [chunk, { type: 'Text', props: { content: chunk } }, { text: 'x'.repeat(remainder) }, 'x'.repeat(100)],
    actions: [
      { label: 'X', url: url.slice(0, -1) },
      { label: 'Y', url },
    ],
  });
  expect(card?.parts).toHaveLength(3);
  expect(card?.actions).toEqual([{ label: 'X', url, style: 'default' }]);
});

it('stores canonical web URLs and drops unsupported, ambiguous and oversized links', async () => {
  const base = 'https://example.com/';
  const max = base.padEnd(2048, 'a');
  const urls = [
    '#',
    'file:///tmp/test',
    'javascript:void(0)',
    'https://',
    'https:///example.com',
    'https://%',
    ' ' + base,
    base + ' ',
    base + 'two words',
    base + '\u0007bell',
    'https://user@example.com',
    'https://user:pass@example.com',
    'https://@example.com',
    max + 'a',
    base + 'ü'.repeat(400),
    'HTTPS://MÜNCHEN.DE/ä',
    'http://example.com',
    max,
  ];
  const { card } = await deliverCard({ actions: urls.map((url) => ({ label: 'Details', url, style: 'unknown' })) });
  expect(card?.actions).toEqual(
    ['https://xn--mnchen-3ya.de/%C3%A4', 'http://example.com/', max].map((url) => ({
      label: 'Details',
      url,
      style: 'default',
    })),
  );
});

it('derives fallback text from the normalized title, description and first fields', async () => {
  const fields = {
    type: 'Fields',
    children: ['One', 'Two', 'Three', 'Four'].map((label, value) => ({ type: 'Field', props: { label, value } })),
  };
  const input = { title: 'Results', description: 'Done', children: [fields] };
  expect((await deliverCard(input, ' ')).text).toBe('Results\nDone\nOne: 0\nTwo: 1\nThree: 2');
  expect((await deliverCard({ children: [fields] })).text).toBe('One: 0\nTwo: 1\nThree: 2');
  expect((await deliverCard({ actions: [{ label: 'Details', url: 'https://example.com' }] })).text).toBe('Details');
});

it.each([
  { sourceId: undefined, hostWritten: false, role: 'host' },
  { sourceId: 'hcmd-agent', hostWritten: false, role: 'agent' },
  { sourceId: 'appr-agent', hostWritten: false, role: 'agent' },
  { sourceId: 'host-source', hostWritten: true, role: 'host' },
])('keeps host or reserved card source $sourceId plain', async ({ sourceId, hostWritten, role }) => {
  if (hostWritten) mocks.hostWritten.add(sourceId!);
  const id = await deliver(conversationId, null, {
    kind: 'chat-sdk',
    sourceId,
    content: { type: 'card', card: { title: 'Request', description: 'Approval pending', children: ['Details'] } },
  });
  expect(await message(id!)).toMatchObject({ role, text: 'Approval pending', card: null });
});

it('upgrades an existing message before serving history and updating delivery', async () => {
  const db = await initSqliteTestDb();
  const migrations = getRegisteredMigrations().filter(
    (m) => m.name === 'module:app:initial' || m.name === 'module:app:message-card',
  );
  await runMigrations(
    db,
    migrations.filter((m) => m.name === 'module:app:initial'),
  );
  await db.run(
    "INSERT INTO app_conversations (id,user_id,agent_group_id,messaging_group_id,seq,created_at) VALUES (?,'telegram:owner','ag_taylor',?,1,1)",
    conversationId,
    conversationId,
  );
  await db.run(
    "INSERT INTO app_messages (id,conversation_id,user_id,item_order,seq,role,text,files_json,reactions_json,delivery,created_at) VALUES ('original',?,'telegram:owner',1,1,'user','Original','[]','[]','stored',1)",
    conversationId,
  );
  await runMigrations(db, migrations);
  expect((await request(history)).body.items).toMatchObject([
    { id: 'original', text: 'Original', card: null, delivery: 'stored' },
  ]);
  await setDelivery('original', 'reached');
  expect((await request(history)).body.items).toMatchObject([
    { id: 'original', text: 'Original', card: null, delivery: 'reached' },
  ]);
});

async function question(id: string) {
  return questionEntity((await getDb().get<QuestionRow>('SELECT * FROM app_questions WHERE id=?', id))!);
}
async function ask(expiresAt: number | null = null) {
  const db = getDb();
  await db.run(
    "INSERT OR IGNORE INTO sessions (id,agent_group_id,messaging_group_id,created_at) VALUES ('session','ag_taylor',?,'2026-11-17')",
    conversationId,
  );
  const questionId = randomUUID();
  await db.run(
    "INSERT INTO pending_questions (question_id,session_id,message_out_id,platform_id,channel_type,title,options_json,created_at) VALUES (?,'session',?,?,'app','Deploy','[]','2026-11-17')",
    questionId,
    questionId,
    conversationId,
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
it('routes a sent message to its agent as a direct mention', async () => {
  const first = await request(sendMessage, { clientId: randomUUID(), text: 'hello', fileIds: [] });
  const route = vi.fn(async (event) => {
    event.onStored({});
  });
  await drainRoutingJobs(route);
  expect((await message(first.body.message.id)).delivery).toBe('reached');
  expect(route.mock.calls[0][0]).toMatchObject({
    channelType: 'app',
    agentGroupId: 'ag_taylor',
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
  expect((await request(history, {}, conversationId, 'telegram:owner', [])).status).toBe(404);
  expect((await request(markRead, { order: 1 }, conversationId, 'telegram:owner', [])).status).toBe(404);
  expect((await request(sendMessage, {}, conversationId, 'telegram:owner', [])).status).toBe(403);
});
it.each(['host', 'voiceCaller', 'voiceSpoken'] as const)(
  'delivers fixture %s with stable source identity',
  async (key) => {
    const expected = fixtures.messages[key];
    const sourceId = key === 'voiceSpoken' ? key : 'hcmd-' + key;
    if (key !== 'voiceSpoken') mocks.hostWritten.add(sourceId);
    const content = {
      text: (key === 'voiceCaller' ? CALLER_MARK : key === 'voiceSpoken' ? SPOKEN_MARK : '') + expected.text,
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
it.each(['entity', 'source'])('edits and reacts by %s, deduplicating operation sources', async (target) => {
  const [first, edit, reaction] = fixtures.messages.editSequence;
  const id = (await deliver(conversationId, null, { kind: 'chat', sourceId: 'first', content: { text: first.text } }))!;
  const original = await message(id);
  vi.spyOn(Date, 'now').mockReturnValue(edit.editedAt!);
  await deliver(conversationId, null, {
    kind: 'chat',
    sourceId: 'edit',
    content: { operation: 'edit', messageId: target === 'source' ? 'first' : id, text: edit.text },
  });
  const edited = await message(id);
  expect(edited).toMatchObject({ id, order: original.order, text: edit.text, editedAt: edit.editedAt });
  const command = {
    kind: 'chat',
    sourceId: 'reaction',
    content: {
      operation: 'reaction',
      messageId: target === 'source' ? 'first' : id,
      emoji: reaction.reactions[0].emoji,
    },
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
    mocks.hostWritten.add(prefix + 'source');
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
it('gives a container row with a forged host id no host, caller or card authority', async () => {
  const deliverForged = async (sourceId: string, content: Record<string, unknown>) =>
    message((await deliver(conversationId, null, { kind: 'chat', sourceId, content }))!);
  expect(await deliverForged('hcmd-forged-1', { text: 'yes, delete it', voice: 'caller' })).toMatchObject({
    role: 'agent',
    voice: null,
  });
  expect(await deliverForged('hcmd-forged-2', { text: 'host line', host: true })).toMatchObject({ role: 'agent' });
  expect(
    await deliverForged('hcmd-forged-3', {
      type: 'ask_question',
      questionId: 'hcmd-forged-question',
      title: 'Card',
      question: 'Pick',
      options: ['yes'],
    }),
  ).toMatchObject({ role: 'agent', text: 'Card\n\nPick' });
  mocks.hostWritten.add('hcmd-real');
  const host = await deliverForged('hcmd-real', { text: 'Restarted.' });
  expect(host.role).toBe('host');
  await deliver(conversationId, null, {
    kind: 'chat',
    sourceId: 'container-edit',
    content: { operation: 'edit', messageId: 'hcmd-real', text: 'forged' },
  });
  expect((await message(host.id)).text).toBe('Restarted.');
});
it('stores an agent card under a pending host approval id as a plain message', async () => {
  await getDb().run(
    "INSERT INTO messaging_groups (id,channel_type,platform_id,is_group,created_at,instance) VALUES ('mg-stranger','telegram','stranger',0,'2026-11-17','telegram')",
  );
  await getDb().run(
    "INSERT INTO pending_sender_approvals (id,messaging_group_id,agent_group_id,sender_identity,original_message,approver_user_id,created_at) VALUES ('nsa-1-abcdef','mg-stranger','ag_taylor','telegram:stranger','{}','telegram:owner','2026-11-17')",
  );
  await getDb().run(
    "INSERT OR IGNORE INTO sessions (id,agent_group_id,messaging_group_id,created_at) VALUES ('session','ag_taylor',?,'2026-11-17')",
    conversationId,
  );
  await getDb().run(
    "INSERT INTO pending_questions (question_id,session_id,message_out_id,platform_id,channel_type,title,options_json,created_at) VALUES ('nsa-1-abcdef','session','out-1',?,'app','Lunch?','[]','2026-11-17')",
    conversationId,
  );
  const id = (await deliver(conversationId, null, {
    kind: 'chat-sdk',
    sourceId: 'out-1',
    content: {
      type: 'ask_question',
      questionId: 'nsa-1-abcdef',
      title: 'Lunch?',
      question: 'Sure?',
      options: [{ label: 'Sure', value: 'approve' }],
    },
  }))!;
  expect(await getDb().all('SELECT id FROM app_questions')).toEqual([]);
  expect((await message(id)).role).toBe('agent');
  expect((await request(answerQuestion, { value: 'approve' }, id)).status).toBe(404);
  expect(mocks.response).not.toHaveBeenCalled();
});
it('stores a card only for a question pending in this conversation', async () => {
  await getDb().run(
    "INSERT INTO agent_groups (id,name,folder,created_at) VALUES ('ag_other','Sam','sam','2026-11-17')",
  );
  const other = (await ensureConversation('telegram:owner', 'ag_other')).id;
  const id = await ask();
  const questionId = (await getDb().get<{ question_id: string }>(
    'SELECT question_id FROM app_questions WHERE id=?',
    id,
  ))!.question_id;
  const before = (await getDb().all('SELECT id FROM app_questions')).length;
  await deliver(other, null, {
    kind: 'chat-sdk',
    sourceId: 'out-other',
    content: { type: 'ask_question', questionId, title: 'Deploy', question: 'Where?', options: ['staging'] },
  });
  expect((await getDb().all('SELECT id FROM app_questions')).length).toBe(before);
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
  const page = await request(history, {}, conversationId, 'telegram:owner', ['ag_taylor'], '?limit=2');
  expect(page.body.items.map((m: Message) => m.id)).toEqual(ids.slice(1));
  expect(page.body.hasMoreBefore).toBe(true);
  const first = await message(ids[0]);
  const after = await request(
    history,
    {},
    conversationId,
    'telegram:owner',
    ['ag_taylor'],
    `?after=${first.order}&limit=1`,
  );
  expect(after.body.items[0].id).toBe(ids[1]);
  expect(after.body.hasMoreAfter).toBe(true);
  await request(markRead, { order: 999999 });
  const seq = await lastEventSeq();
  await request(markRead, { order: 0 });
  expect(await lastEventSeq()).toBe(seq);
  expect(await badgeFor('telegram:owner', ['ag_taylor'])).toMatchObject({ unreadTotal: 0, rev: 4 });
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

it('bounds preview work before regex matching and preserves code points', () => {
  expect(plainPreview('*'.repeat(1999) + '😀')).toBe('');
  const start = performance.now();
  expect(plainPreview('['.repeat(32768))).toBe('['.repeat(160));
  expect(performance.now() - start).toBeLessThan(500);
  expect(plainPreview('a'.repeat(159) + '😀 tail')).toBe('a'.repeat(159) + '😀');
});
it('refuses edits to user messages without appending events', async () => {
  const sent = await request(sendMessage, { clientId: randomUUID(), text: 'original', fileIds: [] });
  const seq = await lastEventSeq();
  expect(
    await deliver(conversationId, null, {
      kind: 'chat',
      sourceId: 'edit-user',
      content: { operation: 'edit', messageId: sent.body.message.id, text: 'changed' },
    }),
  ).toBeUndefined();
  expect(await lastEventSeq()).toBe(seq);
  expect((await message(sent.body.message.id)).text).toBe('original');
});
it('authorizes a real question before handing it off', async () => {
  const id = await ask();
  expect((await request(answerQuestion, { value: 'staging' }, id, 'telegram:other')).status).toBe(404);
  expect((await request(answerQuestion, { value: 'staging' }, id, 'telegram:owner', [])).status).toBe(404);
  expect(mocks.response).not.toHaveBeenCalled();
  expect((await question(id)).state).toBe('open');
});
it('keeps a recovered answer done when the runner already consumed it', async () => {
  const id = await ask();
  await request(answerQuestion, { value: 'staging' }, id);
  await getDb().run("UPDATE app_questions SET handoff_state='pending' WHERE id=?", id);
  await getDb().run('DELETE FROM pending_questions');
  mocks.response.mockReset().mockResolvedValue(false);
  await recoverAnswers();
  expect(mocks.response).not.toHaveBeenCalled();
  expect((await question(id)).state).toBe('answered');
  expect(await getDb().get('SELECT handoff_state FROM app_questions WHERE id=?', id)).toEqual({
    handoff_state: 'done',
  });
});
it('never regresses reached delivery and emits scoped conversation events after messages', async () => {
  const cursor = await lastEventSeq();
  const sent = await request(sendMessage, { clientId: randomUUID(), text: 'hello', fileIds: [] });
  const events = await readEventsAfter(cursor, 10);
  expect(events.map((e) => e.kind)).toEqual(['message', 'conversation']);
  for (const event of events)
    expect(event).toMatchObject({
      user_id: 'telegram:owner',
      agent_group_id: 'ag_taylor',
      conversation_id: conversationId,
    });
  await setDelivery(sent.body.message.id, 'reached');
  const seq = await lastEventSeq();
  await setDelivery(sent.body.message.id, 'routed');
  await setDelivery(sent.body.message.id, 'failed');
  expect(await lastEventSeq()).toBe(seq);
});
it('captures the first list cursor before creating conversations', async () => {
  const cursor = await lastEventSeq();
  const list = await request(listConversations, {}, '', 'telegram:new');
  expect(list.body.seq).toBe(cursor);
  expect(list.body.conversations[0].seq).toBeGreaterThan(cursor);
});
it('pages mixed questions and messages before an order', async () => {
  const q = await ask();
  const id = (await deliver(conversationId, null, { kind: 'chat', sourceId: 'last', content: { text: 'last' } }))!;
  const page = await request(
    history,
    {},
    conversationId,
    'telegram:owner',
    ['ag_taylor'],
    '?before=' + (await message(id)).order,
  );
  expect(page.body).toEqual({ items: [await question(q)], hasMoreBefore: false, hasMoreAfter: true });
});
it('finishes a job when its reached write fails and continues the batch', async () => {
  const a = await request(sendMessage, { clientId: randomUUID(), text: 'a', fileIds: [] });
  await request(sendMessage, { clientId: randomUUID(), text: 'b', fileIds: [] });
  const db = getDb();
  const run = db.run.bind(db);
  let failed = false;
  vi.spyOn(db, 'run').mockImplementation(async (sql, ...args) => {
    if (!failed && sql.startsWith('INSERT INTO app_messages') && args[14] === 'reached') {
      failed = true;
      throw new Error('injected write failure');
    }
    return run(sql, ...args);
  });
  const route = vi.fn(async (event) => {
    event.onStored({});
    await new Promise((resolve) => setImmediate(resolve));
  });
  await drainRoutingJobs(route);
  expect(failed).toBe(true);
  expect(route).toHaveBeenCalledTimes(2);
  expect(await db.get('SELECT state FROM app_routing_jobs WHERE message_id=?', a.body.message.id)).toEqual({
    state: 'failed',
  });
});
it('calls availability outside central transactions', async () => {
  let depth = 0;
  const db = getDb(),
    transaction = db.transaction.bind(db);
  vi.spyOn(db, 'transaction').mockImplementation((fn) =>
    transaction(async () => {
      depth++;
      try {
        return await fn();
      } finally {
        depth--;
      }
    }),
  );
  setAppHooks({
    callAvailability: async () => {
      expect(depth).toBe(0);
      return { canCall: true, callRefusal: null };
    },
  });
  await ensureConversation('telegram:new', 'ag_taylor');
  await request(sendMessage, { clientId: randomUUID(), text: 'hello', fileIds: [] });
  await deliver(conversationId, null, { kind: 'chat', sourceId: 'reply', content: { text: 'reply' } });
  await request(markRead, { order: 9999 });
});

it("replays only the named user's events", async () => {
  await getDb().run("INSERT INTO agent_groups (id,name,folder,created_at) VALUES ('ag_sam','Sam','sam','2026-11-17')");
  const other = await ensureConversation('telegram:other', 'ag_sam');
  await deliver(other.id, null, { kind: 'chat', sourceId: 'other-1', content: { text: 'for someone else' } });
  await deliver(conversationId, null, { kind: 'chat', sourceId: 'owner-1', content: { text: 'for the owner' } });
  const all = await readEventsAfter(0, 100);
  const owner = await readEventsAfter(0, 100, 'telegram:owner');
  expect(all.some((e) => e.user_id === 'telegram:other')).toBe(true);
  expect(owner.length).toBeGreaterThan(0);
  expect(owner.every((e) => e.user_id === 'telegram:owner')).toBe(true);
  expect(owner).toEqual(all.filter((e) => e.user_id === 'telegram:owner'));
});
it('matches send, list, history and read response fixture shapes', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(fixtures.sendResponse.message.createdAt);
  const sent = await request(sendMessage, {
    clientId: fixtures.sendResponse.message.clientId,
    text: fixtures.sendResponse.message.text,
    fileIds: [],
  });
  expect(sent.body).toEqual({
    message: {
      ...fixtures.sendResponse.message,
      id: sent.body.message.id,
      conversationId,
      order: sent.body.message.order,
      seq: sent.body.message.seq,
    },
  });
  const reply = fixtures.messages.editSequence[0];
  const id = (await deliver(conversationId, null, {
    kind: 'chat',
    sourceId: 'fixture',
    content: { text: reply.text },
  }))!;
  const m = await message(id);
  const c = (await getConversation(conversationId))!;
  const status = { ...fixtures.conversations.statuses[0], conversationId };
  setAppHooks({ statuses: async () => [status] });
  const expectedConversation = {
    ...fixtures.conversations.conversations[0],
    id: conversationId,
    seq: c.seq,
    lastMessage: { id, role: 'agent', preview: reply.text, at: m.createdAt },
    unread: 1,
    readOrder: 0,
    createdAt: c.created_at,
  };
  expect((await request(listConversations)).body).toEqual({
    ...fixtures.conversations,
    conversations: [expectedConversation],
    statuses: [status],
    badge: { kind: 'badge', rev: 1, unreadTotal: 1 },
    seq: await lastEventSeq(),
  });
  expect((await request(history)).body).toEqual({
    ...fixtures.historyPage,
    items: [sent.body.message, m],
    hasMoreBefore: false,
    hasMoreAfter: false,
  });
  const read = await request(markRead, { order: m.order });
  expect(read.body).toEqual({
    ...fixtures.readResponse,
    conversation: { ...expectedConversation, seq: read.body.conversation.seq, unread: 0, readOrder: m.order },
    badge: { kind: 'badge', rev: 2, unreadTotal: 0 },
  });
});
it('isolates startup recovery failures from other host callbacks', async () => {
  const db = getDb(),
    all = db.all.bind(db);
  vi.spyOn(db, 'all').mockImplementation(async (sql, ...args) => {
    if (sql.includes('app_routing_jobs') || sql.includes("handoff_state='pending'")) throw new Error('recovery failed');
    return all(sql, ...args);
  });
  for (const start of getHostStartCallbacks()) await start({ db } as Parameters<typeof start>[0]);
  await new Promise((resolve) => setImmediate(resolve));
  await stopHostModules();
});

it.each(['edit', 'reaction'])('retries an unresolved %s target', async (operation) => {
  await expect(
    deliver(conversationId, null, {
      kind: 'chat',
      sourceId: 'unresolved',
      content: { operation, messageId: 'missing' },
    }),
  ).rejects.toThrow('App delivery target unresolved');
  expect(await getDb().get('SELECT * FROM app_applied_sources WHERE source_id=?', 'unresolved')).toBeUndefined();
});

it('notifies another device of the committed badge when a conversation is read', async () => {
  const id = (await deliver(conversationId, null, {
    kind: 'chat',
    sourceId: 'agent-unread',
    content: { text: 'Unread' },
  }))!;
  const before = await badgeFor('telegram:owner', ['ag_taylor']);
  expect(before.unreadTotal).toBe(1);
  const updates: Promise<unknown>[] = [];
  const listener = vi.fn((userId: string) => {
    updates.push(badgeFor(userId, ['ag_taylor']));
  });
  const off = onBadgeChanged(listener);
  try {
    const read = await request(markRead, { order: (await message(id)).order });
    expect(read.status).toBe(200);
    expect(listener).toHaveBeenCalledExactlyOnceWith('telegram:owner');
    expect(await Promise.all(updates)).toEqual([{ kind: 'badge', rev: before.rev + 1, unreadTotal: 0 }]);
    expect(read.body.badge).toEqual(await updates[0]);
    await request(markRead, { order: 0 });
    expect(listener).toHaveBeenCalledTimes(1);
  } finally {
    off();
  }
});
