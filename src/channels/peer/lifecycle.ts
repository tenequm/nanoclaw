import { randomUUID } from 'node:crypto';
import { log } from '../../log.js';
import { getDb } from '../../db/connection.js';
import { appendEvent, announceEndpoint, type MessageRow } from './routing.js';
import { checkEpoch, fail, limits, meshChanged, remoteById, remoteSession } from './store.js';
import type { DeliveryState, HeartbeatRequest, ReportsRequest, ReportsResponse, SendResponse } from './types.js';

export async function queueNotice(hub: string, remote: string, text: string, channel = 'peer') {
  await getDb().run(
    'INSERT INTO peer_inbound(id,hub_session,remote_id,content,created_at,channel) VALUES (?,?,?,?,?,?)',
    randomUUID(),
    hub,
    remote,
    JSON.stringify({ text, sender: 'Peer delivery', failureNotice: true }),
    Date.now(),
    channel,
  );
}
export async function transition(row: MessageRow, state: DeliveryState, reason: string | null, at: number) {
  if (!['queued', 'sent', 'held'].includes(row.state) || row.state === state) return false;
  const db = getDb();
  const result = JSON.parse(row.response) as SendResponse;
  const message = result.message.to.address + ' delivery: ' + state + (reason ? ' (' + reason + ')' : '') + '.';
  const sender = await remoteById(row.sender);
  const notice = ['denied', 'dropped', 'expired', 'refused'].includes(state);
  if (sender) {
    await appendEvent(
      sender.machine_id,
      {
        kind: 'delivery',
        id: row.id,
        session: sender.key,
        to: { address: result.message.to.address, endpoint: result.message.endpoint.id },
        state,
        reason,
        message,
        at,
      },
      row.row_id,
    );
  } else if (notice && !row.failure_notice) await queueNotice(row.sender, row.recipient, message);
  await db.run(
    'UPDATE peer_messages SET state=?,sent_at=COALESCE(sent_at,?) WHERE row_id=?',
    state,
    row.sent_at,
    row.row_id,
  );
  row.state = state;
  return true;
}

