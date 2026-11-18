import { getConversation } from './conversations.js';
import { setAppHooks } from './log.js';
import { getDb } from '../../db/connection.js';
import { bindVoiceModeLineChat, createVoiceModeLine, getVoiceModeLineForAgent } from '../../db/voice-mode-lines.js';
import { hasAdminPrivilege } from '../../modules/permissions/db/user-roles.js';
import { encryptionKey } from '../../secret-seal.js';
import { JEV_API_KEY } from '../../config.js';
import { onDeviceRevoked, readSignedBody } from '../../modules/device-auth/verify.js';
import { log } from '../../log.js';
import { liveVoiceAdapter } from '../voice-mode-chat.js';
import { appVoiceErrorMessages as messages, lineRunsJev } from '../voice-mode-command.js';
import { linePlatformId } from '../voice-mode-line.js';
import { LIVEKIT_PROTOCOL_VERSION } from '../voice-mode-protocol.js';
import { appConfig } from './config.js';
import { parseAuthorization } from './contract.js';
import type { CallAttemptRow, ConversationRow } from './db.js';
import { json, type AppHandler, type AppRequest } from './routes.js';

export interface CallDeps {
  getConversation(id: string): Promise<ConversationRow | undefined>;
  setAppHooks(hooks: { callAvailability: typeof callAvailability }): void;
  onDeviceRevoked(listener: (deviceId: string) => void): () => void;
}
export class AppCallError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    message: string = messages[error] ?? error,
  ) {
    super(message);
  }
}
export const guarded =
  (handler: AppHandler): AppHandler =>
  async (ctx) => {
    try {
      await handler(ctx);
    } catch (err) {
      if (!(err instanceof AppCallError)) {
        if (err instanceof Error && 'error' in err && err.error === 'voice_offline')
          return json(ctx.res, 503, { error: 'voice_offline', message: messages.voice_offline });
        throw err;
      }
      json(ctx.res, err.status, { error: err.error, message: err.message });
    }
  };
export async function signedObject(ctx: AppRequest): Promise<Record<string, unknown>> {
  const auth = parseAuthorization(ctx.req.headers.authorization);
  if (!auth || !ctx.identity) throw new AppCallError(401, 'bad_signature');
  const bytes = await readSignedBody(ctx.req, auth.bodyHash, 4096);
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new AppCallError(400, 'bad_request');
  }
}
export async function conversationFor(ctx: AppRequest, id: string, deps: CallDeps, picker = false) {
  if (!ctx.identity) throw new AppCallError(401, 'bad_signature');
  const c = await deps.getConversation(id);
  if (!c || c.user_id !== ctx.identity.userId) throw new AppCallError(404, 'not_found');
  if (!ctx.identity.agentIds.includes(c.agent_group_id))
    throw new AppCallError(picker ? 404 : 403, picker ? 'not_found' : 'forbidden');
  return c;
}
export async function ownLine(c: ConversationRow, create: boolean) {
  if (!(await hasAdminPrivilege(c.user_id, c.agent_group_id))) throw new AppCallError(403, 'no_line');
  let line = await getVoiceModeLineForAgent(c.agent_group_id);
  if (!line && create) {
    const key = encryptionKey();
    if (!key) throw new AppCallError(403, 'no_line');
    await createVoiceModeLine(
      {
        agentGroupId: c.agent_group_id,
        ownerUserId: c.user_id,
        messagingGroupId: c.messaging_group_id,
        threadId: null,
      },
      key,
    );
    line = await getVoiceModeLineForAgent(c.agent_group_id);
  }
  if (line && line.owner_user_id !== c.user_id) throw new AppCallError(403, 'no_line');
  return line;
}
export async function callAvailability(userId: string, agentGroupId: string) {
  let error: string | null = null;
  if (!appConfig().livekitUrl || !liveVoiceAdapter()?.isConnected()) error = 'voice_offline';
  else {
    const line = await getVoiceModeLineForAgent(agentGroupId);
    if (!(await hasAdminPrivilege(userId, agentGroupId)) || (line ? line.owner_user_id !== userId : !encryptionKey()))
      error = 'no_line';
  }
  return { canCall: !error, callRefusal: error ? { error, message: messages[error] } : null };
}
export function runningVoice() {
  const adapter = liveVoiceAdapter();
  if (!adapter?.isConnected()) throw new AppCallError(503, 'voice_offline');
  return adapter;
}
const reasonText = (reason: unknown) =>
  reason === 'no-agent'
    ? 'no voice worker joined (worker down, or not on this protocol version)'
    : reason === 'updating'
      ? 'the voice worker is on another protocol version'
      : reason === 'revoked'
        ? 'caller device revoked'
        : 'hangup';
