import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import type { Conversation, Message, Question, FileAttachment, Status } from './contract.js';
import type { DbDriver } from '../../db/driver.js';
import type { OutboundFile } from '../adapter.js';
import type { EventRow } from './db.js';
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import './db.js';

export interface AppHooks {
  // Runs inside the central transaction: use only the supplied database, never network IO.
  claimFiles(
    db: DbDriver,
    c: { userId: string; conversationId: string; messageId: string; fileIds: string[] },
  ): Promise<{ ok: true; files: FileAttachment[] } | { ok: false; fileId: string }>;
  stageFiles(messageId: string): Promise<{ name: string; mimeType: string; size: number; stagedPath: string }[]>;
  storeOutboundFiles(o: {
    userId: string;
    conversationId: string;
    messageId: string;
    files: OutboundFile[];
  }): Promise<FileAttachment[]>;
  statuses(conversationIds: string[]): Promise<Status[]>;
  callAvailability(
    userId: string,
    agentGroupId: string,
  ): Promise<{ canCall: boolean; callRefusal: { error: string; message: string } | null }>;
}
export const appHooks: AppHooks = {
  claimFiles: async (_db, c) => (c.fileIds.length ? { ok: false, fileId: c.fileIds[0] } : { ok: true, files: [] }),
  stageFiles: async () => [],
  storeOutboundFiles: async () => [],
  statuses: async (ids) =>
    ids.map((conversationId) => ({
      kind: 'status',
      conversationId,
      rev: 0,
      state: 'idle',
      label: null,
      at: Date.now(),
    })),
  callAvailability: async () => ({
    canCall: false,
    callRefusal: { error: 'voice_offline', message: 'Calls are offline right now.' },
  }),
};
export function setAppHooks(hooks: Partial<AppHooks>): void {
  Object.assign(appHooks, hooks);
}
const listeners = new Set<(event: EventRow) => void>();
const commits = new AsyncLocalStorage<(() => void)[]>();
const committedReader = new AsyncResource('app-committed-events');
export function afterAppCommit(callback: () => void): void {
  const pending = commits.getStore();
  if (!pending) throw new Error('App mutation requires appTransaction');
  pending.push(callback);
}
export async function appTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const callbacks: (() => void)[] = [];
  const parent = commits.getStore();
  const result = await getDb().transaction(() => commits.run(callbacks, fn));
  if (parent) parent.push(...callbacks);
  else
    for (const callback of callbacks) {
      try {
        callback();
      } catch {
        log.warn('App commit listener failed');
      }
    }
  return result;
}
export async function appendEvent(
  db: DbDriver,
  userId: string,
  agentId: string,
  entity: Conversation | Message | Question,
): Promise<number> {
  const row = await db.get<{ seq: number }>(
    `INSERT INTO app_events (user_id, agent_group_id, conversation_id, entity_id, kind, entity_json, created_at) VALUES (?, ?, ?, ?, ?, '', ?) RETURNING seq`,
    userId,
    agentId,
    'conversationId' in entity ? entity.conversationId : entity.id,
    entity.id,
    entity.kind,
    Date.now(),
  );
  entity.seq = row!.seq;
  if ('order' in entity && !entity.order) entity.order = entity.seq;
  await db.run('UPDATE app_events SET entity_json = ? WHERE seq = ?', JSON.stringify(entity), entity.seq);
  const event = (await db.get<EventRow>('SELECT * FROM app_events WHERE seq = ?', entity.seq))!;
  const publish = () => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        log.warn('App event listener failed');
      }
    }
  };
  if (commits.getStore()) afterAppCommit(publish);
  else
    committedReader.runInAsyncScope(() => {
      setImmediate(() => {
        // A read outside the transaction waits for commit and excludes rolled-back versions.
        void db
          .get<EventRow>('SELECT * FROM app_events WHERE seq = ?', event.seq)
          .then((saved) => {
            if (saved?.entity_json === event.entity_json) publish();
          })
          .catch(() => log.warn('App committed event read failed'));
      });
    });
  return entity.seq;
}
export async function lastEventSeq(): Promise<number> {
  return (await getDb().get<{ seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM app_events'))!.seq;
}
export async function readEventsAfter(afterSeq: number, limit: number): Promise<EventRow[]> {
  return getDb().all('SELECT * FROM app_events WHERE seq > ? ORDER BY seq LIMIT ?', afterSeq, limit);
}
export function onEventAppended(listener: (event: EventRow) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
