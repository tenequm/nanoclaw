/**
 * Host-executed chat commands: /status and /config render the group's
 * container config, /model applies a model override (arg form) or delivers
 * an interactive picker (bare form) whose button click is claimed by the
 * registered response handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  outbound: [] as Array<{ agentGroupId: string; sessionId: string; content: string }>,
  deliveries: [] as unknown[][],
  restarts: [] as string[],
}));

vi.mock('./session-manager.js', () => ({
  writeOutboundDirect: vi.fn(async (agentGroupId: string, sessionId: string, msg: { content: string }) => {
    captured.outbound.push({ agentGroupId, sessionId, content: msg.content });
  }),
}));

vi.mock('./container-restart.js', () => ({
  restartAgentGroupContainers: vi.fn(async (agentGroupId: string) => {
    captured.restarts.push(agentGroupId);
    return 0;
  }),
}));

vi.mock('./container-runner.js', () => ({
  isContainerRunning: () => false,
}));

vi.mock('./delivery.js', () => ({
  getDeliveryAdapter: () => ({
    async deliver(...args: unknown[]) {
      captured.deliveries.push(args);
      return undefined;
    },
  }),
}));

import { handleHostCommand, type HostCommandContext } from './host-commands.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { createUser } from './modules/permissions/db/users.js';
import { grantRole } from './modules/permissions/db/user-roles.js';
import { getResponseHandlers } from './response-registry.js';
import type { AgentGroup, Session } from './types.js';

function now(): string {
  return new Date().toISOString();
}

const agentGroup: AgentGroup = { id: 'ag-1', name: 'Emma', folder: 'emma', agent_provider: null, created_at: now() };
const session = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;

function ctx(command: string, argText = ''): HostCommandContext {
  return {
    command,
    argText,
    agentGroup,
    session,
    userId: 'slack:U-owner',
    channelType: 'slack',
    platformId: 'slack:D1',
    threadId: 'slack:D1:1',
    instance: null,
  };
}

function lastReplyText(): string {
  const last = captured.outbound[captured.outbound.length - 1];
  return (JSON.parse(last.content) as { text: string }).text;
}

beforeEach(async () => {
  captured.outbound.length = 0;
  captured.deliveries.length = 0;
  captured.restarts.length = 0;
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup(agentGroup);
  await ensureContainerConfig('ag-1');
  await updateContainerConfigScalars('ag-1', { model: 'claude-sonnet-5', effort: 'high' });
  await createUser({ id: 'slack:U-owner', kind: 'slack', display_name: null, created_at: now() });
  await grantRole({
    user_id: 'slack:U-owner',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
});

afterEach(async () => {
  await closeDb();
});

describe('/config', () => {
  it('renders the group config, container state, and change hints', async () => {
    await handleHostCommand(ctx('/config'));
    const text = lastReplyText();
    expect(text).toContain('**Emma** (emma)');
    expect(text).toContain('`claude-sonnet-5`');
    expect(text).toContain('**Effort:** high');
    expect(text).toContain('container stopped');
    expect(text).toContain('Change with:');
    expect(text).toContain('ncl groups config update --id ag-1');
  });
});

describe('/model with an argument', () => {
  it('applies the model, restarts the group, and confirms', async () => {
    await handleHostCommand(ctx('/model', 'claude-opus-5'));
    expect((await getContainerConfig('ag-1'))?.model).toBe('claude-opus-5');
    expect(captured.restarts).toEqual(['ag-1']);
    expect(lastReplyText()).toContain('Model set to `claude-opus-5`');
  });

  it('clears the override on "default"', async () => {
    await handleHostCommand(ctx('/model', 'default'));
    expect((await getContainerConfig('ag-1'))?.model).toBeNull();
    expect(captured.restarts).toEqual(['ag-1']);
  });

  it('rejects a malformed model id without touching the config', async () => {
    await handleHostCommand(ctx('/model', '$$nope'));
    expect((await getContainerConfig('ag-1'))?.model).toBe('claude-sonnet-5');
    expect(captured.restarts).toEqual([]);
    expect(lastReplyText()).toContain("doesn't look like a model id");
  });
});

describe('/model picker', () => {
  async function dispatchClick(questionId: string, value: string, userId: string): Promise<boolean> {
    for (const handler of getResponseHandlers()) {
      if (await handler({ questionId, value, userId, channelType: 'slack', platformId: '', threadId: null })) {
        return true;
      }
    }
    return false;
  }

  function deliveredQuestion(): { questionId: string; options: Array<{ value: string }> } {
    expect(captured.deliveries).toHaveLength(1);
    // deliver(channelType, platformId, threadId, kind, content, files, instance)
    return JSON.parse(captured.deliveries[0][4] as string);
  }

  it('delivers an ask_question card and applies the clicked model', async () => {
    await handleHostCommand(ctx('/model'));
    const question = deliveredQuestion();
    expect(question.options.map((o) => o.value)).toEqual(expect.arrayContaining(['claude-fable-5', 'claude-opus-5']));

    expect(await dispatchClick(question.questionId, 'claude-opus-5', 'U-owner')).toBe(true);
    expect((await getContainerConfig('ag-1'))?.model).toBe('claude-opus-5');
    expect(captured.restarts).toEqual(['ag-1']);
    expect(lastReplyText()).toContain('Model set to `claude-opus-5`');

    // Consumed: a second click on the same card is not claimed.
    expect(await dispatchClick(question.questionId, 'claude-opus-5', 'U-owner')).toBe(false);
  });

  it('ignores a click from a non-admin', async () => {
    await handleHostCommand(ctx('/model'));
    const question = deliveredQuestion();

    expect(await dispatchClick(question.questionId, 'claude-opus-5', 'U-stranger')).toBe(true);
    expect((await getContainerConfig('ag-1'))?.model).toBe('claude-sonnet-5');
    expect(captured.restarts).toEqual([]);
  });
});
