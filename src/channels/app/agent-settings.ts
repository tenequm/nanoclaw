import { DEFAULT_MODEL } from '../../config.js';
import { getAgentConfigStatus, getStatus, setConfigValue, setModel } from '../../commands/service.js';
import {
  describeModel,
  EFFORT_LEVELS,
  MODEL_CATALOG,
  type CommandFailure,
  type StatusView,
} from '../../commands/types.js';
import { reachableAgentIds } from '../../modules/device-auth/verify.js';
import { hasAdminPrivilege } from '../../modules/permissions/db/user-roles.js';
import { accessibleConversation, requestBody } from './conversations.js';
import type { AgentSettings, AgentSettingsResponse, AgentStatusResponse } from './contract.js';
import { json, type AppHandler, type AppRequest } from './http.js';

function agentSettings(
  view: Pick<StatusView, 'agentGroupId' | 'agentName' | 'model' | 'effort' | 'provider' | 'configUpdatedAt'>,
  canEdit: boolean,
): AgentSettings {
  return {
    id: view.agentGroupId,
    name: view.agentName,
    model: describeModel(view.model),
    defaultModel: describeModel(DEFAULT_MODEL || null),
    effort: view.effort,
    provider: view.provider,
    canEdit,
    configUpdatedAt: view.configUpdatedAt,
  };
}

function invalidValue(ctx: AppRequest, field: string, allowed: readonly (number | string)[]) {
  json(ctx.res, 400, { error: 'invalid_value', message: 'Choose a supported setting.', field, allowed });
}

function commandError(ctx: AppRequest, failure: CommandFailure) {
  if (failure.reason === 'unauthorized') {
    json(ctx.res, 403, { error: 'forbidden', message: 'Admin access is required.' });
  } else if (failure.reason === 'unknown-agent') {
    json(ctx.res, 404, { error: 'not_found', message: 'Not found.' });
  } else {
    invalidValue(ctx, failure.detail?.field ?? 'settings', failure.detail?.allowed ?? []);
  }
}

export const conversationStatus: AppHandler = async (ctx) => {
  const conversation = await accessibleConversation(ctx);
  if (!conversation) return;
  const result = await getStatus(conversation.agent_group_id, {
    messagingGroupId: conversation.messaging_group_id,
    threadId: null,
    transcriptScope: 'session',
  });
  if (!result.ok) return commandError(ctx, result);
  const view = result.view;
  const turns = view.sessionTurns ?? null;
  const canEdit = await hasAdminPrivilege(ctx.identity!.userId, conversation.agent_group_id);
  json(ctx.res, 200, {
    status: {
      agent: agentSettings(view, canEdit),
      session: {
        contextTokens: view.contextTokens ?? null,
        contextWindow: turns === null ? null : (view.contextWindow ?? null),
        turns,
        outputTokens: view.sessionOutputTokens ?? null,
        queueDepth: turns === null ? null : (view.queueDepth ?? null),
      },
      taskCount: view.taskCount ?? null,
      options: { models: MODEL_CATALOG.map(({ id, label }) => ({ id, label })), efforts: EFFORT_LEVELS },
    },
  } satisfies AgentStatusResponse);
};

export const updateAgentSettings: AppHandler = async (ctx) => {
  const { userId, agentIds, deviceId } = ctx.identity!;
  const id = ctx.params.id;
  if (!agentIds.includes(id)) return json(ctx.res, 404, { error: 'not_found', message: 'Not found.' });
  const body = await requestBody(ctx);
  if (!(await reachableAgentIds(deviceId)).includes(id))
    return json(ctx.res, 404, { error: 'not_found', message: 'Not found.' });
  const { model, effort } = body;
  if (
    (model === undefined && effort === undefined) ||
    Object.keys(body).some((key) => key !== 'model' && key !== 'effort')
  ) {
    return invalidValue(ctx, 'settings', ['model', 'effort']);
  }
  if (model !== undefined && typeof model !== 'string')
    return invalidValue(
      ctx,
      'model',
      MODEL_CATALOG.map((m) => m.alias),
    );
  if (effort !== undefined && typeof effort !== 'string') return invalidValue(ctx, 'effort', EFFORT_LEVELS);
  const result =
    model !== undefined
      ? await setModel(id, model, userId, effort)
      : await setConfigValue(id, 'effort', effort as string, userId);
  if (!result.ok) return commandError(ctx, result);
  const config = await getAgentConfigStatus(id);
  if (!config.ok) return commandError(ctx, config);
  json(ctx.res, 200, { agent: agentSettings(config.view, true) } satisfies AgentSettingsResponse);
};
