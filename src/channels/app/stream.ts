import { setImmediate as yieldToHost } from 'node:timers/promises';
import { lastEventSeq, readEventsAfter, onEventAppended } from './log.js';
import { onBadgeChanged, conversationsFor, badgeFor } from './conversations.js';
import { statuses, onStatusChanged } from './status.js';
import { getLiveDevice, reachableAgentIds, onDeviceRevoked } from '../../modules/device-auth/verify.js';
import { formatEvent, type Badge, type Status } from './contract.js';
import type { ConversationRow, EventRow } from './db.js';
import { json, type AppHandler, type AppRequest } from './routes.js';

export interface StreamDeps {
  lastEventSeq(): Promise<number>;
  readEventsAfter(after: number, limit: number): Promise<EventRow[]>;
  onEventAppended(listener: (event: EventRow) => void): () => void;
  onBadgeChanged(listener: (userId: string) => void): () => void;
  onStatusChanged(listener: (status: Status) => void): () => void;
  conversationsFor(userId: string, agentIds: string[]): Promise<ConversationRow[]>;
  badgeFor(userId: string, agentIds: string[]): Promise<Badge>;
  statuses(ids: string[]): Promise<Status[]>;
}
const defaults: StreamDeps = {
  lastEventSeq,
  readEventsAfter,
  onEventAppended,
  onBadgeChanged,
  conversationsFor,
  badgeFor,
  statuses: (ids) => statuses(ids),
  onStatusChanged: (listener) => onStatusChanged(listener),
};
let configured: StreamDeps = defaults;
export function configureStream(deps: StreamDeps = defaults): void {
  configured = deps;
}
const streams = new Map<string, Set<() => void>>();
type Pending = { event: EventRow } | { status: Status } | { badge: true } | { ping: true };

export const streamEvents: AppHandler = (ctx) => openStream(ctx, configured);
export async function openStream({ req, res, identity }: AppRequest, deps?: StreamDeps): Promise<void> {
  if (!identity) return json(res, 401, { error: 'device_revoked', message: 'Device authentication required.' });
  if (!deps) return json(res, 503, { error: 'unavailable', message: 'Event stream is unavailable.' });
  const afterText = new URL(req.url!, 'http://localhost').searchParams.get('after');
  if (afterText === null || !/^(0|[1-9][0-9]*)$/.test(afterText) || !Number.isSafeInteger(Number(afterText)))
    return json(res, 400, { error: 'bad_request', message: 'Invalid cursor.' });
  let closed = false,
    replaying = true,
    pumping = false;
  let cancelDrain: (() => void) | undefined;
  let cursor = Number(afterText);
  const pending: Pending[] = [];
  const cleanup: (() => void)[] = [];
  const close = () => {
    if (closed) return;
    closed = true;
    pending.length = 0;
    cancelDrain?.();
    for (const dispose of cleanup) dispose();
    const active = streams.get(identity.deviceId);
    active?.delete(close);
    if (!active?.size) streams.delete(identity.deviceId);
    res.end();
  };
  res.once('close', close);
  res.once('error', close);
  cleanup.push(() => {
    res.off('close', close);
    res.off('error', close);
  });
  const active = streams.get(identity.deviceId) ?? new Set();
  streams.set(identity.deviceId, active);
  active.add(close);
  if (active.size > 3) active.values().next().value!();
  let access: { ids: string[]; at: number } | undefined;
  async function agents(): Promise<string[]> {
    if (closed) return [];
    if (access && Date.now() - access.at < 2_000) return access.ids;
    if (!(await getLiveDevice(identity!.deviceId))) {
      close();
      return [];
    }
    const at = Date.now();
    const ids = await reachableAgentIds(identity!.deviceId);
    access = { ids, at };
    return ids;
  }
  async function write(bytes: string): Promise<void> {
    if (closed) return;
    if (!res.write(bytes))
      await new Promise<void>((resolve) => {
        const done = () => {
          res.off('drain', done);
          res.off('close', done);
          res.off('error', done);
          cancelDrain = undefined;
          resolve();
        };
        cancelDrain = done;
        res.once('drain', done);
        res.once('close', done);
        res.once('error', done);
      });
  }
  async function event(row: EventRow): Promise<void> {
    if (row.seq <= cursor) return;
    const allowed = await agents();
    if (row.user_id === identity!.userId && allowed.includes(row.agent_group_id))
      await write(formatEvent({ kind: row.kind, data: JSON.parse(row.entity_json), id: row.seq }));
    cursor = row.seq;
  }
  async function status(value: Status): Promise<void> {
    const conversations = await deps!.conversationsFor(identity!.userId, await agents());
    const allowed = await agents();
    if (conversations.some((c) => c.id === value.conversationId && allowed.includes(c.agent_group_id)))
      await write(formatEvent({ kind: 'status', data: value }));
  }
  async function badge(): Promise<void> {
    let allowed = await agents();
    while (!closed) {
      const value = await deps!.badgeFor(identity!.userId, allowed);
      const current = await agents();
      if (current.length === allowed.length && current.every((id) => allowed.includes(id))) {
        await write(formatEvent({ kind: 'badge', data: value }));
        return;
      }
      allowed = current;
    }
  }
  async function pump(): Promise<void> {
    if (replaying || pumping || closed) return;
    pumping = true;
    try {
      while (!closed && pending.length) {
        const item = pending.shift()!;
        if ('event' in item) await event(item.event);
        else if ('status' in item) await status(item.status);
        else if ('badge' in item) await badge();
        else {
          await agents();
          await write(formatEvent({ comment: 'ping' }));
        }
      }
    } catch {
      close();
    } finally {
      pumping = false;
    }
  }
  function enqueue(item: Pending): void {
    if (closed) return;
    pending.push(item);
    void pump();
  }
  try {
    cleanup.push(deps.onEventAppended((row) => enqueue({ event: row })));
    cleanup.push(
      deps.onBadgeChanged((user) => {
        if (user === identity.userId) enqueue({ badge: true });
      }),
    );
    cleanup.push(deps.onStatusChanged((value) => enqueue({ status: value })));
    cleanup.push(
      onDeviceRevoked((id) => {
        if (id === identity.deviceId) {
          access = undefined;
          close();
        }
      }),
    );
    const ping = setInterval(() => enqueue({ ping: true }), 20_000);
    const recheck = setInterval(() => {
      void agents().catch(close);
    }, 5_000);
    ping.unref();
    recheck.unref();
    cleanup.push(() => {
      clearInterval(ping);
      clearInterval(recheck);
    });
    await agents();
    if (closed) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.flushHeaders();
    const high = await deps.lastEventSeq();
    while (!closed && cursor < high) {
      const rows = await deps.readEventsAfter(cursor, 100);
      if (closed || !rows.length) break;
      for (const row of rows) {
        if (closed || row.seq > high) break;
        await event(row);
      }
      await yieldToHost();
      if (rows.at(-1)!.seq >= high) break;
    }
    if (closed) return;
    const conversations = await deps.conversationsFor(identity.userId, await agents());
    for (const value of await deps.statuses(conversations.map((c) => c.id))) await status(value);
    await badge();
    await agents();
    await write(formatEvent({ kind: 'synchronized', data: { seq: high } }));
    cursor = Math.max(cursor, high);
    replaying = false;
    await pump();
  } catch {
    close();
  }
}
