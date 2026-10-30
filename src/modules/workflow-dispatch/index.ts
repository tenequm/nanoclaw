/**
 * Workflow dispatch module — owner-approved GitHub Actions workflow_dispatch.
 *
 * The agent asks (dispatch_workflow MCP tool → system action); an owner
 * approves on a card; the HOST dispatches with a token read from a file the
 * container never sees. Off until the host .env names the repo, workflow,
 * env allowlist and token file.
 *
 *   - precheck: config present, env in the allowlist, version matches the
 *     pattern. Runs on the request AND again on the approved replay, so a
 *     config change between card and click is honored.
 *   - guard: unconditional hold from the container path.
 *   - requestHold: card to the owners only (never scoped/global admins).
 *   - approval handler: re-checks the clicker is still an owner, then
 *     re-enters the guarded action with the approval row as the grant.
 *   - apply: POST .../dispatches once (never retried), report the run URL.
 */
import fs from 'fs';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getPendingApprovalsByAction } from '../../db/sessions.js';
import { reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { readEnvFile } from '../../env.js';
import { DENY, HOLD, defineGuardedAction } from '../../guard/index.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent, registerApprovalHandler, requestApproval } from '../approvals/index.js';
import { getOwners, isOwner } from '../permissions/db/user-roles.js';
import { escapeInvisibles } from '../self-mod/request.js';

export const DISPATCH_WORKFLOW_ACTION = 'dispatch_workflow';
const REF = 'main';
const DEFAULT_VERSION_PATTERN = '^[0-9]{2}-[0-9]{2}-[0-9]{2}\\.[0-9]{4}$';
// Workflows interpolate inputs into run-name and shell steps, so whatever the
// operator's pattern allows, the version stays inside this charset.
const VERSION_CHARSET = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_REASON_CHARS = 500;
const GITHUB_API = 'https://api.github.com';
const RUN_LOOKUP_ATTEMPTS = 5;
const RUN_LOOKUP_DELAY_MS = 2000;

export interface DispatchConfig {
  tokenFile: string;
  repo: string;
  workflow: string;
  envs: string[];
  versionPattern: RegExp;
}

interface DispatchRequest {
  env: string;
  version: string;
  reason: string;
}

/** Read per call so .env edits apply without a restart. Returns the reason when unusable. */
export function readDispatchConfig(): DispatchConfig | string {
  const env = readEnvFile([
    'WORKFLOW_DISPATCH_TOKEN_FILE',
    'WORKFLOW_DISPATCH_REPO',
    'WORKFLOW_DISPATCH_WORKFLOW',
    'WORKFLOW_DISPATCH_ENVS',
    'WORKFLOW_DISPATCH_VERSION_PATTERN',
  ]);
  const tokenFile = env.WORKFLOW_DISPATCH_TOKEN_FILE?.trim();
  const repo = env.WORKFLOW_DISPATCH_REPO?.trim();
  const workflow = env.WORKFLOW_DISPATCH_WORKFLOW?.trim();
  const envs = (env.WORKFLOW_DISPATCH_ENVS ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  if (!tokenFile || !repo || !workflow || envs.length === 0) return 'workflow dispatch is not configured on this host';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return 'WORKFLOW_DISPATCH_REPO must be owner/repo';
  if (!/^[A-Za-z0-9_.-]+$/.test(workflow)) return 'WORKFLOW_DISPATCH_WORKFLOW must be a workflow file name or id';
  let versionPattern: RegExp;
  try {
    versionPattern = new RegExp(env.WORKFLOW_DISPATCH_VERSION_PATTERN?.trim() || DEFAULT_VERSION_PATTERN);
  } catch {
    return 'WORKFLOW_DISPATCH_VERSION_PATTERN is not a valid regex';
  }
  return { tokenFile, repo, workflow, envs, versionPattern };
}

function parseRequest(content: Record<string, unknown>, cfg: DispatchConfig): DispatchRequest | string {
  const { env, version, reason } = content;
  if (typeof env !== 'string' || !cfg.envs.includes(env)) return `env must be one of: ${cfg.envs.join(', ')}`;
  if (typeof version !== 'string' || !VERSION_CHARSET.test(version) || !cfg.versionPattern.test(version)) {
    return `version must match ${cfg.versionPattern.source}`;
  }
  if (typeof reason !== 'string' || !reason.trim()) return 'reason is required';
  if (reason.length > MAX_REASON_CHARS) return `reason is limited to ${MAX_REASON_CHARS} characters`;
  return { env, version, reason: reason.trim() };
}

async function validateDispatch(content: Record<string, unknown>, session: Session): Promise<boolean> {
  const cfg = readDispatchConfig();
  const parsed = typeof cfg === 'string' ? cfg : parseRequest(content, cfg);
  if (typeof parsed === 'string') {
    await notifyAgent(session, `${DISPATCH_WORKFLOW_ACTION} failed: ${parsed}.`);
    return false;
  }
  return true;
}

async function requestDispatchHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const cfg = readDispatchConfig();
  if (typeof cfg === 'string') return;
  const req = parseRequest(content, cfg);
  if (typeof req === 'string') return;
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  // One open card per session: a looping agent must not stack approvals an
  // owner could click through into repeated deploys.
  const open = await getPendingApprovalsByAction(DISPATCH_WORKFLOW_ACTION);
  if (open.some((row) => row.session_id === session.id)) {
    await notifyAgent(
      session,
      `${DISPATCH_WORKFLOW_ACTION} failed: a request from this session is already awaiting approval.`,
    );
    return;
  }

  // Each field JSON-encoded with invisibles and backticks escaped, inside a
  // fence: the agent-written reason cannot add lines or spoof another field.
  const fields: Array<[string, string]> = [
    ['repo', cfg.repo],
    ['workflow', cfg.workflow],
    ['ref', REF],
    ['env', req.env],
    ['version', req.version],
    ['agent', agentGroup.name],
    ['session', session.id],
    ['reason', req.reason],
  ];
  const question =
    `Agent "${escapeInvisibles(agentGroup.name)}" requests a GitHub workflow dispatch:\n` +
    '```\n' +
    fields.map(([k, v]) => `${k}: ${escapeInvisibles(JSON.stringify(v))}`).join('\n') +
    '\n```';

  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: DISPATCH_WORKFLOW_ACTION,
    // repo/workflow are pinned so the approved replay refuses if the config moved under the card.
    payload: { ...req, repo: cfg.repo, workflow: cfg.workflow },
    title: 'Workflow Dispatch Request',
    question,
    approvers: (await getOwners()).map((r) => r.user_id),
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'nanoclaw-workflow-dispatch',
  };
}

