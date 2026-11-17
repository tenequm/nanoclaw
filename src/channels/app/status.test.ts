import Database from 'better-sqlite3';
import { parseIsoTimestamp, type ContainerRecord } from '../../mailbox/model.js';
import { afterEach, expect, it, vi } from 'vitest';
import { SqliteDriver } from '../../db/drivers/sqlite.js';
import { createStatusService, toolLabel, type StatusDeps } from './status.js';
import type { EventRow, ConversationRow } from './db.js';
import type { Status } from './contract.js';
import fixtures from './app-contract.fixtures.json' with { type: 'json' };

vi.mock('../../session-manager.js', () => ({ withExistingMailboxSession: vi.fn() }));
afterEach(() => vi.useRealTimers());
it('persists revisions across restart, maps ticks, prioritizes questions and expires stale working', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(fixtures.statuses.working.at);
  const db = new SqliteDriver(new Database(':memory:'));
  await db.exec(
    "CREATE TABLE app_statuses (conversation_id TEXT PRIMARY KEY, rev INTEGER, state TEXT, label TEXT, at INTEGER); CREATE TABLE app_conversations (id TEXT); INSERT INTO app_conversations VALUES ('conv_stan01');",
  );
  await db.run('INSERT INTO app_statuses VALUES (?, ?, ?, ?, ?)', 'conv_stan01', 39, 'idle', null, 0);
  let open: string[] = [];
  let event: (e: EventRow) => void = () => {};
  const states = vi.fn(
    async (): Promise<ContainerRecord[]> => [
      {
        currentTool: 'Bash',
        turn: 'idle' as const,
        updatedAt: parseIsoTimestamp(new Date().toISOString()),
        toolDeclaredTimeoutMs: null,
        toolStartedAt: null,
      },
    ],
  );
  const deps: StatusDeps = {
    db: () => db,
    containerStates: states,
    getConversationByPlatformId: async () => ({ id: 'conv_stan01' }) as ConversationRow,
    openQuestionConversationIds: async () => open,
    onEventAppended: (fn) => {
      event = fn;
      return () => {};
    },
    setAppHooks: vi.fn(),
  };
  let service = createStatusService(deps);
  await service.ready;
  const changes: Status[] = [];
  service.onStatusChanged((s) => changes.push(s));
  await service.setTyping('p');
  await service.setTyping('p');
  expect(changes).toEqual([fixtures.statuses.working]);
  expect(states).toHaveBeenCalledTimes(2);
  event({
    kind: 'message',
    conversation_id: 'conv_stan01',
    entity_json: JSON.stringify({ role: 'agent', seq: 1, order: 1 }),
  } as EventRow);
  expect((await service.statuses(['conv_stan01']))[0].state).toBe('idle');
  open = ['conv_stan01'];
  event({ kind: 'question', conversation_id: 'conv_stan01', entity_json: '{}' } as EventRow);
  await service.setTyping('p');
  expect((await service.statuses(['conv_stan01']))[0]).toMatchObject({
    state: 'waiting',
    label: 'Waiting for your answer',
  });
  open = [];
  event({ kind: 'question', conversation_id: 'conv_stan01', entity_json: '{}' } as EventRow);
  expect((await service.statuses(['conv_stan01']))[0].state).toBe('working');
  await vi.advanceTimersByTimeAsync(30_000);
  const idle = (await service.statuses(['conv_stan01']))[0];
  expect(idle.state).toBe('idle');
  await service.stop();
  service = createStatusService(deps);
  await service.ready;
  expect((await service.statuses(['conv_stan01']))[0].rev).toBe(idle.rev + 1);
  await service.stop();
  states.mockResolvedValue([
    {
      currentTool: 'Read',
      turn: 'working',
      updatedAt: parseIsoTimestamp(new Date().toISOString()),
      toolDeclaredTimeoutMs: null,
      toolStartedAt: null,
    },
  ]);
  open = ['conv_stan01'];
  service = createStatusService(deps);
  await service.ready;
  expect((await service.statuses(['conv_stan01']))[0].state).toBe('waiting');
  await service.stop();
  open = [];
  service = createStatusService(deps);
  await service.ready;
  expect((await service.statuses(['conv_stan01']))[0]).toMatchObject({ state: 'working', label: 'Reading files' });
  await service.clearTyping('p');
  expect((await service.statuses(['conv_stan01']))[0].state).toBe('idle');
  await service.stop();
  states.mockRejectedValue(new Error('missing mailbox'));
  service = createStatusService(deps);
  await service.ready;
  await service.setTyping('p');
  expect((await service.statuses(['conv_stan01']))[0]).toMatchObject({ state: 'working', label: 'Working' });
  await service.stop();
  await db.close();
});
it.each([
  ['Read', 'Reading files'],
  ['Write', 'Editing files'],
  ['WebFetch', 'Searching the web'],
  ['mcp__secret_name', 'Using a tool'],
  ['unknown', 'Working'],
])('maps %s without exposing tool names', (tool, label) => expect(toolLabel(tool)).toBe(label));

it('survives failed boot reads and continues initializing other conversations', async () => {
  const db = new SqliteDriver(new Database(':memory:'));
  await db.exec(
    "CREATE TABLE app_statuses (conversation_id TEXT PRIMARY KEY, rev INTEGER, state TEXT, label TEXT, at INTEGER); CREATE TABLE app_conversations (id TEXT); INSERT INTO app_conversations VALUES ('a'), ('b');",
  );
  await db.run("INSERT INTO app_statuses VALUES ('a', 7, 'idle', NULL, 0)");
  const deps: StatusDeps = {
    db: () => db,
    containerStates: async () => [],
    getConversationByPlatformId: async (id) => ({ id }) as ConversationRow,
    openQuestionConversationIds: vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue([]),
    onEventAppended: () => () => {},
    setAppHooks: vi.fn(),
  };
  const service = createStatusService(deps);
  try {
    await service.ready;
    expect(await service.statuses(['a', 'b', 'missing'])).toMatchObject([{ rev: 7 }, { rev: 1 }, { rev: 0 }]);
    await service.setTyping('a');
    expect((await service.statuses(['a']))[0]).toMatchObject({ rev: 8, state: 'working' });
  } finally {
    await service.stop();
  }
  const all = vi.spyOn(db, 'all').mockRejectedValueOnce(new Error('boot unavailable'));
  const restarted = createStatusService(deps);
  try {
    await restarted.ready;
    expect((await restarted.statuses(['a']))[0].rev).toBe(8);
  } finally {
    await restarted.stop();
    all.mockRestore();
    await db.close();
  }
});
