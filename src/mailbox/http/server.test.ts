import fs from 'fs';
import type http from 'http';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureSchema } from '../sqlite/session-db.js';
import type { RunnerSnapshot } from './runner-ops.js';
import { createMailboxHttpServer, MAILBOX_HTTP_PATH } from './server.js';

const KEY = { agentGroupId: 'ag-1', sessionId: 'sess-1' };
const TOKEN = 'a'.repeat(64);

let dir: string;
let server: http.Server;
let base: string;
let inboundPath: string;
let outboundPath: string;
let heartbeatPath: string;

function post(
  ops: unknown,
  {
    token = TOKEN,
    agentGroupId = KEY.agentGroupId,
    sessionId = KEY.sessionId,
    raw = undefined as string | undefined,
  } = {},
) {
  return fetch(`${base}${MAILBOX_HTTP_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-nanoclaw-agent-group': agentGroupId,
      'x-nanoclaw-session': sessionId,
    },
    body: raw ?? JSON.stringify({ ops }),
  });
}

async function call(ops: Array<{ op: string; args?: unknown[] }>) {
  const response = await post(ops);
  const body = (await response.json()) as { results?: unknown[]; error?: { code: string; message: string } };
  return { status: response.status, ...body };
}

function insertInbound(row: Record<string, unknown>): void {
  const db = new Database(inboundPath);
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content, on_wake, process_after)
     VALUES (@id, @seq, @kind, @timestamp, @status, @trigger, @platform_id, @channel_type, @thread_id, @content, @on_wake, @process_after)`,
  ).run({
    kind: 'chat',
    timestamp: '2026-01-01 00:00:00',
    status: 'pending',
    trigger: 1,
    platform_id: 'room',
    channel_type: 'test',
    thread_id: null,
    content: '{"text":"hi"}',
    on_wake: 0,
    process_after: null,
    ...row,
  });
  db.close();
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mailbox-http-'));
  inboundPath = path.join(dir, 'inbound.db');
  outboundPath = path.join(dir, 'outbound.db');
  heartbeatPath = path.join(dir, '.heartbeat');
  ensureSchema(inboundPath, 'inbound');
  ensureSchema(outboundPath, 'outbound');
  server = createMailboxHttpServer({
    exists: async (key) => key.agentGroupId === KEY.agentGroupId && key.sessionId === KEY.sessionId,
    verifyToken: (key, token) => key.sessionId !== 'unauthorized' && token === TOKEN,
    paths: () => ({ inbound: inboundPath, outbound: outboundPath, heartbeat: heartbeatPath }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('mailbox HTTP server: auth and errors', () => {
  it('refuses a wrong token, a missing token and path-like session ids with 401', async () => {
    expect((await post([{ op: 'snapshot', args: [null] }], { token: 'wrong' })).status).toBe(401);
    expect((await post([{ op: 'snapshot', args: [null] }], { token: '' })).status).toBe(401);
    expect((await post([{ op: 'snapshot', args: [null] }], { sessionId: '../sess-1' })).status).toBe(401);
    expect((await post([{ op: 'snapshot', args: [null] }], { agentGroupId: '..' })).status).toBe(401);
    expect((await post([{ op: 'snapshot', args: [null] }], { sessionId: 'unauthorized' })).status).toBe(401);
  });

  it('answers 404 for a session without storage and never creates it', async () => {
    const response = await post([{ op: 'snapshot', args: [null] }], { sessionId: 'sess-unknown' });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('no_mailbox');
  });

  it('maps malformed requests to 400 and unknown routes to 404/405', async () => {
    expect((await post(undefined, { raw: '{not json' })).status).toBe(400);
    expect((await post([])).status).toBe(400);
    expect((await call([{ op: 'dropTables' }])).error?.code).toBe('bad_request');
    expect((await call([{ op: 'markMessages', args: [['m'], 'bogus'] }])).status).toBe(400);
    expect((await call([{ op: 'writeMessageOut', args: [{ id: 'x' }] }])).status).toBe(400);
    expect((await fetch(`${base}/elsewhere`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}${MAILBOX_HTTP_PATH}`)).status).toBe(405);
  });
});

describe('mailbox HTTP server: operations', () => {
  it('commits a write before answering and returns its odd sequence', async () => {
    insertInbound({ id: 'in-1', seq: 2 });
    const { status, results } = await call([
      { op: 'writeMessageOut', args: [{ id: 'out-1', kind: 'chat', content: '{"text":"a"}' }] },
    ]);
    expect(status).toBe(200);
    expect(results).toEqual([3]);
    // The response arrived, so a fresh connection must already see the committed row.
    const db = new Database(outboundPath, { readonly: true });
    expect(db.prepare('SELECT seq, content FROM messages_out WHERE id = ?').get('out-1')).toEqual({
      seq: 3,
      content: '{"text":"a"}',
    });
    db.close();
  });

  it('replays a retried write idempotently and refuses a conflicting reuse of its id', async () => {
    const write = { op: 'writeMessageOut', args: [{ id: 'out-1', kind: 'chat', content: 'x' }] };
    expect((await call([write])).results).toEqual([1]);
    expect((await call([write])).results).toEqual([1]);
    const conflict = await call([{ op: 'writeMessageOut', args: [{ id: 'out-1', kind: 'chat', content: 'y' }] }]);
    expect(conflict.status).toBe(400);
  });

  it('runs a batch atomically: a failing op rolls back the writes before it', async () => {
    const { status } = await call([
      { op: 'setState', args: ['k', 'v'] },
      { op: 'markMessages', args: [['m'], 'nope'] },
    ]);
    expect(status).toBe(400);
    const db = new Database(outboundPath, { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM session_state').get()).toEqual({ n: 0 });
    db.close();
  });

  it('applies acks, state and container writes in order, then snapshots them', async () => {
    insertInbound({ id: 'in-1', seq: 2 });
    insertInbound({ id: 'in-2', seq: 4, content: '{"text":"q","replyTo":{"id":"in-1"}}' });
    const { results } = await call([
      { op: 'markMessages', args: [['in-1'], 'processing'] },
      { op: 'markScriptSkipped', args: [[{ id: 'in-2', reason: 'error' }]] },
      { op: 'setState', args: ['k', 'v'] },
      { op: 'setState', args: ['gone', 'v'] },
      { op: 'deleteState', args: ['gone'] },
      { op: 'setContainerToolInFlight', args: ['Bash', 60000] },
      { op: 'markContainerTurn', args: ['working'] },
      { op: 'snapshot', args: [null] },
    ]);
    const snapshot = results![7] as RunnerSnapshot;
    expect(snapshot.claimed).toEqual({ 'in-1': 'processing', 'in-2': 'script-skip:error' });
    expect(snapshot.pending.map((m: { id: string }) => m.id)).toEqual(['in-1', 'in-2']);
    expect(snapshot.pending[0]).toMatchObject({ trigger: true, onWake: false, timestamp: '2026-01-01T00:00:00.000Z' });
    expect(snapshot.state.map((s: { key: string }) => s.key)).toEqual(['k']);
    expect(snapshot.replySeqs).toEqual([
      { channelType: 'test', platformId: 'room', platformMessageId: 'in-1', sequence: 2 },
    ]);
    expect(snapshot.latestRoutes).toEqual([
      { channelType: 'test', platformId: 'room', threadId: null, inReplyTo: 'in-2' },
    ]);
    expect(snapshot.cursor).toEqual({ inbound: 4, outbound: 0, delivered: 0 });

    const db = new Database(outboundPath, { readonly: true });
    expect(db.prepare('SELECT current_tool, tool_declared_timeout_ms, turn FROM container_state').get()).toEqual({
      current_tool: 'Bash',
      tool_declared_timeout_ms: 60000,
      turn: 'working',
    });
    db.close();

    await call([{ op: 'clearStaleProcessingAcks' }, { op: 'clearContainerToolInFlight' }]);
    const after = (await call([{ op: 'snapshot', args: [null] }])).results![0] as RunnerSnapshot;
    expect(after.claimed).toEqual({ 'in-2': 'script-skip:error' });
  });

  it('returns only rows past the cursor, plus delivered mappings past its rowid', async () => {
    insertInbound({ id: 'in-1', seq: 2 });
    const first = (await call([{ op: 'snapshot', args: [null] }])).results![0] as RunnerSnapshot;
    expect(first.inbound).toHaveLength(1);
    insertInbound({ id: 'in-2', seq: 4 });
    await call([
      {
        op: 'writeMessageOut',
        args: [{ id: 'out-1', kind: 'chat', content: 'x', channelType: 'test', platformId: 'room' }],
      },
    ]);
    const db = new Database(inboundPath);
    db.prepare(
      "INSERT INTO delivered (message_out_id, platform_message_id, delivered_at) VALUES ('out-1', 'p-1', 'now')",
    ).run();
    db.close();
    const second = (await call([{ op: 'snapshot', args: [first.cursor] }])).results![0] as RunnerSnapshot;
    expect(second.inbound.map((m: { id: string }) => m.id)).toEqual(['in-2']);
    expect(second.outbound.map((m: { id: string }) => m.id)).toEqual(['out-1']);
    expect(second.delivered).toEqual([{ messageOutId: 'out-1', platformMessageId: 'p-1' }]);
    const third = (await call([{ op: 'snapshot', args: [second.cursor] }])).results![0] as RunnerSnapshot;
    expect([third.inbound, third.outbound, third.delivered]).toEqual([[], [], []]);
    expect(third.cursor).toEqual(second.cursor);
    insertInbound({ id: 'in-3', seq: 6, content: '{"text":"q","replyTo":{"id":"p-1"}}' });
    const fourth = (await call([{ op: 'snapshot', args: [third.cursor] }])).results![0] as RunnerSnapshot;
    expect(fourth.replySeqs, 'outbound row found through its delivered platform id').toEqual([
      { channelType: 'test', platformId: 'room', platformMessageId: 'p-1', sequence: 5 },
    ]);
  });

  it('never follows a heartbeat symlink planted in the container-writable session dir', async () => {
    const target = path.join(dir, 'outside');
    fs.symlinkSync(target, heartbeatPath);
    expect((await call([{ op: 'heartbeat' }, { op: 'setState', args: ['k', 'v'] }])).status).toBe(200);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('never creates a missing outbound.db', async () => {
    fs.rmSync(outboundPath);
    expect((await call([{ op: 'snapshot', args: [null] }])).status).toBe(500);
    expect(fs.existsSync(outboundPath)).toBe(false);
  });

  it('touches the session heartbeat file on a heartbeat op', async () => {
    expect(fs.existsSync(heartbeatPath)).toBe(false);
    await call([{ op: 'heartbeat' }]);
    const created = fs.statSync(heartbeatPath).mtimeMs;
    fs.utimesSync(heartbeatPath, new Date(0), new Date(0));
    await call([{ op: 'heartbeat' }]);
    expect(fs.statSync(heartbeatPath).mtimeMs).toBeGreaterThanOrEqual(created);
  });

  it('normalizes legacy empty state timestamps and skips rows that still fail validation', async () => {
    const db = new Database(outboundPath);
    db.prepare("INSERT INTO session_state (key, value, updated_at) VALUES ('legacy', 'v', '')").run();
    db.prepare("INSERT INTO session_state (key, value, updated_at) VALUES ('broken', 'v', 'not a time')").run();
    db.close();
    const { status, results } = await call([{ op: 'snapshot', args: [null] }]);
    expect(status).toBe(200);
    expect((results![0] as RunnerSnapshot).state).toEqual([
      { key: 'legacy', value: 'v', updatedAt: '1970-01-01T00:00:00.000Z' },
    ]);
  });

  it('creates the runner-owned tables an older outbound.db lacks', async () => {
    const db = new Database(outboundPath);
    db.exec('DROP TABLE session_state; DROP TABLE container_state;');
    db.close();
    expect(
      (
        await call([
          { op: 'setState', args: ['k', 'v'] },
          { op: 'markContainerTurn', args: ['idle'] },
        ])
      ).status,
    ).toBe(200);
  });
});