const normalizedReason = (reason: unknown) => (reason === 'no-agent' || reason === 'updating' ? reason : 'hangup');
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function createCallHandlers(deps: CallDeps) {
  deps.setAppHooks({ callAvailability });
  const opening = new Map<string, Promise<unknown>>();
  const attempt = (user: string, id: string) =>
    getDb().get<CallAttemptRow>('SELECT * FROM app_call_attempts WHERE user_id = ? AND attempt_id = ?', user, id);
  const stop = async (row: CallAttemptRow, reason: string) => {
    if (!row.call_id || !row.conversation_id) return;
    const c = await deps.getConversation(row.conversation_id);
    if (!c) return;
    const line = await getVoiceModeLineForAgent(c.agent_group_id);
    const voice = liveVoiceAdapter();
    if (line?.owner_user_id === row.user_id && voice?.isConnected())
      await voice.endAppCall(linePlatformId(line.line_id), row.call_id, reason, {
        grace: reason === 'hangup',
      });
  };
  deps.onDeviceRevoked((deviceId) => {
    void getDb()
      .all<CallAttemptRow>(
        "UPDATE app_call_attempts SET state = 'stopped', reason = 'revoked', updated_at = ? WHERE device_id = ? AND state IN ('opening', 'live') RETURNING *",
        Date.now(),
        deviceId,
      )
      .then(async (rows) => {
        for (const row of rows) await stop(row, reasonText('revoked'));
      })
      .catch((error: unknown) =>
        log.warn('App call stop on revocation failed', {
          deviceId,
          kind: error instanceof Error ? error.name : typeof error,
        }),
      );
  });
  // End and cancel name an attempt by id: the device must still reach that call's agent.
  const deviceReaches = async (ctx: AppRequest, row: CallAttemptRow) => {
    const c = row.conversation_id ? await deps.getConversation(row.conversation_id) : undefined;
    return !c || ctx.identity!.agentIds.includes(c.agent_group_id);
  };
  const startCall = guarded(async (ctx) => {
    const body = await signedObject(ctx);
    const jev = body.jev ?? null;
    if (
      typeof body.conversationId !== 'string' ||
      !uuid(body.attemptId) ||
      ![null, true, false].includes(jev as null | boolean)
    )
      throw new AppCallError(400, 'bad_request');
    const c = await conversationFor(ctx, body.conversationId, deps);
    if (body.voiceProtocol !== LIVEKIT_PROTOCOL_VERSION) {
      return json(ctx.res, 426, {
        error: 'protocol',
        protocol: LIVEKIT_PROTOCOL_VERSION,
        message: messages.protocol,
      });
    }
    const url = appConfig().livekitUrl;
    if (!url) throw new AppCallError(503, 'voice_offline');
    const voice = runningVoice();
    const { userId, deviceId } = ctx.identity!;
    const id = body.attemptId;
    const key = JSON.stringify([userId, id]);
    const pending = opening.get(key);
    if (pending) await pending.catch(() => undefined);
    let opened: { platform: string; callId: string } | undefined;
    const run = async () => {
      const now = Date.now();
      const inserted = await getDb().run(
        `INSERT INTO app_call_attempts (user_id, attempt_id, device_id, conversation_id, state, jev, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'opening', ?, ?, ?) ON CONFLICT (user_id, attempt_id) DO NOTHING`,
        userId,
        id,
        deviceId,
        c.id,
        jev === null ? null : Number(jev),
        now,
        now,
      );
      let row = (await attempt(userId, id))!;
      if (row.conversation_id && row.conversation_id !== c.id) throw new AppCallError(409, 'attempt_conflict');
      if (row.state === 'stopped') throw new AppCallError(409, 'stopped');
      const line = await ownLine(c, true);
      if (!line) throw new AppCallError(403, 'no_line');
      const platform = linePlatformId(line.line_id);
      if (!inserted.changes && !row.call_id) throw new AppCallError(409, 'stopped');
      const result = row.call_id
        ? await voice.resumeAppCall(platform, row.call_id, url)
        : await voice.startAppCall(
            platform,
            url,
            (jev === null ? lineRunsJev(platform) : jev === true) && !!JEV_API_KEY,
            async () => {
              if ((await attempt(userId, id))?.state !== 'opening') return false;
              return !!(await bindVoiceModeLineChat({
                agentGroupId: c.agent_group_id,
                callerUserId: userId,
                messagingGroupId: c.messaging_group_id,
                threadId: null,
              }));
            },
          );
      if (!result.ok) {
        if ((await attempt(userId, id))?.state === 'stopped') throw new AppCallError(409, 'stopped');
        await getDb().run(
          "UPDATE app_call_attempts SET state = 'stopped', updated_at = ? WHERE user_id = ? AND attempt_id = ?",
          Date.now(),
          userId,
          id,
        );
        if (result.error === 'limit') {
          ctx.res.setHeader('Retry-After', result.retryAfter);
          return json(ctx.res, 429, { error: 'limit', message: messages.limit, retryAfter: Number(result.retryAfter) });
        }
        const error = result.error.replaceAll('-', '_');
        throw new AppCallError(result.error === 'no-line' ? 403 : result.error === 'room' ? 502 : 409, error);
      }
      opened = { platform, callId: result.grant.callId };
      await getDb().run(
        "UPDATE app_call_attempts SET call_id = ?, state = CASE WHEN state = 'opening' THEN 'live' ELSE state END, updated_at = ? WHERE user_id = ? AND attempt_id = ?",
        result.grant.callId,
        Date.now(),
        userId,
        id,
      );
      row = (await attempt(userId, id))!;
      if (row.state === 'stopped') {
        await stop(row, reasonText(row.reason));
        throw new AppCallError(409, 'stopped');
      }
      json(ctx.res, 200, { ...result.grant, attemptId: id });
    };
    const work = run().catch(async (err: unknown) => {
      await getDb().run(
        "UPDATE app_call_attempts SET state = 'stopped', updated_at = ? WHERE user_id = ? AND attempt_id = ? AND conversation_id = ? AND state = 'opening'",
        Date.now(),
        userId,
        id,
        c.id,
      );
      // A call that opened but could not be recorded has no id the app can end it by.
      if (opened) await voice.endAppCall(opened.platform, opened.callId, 'call setup failed').catch(() => undefined);
      throw err;
    });
    opening.set(key, work);
    try {
      await work;
    } finally {
      if (opening.get(key) === work) opening.delete(key);
    }
  });
  const endCall = guarded(async (ctx) => {
    const body = await signedObject(ctx);

    const row = await getDb().get<CallAttemptRow>(
      'SELECT * FROM app_call_attempts WHERE user_id = ? AND call_id = ?',
      ctx.identity!.userId,
      ctx.params.callId,
    );
    if (!row || !(await deviceReaches(ctx, row))) throw new AppCallError(404, 'not_found');
    if (row.state !== 'stopped') {
      await getDb().run(
        "UPDATE app_call_attempts SET state = 'stopped', reason = ?, updated_at = ? WHERE user_id = ? AND attempt_id = ?",
        normalizedReason(body.reason),
        Date.now(),
        row.user_id,
        row.attempt_id,
      );
      await stop(row, reasonText(body.reason));
    }
    ctx.res.writeHead(204);
    ctx.res.end();
  });
  const cancelCallAttempt = guarded(async (ctx) => {
    const body = await signedObject(ctx);
    if (!uuid(ctx.params.attemptId)) throw new AppCallError(400, 'bad_request');
    const { userId, deviceId } = ctx.identity!;
    const existing = await attempt(userId, ctx.params.attemptId);
    if (existing && !(await deviceReaches(ctx, existing))) throw new AppCallError(404, 'not_found');
    const now = Date.now();
    await getDb().run(
      `INSERT INTO app_call_attempts (user_id, attempt_id, device_id, state, reason, created_at, updated_at)
      VALUES (?, ?, ?, 'stopped', ?, ?, ?) ON CONFLICT (user_id, attempt_id) DO UPDATE SET state = 'stopped', reason = excluded.reason, updated_at = excluded.updated_at`,
      userId,
      ctx.params.attemptId,
      deviceId,
      normalizedReason(body.reason),
      now,
      now,
    );
    await stop((await attempt(userId, ctx.params.attemptId))!, reasonText(body.reason));
    ctx.res.writeHead(204);
    ctx.res.end();
  });
  return { startCall, endCall, cancelCallAttempt };
}
export const callDeps: CallDeps = {
  getConversation: (id) => getConversation(id),
  setAppHooks,
  onDeviceRevoked: (listener) => onDeviceRevoked(listener),
};
export const { startCall, endCall, cancelCallAttempt } = createCallHandlers(callDeps);
