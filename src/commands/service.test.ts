import fs from 'fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks: container primitives must never spawn/kill real containers ---

vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockIsContainerRunning = vi.fn<(id: string) => boolean>(() => false);
const mockKillContainer = vi.fn<(id: string, reason: string, onExit?: () => void) => void>();
vi.mock('../container-runner.js', () => ({
  isContainerRunning: (...args: unknown[]) => mockIsContainerRunning(args[0] as string),
  killContainer: (...args: unknown[]) =>
    mockKillContainer(args[0] as string, args[1] as string, args[2] as (() => void) | undefined),
}));

const mockRestartAgentGroupContainers = vi.fn<(id: string, reason: string, wake?: string) => Promise<number>>(
  async () => 0,
);
vi.mock('../container-restart.js', () => ({
  restartAgentGroupContainers: (...args: unknown[]) =>
    mockRestartAgentGroupContainers(args[0] as string, args[1] as string, args[2] as string | undefined),
}));

// Isolate transcript reads (sessionsBaseDir) into the test dir.
vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-commands' };
});

import { closeDb, initTestDb } from '../db/connection.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from '../db/container-configs.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../db/messaging-groups.js';
import { createSession } from '../db/sessions.js';
import { runMigrations } from '../db/migrations/index.js';
import { grantRole } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import type { MessagingGroupAgent, Session } from '../types.js';
import { getMessagingGroupAgentByPair } from '../db/messaging-groups.js';
import {
  getConfigView,
  getModelPicker,
  getStatus,
  resolveTargets,
  restartAgent,
  setActivation,
  setConfigValue,
  setModel,
} from './service.js';

const OWNER = 'telegram:1';
const NON_ADMIN = 'telegram:2';
const SCOPED_ADMIN = 'telegram:3';

const TEST_DIR = '/tmp/nanoclaw-test-commands';

function now() {
  return new Date().toISOString();
}

async function makeUser(id: string) {
  await upsertUser({ id, kind: 'telegram', display_name: null, created_at: now() });
}

async function makeAgentGroup(id: string, name: string) {
  await createAgentGroup({ id, name, folder: id, agent_provider: null, created_at: now() });
  await ensureContainerConfig(id);
}

async function makeSession(id: string, agentGroupId: string, status: Session['status'] = 'active') {
  await createSession({
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status,
    container_status: 'idle',
    last_active: null,
    created_at: now(),
  });
}

