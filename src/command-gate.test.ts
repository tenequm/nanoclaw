/**
 * Tests for the host-side command gate: filtered commands are dropped
 * before reaching the container, admin commands are gated against the
 * user_roles table, the four host commands classify for host execution
 * regardless of sender (auth lives in the command service), and the
 * bang prefix / alias rewrite normalizes to canonical slash commands.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyNormalizedText, classifyHostCommand, gateCommand } from './command-gate.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { createUser } from './modules/permissions/db/users.js';
import { grantRole } from './modules/permissions/db/user-roles.js';

function now(): string {
  return new Date().toISOString();
}

async function seedAgentGroup(id: string): Promise<void> {
  await createAgentGroup({ id, name: id.toUpperCase(), folder: id, agent_provider: null, created_at: now() });
}

async function seedUser(id: string): Promise<void> {
  await createUser({ id, kind: 'telegram', display_name: null, created_at: now() });
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  await seedAgentGroup('ag-1');
  await seedAgentGroup('ag-2');
});

afterEach(async () => {
  await closeDb();
});

describe('filtered commands', () => {
  it('drops /start before it reaches the container', async () => {
    expect(await gateCommand('/start', 'telegram:1', 'ag-1')).toEqual({ action: 'filter' });
  });

  it('drops /start regardless of sender', async () => {
    expect(await gateCommand('/start', null, 'ag-1')).toEqual({ action: 'filter' });
  });
});

describe('admin gating goes through roles', () => {
  it('denies an admin command from a non-admin user', async () => {
    expect(await gateCommand('/clear', 'telegram:nobody', 'ag-1')).toEqual({ action: 'deny', command: '/clear' });
  });

  it('denies an admin command with no sender', async () => {
    expect(await gateCommand('/clear', null, 'ag-1')).toEqual({ action: 'deny', command: '/clear' });
  });

  it('allows an admin command from an owner', async () => {
    await seedUser('telegram:owner');
    await grantRole({
      user_id: 'telegram:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    expect(await gateCommand('/clear', 'telegram:owner', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('allows an admin command from a scoped admin of the group', async () => {
    await seedUser('telegram:admin');
    await grantRole({
      user_id: 'telegram:admin',
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: null,
      granted_at: now(),
    });
    expect(await gateCommand('/clear', 'telegram:admin', 'ag-1')).toEqual({ action: 'pass' });
    expect(await gateCommand('/clear', 'telegram:admin', 'ag-2')).toEqual({ action: 'deny', command: '/clear' });
  });
});

describe('normal messages pass through', () => {
  it('passes a plain message', async () => {
    expect(await gateCommand('hello there', 'telegram:1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('passes an unknown slash command', async () => {
    expect(await gateCommand('/whatever', 'telegram:1', 'ag-1')).toEqual({ action: 'pass' });
  });
});

async function seedOwner(id: string): Promise<void> {
  await seedUser(id);
  await grantRole({ user_id: id, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
}

describe('bang prefix on slack', () => {
  it('rewrites a known !command to the canonical slash command', async () => {
    await seedOwner('slack:owner');
    expect(await gateCommand('!compact', 'slack:owner', 'ag-1', 'slack')).toEqual({
      action: 'pass',
      normalizedText: '/compact',
    });
  });

  it('carries the rewritten text with its arguments', async () => {
    await seedOwner('slack:owner');
    const content = JSON.stringify({ text: '!compact focus on the deploy', author: { userId: 'U1' }, id: 'm1' });
    expect(await gateCommand(content, 'slack:owner', 'ag-1', 'slack')).toEqual({
      action: 'pass',
      normalizedText: '/compact focus on the deploy',
    });
  });

  it('ignores ! on channels without the bang prefix', async () => {
    await seedOwner('telegram:owner');
    expect(await gateCommand('!compact', 'telegram:owner', 'ag-1', 'telegram')).toEqual({ action: 'pass' });
  });

  it('leaves an unknown !word untouched (! is common in prose)', async () => {
    expect(await gateCommand('!foo bar', 'slack:1', 'ag-1', 'slack')).toEqual({ action: 'pass' });
    expect(await gateCommand('!!! urgent', 'slack:1', 'ag-1', 'slack')).toEqual({ action: 'pass' });
  });

  it('admin-gates a bang command exactly like its slash form', async () => {
    expect(await gateCommand('!clear', 'slack:nobody', 'ag-1', 'slack')).toEqual({
      action: 'deny',
      command: '/clear',
    });
  });
});

describe('/new alias', () => {
  it('rewrites /new to /clear for an admin on any channel', async () => {
    await seedOwner('telegram:owner');
    expect(await gateCommand('/new', 'telegram:owner', 'ag-1', 'telegram')).toEqual({
      action: 'pass',
      normalizedText: '/clear',
    });
  });

  it('rewrites !new to /clear on slack', async () => {
    await seedOwner('slack:owner');
    expect(await gateCommand('!new', 'slack:owner', 'ag-1', 'slack')).toEqual({
      action: 'pass',
      normalizedText: '/clear',
    });
  });

  it('denies /new from a non-admin', async () => {
    expect(await gateCommand('/new', 'telegram:nobody', 'ag-1', 'telegram')).toEqual({
      action: 'deny',
      command: '/clear',
    });
  });
});

describe('host commands', () => {
  it('claims /status for ANY sender (auth is decided in the command service)', async () => {
    expect(await gateCommand('/status', 'telegram:anyone', 'ag-1', 'telegram')).toEqual({
      action: 'host',
      command: 'status',
      args: '',
    });
    expect(await gateCommand('/status', null, 'ag-1', 'telegram')).toEqual({
      action: 'host',
      command: 'status',
      args: '',
    });
  });

  it('normalizes !status on slack into the host claim', async () => {
    expect(await gateCommand('!status', 'slack:anyone', 'ag-1', 'slack')).toEqual({
      action: 'host',
      command: 'status',
      args: '',
    });
  });

  it('carries the argument text for /model', async () => {
    expect(await gateCommand('!model claude-opus-5', 'slack:nobody', 'ag-1', 'slack')).toEqual({
      action: 'host',
      command: 'model',
      args: 'claude-opus-5',
    });
  });

  it('claims /config and /restart', async () => {
    expect(await gateCommand('/config set effort high', 'telegram:1', 'ag-1', 'telegram')).toEqual({
      action: 'host',
      command: 'config',
      args: 'set effort high',
    });
    expect(await gateCommand('/restart', 'telegram:1', 'ag-1', 'telegram')).toEqual({
      action: 'host',
      command: 'restart',
      args: '',
    });
  });

  it('strips a Telegram @botname suffix before matching', async () => {
    expect(await gateCommand('/model@opx_cc_bl_bot opus', 'telegram:1', 'ag-1', 'telegram')).toEqual({
      action: 'host',
      command: 'model',
      args: 'opus',
    });
  });
});

describe('classifyHostCommand (router 3b entry)', () => {
  it('classifies from a chat-sdk JSON envelope', () => {
    const content = JSON.stringify({ text: '/status', author: { userId: 'U1' }, id: 'm1' });
    expect(classifyHostCommand(content, 'telegram')).toEqual({ command: 'status', args: '' });
  });

  it('classifies a slack bang command with args', () => {
    expect(classifyHostCommand('!model fable', 'slack')).toEqual({ command: 'model', args: 'fable' });
  });

  it('returns null for non-host commands and plain text', () => {
    expect(classifyHostCommand('/clear', 'telegram')).toBeNull();
    expect(classifyHostCommand('hello', 'telegram')).toBeNull();
    expect(classifyHostCommand('!status', 'telegram')).toBeNull();
  });
});

describe('applyNormalizedText', () => {
  it('preserves chat-sdk JSON structure, replacing only the text', () => {
    const content = JSON.stringify({ text: '!compact now', author: { userId: 'U1' }, id: 'm1', attachments: [1] });
    expect(JSON.parse(applyNormalizedText(content, '/compact now'))).toEqual({
      text: '/compact now',
      author: { userId: 'U1' },
      id: 'm1',
      attachments: [1],
    });
  });

  it('returns the normalized text for plain (non-JSON) content', () => {
    expect(applyNormalizedText('!compact', '/compact')).toBe('/compact');
  });

  it('leaves JSON without a text field untouched', () => {
    const content = JSON.stringify({ files: ['a'] });
    expect(applyNormalizedText(content, '/compact')).toBe(content);
  });
});
