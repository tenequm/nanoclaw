/**
 * Host-executed chat commands: /config, /model.
 *
 * These are admin-gated by the command gate (src/command-gate.ts) and run
 * entirely on the host — the sender's admin role IS the authorization, so
 * unlike agent-initiated `ncl groups config update` there is no approval
 * card round-trip. Replies are written straight to the session's outbound
 * mailbox; the container is never involved (and for /model is restarted).
 *
 * `/model` with no argument delivers an interactive picker card through the
 * same ask_question rendering the approvals module uses (buttons on Slack /
 * Telegram, text fallback elsewhere). Pending pickers live in an in-memory
 * map — a host restart invalidates outstanding cards, which is acceptable
 * for an ephemeral picker. The card is delivered directly via the delivery
 * adapter (the approvals pattern, src/modules/approvals/primitive.ts), NOT
 * through messages_out — that path would auto-persist a pending_questions
 * row and the interactive module would claim the button click for the
 * agent's ask_user_question flow.
 */
import { normalizeOptions, type NormalizedOption } from './channels/ask-question.js';
import { registerQuestionRenderResolver } from './channels/question-render-registry.js';
import { DEFAULT_MODEL, TIMEZONE } from './config.js';
import { restartAgentGroupContainers } from './container-restart.js';
import { isContainerRunning } from './container-runner.js';
import { getContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { getDeliveryAdapter } from './delivery.js';
import { log } from './log.js';
import { hasAdminPrivilege } from './modules/permissions/db/user-roles.js';
import { registerResponseHandler, type ResponsePayload } from './response-registry.js';
import { writeOutboundDirect } from './session-manager.js';
import type { AgentGroup, ContainerConfigRow, Session } from './types.js';

export interface HostCommandContext {
  command: string;
  argText: string;
  agentGroup: AgentGroup;
  session: Session;
  userId: string | null;
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
  /** Adapter-instance name of the originating messaging group. */
  instance: string | null;
}

/** Curated picker rows. `__default__` clears the per-group override. */
const MODEL_OPTIONS: Array<{ label: string; value: string }> = [
  { label: 'Fable 5', value: 'claude-fable-5' },
  { label: 'Opus 5', value: 'claude-opus-5' },
  { label: 'Sonnet 5', value: 'claude-sonnet-5' },
  { label: 'Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
  { label: 'Default (install)', value: '__default__' },
];

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;
const PICKER_TTL_MS = 10 * 60_000;
const PICKER_MAX = 50;

interface PendingPicker {
  agentGroupId: string;
  sessionId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  instance: string | null;
  options: NormalizedOption[];
  createdAt: number;
}

const pendingPickers = new Map<string, PendingPicker>();

function sweepPickers(): void {
  const cutoff = Date.now() - PICKER_TTL_MS;
  for (const [id, p] of pendingPickers) {
    if (p.createdAt < cutoff) pendingPickers.delete(id);
  }
}

/** Serve button labels/values for pending picker cards at click time. */
registerQuestionRenderResolver((questionId) => {
  const p = pendingPickers.get(questionId);
  if (!p) return undefined;
  return { title: 'Model', options: p.options };
});

/** Claim picker button clicks. Returns false for every other questionId. */
registerResponseHandler(async (payload: ResponsePayload): Promise<boolean> => {
  const picker = pendingPickers.get(payload.questionId);
  if (!picker) return false;
  pendingPickers.delete(payload.questionId);

  const userId = namespacedUserId(payload);
  if (!userId || !(await hasAdminPrivilege(userId, picker.agentGroupId))) {
    log.warn('Ignoring model picker click from non-admin', { userId, agentGroupId: picker.agentGroupId });
    return true;
  }

  const reply = (text: string) =>
    writeOutboundDirect(picker.agentGroupId, picker.sessionId, {
      id: hostMsgId('model'),
      kind: 'chat',
      platformId: picker.platformId,
      channelType: picker.channelType,
      threadId: picker.threadId,
      content: JSON.stringify({ text }),
    });

  try {
    await applyModel(picker.agentGroupId, payload.value === '__default__' ? null : payload.value);
    await reply(modelAppliedText(payload.value));
  } catch (err) {
    log.error('Model picker apply failed', { agentGroupId: picker.agentGroupId, value: payload.value, err });
    await reply(`Failed to apply model: ${String(err)}`);
  }
  return true;
});

function namespacedUserId(payload: ResponsePayload): string | null {
  if (!payload.userId) return null;
  return payload.userId.includes(':') ? payload.userId : `${payload.channelType}:${payload.userId}`;
}

function hostMsgId(tag: string): string {
  return `host-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Execute a gate-classified host command. Never throws — errors become replies. */
export async function handleHostCommand(ctx: HostCommandContext): Promise<void> {
  const reply = (text: string) =>
    writeOutboundDirect(ctx.agentGroup.id, ctx.session.id, {
      id: hostMsgId(ctx.command.slice(1)),
      kind: 'chat',
      platformId: ctx.platformId,
      channelType: ctx.channelType,
      threadId: ctx.threadId,
      content: JSON.stringify({ text }),
    });

  try {
    switch (ctx.command) {
      case '/config': {
        const row = await getContainerConfig(ctx.agentGroup.id);
        await reply(renderConfig(ctx, row));
        return;
      }
      case '/model': {
        if (!ctx.argText) {
          await sendModelPicker(ctx, reply);
          return;
        }
        const arg = ctx.argText.split(/\s/)[0];
        if (arg.toLowerCase() === 'default') {
          await applyModel(ctx.agentGroup.id, null);
          await reply(modelAppliedText('__default__'));
          return;
        }
        if (!MODEL_ID_RE.test(arg)) {
          await reply(`"${arg}" doesn't look like a model id. Use /model <model-id> or bare /model for the picker.`);
          return;
        }
        await applyModel(ctx.agentGroup.id, arg);
        await reply(modelAppliedText(arg));
        return;
      }
      default:
        // Gate and handler sets out of sync — surface instead of silence.
        await reply(`Unknown host command: ${ctx.command}`);
        return;
    }
  } catch (err) {
    log.error('Host command failed', { command: ctx.command, agentGroupId: ctx.agentGroup.id, err });
    try {
      await reply(`${ctx.command} failed: ${String(err)}`);
    } catch {
      // Reply write failed too — already logged above, nothing left to do.
    }
  }
}

