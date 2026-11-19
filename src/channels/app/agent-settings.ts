import { DEFAULT_EFFORT, DEFAULT_MODEL } from '../../config.js';
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
    defaultEffort: DEFAULT_EFFORT || null,
    provider: view.provider,
    canEdit,
    configUpdatedAt: view.configUpdatedAt,
  };
}

function modelOptions(provider: string | null) {
  return provider === null || provider === 'claude' ? MODEL_CATALOG.map(({ id, label }) => ({ id, label })) : [];
}

async function invalidModel(ctx: AppRequest) {
  const config = await getAgentConfigStatus(ctx.params.id);
  if (!config.ok) return commandError(ctx, config);
  invalidValue(
    ctx,
    'model',
    modelOptions(config.view.provider).map(({ id }) => id),
  );
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
  const canEdit = await hasAdminPrivilege(ctx.identity!.userId, conversation.agent_group_id);
  json(ctx.res, 200, {
    status: {
      agent: agentSettings(view, canEdit),
      session: {
        contextTokens: view.contextTokens ?? null,
        contextWindow: view.contextWindow,
        turns: view.sessionTurns ?? null,
        outputTokens: view.sessionOutputTokens ?? null,
        queueDepth: view.queueDepth,
      },
      options: { models: modelOptions(view.provider), efforts: EFFORT_LEVELS },
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
  if (model != null && typeof model !== 'string') return invalidModel(ctx);
  if (effort != null && typeof effort !== 'string') return invalidValue(ctx, 'effort', EFFORT_LEVELS);
  const result =
    model !== undefined
      ? await setModel(id, model, userId, effort)
      : await setConfigValue(id, 'effort', effort as string | null, userId);
  if (!result.ok && result.reason === 'invalid-value' && result.detail?.field === 'model') return invalidModel(ctx);
  if (!result.ok) return commandError(ctx, result);
  const config = await getAgentConfigStatus(id);
  if (!config.ok) return commandError(ctx, config);
  json(ctx.res, 200, { agent: agentSettings(config.view, true) } satisfies AgentSettingsResponse);
};
