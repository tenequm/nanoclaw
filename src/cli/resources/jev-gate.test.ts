/**
 * `ncl jev-gate get|update` — the file-backed config resource and its guard.
 *
 * Runs through dispatch() so the guard decision, the group-scope rules, and the
 * JSON round-trip are all exercised on the real path. A host caller is the
 * operator at the 0600 socket; the agent caller is what a container sees.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-cli-jev-gate';

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-test-cli-jev-gate/data',
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { resetGateConfigCache } from '../../modules/jev-gate/index.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `jev-gate-*` commands.
import './jev-gate.js';

const GROUP = 'ag-dan';
const CONFIG_FILE = path.join(TEST_ROOT, 'data', 'jev-gate.json');

async function run(command: string, args: Record<string, unknown>, caller: 'host' | 'agent' = 'host') {
  return dispatch(
    { id: 'req-1', command, args },
    caller === 'host'
      ? { caller: 'host' }
      : { caller: 'agent', sessionId: 'sess-1', agentGroupId: GROUP, messagingGroupId: 'mg-1' },
  );
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_ROOT, 'data'), { recursive: true });
  resetGateConfigCache();
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: GROUP,
    name: 'Dan',
    folder: 'dan',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('jev-gate get', () => {
  it('reports the defaults with configured=false when nothing is set', async () => {
    const res = await run('jev-gate-get', { group: GROUP });
    expect(res.ok).toBe(true);
    const data = (res as { data: { configured: boolean; config: { enabled: boolean } } }).data;
    expect(data.configured).toBe(false);
    expect(data.config.enabled).toBe(false);
  });

  it('requires --group', async () => {
    const res = await run('jev-gate-get', {});
    expect(res.ok).toBe(false);
  });
});

describe('jev-gate update', () => {
  it('creates the entry, merging only the flags passed', async () => {
    await run('jev-gate-update', { group: GROUP, enabled: true, mode: 'shadow' });
    await run('jev-gate-update', { group: GROUP, 'daily-cap': 12 });

    const stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as Record<
      string,
      { enabled: boolean; mode: string; daily_cap: number; thresholds: Record<string, number> }
    >;
    expect(stored[GROUP].enabled).toBe(true);
    expect(stored[GROUP].mode).toBe('shadow');
    expect(stored[GROUP].daily_cap).toBe(12);
    expect(stored[GROUP].thresholds.direct_invitation).toBe(0.7);
  });

  it('merges thresholds field-by-field', async () => {
    await run('jev-gate-update', { group: GROUP, thresholds: '{"unresolved":0.45}' });
    const res = await run('jev-gate-get', { group: GROUP });
    const thresholds = (res as { data: { config: { thresholds: Record<string, number> } } }).data.config.thresholds;
    expect(thresholds.unresolved).toBe(0.45);
    expect(thresholds.already_answered).toBe(0.6);
  });

  it('rejects an unknown threshold and an out-of-range value', async () => {
    expect((await run('jev-gate-update', { group: GROUP, thresholds: '{"vibes":0.5}' })).ok).toBe(false);
    expect((await run('jev-gate-update', { group: GROUP, thresholds: '{"unresolved":7}' })).ok).toBe(false);
  });

  it('rejects a mode that is neither live nor shadow', async () => {
    expect((await run('jev-gate-update', { group: GROUP, mode: 'loud' })).ok).toBe(false);
  });

  it('rejects an unknown flag', async () => {
    expect((await run('jev-gate-update', { group: GROUP, 'daily-limit': 5 })).ok).toBe(false);
  });
});

describe('guard', () => {
  it('lets a group-scoped agent read its own gate', async () => {
    const res = await run('jev-gate-get', {}, 'agent');
    expect(res.ok).toBe(true);
    // dispatch auto-fills --group with the caller's own id.
    expect((res as { data: { agent_group_id: string } }).data.agent_group_id).toBe(GROUP);
  });

  it('denies a group-scoped agent reading another group', async () => {
    const res = await run('jev-gate-get', { group: 'ag-someone-else' }, 'agent');
    expect(res.ok).toBe(false);
    expect((res as { error: { code: string } }).error.code).toBe('forbidden');
  });

  it('holds an agent-initiated update for approval instead of applying it', async () => {
    const res = await run('jev-gate-update', { enabled: true, mode: 'live' }, 'agent');
    expect(res.ok).toBe(false);
    // Past the guard's deny and into the hold branch: the approval card needs a
    // real session, which this unit test doesn't stand up. Either way the
    // handler never ran, so nothing was written.
    expect((res as { error: { code: string } }).error.code).not.toBe('forbidden');
    expect(fs.existsSync(CONFIG_FILE)).toBe(false);
  });
});
