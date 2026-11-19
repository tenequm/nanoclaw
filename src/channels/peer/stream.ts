import type { ServerResponse } from 'node:http';
import { getDb } from '../../db/connection.js';
import { checkEpoch, fail, limits, listPeers, onMachineRevoked } from './store.js';
import { eventHead } from './lifecycle.js';
import type { Peer, PeerEvent } from './types.js';

const streams = new Map<string, { epoch: number; close: (event?: PeerEvent) => void }>();
export function streamIsOpen(id: string) {
  return streams.has(id);
}
export function closeStream(id: string, epoch: number, takeover: boolean) {
  const old = streams.get(id);
  if (old && old.epoch < epoch)
    old.close(
      takeover
        ? { kind: 'superseded', epoch: old.epoch, by: epoch, message: 'A new daemon took over.', at: Date.now() }
        : undefined,
    );
}
export function closeStreams() {
  for (const s of streams.values()) s.close();
}
onMachineRevoked((id) =>
  streams.get(id)?.close({ kind: 'revoked', machine: id, message: 'Enrollment revoked.', at: Date.now() }),
);
function frame(event: PeerEvent) {
  const id = 'seq' in event && event.kind !== 'synchronized' ? 'id: ' + event.seq + '\n' : '';
  return id + 'event: ' + event.kind + '\ndata: ' + JSON.stringify(event) + '\n\n';
}
export async function openStream(res: ServerResponse, machineId: string, epoch: number, after: number) {
  const db = getDb();
  let cursor = after;
  let replayHead = 0;
  let directory = new Map<string, Peer>();
  let closed = false,
    timer: NodeJS.Timeout | undefined,
    lastPing = Date.now();
  function close(event?: PeerEvent) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (streams.get(machineId)?.close === close) streams.delete(machineId);
    res.end(event ? frame(event) : undefined);
  }
  function write(bytes: string) {
    if (closed || res.destroyed) return;
    // A stalled reader resumes from its durable cursor instead of buffering the event log in host memory.
    if (res.writableLength > 256 * 1024) {
      res.destroy();
      close();
      return;
    }
    res.write(bytes);
  }
  async function events(head: number) {
    while (!closed && cursor < head) {
      const rows = await db.all<{ seq: number; payload: string }>(
        `SELECT e.seq,e.payload FROM peer_events e
        LEFT JOIN peer_messages m ON m.row_id=e.message_row WHERE e.machine_id=? AND e.seq>? AND e.seq<=?
        AND (e.kind<>'message' OR (m.state NOT IN ('accepted','delivered','denied','expired','refused','dropped','unknown')
          AND (m.state<>'queued' OR m.expires_at>?))) ORDER BY e.seq LIMIT 100`,
        machineId,
        cursor,
        head,
        Date.now(),
      );
      for (const row of rows) {
        write(frame({ ...JSON.parse(row.payload), seq: row.seq }));
        cursor = row.seq;
      }
      if (rows.length < 100) cursor = head;
    }
  }
  async function status(peers: Peer[]) {
    const current = new Map(peers.map((p) => [p.address, p]));
    for (const [address, peer] of directory)
      if (!current.has(address)) write(frame({ kind: 'status', peer, listed: false }));
    for (const peer of peers)
      if (JSON.stringify(peer) !== JSON.stringify(directory.get(peer.address)))
        write(frame({ kind: 'status', peer, listed: true }));
    directory = current;
  }
  async function tick() {
    try {
      await events(await eventHead());
      await status(await listPeers());
      if (Date.now() - lastPing >= limits.keepaliveMs) {
        write(': ping\n\n');
        lastPing = Date.now();
      }
      if (!closed) timer = setTimeout(() => void tick(), 1000).unref();
    } catch {
      close();
    }
  }
  await db.transaction(async () => {
    await checkEpoch(machineId, epoch);
    replayHead = await eventHead();
    if (after > replayHead) fail(400, 'bad_cursor', 'Cursor exceeds the event log head.', { seq: replayHead });
    if (res.destroyed) {
      closed = true;
      return;
    }
    streams.get(machineId)?.close();
    streams.set(machineId, { epoch, close });
    res.once('close', () => close());
    res.once('error', () => close());
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
  });
  try {
    await events(replayHead);
    await status(await listPeers());
    write(frame({ kind: 'synchronized', seq: replayHead }));
    if (!closed) await tick();
  } catch {
    close();
  }
}
