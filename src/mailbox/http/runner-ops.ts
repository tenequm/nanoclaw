/**
 * The runner's view of a session mailbox, executed on the host for the HTTP
 * transport. Same files and SQL semantics as the runner's own SQLite mailbox
 * (container/agent-runner/src/mailbox/sqlite/operations.ts); records cross the
 * wire in the canonical model shape.
 *
 * Adding an operation is one entry in RUNNER_OPS (plus the matching entry in
 * the runner client's tables).
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import {
  createOutboundRecord,
  parseContainerRecord,
  parseDestinationRecord,
  parseInboundRecord,
  parseOutboundRecord,
  parseOutboundWrite,
  parseSessionRoutingRecord,
  parseStateRecord,
  type DestinationRecord,
  type InboundRecord,
  type OutboundRecord,
  type ProcessingStatus,
  type SessionRoutingRecord,
  type StateRecord,
} from '../model.js';

/** How many recent rows a fresh replica receives per table. */
export const SNAPSHOT_WINDOW = 500;

const PROCESSING_STATUSES = new Set<ProcessingStatus>(['processing', 'completed', 'failed', 'script-skip:error']);
const TURN_STATES = new Set(['working', 'idle']);
const SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

/** A caller mistake (HTTP 400): bad op name, bad arguments, or a record that fails validation. */
export class MailboxRequestError extends Error {
  readonly status = 400;
}

export interface RunnerSession {
  inbound: Database.Database;
  outbound: Database.Database;
  touchHeartbeat(): void;
}

export interface SnapshotCursor {
  inbound: number;
  outbound: number;
  delivered: number;
}

export interface RunnerSnapshot {
  cursor: SnapshotCursor;
  /** Every pending inbound row, refreshed in full on each snapshot. */
  pending: InboundRecord[];
  /** processing_ack status for pending ids that the runner already claimed. */
  claimed: Record<string, ProcessingStatus>;
  /** Inbound rows past the cursor (a recent window on a fresh cursor). */
  inbound: InboundRecord[];
  /** Outbound rows past the cursor (a recent window on a fresh cursor). */
  outbound: OutboundRecord[];
  delivered: Array<{ messageOutId: string; platformMessageId: string | null }>;
  latestRoutes: Array<{ channelType: string; platformId: string; threadId: string | null; inReplyTo: string }>;
  destinations: DestinationRecord[];
  routing: SessionRoutingRecord;
  state: StateRecord[];
}

type Row = Record<string, unknown>;

function sqliteTimestamp(value: string): string {
  const source = SQLITE_TIMESTAMP.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const milliseconds = Date.parse(source);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : value;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : sqliteTimestamp(String(value));
}

function inboundRecord(row: Row): InboundRecord | undefined {
  try {
    return parseInboundRecord({
      id: row.id,
      sequence: row.seq,
      kind: row.kind,
      timestamp: sqliteTimestamp(String(row.timestamp)),
      status: row.status,
      processAfter: nullableTimestamp(row.process_after),
      recurrence: row.recurrence ?? null,
      seriesId: row.series_id ?? null,
      tries: row.tries ?? 0,
      trigger: row.trigger === undefined ? true : row.trigger === 1,
      platformId: row.platform_id ?? null,
      channelType: row.channel_type ?? null,
      threadId: row.thread_id ?? null,
      content: row.content,
      sourceSessionId: row.source_session_id ?? null,
      onWake: row.on_wake === 1,
    });
  } catch (err) {
    // Same containment as the runner's SQLite reader: one bad row never blocks the mailbox.
    log.warn('Skipping invalid inbound mailbox row', { id: String(row.id), err });
    return undefined;
  }
}

function outboundRecord(row: Row): OutboundRecord | undefined {
  try {
    return parseOutboundRecord({
      id: row.id,
      sequence: row.seq,
      inReplyTo: row.in_reply_to ?? null,
      timestamp: sqliteTimestamp(String(row.timestamp)),
      deliverAfter: nullableTimestamp(row.deliver_after),
      recurrence: row.recurrence ?? null,
      kind: row.kind,
      platformId: row.platform_id ?? null,
      channelType: row.channel_type ?? null,
      threadId: row.thread_id ?? null,
      content: row.content,
    });
  } catch (err) {
    log.warn('Skipping invalid outbound mailbox row', { id: String(row.id), err });
    return undefined;
  }
}

