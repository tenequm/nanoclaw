import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initTestDb, runMigrations, getDb, closeDb, createAgentGroup } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder } from '../../session-manager.js';
import { setDeliveryAdapter, deliverSessionMessages } from '../../delivery.js';
import { outboundDbPath, inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { DATA_DIR } from '../../config.js';
import type { Session } from '../../types.js';
import { registerSession, setMeshMembership, enrollMachine } from './store.js';
import { drainInbound, routeAgentPeer, sendRemote } from './routing.js';

vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: mkdtempSync(join(tmpdir(), 'peer-route-')),
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(undefined) }));
beforeEach(async () => {
  await runMigrations(await initTestDb());
});
afterEach(async () => {
  await closeDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

async function registerTestMachine(name: string) {
  const publicKey = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .publicKey.export({ format: 'der', type: 'spki' })
    .toString('base64url');
  const id = await enrollMachine(name, publicKey);
  await getDb().run('UPDATE peer_machines SET epoch=1,last_seen_at=? WHERE id=?', Date.now(), id);
  const key = '12-1234abcd';
  const info = await registerSession(id, key, {
    epoch: 1,
    name: 'review',
    project: 'test',
    nameSource: 'user',
    startedAt: 0,
    entrypoint: 'cli',
    status: 'idle',
    claudeCode: 'test',
    sessionId: name,
  });
  return { id, key, address: info.address };
}
it('delivers a reply only to the agent session that asked, even when another session is newer', async () => {
  const remote = await registerTestMachine('test');
  const agent = 'test-agent';
  await createAgentGroup({
    id: agent,
    name: agent,
    folder: agent,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await setMeshMembership(agent, true);
  const session: Session = {
    id: 'sess-asking',
    agent_group_id: agent,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
  await createSession(session);
  await createSession({ ...session, id: 'sess-newer', last_active: new Date().toISOString() });
  initSessionFolder(agent, session.id);
  const outbox = new Database(outboundDbPath(agent, session.id));
  try {
    outbox
      .prepare(
        "INSERT INTO messages_out(id,timestamp,kind,platform_id,channel_type,content) VALUES ('ask',datetime('now'),'chat',?,'peer',?)",
      )
      .run(remote.address, JSON.stringify({ text: 'question' }));
  } finally {
    outbox.close();
  }
  const external = vi.fn();
  setDeliveryAdapter({ deliver: external });
  await deliverSessionMessages(session);
  expect(external).not.toHaveBeenCalled();
  const endpoint = await getDb().get<{ id: string }>('SELECT id FROM peer_endpoints WHERE actor=?', session.id);
  const { heartbeat } = await import('./lifecycle.js');
  const { seq } = (await getDb().get<{ seq: number }>('SELECT MAX(seq) AS seq FROM peer_events'))!;
  await heartbeat(remote.id, { epoch: 1, cursor: seq, sessions: [{ key: remote.key, status: 'idle' }] });
  const reply = {
    epoch: 1,
    id: randomUUID(),
    from: { session: remote.key },
    to: { endpoint: endpoint!.id },
    text: 'answer',
    hopChain: [],
    fromMode: 'prompting' as const,
    origin: 'peer' as const,
    notifyWhenIdle: false,
    failureNotice: false,
    senderId: 'telegram:1',
    senderRole: 'owner',
    stagedPath: 'private',
  };
  await sendRemote(remote.id, reply);
  await sendRemote(remote.id, reply);
  await drainInbound();
  const inbox = new Database(inboundDbPath(agent, session.id), { readonly: true });
  try {
    const rows = inbox.prepare('SELECT content,channel_type FROM messages_in').all() as {
      content: string;
      channel_type: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].channel_type).toBe('peer');
    expect(JSON.parse(rows[0].content)).toEqual({
      text: 'answer',
      sender: remote.address + ' (Claude Code session)',
      senderId: 'peer:test',
      replyTo: expect.objectContaining({ text: 'question' }),
    });
  } finally {
    inbox.close();
  }
});

it('creates a dedicated chat per remote, drops omitted heartbeat sessions and enforces the hop limit', async () => {
  const { heartbeat, resetHops, reports } = await import('./lifecycle.js');
  const { getSession } = await import('../../db/sessions.js');
  const remote = await registerTestMachine('test');
  await createAgentGroup({
    id: 'test-agent',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await setMeshMembership('test-agent', true);
  const start = {
    epoch: 1,
    id: randomUUID(),
    from: { session: remote.key },
    to: { address: 'test-agent' },
    text: 'question',
    hopChain: ['a'.repeat(24)],
    fromMode: 'prompting' as const,
    origin: 'unknown' as const,
    notifyWhenIdle: false,
    failureNotice: false,
  };
  const result = await sendRemote(remote.id, start);
  const endpoint = await getDb().get<{ actor: string }>(
    'SELECT actor FROM peer_endpoints WHERE id=?',
    result.message.endpoint.id,
  );
  const hub = (await getSession(endpoint!.actor))!;
  const outbound = await routeAgentPeer(hub, {
    id: 'reply',
    platformId: hub.messaging_group_id,
    content: JSON.stringify({ text: 'answer' }),
  });
  const frame = await getDb().get<{ payload: string }>("SELECT payload FROM peer_events WHERE kind='message'");
  expect(JSON.parse(frame!.payload)).toMatchObject({
    hopChain: start.hopChain,
    fromMode: 'bypass',
    session: remote.key,
    hop: { count: 2 },
  });
  const report = {
    id: outbound.message.id,
    session: remote.key,
    kind: 'state' as const,
    reason: null,
    at: Date.now(),
    state: 'held' as const,
  };
  expect((await reports(remote.id, { epoch: 1, reports: [report] })).results[0]).toMatchObject({
    applied: true,
    state: 'held',
  });
  expect(
    (await reports(remote.id, { epoch: 1, reports: [{ ...report, state: 'delivered' }] })).results[0].applied,
  ).toBe(true);
  expect((await reports(remote.id, { epoch: 1, reports: [{ ...report, state: 'unknown' }] })).results[0]).toMatchObject(
    { state: 'delivered', applied: false },
  );
  expect(
    (await getDb().get<{ sent_at: number }>('SELECT sent_at FROM peer_messages WHERE id=?', report.id))!.sent_at,
  ).toBe(report.at);
  await getDb().run('UPDATE peer_conversations SET hops=20');
  const stopped = { ...start, id: randomUUID(), origin: 'human' as const };
  await expect(sendRemote(remote.id, stopped)).rejects.toMatchObject({ body: { error: 'hop_limit' } });
  await expect(sendRemote(remote.id, stopped)).rejects.toMatchObject({ body: { error: 'hop_limit' } });
  expect(await getDb().get('SELECT COUNT(*) AS n FROM peer_inbound WHERE message_row IS NULL')).toEqual({ n: 1 });
  await expect(sendRemote(remote.id, { ...stopped, id: randomUUID() })).rejects.toMatchObject({
    body: { error: 'hop_limit' },
  });
  expect(await getDb().get('SELECT COUNT(*) AS n FROM peer_inbound WHERE message_row IS NULL')).toEqual({ n: 1 });
  expect(await resetHops(hub.id)).toBe(1);
  const next = await sendRemote(remote.id, { ...start, id: randomUUID() });
  expect(next.message.hop.count).toBe(1);
  expect(await getDb().get('SELECT chain FROM peer_conversations')).toEqual({ chain: '[]' });

  expect(await heartbeat(remote.id, { epoch: 1, cursor: 0, sessions: [] })).toMatchObject({ ended: [remote.key] });
  await expect(
    routeAgentPeer(hub, { id: 'failed', platformId: remote.address, content: '{"text":"hello"}' }),
  ).rejects.toMatchObject({ body: { error: 'not_running' } });
  const unread = new Database(inboundDbPath('test-agent', hub.id), { readonly: true });
  try {
    expect(unread.prepare('SELECT content FROM messages_in WHERE id=?').get('peer-refusal-failed')).toMatchObject({
      content: JSON.stringify({
        sender: 'Peer delivery',
        failureNotice: true,
        text: 'This session is no longer running.',
      }),
    });
  } finally {
    unread.close();
  }
});

it('resumes the ended process hub chat and endpoints while concurrent keys keep separate chats', async () => {
  const remote = await registerTestMachine('resume');
  const { endRemote } = await import('./lifecycle.js');
  await createAgentGroup({
    id: 'agent',
    name: 'Agent',
    folder: 'agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await setMeshMembership('agent', true);
  const request = {
    epoch: 1,
    name: '._-Review-_.',
    project: '._-Test-_.',
    nameSource: 'user' as const,
    startedAt: 0,
    entrypoint: 'cli',
    status: 'idle' as const,
    claudeCode: 'test',
    sessionId: 'resume',
  };
  const send = (key: string, to: { address: string } | { endpoint: string }) =>
    sendRemote(remote.id, {
      id: randomUUID(),
      epoch: 1,
      from: { session: key },
      to,
      text: 'question',
      origin: 'unknown',
      fromMode: null,
      hopChain: [],
      notifyWhenIdle: false,
      failureNotice: false,
    });
  const first = await send(remote.key, { address: 'agent' });
  const secondKey = '13-aaaaaaaa';
  const second = await registerSession(remote.id, secondKey, request);
  expect(second.address).toBe('review-2@test:resume');
  const concurrent = await send(secondKey, { address: 'agent' });
  expect(concurrent.message.endpoint.id).not.toBe(first.message.endpoint.id);
  await endRemote(remote.id, remote.key);
  const resumedKey = '14-bbbbbbbb';
  expect((await registerSession(remote.id, resumedKey, request)).address).toBe('review@test:resume');
  const same = await send(resumedKey, { address: 'agent' });
  expect(same.message.endpoint.id).toBe(first.message.endpoint.id);
  expect((await send(resumedKey, { endpoint: first.message.endpoint.id })).message.hop.count).toBe(3);
  await expect(send(secondKey, { endpoint: first.message.endpoint.id })).rejects.toMatchObject({
    body: { error: 'not_a_party' },
  });
});

it('reconciles an inbox write after a hub restart and reports definite delivery failures', async () => {
  const { initDb } = await import('../../db/connection.js');
  const manager = await import('../../session-manager.js');
  const { mkdirSync } = await import('node:fs');
  await closeDb();
  mkdirSync(DATA_DIR, { recursive: true });
  const file = join(DATA_DIR, 'hub.db');
  await runMigrations(await initDb(file));
  const remote = await registerTestMachine('restart');
  await createAgentGroup({
    id: 'agent',
    name: 'agent',
    folder: 'agent',
    created_at: new Date().toISOString(),
    agent_provider: null,
  });
  await setMeshMembership('agent', true);
  const send = () =>
    sendRemote(remote.id, {
      epoch: 1,
      id: randomUUID(),
      from: { session: remote.key },
      to: { address: 'agent' },
      text: 'question',
      origin: 'human',
      fromMode: null,
      hopChain: [],
      notifyWhenIdle: false,
      failureNotice: false,
    });
  const pending = await send();
  const job = (await getDb().get<{ id: string; content: string; hub_session: string; remote_id: string }>(
    'SELECT * FROM peer_inbound',
  ))!;
  await manager.writeSessionMessage('agent', job.hub_session, {
    id: 'peer-' + job.id,
    kind: 'chat',
    channelType: 'peer',
    platformId: job.remote_id,
    timestamp: new Date().toISOString(),
    content: job.content,
  });
  await closeDb();
  await runMigrations(await initDb(file));
  await drainInbound();
  await drainInbound();
  const inbox = new Database(inboundDbPath('agent', job.hub_session), { readonly: true });
  try {
    expect(inbox.prepare('SELECT count(*) AS n FROM messages_in').get()).toEqual({ n: 1 });
  } finally {
    inbox.close();
  }
  const failed = await send();
  const write = vi.spyOn(manager, 'writeSessionMessage').mockRejectedValueOnce(new Error('mailbox write failed'));
  try {
    await drainInbound();
  } finally {
    write.mockRestore();
  }
  const revoked = await send();
  await setMeshMembership('agent', false);
  await setMeshMembership('agent', true);
  await drainInbound();
  const events = await getDb().all<{ payload: string }>(
    "SELECT payload FROM peer_events WHERE kind='delivery' ORDER BY seq",
  );
  expect(events.map((e) => JSON.parse(e.payload))).toMatchObject([
    { id: pending.message.id, state: 'delivered', reason: null },
    { id: failed.message.id, state: 'dropped', reason: 'route_failed' },
    { id: revoked.message.id, state: 'dropped', reason: 'not_member' },
  ]);
});

it('counts both mesh agents through normal delivery, tells each side once, and resets on owner input to either group', async () => {
  const { routeAgentMessage } = await import('../../modules/agent-to-agent/agent-route.js');
  const { resetHops } = await import('./lifecycle.js');
  const now = new Date().toISOString();
  async function group(id: string) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now });
    await setMeshMembership(id, true);
    const session: Session = {
      id: 'sess-' + id,
      agent_group_id: id,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: now,
      created_at: now,
    };
    await createSession(session);
    return session;
  }
  const a = await group('sender'),
    b = await group('receiver');
  const send = (i: number) =>
    routeAgentMessage({ id: 'm' + i, in_reply_to: null, platform_id: b.agent_group_id, content: '{"text":"test"}' }, a);
  for (let i = 0; i < 22; i++) await send(i);
  await send(21);
  expect(await getDb().get('SELECT count(*) AS n FROM peer_agent_sends WHERE refused=1')).toEqual({ n: 2 });
  expect(await getDb().get('SELECT count(*) AS n FROM peer_inbound WHERE hub_session=?', a.id)).toEqual({ n: 2 });
  expect(await getDb().get('SELECT count(*) AS n FROM peer_inbound WHERE hub_session=?', b.id)).toEqual({ n: 1 });
  await createSession({ ...b, id: 'sess-owner-separate' });
  expect(await resetHops('sess-owner-separate')).toBe(1);
  await send(22);
  expect(await getDb().get('SELECT hops,limited FROM peer_conversations')).toEqual({ hops: 1, limited: 0 });
});
