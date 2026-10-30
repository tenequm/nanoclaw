/**
 * dispatch_workflow end to end through the real registries: system action →
 * precheck → guard hold → owner card → click → guarded replay → GitHub call.
 * Real central DB; the delivery adapter records cards, fetch is stubbed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getPendingApprovalsByAction } from '../../db/sessions.js';
import { getDeliveryAction, setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import { handleApprovalsResponse } from '../approvals/response-handler.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole, revokeRole } from '../permissions/db/user-roles.js';
import type { Session } from '../../types.js';
import './index.js';

const TEST_DIR = '/tmp/nanoclaw-test-workflow-dispatch';
const TOKEN = 'ghs_test-token-value-0123456789';

const envValues = vi.hoisted((): Record<string, string> => ({}));
vi.mock('../../env.js', () => ({
  readEnvFile: (keys: string[]) => Object.fromEntries(keys.filter((k) => envValues[k]).map((k) => [k, envValues[k]])),
}));
vi.mock('../../container-runner.js', () => ({ wakeContainer: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../config.js', async () => ({
  ...(await vi.importActual('../../config.js')),
  DATA_DIR: '/tmp/nanoclaw-test-workflow-dispatch',
}));
vi.mock('../../session-manager.js', async () => ({
  ...(await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js')),
  writeSessionMessage: vi.fn(),
}));
vi.mock('../../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn() }));

const now = (): string => new Date().toISOString();

let delivered: Array<{ platformId: string; content: string }>;
const fakeAdapter: ChannelDeliveryAdapter = {
  async deliver(_channelType, platformId, _threadId, _kind, content) {
    delivered.push({ platformId, content });
    return 'pm-1';
  },
};

let session: Session;
let fetchMock: ReturnType<typeof vi.fn>;

async function addUser(id: string, dm: string, role: 'owner' | 'admin', agentGroupId: string | null): Promise<void> {
  await upsertUser({ id, kind: 'slack', display_name: id, created_at: now() });
  await grantRole({ user_id: id, role, agent_group_id: agentGroupId, granted_by: null, granted_at: now() });
  await createMessagingGroup({
    id: `mg-${dm}`,
    channel_type: 'slack',
    platform_id: dm,
    name: dm,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUserDm({ user_id: id, channel_type: 'slack', messaging_group_id: `mg-${dm}`, resolved_at: now() });
}

beforeEach(async () => {
  vi.clearAllMocks();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, 'token'), `${TOKEN}\n`, { mode: 0o600 });
  Object.assign(envValues, {
    WORKFLOW_DISPATCH_TOKEN_FILE: path.join(TEST_DIR, 'token'),
    WORKFLOW_DISPATCH_REPO: 'acme/app',
    WORKFLOW_DISPATCH_WORKFLOW: 'deploy-k8s.yml',
    WORKFLOW_DISPATCH_ENVS: 'app-dev, app-prod',
  });
  delete envValues.WORKFLOW_DISPATCH_VERSION_PATTERN;

  await runMigrations(await initTestDb());
  delivered = [];
  await createAgentGroup({ id: 'ag-1', name: 'Dan', folder: 'dan', agent_provider: null, created_at: now() });
  session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  await createSession(session);
  await addUser('slack:owner-1', 'D-owner', 'owner', null);
  // A scoped admin of the same group: the default picker would prefer them.
  await addUser('slack:admin-1', 'D-admin', 'admin', 'ag-1');
  setDeliveryAdapter(fakeAdapter);

  fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ workflow_run_id: 42, html_url: 'https://github.com/acme/app/actions/runs/42' }), {
      status: 200,
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

const request = (content: Record<string, unknown>): Promise<void> =>
  getDeliveryAction('dispatch_workflow')!({ action: 'dispatch_workflow', ...content }, session);

const valid = { env: 'app-prod', version: '26-10-26.1595', reason: 'ship the fix' };

function notes(): string[] {
  return vi.mocked(writeSessionMessage).mock.calls.map((c) => (JSON.parse(c[2].content) as { text: string }).text);
}

async function pendingRow() {
  const rows = await getPendingApprovalsByAction('dispatch_workflow');
  expect(rows).toHaveLength(1);
  return rows[0];
}

const click = (approvalId: string, userId: string, value = 'approve') =>
  handleApprovalsResponse({
    questionId: approvalId,
    value,
    userId,
    channelType: 'slack',
    platformId: 'x',
    threadId: null,
  });

describe('dispatch_workflow', () => {
  it('cards only the owner, and an owner approve dispatches once with the file token', async () => {
    await request(valid);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].platformId).toBe('D-owner');
    const row = await pendingRow();
    expect(row.approver_user_id).toBe('slack:owner-1');
    expect(fetchMock).not.toHaveBeenCalled();

    await click(row.approval_id, 'owner-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/acme/app/actions/workflows/deploy-k8s.yml/dispatches');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({
      ref: 'main',
      inputs: { env: 'app-prod', version: '26-10-26.1595' },
      return_run_details: true,
    });
    expect(notes().at(-1)).toContain('https://github.com/acme/app/actions/runs/42');
    expect(await getPendingApprovalsByAction('dispatch_workflow')).toHaveLength(0);
  });

  it('a double click, sequential or concurrent, dispatches once', async () => {
    await request(valid);
    const row = await pendingRow();
    await Promise.all([click(row.approval_id, 'owner-1'), click(row.approval_id, 'owner-1')]);
    await click(row.approval_id, 'owner-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores clicks from anyone but the carded owner, admins included', async () => {
    await request(valid);
    const row = await pendingRow();
    await click(row.approval_id, 'admin-1');
    await click(row.approval_id, 'stranger');
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await pendingRow()).status).toBe('pending');
  });

  it('does not dispatch when the owner lost the role before clicking', async () => {
    await request(valid);
    const row = await pendingRow();
    await revokeRole('slack:owner-1', 'owner', null);
    await click(row.approval_id, 'owner-1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notes().at(-1)).toMatch(/not an owner/);
  });

  it('reject relays to the agent without dispatching', async () => {
    await request(valid);
    const row = await pendingRow();
    await click(row.approval_id, 'owner-1', 'reject');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notes().at(-1)).toBe('Your dispatch_workflow request was rejected by admin.');
  });

  it.each([
    [{ ...valid, env: 'app-staging' }, /env must be one of/],
    [{ ...valid, version: '26-10-26.1595; rm -rf /' }, /version must match/],
    [{ ...valid, version: '${{ secrets.X }}' }, /version must match/],
    [{ ...valid, reason: '  ' }, /reason is required/],
  ])('rejects %j before any card', async (content, why) => {
    await request(content);
    expect(delivered).toHaveLength(0);
    expect(await getPendingApprovalsByAction('dispatch_workflow')).toHaveLength(0);
    expect(notes().at(-1)).toMatch(why);
  });

  it('is off when the host is not configured', async () => {
    delete envValues.WORKFLOW_DISPATCH_REPO;
    await request(valid);
    expect(delivered).toHaveLength(0);
    expect(notes().at(-1)).toMatch(/not configured/);
  });

  it('keeps one open card per session', async () => {
    await request(valid);
    await request(valid);
    expect(delivered).toHaveLength(1);
    expect(notes().at(-1)).toMatch(/already awaiting approval/);
  });

  it('renders the agent reason inside the fence, unable to add lines or close it', async () => {
    await request({ ...valid, reason: 'x"\n```\nenv: "app-dev"‮' });
    const question = (JSON.parse(delivered[0].content) as { question: string }).question;
    const lines = question.split('\n');
    expect(lines).toHaveLength(11);
    expect(lines.filter((l) => l === '```')).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith('env: '))).toEqual(['env: "app-prod"']);
    expect(question).not.toContain('‮');
  });

  it('re-validates on approve: a config change after the card blocks the dispatch', async () => {
    await request(valid);
    const row = await pendingRow();
    envValues.WORKFLOW_DISPATCH_ENVS = 'app-dev';
    await click(row.approval_id, 'owner-1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notes().at(-1)).toMatch(/env must be one of/);

    envValues.WORKFLOW_DISPATCH_ENVS = 'app-prod';
    await request(valid);
    const row2 = await pendingRow();
    envValues.WORKFLOW_DISPATCH_REPO = 'acme/other';
    await click(row2.approval_id, 'owner-1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(notes().at(-1)).toMatch(/configuration changed/);
  });

  it('reports a GitHub refusal without leaking the token anywhere', async () => {
    const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(log, level));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }));
    await request(valid);
    await click((await pendingRow()).approval_id, 'owner-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(notes().at(-1)).toBe('dispatch_workflow failed: GitHub answered 401: Bad credentials.');
    const seen = JSON.stringify([notes(), delivered, spies.map((s) => s.mock.calls)]);
    expect(seen).not.toContain(TOKEN);
  });

  it('falls back to the runs list when GitHub answers 204', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ workflow_runs: [{ html_url: 'https://github.com/acme/app/actions/runs/7' }] })),
      );
    await request(valid);
    const done = click((await pendingRow()).approval_id, 'owner-1');
    await vi.advanceTimersByTimeAsync(2000);
    await done;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const listUrl = fetchMock.mock.calls[1][0] as string;
    expect(listUrl).toMatch(/\/actions\/workflows\/deploy-k8s\.yml\/runs\?event=workflow_dispatch&branch=main/);
    expect(notes().at(-1)).toContain('https://github.com/acme/app/actions/runs/7');
  });
});