/** Persist the model override (null clears) and bounce the group's containers. */
async function applyModel(agentGroupId: string, model: string | null): Promise<void> {
  await updateContainerConfigScalars(agentGroupId, { model });
  await restartAgentGroupContainers(agentGroupId, 'model changed via /model command');
}

function modelAppliedText(value: string): string {
  const target =
    value === '__default__' ? `the install default${DEFAULT_MODEL ? ` (\`${DEFAULT_MODEL}\`)` : ''}` : `\`${value}\``;
  return `Model set to ${target}. Container restarting, the next reply may take a few extra seconds.`;
}

async function sendModelPicker(ctx: HostCommandContext, reply: (text: string) => Promise<void>): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter || !ctx.channelType || !ctx.platformId) {
    await reply('Model picker unavailable here, use /model <model-id> instead.');
    return;
  }

  sweepPickers();
  if (pendingPickers.size >= PICKER_MAX) {
    await reply('Too many pending pickers, use /model <model-id> instead.');
    return;
  }

  const row = await getContainerConfig(ctx.agentGroup.id);
  const current = row?.model
    ? `\`${row.model}\``
    : DEFAULT_MODEL
      ? `\`${DEFAULT_MODEL}\` (install default)`
      : 'SDK default';
  const questionId = `hostq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const options = normalizeOptions(MODEL_OPTIONS);

  pendingPickers.set(questionId, {
    agentGroupId: ctx.agentGroup.id,
    sessionId: ctx.session.id,
    channelType: ctx.channelType,
    platformId: ctx.platformId,
    threadId: ctx.threadId,
    instance: ctx.instance,
    options,
    createdAt: Date.now(),
  });

  try {
    await adapter.deliver(
      ctx.channelType,
      ctx.platformId,
      ctx.threadId,
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        questionId,
        title: 'Model',
        question: `Current: ${current}. Pick a model for ${ctx.agentGroup.name}:`,
        options,
      }),
      undefined,
      ctx.instance ?? undefined,
    );
  } catch (err) {
    pendingPickers.delete(questionId);
    log.error('Failed to deliver model picker', { agentGroupId: ctx.agentGroup.id, err });
    await reply('Could not deliver the model picker, use /model <model-id> instead.');
  }
}

function renderConfig(ctx: HostCommandContext, row: ContainerConfigRow | undefined): string {
  const provider = row?.provider ?? 'claude';
  const model = row?.model
    ? `\`${row.model}\``
    : DEFAULT_MODEL
      ? `\`${DEFAULT_MODEL}\` (install default)`
      : 'SDK default';
  const effort = row?.effort ?? 'default';
  const timezone = row?.timezone ?? `${TIMEZONE} (install default)`;
  const cliScope = row?.cli_scope ?? 'group';
  const mcpServers = Object.keys(safeParse(row?.mcp_servers, {}));
  const apt = safeParse<string[]>(row?.packages_apt, []);
  const npm = safeParse<string[]>(row?.packages_npm, []);
  const running = isContainerRunning(ctx.session.id);
  // The command prefix the reader can actually type where they are.
  const p = ctx.channelType === 'slack' ? '!' : '/';

  const lines = [
    `**${ctx.agentGroup.name}** (${ctx.agentGroup.folder}), container ${running ? 'running' : 'stopped'}`,
    `**Model:** ${model} · **Effort:** ${effort} · **Provider:** ${provider}`,
    `**Timezone:** ${timezone} · **CLI scope:** ${cliScope}`,
    `**Session:** \`${ctx.session.id}\``,
    `**MCP servers:** ${mcpServers.length > 0 ? mcpServers.join(', ') : 'none'}`,
    `**Packages:** ${apt.length + npm.length > 0 ? `${apt.length} apt, ${npm.length} npm` : 'none'}`,
  ];

  lines.push(
    '',
    '**Change with:**',
    `- \`${p}model <model-id>\`, or bare \`${p}model\` for a picker`,
    `- \`ncl groups config update --id ${ctx.agentGroup.id}\` with \`--effort <level>\`, \`--timezone <IANA>\`, or \`--provider <name>\``,
    `- \`ncl groups config add-mcp-server\` / \`add-package\`, then \`ncl groups restart --id ${ctx.agentGroup.id}\``,
  );

  return lines.join('\n');
}

function safeParse<T>(json: string | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
