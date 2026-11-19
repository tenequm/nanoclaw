import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { isMeshMember } from '../../channels/peer/store.js';
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
afterEach(closeDb);

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
  for (const command of ['peers-list', 'peers-add', 'peers-revoke', 'mesh-add', 'mesh-remove']) {
    const result = await dispatch(
      { id: 'test', command, args: {} },
      { caller: 'agent', sessionId: 's', messagingGroupId: 'm', agentGroupId: 'ag-test' },
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  }
});
