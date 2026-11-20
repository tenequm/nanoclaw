import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: `/tmp/nanoclaw-peer-directory-test-${process.pid}`,
}));
import { DATA_DIR } from '../../config.js';
import { startMeshProjection } from '../../channels/peer/directory.js';
import { createSession } from '../../db/sessions.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { initSessionFolder } from '../../session-manager.js';
import { isMeshMember, listPeers } from '../../channels/peer/store.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
import './peers.js';

const host = (command: string, args = {}) => dispatch({ id: 'test', command, args }, { caller: 'host' });

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'ag-test',
    name: 'Test Peer',
    folder: 'test-peer',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
});
afterEach(async () => {
  await closeDb();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

it('enrolls, lists, and revokes a test machine over the command dispatcher', async () => {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const added = await host('peers-add', {
    name: 'test',
    'public-key': publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
  });
  expect(added).toMatchObject({ ok: true, data: { id: expect.stringMatching(/^pm_/) } });
  if (!added.ok) throw new Error('Enrollment failed');
  const { id } = added.data as { id: string };
  expect(await host('peers-list')).toMatchObject({ ok: true, data: [{ id, revoked_at: null }] });
  expect(await host('peers-revoke-' + id)).toMatchObject({ ok: true, data: { id, status: 'revoked' } });
  expect(await host('peers-list')).toMatchObject({ ok: true, data: [{ id, revoked_at: expect.any(Number) }] });
});

it('toggles membership by group name or id and rejects container administration', async () => {
  expect(await host('mesh-add-test peer')).toMatchObject({ ok: true });
  expect(await isMeshMember('ag-test')).toBe(true);
  expect(await host('mesh-remove-ag-test')).toMatchObject({ ok: true });
  expect(await isMeshMember('ag-test')).toBe(false);
  for (const command of ['peers-list', 'peers-add', 'peers-revoke', 'mesh-add', 'mesh-update', 'mesh-remove']) {
    const result = await dispatch(
      { id: 'test', command, args: {} },
      { caller: 'agent', sessionId: 's', messagingGroupId: 'm', agentGroupId: 'ag-test' },
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  }
});

it('adds a normalized mesh address and preserves it on repeated add', async () => {
  const id = 'ag-test';
  expect(await host('mesh-add', { id, address: 'Lead.Team_2-' })).toMatchObject({ ok: true });
  expect(await host('mesh-add', { id })).toMatchObject({ ok: true });
  expect(await host('mesh-add', { id, address: 'lead.team_2' })).toMatchObject({ ok: true });
  expect(await host('mesh-add', { id, address: 'other' })).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('mesh update') },
  });
  expect(await listPeers()).toMatchObject([{ address: 'lead.team_2' }]);
});

it('refuses invalid or occupied mesh addresses without changing membership', async () => {
  await createAgentGroup({
    id: 'other',
    name: 'Test Peer',
    folder: 'other',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  const id = 'ag-test';
  expect(await host('mesh-update', { id, address: 'lead' })).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('member') },
  });
  expect(await host('mesh-update', { id })).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
  for (const address of ['', '.lead', 'lead role', '\u212Aey', 'lead@project', 'a'.repeat(41)]) {
    expect(await host('mesh-add', { id, address })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('Invalid') },
    });
  }
  expect(await isMeshMember(id)).toBe(false);
  expect(await host('mesh-add', { id })).toMatchObject({ ok: true });
  const conflict = { ok: false, error: { message: expect.stringContaining('already in use') } };
  expect(await host('mesh-add', { id: 'other', address: 'Test-Peer' })).toMatchObject(conflict);
  expect(await host('mesh-add', { id: 'other', address: 'lead' })).toMatchObject({ ok: true });
  expect(await host('mesh-update', { id, address: 'Lead' })).toMatchObject(conflict);
  expect(await host('mesh-update', { id, address: '!bad' })).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('Invalid') },
  });
  expect(await listPeers()).toMatchObject([{ address: 'lead' }, { address: 'test-peer' }]);
});

it('projects CLI membership changes into every active member session and clears them on removal', async () => {
  const now = new Date().toISOString();
  await createAgentGroup({ id: 'other', name: 'Other test', folder: 'other', agent_provider: null, created_at: now });
  const sessions = [
    ['ag-test', 'test-1'],
    ['ag-test', 'test-2'],
    ['other', 'test-3'],
  ] as const;
  for (const [group, id] of sessions) {
    await createSession({
      id,
      agent_group_id: group,
      messaging_group_id: null,
      thread_id: id,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now,
    });
    initSessionFolder(group, id);
  }
  const read = () =>
    sessions.map(([group, id]) => {
      const db = new Database(inboundDbPath(group, id), { readonly: true });
      try {
        return db.prepare('SELECT address FROM mesh_peers ORDER BY address').pluck().all();
      } finally {
        db.close();
      }
    });
  const controller = new AbortController();
  try {
    await startMeshProjection(controller.signal);
    await host('mesh-add-ag-test');
    await vi.waitFor(() => expect(read()).toEqual([['test-peer'], ['test-peer'], []]));
    await host('mesh-add-other');
    await vi.waitFor(() => expect(read()).toEqual(Array(3).fill(['other-test', 'test-peer'])));
    expect(await host('mesh-update', { id: 'ag-test', address: 'lead' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(read()).toEqual(Array(3).fill(['lead', 'other-test'])));
    await host('mesh-remove-ag-test');
    await vi.waitFor(() => expect(read()).toEqual([[], [], ['other-test']]));
  } finally {
    controller.abort();
  }
});
