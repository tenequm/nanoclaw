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
  await sendRemote(remote.id, reply, 'retry-hash');
  await sendRemote(remote.id, reply, 'retry-hash');
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
  const result = await sendRemote(remote.id, start, 'first');
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
  const stopped = { ...start, id: randomUUID() };
  await expect(sendRemote(remote.id, stopped, 'stopped')).rejects.toMatchObject({ body: { error: 'hop_limit' } });
  await expect(sendRemote(remote.id, stopped, 'stopped')).rejects.toMatchObject({ body: { error: 'hop_limit' } });
  expect(await getDb().get("SELECT COUNT(*) AS n FROM peer_events WHERE kind='limit'")).toEqual({ n: 1 });
  expect(await resetHops(hub.id)).toBe(1);
  const next = await sendRemote(remote.id, { ...start, id: randomUUID() }, 'new');
  expect(next.message.hop.count).toBe(1);
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
