/**
 * The host stamps the sender's nanoclaw role into inbound content
 * (`senderRole`), since the container cannot read user_roles.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { grantRole } from './modules/permissions/db/user-roles.js';
import { createUser } from './modules/permissions/db/users.js';
import { senderRoleFor, stampSenderRole } from './router.js';

const now = (): string => new Date().toISOString();

async function seedUser(id: string): Promise<void> {
  await createUser({ id, kind: 'telegram', display_name: id, created_at: now() });
}

async function grant(userId: string, role: 'owner' | 'admin', agentGroupId: string | null): Promise<void> {
  await grantRole({ user_id: userId, role, agent_group_id: agentGroupId, granted_by: null, granted_at: now() });
}

beforeEach(async () => {
  await runMigrations(await initTestDb());
  for (const id of ['ag-1', 'ag-2']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
  }
});

afterEach(async () => {
  await closeDb();
});

describe('senderRoleFor', () => {
  it('returns owner for a global owner, and owner wins over admin', async () => {
    await seedUser('telegram:1');
    await grant('telegram:1', 'admin', null);
    await grant('telegram:1', 'owner', null);
    expect(await senderRoleFor('telegram:1', 'ag-1')).toBe('owner');
  });

  it('returns admin for a global admin in any group', async () => {
    await seedUser('telegram:2');
    await grant('telegram:2', 'admin', null);
    expect(await senderRoleFor('telegram:2', 'ag-2')).toBe('admin');
  });

  it('applies a per-group admin only to that group', async () => {
    await seedUser('telegram:3');
    await grant('telegram:3', 'admin', 'ag-1');
    expect(await senderRoleFor('telegram:3', 'ag-1')).toBe('admin');
    expect(await senderRoleFor('telegram:3', 'ag-2')).toBeUndefined();
  });

  it('returns nothing for a sender without a role or without an id', async () => {
    await seedUser('telegram:4');
    expect(await senderRoleFor('telegram:4', 'ag-1')).toBeUndefined();
    expect(await senderRoleFor(null, 'ag-1')).toBeUndefined();
  });
});

describe('stampSenderRole', () => {
  it('adds senderRole as a top-level key', () => {
    expect(JSON.parse(stampSenderRole(JSON.stringify({ text: 'hi', senderId: 'telegram:1' }), 'owner'))).toEqual({
      text: 'hi',
      senderId: 'telegram:1',
      senderRole: 'owner',
    });
  });

  it('leaves content without a role byte-identical', () => {
    const raw = '{"text":"hi"}';
    expect(stampSenderRole(raw, undefined)).toBe(raw);
    expect(stampSenderRole('not json', 'admin')).toBe('not json');
  });

  it('drops a senderRole the adapter passed through', () => {
    expect(JSON.parse(stampSenderRole(JSON.stringify({ text: 'hi', senderRole: 'owner' }), undefined))).toEqual({
      text: 'hi',
    });
    expect(JSON.parse(stampSenderRole(JSON.stringify({ senderRole: 'owner' }), 'admin'))).toEqual({
      senderRole: 'admin',
    });
  });
});