function defined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function maxSeq(db: Database.Database, table: 'messages_in' | 'messages_out'): number {
  return (db.prepare(`SELECT COALESCE(MAX(seq), 0) AS value FROM ${table}`).get() as { value: number }).value;
}

function windowRows(db: Database.Database, table: 'messages_in' | 'messages_out', after: number): Row[] {
  if (after >= 0) return db.prepare(`SELECT * FROM ${table} WHERE seq > ? ORDER BY seq`).all(after) as Row[];
  return db
    .prepare(`SELECT * FROM (SELECT * FROM ${table} ORDER BY seq DESC LIMIT ?) ORDER BY seq`)
    .all(SNAPSHOT_WINDOW) as Row[];
}

/** The tables the runner creates lazily on its own first open (older outbound.db files lack them). */
export function ensureRunnerOutboundTables(outbound: Database.Database): void {
  outbound.exec(`
    CREATE TABLE IF NOT EXISTS session_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS container_state (
      id                       INTEGER PRIMARY KEY CHECK (id = 1),
      current_tool             TEXT,
      tool_declared_timeout_ms INTEGER,
      tool_started_at          TEXT,
      turn                     TEXT,
      updated_at               TEXT NOT NULL
    );
  `);
  const stateColumns = new Set(
    (outbound.prepare("PRAGMA table_info('session_state')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!stateColumns.has('updated_at')) {
    outbound.exec(`ALTER TABLE session_state ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'`);
  }
  const containerColumns = new Set(
    (outbound.prepare("PRAGMA table_info('container_state')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!containerColumns.has('turn')) outbound.exec('ALTER TABLE container_state ADD COLUMN turn TEXT');
}

function snapshot(session: RunnerSession, cursor: SnapshotCursor | null): RunnerSnapshot {
  const { inbound, outbound } = session;
  const pendingRows = inbound.prepare("SELECT * FROM messages_in WHERE status = 'pending' ORDER BY seq").all() as Row[];
  const claimed: Record<string, ProcessingStatus> = {};
  const ackStatement = outbound.prepare('SELECT message_id, status FROM processing_ack WHERE message_id = ?');
  for (const row of pendingRows) {
    const ack = ackStatement.get(row.id) as { message_id: string; status: ProcessingStatus } | undefined;
    if (ack) claimed[ack.message_id] = ack.status;
  }

  const inboundRows = windowRows(inbound, 'messages_in', cursor ? cursor.inbound : -1);
  const outboundRows = windowRows(outbound, 'messages_out', cursor ? cursor.outbound : -1);
  const deliveredRows = (
    cursor
      ? inbound
          .prepare('SELECT rowid, message_out_id, platform_message_id FROM delivered WHERE rowid > ? ORDER BY rowid')
          .all(cursor.delivered)
      : inbound
          .prepare(
            'SELECT * FROM (SELECT rowid, message_out_id, platform_message_id FROM delivered ORDER BY rowid DESC LIMIT ?) ORDER BY rowid',
          )
          .all(SNAPSHOT_WINDOW)
  ) as Array<{ rowid: number; message_out_id: string; platform_message_id: string | null }>;

  const latestRoutes = (
    inbound
      .prepare(
        `SELECT id, channel_type, platform_id, thread_id FROM messages_in
          WHERE seq IN (
            SELECT MAX(seq) FROM messages_in
             WHERE channel_type IS NOT NULL AND platform_id IS NOT NULL
             GROUP BY channel_type, platform_id
          )`,
      )
      .all() as Array<{ id: string; channel_type: string; platform_id: string; thread_id: string | null }>
  ).map((row) => ({
    channelType: row.channel_type,
    platformId: row.platform_id,
    threadId: row.thread_id,
    inReplyTo: row.id,
  }));

  const routingRow = tableExists(inbound, 'session_routing')
    ? (inbound.prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1').get() as
        | Row
        | undefined)
    : undefined;

  return {
    cursor: {
      inbound: Math.max(cursor?.inbound ?? 0, maxSeq(inbound, 'messages_in')),
      outbound: Math.max(cursor?.outbound ?? 0, maxSeq(outbound, 'messages_out')),
      delivered: Math.max(cursor?.delivered ?? 0, deliveredRows.at(-1)?.rowid ?? 0),
    },
    pending: pendingRows.map(inboundRecord).filter(defined),
    claimed,
    inbound: inboundRows.map(inboundRecord).filter(defined),
    outbound: outboundRows.map(outboundRecord).filter(defined),
    delivered: deliveredRows.map((row) => ({
      messageOutId: row.message_out_id,
      platformMessageId: row.platform_message_id,
    })),
    latestRoutes,
    destinations: (inbound.prepare('SELECT * FROM destinations ORDER BY name').all() as Row[]).map((row) =>
      parseDestinationRecord({
        name: row.name,
        displayName: row.display_name,
        type: row.type,
        channelType: row.channel_type,
        platformId: row.platform_id,
        agentGroupId: row.agent_group_id,
      }),
    ),
    routing: parseSessionRoutingRecord({
      channelType: routingRow?.channel_type ?? null,
      platformId: routingRow?.platform_id ?? null,
      threadId: routingRow?.thread_id ?? null,
    }),
    state: (
      outbound.prepare('SELECT key, value, updated_at FROM session_state ORDER BY key').all() as Array<{
        key: string;
        value: string;
        updated_at: string;
      }>
    ).map((row) => parseStateRecord({ key: row.key, value: row.value, updatedAt: sqliteTimestamp(row.updated_at) })),
  };
}

function writeMessageOut(session: RunnerSession, draft: unknown): number {
  const { inbound, outbound } = session;
  let message;
  try {
    message = parseOutboundWrite(draft);
  } catch (err) {
    throw new MailboxRequestError(err instanceof Error ? err.message : String(err));
  }
  // A client retry after a lost response replays the same id: answer with the
  // committed row instead of failing on the primary key.
  const existing = outbound.prepare('SELECT seq, kind, content FROM messages_out WHERE id = ?').get(message.id) as
    | { seq: number; kind: string; content: string }
    | undefined;
  if (existing) {
    if (existing.kind === message.kind && existing.content === message.content) return existing.seq;
    throw new MailboxRequestError(`messages_out already holds a different row with id ${message.id}`);
  }
  const max = Math.max(maxSeq(outbound, 'messages_out'), maxSeq(inbound, 'messages_in'));
  const sequence = max % 2 === 0 ? max + 1 : max + 2;
  const record = createOutboundRecord(message, sequence, new Date().toISOString());
  outbound
    .prepare(
      `INSERT INTO messages_out
         (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
       VALUES
         (@id, @sequence, @inReplyTo, @timestamp, @deliverAfter, @recurrence, @kind, @platformId, @channelType, @threadId, @content)`,
    )
    .run(record);
  return sequence;
}

function upsertAcks(outbound: Database.Database, acks: Array<[string, string]>): void {
  const statement = outbound.prepare(
    'INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)',
  );
  for (const [id, status] of acks) statement.run(id, status, new Date().toISOString());
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new MailboxRequestError(`${name} must be a string`);
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new MailboxRequestError(`${name} must be an array of strings`);
  }
  return value;
}

function parseCursor(value: unknown): SnapshotCursor | null {
  if (value === null || value === undefined) return null;
  const cursor = value as Partial<SnapshotCursor>;
  for (const field of ['inbound', 'outbound', 'delivered'] as const) {
    if (!Number.isSafeInteger(cursor[field]) || (cursor[field] as number) < 0) {
      throw new MailboxRequestError(`cursor.${field} must be a nonnegative integer`);
    }
  }
  return cursor as SnapshotCursor;
}

type RunnerOp = (session: RunnerSession, args: unknown[]) => unknown;

/** Operation table: name -> implementation. Unknown names are a 400. */
export const RUNNER_OPS: Record<string, RunnerOp> = {
  snapshot: (session, [cursor]) => snapshot(session, parseCursor(cursor)),
  heartbeat: (session) => session.touchHeartbeat(),
  writeMessageOut: (session, [draft]) => writeMessageOut(session, draft),
  markMessages: (session, [ids, status]) => {
    if (!PROCESSING_STATUSES.has(status as ProcessingStatus)) throw new MailboxRequestError('invalid status');
    upsertAcks(
      session.outbound,
      stringArray(ids, 'ids').map((id) => [id, status as string]),
    );
  },
  markScriptSkipped: (session, [skips]) => {
    if (!Array.isArray(skips)) throw new MailboxRequestError('skips must be an array');
    upsertAcks(
      session.outbound,
      skips.map((skip: { id?: unknown; reason?: unknown }) => [
        stringArg(skip?.id, 'skip.id'),
        stringArg(skip?.reason, 'skip.reason') === 'error' ? 'script-skip:error' : 'completed',
      ]),
    );
  },
  setState: (session, [key, value]) => {
    session.outbound
      .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(stringArg(key, 'key'), stringArg(value, 'value'), new Date().toISOString());
  },
  deleteState: (session, [key]) => {
    session.outbound.prepare('DELETE FROM session_state WHERE key = ?').run(stringArg(key, 'key'));
  },
  setContainerToolInFlight: (session, [tool, declaredTimeoutMs]) => {
    const timeout =
      typeof declaredTimeoutMs === 'number' && Number.isSafeInteger(declaredTimeoutMs) && declaredTimeoutMs >= 0
        ? declaredTimeoutMs
        : null;
    const now = new Date().toISOString();
    const record = parseContainerRecord({
      currentTool: stringArg(tool, 'tool'),
      toolDeclaredTimeoutMs: timeout,
      toolStartedAt: now,
      turn: null,
      updatedAt: now,
    });
    session.outbound
      .prepare(
        `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           current_tool = excluded.current_tool,
           tool_declared_timeout_ms = excluded.tool_declared_timeout_ms,
           tool_started_at = excluded.tool_started_at,
           updated_at = excluded.updated_at`,
      )
      .run(record.currentTool, record.toolDeclaredTimeoutMs, now, now);
  },
  clearContainerToolInFlight: (session) => {
    session.outbound
      .prepare(
        `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
         VALUES (1, NULL, NULL, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET
           current_tool = NULL,
           tool_declared_timeout_ms = NULL,
           tool_started_at = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(new Date().toISOString());
  },
  markContainerTurn: (session, [turn]) => {
    if (!TURN_STATES.has(turn as string)) throw new MailboxRequestError('turn must be working or idle');
    session.outbound
      .prepare(
        `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, turn, updated_at)
         VALUES (1, NULL, NULL, NULL, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           turn = excluded.turn,
           updated_at = excluded.updated_at`,
      )
      .run(turn, new Date().toISOString());
  },
  clearStaleProcessingAcks: (session) => {
    session.outbound.prepare("DELETE FROM processing_ack WHERE status = 'processing'").run();
  },
};

export interface RunnerOpCall {
  op: string;
  args: unknown[];
}

/**
 * Run a batch atomically on the outbound side: every write commits together or
 * none does. Returns only after the synchronous SQLite commit — the caller
 * answers the HTTP request after this, which is what makes the runner's async
 * writes durable when their promise resolves.
 */
export function executeRunnerOps(session: RunnerSession, calls: RunnerOpCall[]): unknown[] {
  for (const call of calls) {
    if (!Object.hasOwn(RUNNER_OPS, call.op)) throw new MailboxRequestError(`unknown mailbox op: ${call.op}`);
  }
  return session.outbound.transaction(() => calls.map((call) => RUNNER_OPS[call.op](session, call.args) ?? null))();
}