/** Fallback when GitHub answers 204 without run details: newest dispatch run on REF since the call. */
async function findDispatchedRun(cfg: DispatchConfig, token: string, since: Date): Promise<string | null> {
  // 30s of slack for clock skew between this host and GitHub.
  const created = new Date(since.getTime() - 30_000).toISOString();
  const url =
    `${GITHUB_API}/repos/${cfg.repo}/actions/workflows/${encodeURIComponent(cfg.workflow)}/runs` +
    `?event=workflow_dispatch&branch=${REF}&per_page=5&created=${encodeURIComponent(`>=${created}`)}`;
  for (let attempt = 0; attempt < RUN_LOOKUP_ATTEMPTS; attempt++) {
    await sleep(RUN_LOOKUP_DELAY_MS);
    const res = await fetch(url, { headers: githubHeaders(token), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) continue;
    const body = (await res.json()) as { workflow_runs?: Array<{ html_url?: string }> };
    const run = body.workflow_runs?.[0]?.html_url;
    if (run) return run;
  }
  return null;
}

async function githubError(res: Response): Promise<string> {
  let message = '';
  try {
    message = String(((await res.json()) as { message?: unknown }).message ?? '');
  } catch {
    // Non-JSON body: the status alone is enough.
  }
  return `GitHub answered ${res.status}${message ? `: ${message.slice(0, 200)}` : ''}`;
}

export async function applyDispatch(content: Record<string, unknown>, session: Session): Promise<void> {
  const fail = (why: string): Promise<void> => notifyAgent(session, `${DISPATCH_WORKFLOW_ACTION} failed: ${why}.`);
  const cfg = readDispatchConfig();
  if (typeof cfg === 'string') return fail(cfg);
  if (content.repo !== cfg.repo || content.workflow !== cfg.workflow) {
    return fail('the dispatch configuration changed after the approval card was sent; request again');
  }
  const req = parseRequest(content, cfg);
  if (typeof req === 'string') return fail(req);

  let token: string;
  try {
    token = fs.readFileSync(cfg.tokenFile, 'utf-8').trim();
  } catch (err) {
    log.error('Workflow dispatch token file unreadable', { code: (err as NodeJS.ErrnoException).code });
    return fail('the host could not read its dispatch token');
  }
  if (!token) return fail('the host dispatch token is empty');

  const target = { repo: cfg.repo, workflow: cfg.workflow, env: req.env, version: req.version, sessionId: session.id };
  const startedAt = new Date();
  let res: Response;
  try {
    res = await fetch(
      `${GITHUB_API}/repos/${cfg.repo}/actions/workflows/${encodeURIComponent(cfg.workflow)}/dispatches`,
      {
        method: 'POST',
        headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: REF, inputs: { env: req.env, version: req.version }, return_run_details: true }),
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch (err) {
    // Not retried: a timeout can still have created the run.
    log.error('Workflow dispatch request failed', { ...target, err: err instanceof Error ? err.message : String(err) });
    return fail(
      `the dispatch call to GitHub did not complete (${err instanceof Error ? err.name : 'error'}); check the Actions page before asking again`,
    );
  }
  if (!res.ok) {
    const why = await githubError(res);
    log.error('Workflow dispatch rejected by GitHub', { ...target, status: res.status });
    return fail(why);
  }

  let runUrl: string | null = null;
  if (res.status === 200) {
    runUrl = ((await res.json().catch(() => ({}))) as { html_url?: string }).html_url ?? null;
  }
  if (!runUrl) runUrl = await findDispatchedRun(cfg, token, startedAt).catch(() => null);
  log.info('Workflow dispatched', { ...target, runUrl });

  const where = runUrl
    ? `Run: ${runUrl}`
    : `The run could not be located yet; see https://github.com/${cfg.repo}/actions/workflows/${cfg.workflow}`;
  await notifyAgent(
    session,
    `${DISPATCH_WORKFLOW_ACTION} approved and dispatched: ${cfg.repo} ${cfg.workflow} on ${REF} with env=${req.env} version=${req.version}. ${where}. Report this to the user.`,
  );
}

export const workflowDispatchGuard = defineGuardedAction({
  action: 'workflow.dispatch',
  grantActionName: DISPATCH_WORKFLOW_ACTION,
  decide: (input) =>
    input.actor.kind === 'agent'
      ? HOLD('workflow dispatch always requires owner approval')
      : DENY('dispatch_workflow is a container-originated action.'),
});

registerDeliveryAction(DISPATCH_WORKFLOW_ACTION, applyDispatch, {
  guardAction: workflowDispatchGuard,
  precheck: validateDispatch,
  requestHold: requestDispatchHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `${DISPATCH_WORKFLOW_ACTION} denied: ${reason}`),
});

const replayDispatch = reenterGuardedDeliveryAction(DISPATCH_WORKFLOW_ACTION);
registerApprovalHandler(DISPATCH_WORKFLOW_ACTION, async (ctx) => {
  // The card is routed to an owner, but ownership can be revoked before the click.
  if (!(await isOwner(ctx.userId))) {
    log.warn('Workflow dispatch approval from a non-owner ignored', { approvalId: ctx.approval.approval_id });
    await notifyAgent(ctx.session, `${DISPATCH_WORKFLOW_ACTION} was not dispatched: the approver is not an owner.`);
    return;
  }
  await replayDispatch(ctx);
});