export async function dropAgentQueue(agentId: string) {
  const db = getDb();
  const rows = await db.all<MessageRow>(
    `SELECT m.* FROM peer_messages m JOIN sessions s ON m.recipient=s.id
    WHERE s.agent_group_id=? AND m.state='queued'`,
    agentId,
  );
  for (const row of rows) await transition(row, 'dropped', 'not_member', Date.now());
  await db.run(
    'DELETE FROM peer_inbound WHERE hub_session IN (SELECT id FROM sessions WHERE agent_group_id=?)',
    agentId,
  );
}
export async function advanceDelivery(row: MessageRow, state: DeliveryState, reason: string | null, at: number) {
  if (row.state === 'queued') {
    row.sent_at = at;
    await transition(row, 'sent', null, at);
  }
  return state === 'sent' || transition(row, state, reason, at);
}
export async function refreshEndpoints(id: string) {
  const rows = await getDb().all<{ id: string }>(
    `SELECT id FROM peer_endpoints WHERE actor=? OR id IN
    (SELECT endpoint_id FROM peer_parties WHERE session_id=?)`,
    id,
    id,
  );
  for (const row of rows) await announceEndpoint(row.id);
}
export async function endRemote(machineId: string, key: string) {
  const remote = await remoteSession(machineId, key);
  if (!remote) fail(404, 'unknown_session', 'Session is not registered.');
  const db = getDb();
  await db.run("UPDATE peer_sessions SET status='ended',updated_at=? WHERE id=?", Date.now(), remote.id);
  const rows = await db.all<MessageRow>("SELECT * FROM peer_messages WHERE recipient=? AND state='queued'", remote.id);
  for (const row of rows) await transition(row, 'dropped', 'ended', Date.now());
  await refreshEndpoints(remote.id);
  return { session: { key, status: 'ended' as const }, dropped: rows.length };
}
export async function resetHops(actor: string) {
  return (
    await getDb().run(
      `UPDATE peer_conversations SET hops=0,chain='[]',limited=0,pending_native_limit=NULL,reset_chain=1 WHERE hops>0 AND
      (party_a=? OR party_b=? OR (party_a IN (SELECT id FROM sessions) AND party_b IN (SELECT id FROM sessions) AND EXISTS (
        SELECT 1 FROM sessions s JOIN sessions owner ON owner.agent_group_id=s.agent_group_id
        WHERE owner.id=? AND s.id IN (party_a,party_b))))`,
      actor,
      actor,
      actor,
    )
  ).changes;
}
export async function eventHead() {
  return (await getDb().get<{ seq: number }>('SELECT COALESCE(MAX(seq),0) AS seq FROM peer_events'))!.seq;
}
export async function heartbeat(machineId: string, body: HeartbeatRequest) {
  const db = getDb();
  const result = await db.transaction(async () => {
    await checkEpoch(machineId, body.epoch);
    const head = await eventHead();
    if (body.cursor > head) fail(400, 'bad_cursor', 'Cursor exceeds the event log head.', { seq: head });
    const now = Date.now();
    await db.run('UPDATE peer_machines SET last_seen_at=? WHERE id=?', now, machineId);
    const live = await db.all<{ key: string; status: string }>(
      "SELECT key,status FROM peer_sessions WHERE machine_id=? AND status<>'ended'",
      machineId,
    );
    const reported = new Map(body.sessions.map((s) => [s.key, s.status]));
    const known = new Set(live.map((s) => s.key));
    const unknown = [...reported.keys()].filter((key) => !known.has(key));
    const ended: string[] = [];
    const rows = await db.all<MessageRow>(
      `SELECT m.* FROM peer_messages m JOIN peer_events e ON m.row_id=e.message_row
      WHERE e.kind='message' AND e.machine_id=? AND e.seq<=? AND m.state='queued' ORDER BY e.seq`,
      machineId,
      body.cursor,
    );
    for (const row of rows) await advanceDelivery(row, 'sent', null, now);
    let changed = false;
    for (const s of live) {
      const status = reported.get(s.key);
      if (!reported.has(s.key)) {
        await endRemote(machineId, s.key);
        ended.push(s.key);
        changed = true;
      } else if ((status === 'busy' || status === 'idle') && s.status !== status) {
        await db.run(
          'UPDATE peer_sessions SET status=?,updated_at=? WHERE machine_id=? AND key=?',
          status,
          now,
          machineId,
          s.key,
        );
        changed = true;
      }
    }
    return { changed, response: { unknown, ended, serverTime: now } };
  });
  if (result.changed) meshChanged();
  return result.response;
}
export async function reports(machineId: string, body: ReportsRequest) {
  const db = getDb();
  let ended = false;
  const results = await db.transaction(async () => {
    await checkEpoch(machineId, body.epoch);
    const results: ReportsResponse['results'] = [];
    for (const report of body.reports) {
      const { kind, id } = report;
      if (kind !== 'idle' && kind !== 'state') {
        results.push({ id, state: null, applied: false });
        continue;
      }
      const remote = await remoteSession(machineId, report.session);
      const row =
        remote &&
        (await db.get<MessageRow>('SELECT * FROM peer_messages WHERE recipient=? AND id=?', remote.id, report.id));
      let applied = false;
      if (row && remote) {
        if (report.kind === 'idle') {
          if (row.state === 'queued') await advanceDelivery(row, 'sent', null, report.at);
        } else if (
          report.kind === 'state' &&
          ['accepted', 'held', 'delivered', 'denied', 'expired', 'refused', 'dropped', 'unknown'].includes(report.state)
        ) {
          applied = await advanceDelivery(row, report.state, report.reason, report.at);
          if (applied && report.state === 'dropped' && report.reason === 'unknown_session') {
            await endRemote(machineId, report.session);
            ended = true;
          }
        } else {
          if (row.state === 'queued') await advanceDelivery(row, 'sent', null, report.at);
          log.info('Unknown peer delivery state', { id });
        }
      }
      results.push({ id: report.id, state: row?.state ?? null, applied });
    }
    return results;
  });
  if (ended) meshChanged();
  return { results };
}
export async function sweepPeers(now = Date.now()) {
  const db = getDb();
  const changed = await db.transaction(async () => {
    const offline = await db.run(
      `UPDATE peer_sessions SET status='offline' WHERE status IN ('idle','busy') AND machine_id IN
      (SELECT id FROM peer_machines WHERE last_seen_at<=?)`,
      now - limits.offlineAfterMs,
    );
    const rows = await db.all<MessageRow>(
      `SELECT m.* FROM peer_messages m JOIN peer_sessions s ON m.recipient=s.id
      WHERE m.state='queued' AND (s.status='ended' OR m.expires_at<=?) ORDER BY m.created_at LIMIT 500`,
      now,
    );
    for (const row of rows) await transition(row, 'dropped', row.expires_at <= now ? 'queue_expired' : 'ended', now);
    return offline.changes;
  });
  if (changed) meshChanged();
}