async function wire(mgId: string, agentGroupId: string, priority = 0) {
  const mga: MessagingGroupAgent = {
    id: `mga-${mgId}-${agentGroupId}`,
    messaging_group_id: mgId,
    agent_group_id: agentGroupId,
    engage_mode: 'mention-sticky',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
    priority,
    created_at: now(),
  };
  await createMessagingGroupAgent(mga);
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  vi.clearAllMocks();
  mockIsContainerRunning.mockReturnValue(false);
  mockRestartAgentGroupContainers.mockResolvedValue(0);
  await makeUser(OWNER);
  await makeUser(NON_ADMIN);
  await makeUser(SCOPED_ADMIN);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

// --- resolveTargets ---

describe('resolveTargets', () => {
  it('returns none for an unwired messaging group', async () => {
    await createMessagingGroup({
      id: 'mg-none',
      channel_type: 'telegram',
      platform_id: 'telegram:-100',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    expect(await resolveTargets('mg-none')).toEqual({ kind: 'none' });
  });

  it('returns single for one wired agent', async () => {
    await makeAgentGroup('ag-1', 'Emma');
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'telegram',
      platform_id: 'telegram:-101',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await wire('mg-1', 'ag-1');
    expect(await resolveTargets('mg-1')).toEqual({
      kind: 'single',
      agent: { agentGroupId: 'ag-1', agentName: 'Emma' },
    });
  });

  it('sorts multiple agents deterministically by name then id, regardless of wiring order', async () => {
    // Insert in a non-sorted order and with priorities that would flip a
    // priority-based sort, to prove the sort is name-based and stable.
    await makeAgentGroup('ag-z', 'Zoe');
    await makeAgentGroup('ag-a', 'Aaron');
    await makeAgentGroup('ag-m', 'Aaron'); // duplicate name -> id breaks the tie
    await createMessagingGroup({
      id: 'mg-multi',
      channel_type: 'telegram',
      platform_id: 'telegram:-102',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await wire('mg-multi', 'ag-z', 100);
    await wire('mg-multi', 'ag-m', 5);
    await wire('mg-multi', 'ag-a', 50);

    const res = await resolveTargets('mg-multi');
    expect(res.kind).toBe('multiple');
    if (res.kind !== 'multiple') throw new Error('expected multiple');
    expect(res.agents.map((a) => a.agentGroupId)).toEqual(['ag-a', 'ag-m', 'ag-z']);
  });
});

// --- getStatus (member-runnable read) ---

describe('getStatus', () => {
  it('fails with unknown-agent when the group does not exist', async () => {
    expect(await getStatus('nope')).toEqual({ ok: false, reason: 'unknown-agent' });
  });

  it('returns a view with model label, running state, and active session count', async () => {
    await makeAgentGroup('ag-1', 'Emma');
    await updateContainerConfigScalars('ag-1', {
      model: 'claude-opus-5',
      effort: 'high',
      auto_compact_window: 400000,
      provider: 'claude',
    });
    await makeSession('s-active', 'ag-1', 'active');
    await makeSession('s-closed', 'ag-1', 'closed');
    mockIsContainerRunning.mockImplementation((id) => id === 's-active');

    const res = await getStatus('ag-1');
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.view).toMatchObject({
      agentName: 'Emma',
      agentGroupId: 'ag-1',
      model: 'claude-opus-5',
      modelLabel: 'Opus 5',
      effort: 'high',
      autoCompactWindow: 400000,
      contextWindow: 400000,
      provider: 'claude',
      cliScope: 'group',
      sessionCount: 1,
    });
    // containerRunning was removed from StatusView.
    expect('containerRunning' in res.view).toBe(false);
  });

  it('falls back to the 165k provider default for contextWindow when unset', async () => {
    await makeAgentGroup('ag-1', 'Emma');
    const res = await getStatus('ag-1');
    if (!res.ok) throw new Error('expected ok');
    expect(res.view.autoCompactWindow).toBeNull();
    expect(res.view.contextWindow).toBe(165000);
  });

  it('reflects the chat wiring activation when a chat context is supplied', async () => {
    await makeAgentGroup('ag-1', 'Emma');
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'telegram',
      platform_id: 'telegram:-101',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await wire('mg-1', 'ag-1');
    const res = await getStatus('ag-1', { messagingGroupId: 'mg-1', threadId: null });
    if (!res.ok) throw new Error('expected ok');
    expect(res.view.activation).toEqual({
      engageMode: 'mention-sticky',
      engagePattern: null,
      senderScope: 'all',
    });
  });
});

// --- getModelPicker / getConfigView reads ---

describe('getModelPicker', () => {
  it('marks the current model active', async () => {
    await makeAgentGroup('ag-1', 'Emma');
    await updateContainerConfigScalars('ag-1', { model: 'claude-fable-5-1' });
    const res = await getModelPicker('ag-1');
    if (!res.ok) throw new Error('expected ok');
    expect(res.view.current).toEqual({ id: 'claude-fable-5-1', label: 'Fable 5.1' });
    expect(res.view.options.find((o) => o.id === 'claude-fable-5-1')?.active).toBe(true);
    expect(res.view.options.filter((o) => o.active)).toHaveLength(1);
  });
});

describe('getConfigView', () => {
  it('exposes current scalars plus the option catalogs', async () => {
    await makeAgentGroup('ag-1', 'Emma');
    await updateContainerConfigScalars('ag-1', { model: 'claude-sonnet-5', effort: 'medium' });
    const res = await getConfigView('ag-1');
    if (!res.ok) throw new Error('expected ok');
    expect(res.view.model).toEqual({ id: 'claude-sonnet-5', label: 'Sonnet 5' });
    expect(res.view.effort).toBe('medium');
    expect(res.view.effortOptions).toContain('xhigh');
    expect(res.view.compactWindowPresets).toContain(165000);
  });
});

// --- setModel ---

describe('setModel', () => {
  beforeEach(async () => {
    await makeAgentGroup('ag-1', 'Emma');
    await grantRole({ user_id: OWNER, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  });

  it('denies a non-admin actor', async () => {
    const res = await setModel('ag-1', 'opus', NON_ADMIN);
    expect(res).toEqual({ ok: false, reason: 'unauthorized' });
    expect((await getContainerConfig('ag-1'))?.model).toBeNull();
    expect(mockKillContainer).not.toHaveBeenCalled();
  });

  it('rejects an invalid model with allowed aliases', async () => {
    const res = await setModel('ag-1', 'not a model', OWNER);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.reason).toBe('invalid-value');
    expect(res.detail?.field).toBe('model');
    expect(res.detail?.allowed).toEqual(['sonnet', 'opus', 'fable']);
  });

  it('writes the resolved id and returns old/new labels', async () => {
    await updateContainerConfigScalars('ag-1', { model: 'claude-sonnet-5' });
    const res = await setModel('ag-1', 'opus', OWNER);
    if (!res.ok) throw new Error('expected ok');
    expect(res.view.previous).toEqual({ id: 'claude-sonnet-5', label: 'Sonnet 5' });
    expect(res.view.current).toEqual({ id: 'claude-opus-5', label: 'Opus 5' });
    expect((await getContainerConfig('ag-1'))?.model).toBe('claude-opus-5');
  });

  it('instant-kills running containers with NO respawn (lazy)', async () => {
    await makeSession('s1', 'ag-1', 'active');
    await makeSession('s2', 'ag-1', 'active');
    mockIsContainerRunning.mockReturnValue(true);

    const res = await setModel('ag-1', 'fable', OWNER);
    if (!res.ok) throw new Error('expected ok');
    expect(res.view.containersKilled).toBe(2);
    expect(mockKillContainer).toHaveBeenCalledTimes(2);
    // Lazy: killContainer must be called without an onExit respawn callback.
    for (const call of mockKillContainer.mock.calls) {
      expect(call[2]).toBeUndefined();
    }
    expect(mockRestartAgentGroupContainers).not.toHaveBeenCalled();
  });

  it('does NOT kill containers when the model is unchanged', async () => {
    // The /model menu shows the current model as a tappable row, so re-picking
    // it is a normal misclick. Killing on a no-op destroyed the in-flight turn
    // (and its subagents) for no config change at all.
    await updateContainerConfigScalars('ag-1', { model: 'claude-opus-5' });
    await makeSession('s1', 'ag-1', 'active');
    mockIsContainerRunning.mockReturnValue(true);

    const res = await setModel('ag-1', 'opus', OWNER);
    if (!res.ok) throw new Error('expected ok');
    expect(res.view.current.id).toBe('claude-opus-5');
    expect(res.view.containersKilled).toBe(0);
    expect(mockKillContainer).not.toHaveBeenCalled();
  });

  it('DOES kill when moving off the inherited default to an explicit id', async () => {
    // Stored null means "inherit"; pinning it is a real change even when the
    // effective model is identical, because the container reads the stored value.
    expect((await getContainerConfig('ag-1'))?.model ?? null).toBeNull();
    await makeSession('s1', 'ag-1', 'active');
    mockIsContainerRunning.mockReturnValue(true);

    const res = await setModel('ag-1', 'opus', OWNER);
    if (!res.ok) throw new Error('expected ok');
    expect(res.view.containersKilled).toBe(1);
  });

  it('honors a scoped admin over the target group', async () => {
    await grantRole({
      user_id: SCOPED_ADMIN,
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: OWNER,
      granted_at: now(),
    });
    const res = await setModel('ag-1', 'opus', SCOPED_ADMIN);
    expect(res.ok).toBe(true);
  });

  it('a scoped admin of a different group is denied', async () => {
    await makeAgentGroup('ag-2', 'Stan');
    await grantRole({
      user_id: SCOPED_ADMIN,
      role: 'admin',
      agent_group_id: 'ag-2',
      granted_by: OWNER,
      granted_at: now(),
    });
    const res = await setModel('ag-1', 'opus', SCOPED_ADMIN);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.reason).toBe('unauthorized');
  });
});

// --- setConfigValue ---

describe('setConfigValue', () => {
  beforeEach(async () => {
    await makeAgentGroup('ag-1', 'Emma');
    await grantRole({ user_id: OWNER, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  });

  it('denies a non-admin actor for every field', async () => {
    expect((await setConfigValue('ag-1', 'effort', 'high', NON_ADMIN)).ok).toBe(false);
    expect((await setConfigValue('ag-1', 'model', 'opus', NON_ADMIN)).ok).toBe(false);
    expect(mockKillContainer).not.toHaveBeenCalled();
  });

  it('validates effort against the level enum', async () => {
    const good = await setConfigValue('ag-1', 'effort', 'xhigh', OWNER);
    if (!good.ok) throw new Error('expected ok');
    expect(good.view.current).toBe('xhigh');
    expect((await getContainerConfig('ag-1'))?.effort).toBe('xhigh');

    const bad = await setConfigValue('ag-1', 'effort', 'ultra', OWNER);
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('expected failure');
    expect(bad.reason).toBe('invalid-value');
    expect(bad.detail?.allowed).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('validates auto-compact-window as a positive integer (ncl rule)', async () => {
    const good = await setConfigValue('ag-1', 'auto-compact-window', '600000', OWNER);
    if (!good.ok) throw new Error('expected ok');
    expect(good.view.current).toBe(600000);
    expect((await getContainerConfig('ag-1'))?.auto_compact_window).toBe(600000);

    expect((await setConfigValue('ag-1', 'auto-compact-window', '0', OWNER)).ok).toBe(false);
    expect((await setConfigValue('ag-1', 'auto-compact-window', '1.5', OWNER)).ok).toBe(false);
    expect((await setConfigValue('ag-1', 'auto-compact-window', 'lots', OWNER)).ok).toBe(false);
  });

  it('validates max-messages-per-prompt as a positive integer', async () => {
    const good = await setConfigValue('ag-1', 'max-messages-per-prompt', '10', OWNER);
    if (!good.ok) throw new Error('expected ok');
    expect(good.view.current).toBe(10);
    expect((await getContainerConfig('ag-1'))?.max_messages_per_prompt).toBe(10);
    expect((await setConfigValue('ag-1', 'max-messages-per-prompt', '-3', OWNER)).ok).toBe(false);
  });

  it('model field returns friendly labels for previous/current', async () => {
    await updateContainerConfigScalars('ag-1', { model: 'claude-fable-5-1' });
    const res = await setConfigValue('ag-1', 'model', 'opus', OWNER);
    if (!res.ok) throw new Error('expected ok');
    expect(res.view.previousLabel).toBe('Fable 5.1');
    expect(res.view.currentLabel).toBe('Opus 5');
    expect(res.view.current).toBe('claude-opus-5');
  });

  it('instant-kills running containers with no respawn', async () => {
    await makeSession('s1', 'ag-1', 'active');
    mockIsContainerRunning.mockReturnValue(true);
    const res = await setConfigValue('ag-1', 'effort', 'low', OWNER);
    if (!res.ok) throw new Error('expected ok');
    expect(res.view.containersKilled).toBe(1);
    expect(mockKillContainer).toHaveBeenCalledWith('s1', expect.any(String), undefined);
    expect(mockRestartAgentGroupContainers).not.toHaveBeenCalled();
  });

  it('does NOT kill containers when the value is unchanged', async () => {
    await updateContainerConfigScalars('ag-1', { effort: 'high' });
    await makeSession('s1', 'ag-1', 'active');
    mockIsContainerRunning.mockReturnValue(true);

    const res = await setConfigValue('ag-1', 'effort', 'high', OWNER);
    if (!res.ok) throw new Error('expected ok');
    expect(res.view.current).toBe('high');
    expect(res.view.containersKilled).toBe(0);
    expect(mockKillContainer).not.toHaveBeenCalled();
  });
});

// --- setActivation ---

describe('setActivation', () => {
  beforeEach(async () => {
    await makeAgentGroup('ag-1', 'Emma');
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'telegram',
      platform_id: 'telegram:-101',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await wire('mg-1', 'ag-1');
    await grantRole({ user_id: OWNER, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  });

  it('denies a non-admin actor and never touches the wiring', async () => {
    const res = await setActivation('mg-1', 'ag-1', 'mention', null, NON_ADMIN);
    expect(res).toEqual({ ok: false, reason: 'unauthorized' });
    expect((await getMessagingGroupAgentByPair('mg-1', 'ag-1'))?.engage_mode).toBe('mention-sticky');
  });

  it('writes a non-pattern mode and nulls the pattern (no container kill)', async () => {
    const res = await setActivation('mg-1', 'ag-1', 'mention', null, OWNER);
    if (!res.ok) throw new Error('expected ok');
    expect(res.view).toEqual({ agentName: 'Emma', agentGroupId: 'ag-1', mode: 'mention', pattern: null });
    const w = await getMessagingGroupAgentByPair('mg-1', 'ag-1');
    expect(w?.engage_mode).toBe('mention');
    expect(w?.engage_pattern).toBeNull();
    expect(mockKillContainer).not.toHaveBeenCalled();
  });

  it('writes a valid pattern and stores its source', async () => {
    const res = await setActivation('mg-1', 'ag-1', 'pattern', '^deploy\\b', OWNER);
    if (!res.ok) throw new Error('expected ok');
    expect(res.view).toEqual({ agentName: 'Emma', agentGroupId: 'ag-1', mode: 'pattern', pattern: '^deploy\\b' });
    const w = await getMessagingGroupAgentByPair('mg-1', 'ag-1');
    expect(w?.engage_mode).toBe('pattern');
    expect(w?.engage_pattern).toBe('^deploy\\b');
  });

  it('rejects an invalid regex with the compile error in detail', async () => {
    const res = await setActivation('mg-1', 'ag-1', 'pattern', '(unclosed', OWNER);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.reason).toBe('invalid-value');
    expect(res.detail?.field).toBe('pattern');
    expect(typeof res.detail?.message).toBe('string');
    expect((res.detail?.message ?? '').length).toBeGreaterThan(0);
  });

  it('rejects an empty pattern for pattern mode', async () => {
    const res = await setActivation('mg-1', 'ag-1', 'pattern', '   ', OWNER);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected failure');
    expect(res.reason).toBe('invalid-value');
    expect(res.detail?.field).toBe('pattern');
  });
});

// --- restartAgent ---

describe('restartAgent', () => {
  beforeEach(async () => {
    await makeAgentGroup('ag-1', 'Emma');
    await grantRole({ user_id: OWNER, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  });

  it('denies a non-admin actor', async () => {
    expect((await restartAgent('ag-1', NON_ADMIN)).ok).toBe(false);
    expect(mockRestartAgentGroupContainers).not.toHaveBeenCalled();
  });

  it('restarts with a wake message (immediate respawn) and returns the count', async () => {
    mockRestartAgentGroupContainers.mockResolvedValue(2);
    const res = await restartAgent('ag-1', OWNER);
    if (!res.ok) throw new Error('expected ok');
    expect(res.view.restarted).toBe(2);
    expect(mockRestartAgentGroupContainers).toHaveBeenCalledTimes(1);
    const [id, , wake] = mockRestartAgentGroupContainers.mock.calls[0];
    expect(id).toBe('ag-1');
    expect(typeof wake).toBe('string');
    expect((wake as string).length).toBeGreaterThan(0);
  });
});
