import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initTestDb, runMigrations, getDb, closeDb, createAgentGroup } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { DATA_DIR } from '../../config.js';
import type { Session } from '../../types.js';
import { registerSession, setMeshMembership, enrollMachine } from './store.js';
import { routeAgentPeer, sendRemote } from './routing.js';

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
  await routeAgentPeer(session, {
    id: 'ask',
    platformId: remote.address,
    content: JSON.stringify({ text: 'question' }),
  });
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
