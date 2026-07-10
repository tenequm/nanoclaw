/**
 * Tests for the host-side command gate — filtered commands are dropped
 * before reaching the container, and admin commands are gated against
 * the user_roles table.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gateCommand } from './command-gate.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { createUser } from './modules/permissions/db/users.js';
import { grantRole } from './modules/permissions/db/user-roles.js';

function now(): string {
  return new Date().toISOString();
}

function seedAgentGroup(id: string): void {
  createAgentGroup({ id, name: id.toUpperCase(), folder: id, agent_provider: null, created_at: now() });
}

function seedUser(id: string): void {
  createUser({ id, kind: 'telegram', display_name: null, created_at: now() });
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  seedAgentGroup('ag-1');
  seedAgentGroup('ag-2');
});

afterEach(() => {
  closeDb();
});

describe('filtered commands', () => {
  it('drops /start before it reaches the container', () => {
    expect(gateCommand('/start', 'telegram:1', 'ag-1')).toEqual({ action: 'filter' });
  });

  it('drops /start regardless of sender', () => {
    expect(gateCommand('/start', null, 'ag-1')).toEqual({ action: 'filter' });
  });
});

describe('admin gating goes through roles', () => {
  it('denies an admin command from a non-admin user', () => {
    expect(gateCommand('/clear', 'telegram:nobody', 'ag-1')).toEqual({ action: 'deny', command: '/clear' });
  });

  it('denies an admin command with no sender', () => {
    expect(gateCommand('/clear', null, 'ag-1')).toEqual({ action: 'deny', command: '/clear' });
  });

  it('allows an admin command from an owner', () => {
    seedUser('telegram:owner');
    grantRole({ user_id: 'telegram:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    expect(gateCommand('/clear', 'telegram:owner', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('allows an admin command from a scoped admin of the group', () => {
    seedUser('telegram:admin');
    grantRole({
      user_id: 'telegram:admin',
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: null,
      granted_at: now(),
    });
    expect(gateCommand('/clear', 'telegram:admin', 'ag-1')).toEqual({ action: 'pass' });
    expect(gateCommand('/clear', 'telegram:admin', 'ag-2')).toEqual({ action: 'deny', command: '/clear' });
  });
});

describe('normal messages pass through', () => {
  it('passes a plain message', () => {
    expect(gateCommand('hello there', 'telegram:1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('passes an unknown slash command', () => {
    expect(gateCommand('/whatever', 'telegram:1', 'ag-1')).toEqual({ action: 'pass' });
  });
});

describe('host commands are claimed for the host', () => {
  it('classifies /status', () => {
    expect(gateCommand('/status', 'telegram:1', 'ag-1')).toEqual({ action: 'host', command: 'status', args: '' });
  });

  it('classifies bare /model', () => {
    expect(gateCommand('/model', 'telegram:1', 'ag-1')).toEqual({ action: 'host', command: 'model', args: '' });
  });

  it('classifies /model with an argument', () => {
    expect(gateCommand('/model opus', 'telegram:1', 'ag-1')).toEqual({
      action: 'host',
      command: 'model',
      args: 'opus',
    });
  });

  it('classifies /config (no longer filtered)', () => {
    expect(gateCommand('/config', 'telegram:1', 'ag-1')).toEqual({ action: 'host', command: 'config', args: '' });
  });

  it('classifies /config set with a multi-word argument', () => {
    expect(gateCommand('/config set effort high', 'telegram:1', 'ag-1')).toEqual({
      action: 'host',
      command: 'config',
      args: 'set effort high',
    });
  });

  it('classifies /restart', () => {
    expect(gateCommand('/restart', 'telegram:1', 'ag-1')).toEqual({ action: 'host', command: 'restart', args: '' });
  });

  it('strips the @botname suffix', () => {
    expect(gateCommand('/model@opx_cc_bl_bot', 'telegram:1', 'ag-1')).toEqual({
      action: 'host',
      command: 'model',
      args: '',
    });
  });

  it('strips the @botname suffix and keeps args', () => {
    expect(gateCommand('/model@opx_cc_bl_bot sonnet', 'telegram:1', 'ag-1')).toEqual({
      action: 'host',
      command: 'model',
      args: 'sonnet',
    });
  });

  it('is case-insensitive on the command token', () => {
    expect(gateCommand('/STATUS', 'telegram:1', 'ag-1')).toEqual({ action: 'host', command: 'status', args: '' });
  });

  it('classifies a host command regardless of sender (auth is enforced later)', () => {
    expect(gateCommand('/model opus', null, 'ag-1')).toEqual({ action: 'host', command: 'model', args: 'opus' });
  });

  it('classifies host commands wrapped in a JSON content envelope', () => {
    expect(gateCommand(JSON.stringify({ text: '/status' }), 'telegram:1', 'ag-1')).toEqual({
      action: 'host',
      command: 'status',
      args: '',
    });
  });
});
