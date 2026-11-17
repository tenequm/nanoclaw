import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../modules/device-auth/verify.js', async (original) => ({
  ...(await original<typeof import('../../modules/device-auth/verify.js')>()),
  readSignedBody: vi.fn(async (req: IncomingMessage) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }),
}));
vi.mock('../../env.js', async (original) => ({
  ...(await original<typeof import('../../env.js')>()),
  envValue: (key: string) => process.env[key],
}));
vi.mock('../../webhook-server.js', () => ({
  registerRootHandler: vi.fn(),
  registerWebhookHandler: vi.fn(),
  registerUpgradeHandler: vi.fn(),
}));
vi.mock('../../secret-seal.js', async (original) => ({
  ...(await original<typeof import('../../secret-seal.js')>()),
  encryptionKey: () => Buffer.alloc(32, 7),
}));
const state = vi.hoisted(() => ({ adapter: undefined as unknown }));
vi.mock('../voice-mode-chat.js', async (original) => ({
  ...(await original<typeof import('../voice-mode-chat.js')>()),
  liveVoiceAdapter: () => state.adapter,
}));
import { initTestDb, runMigrations, closeDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createUser } from '../../modules/permissions/db/users.js';
import { grantRole } from '../../modules/permissions/db/user-roles.js';
import { getVoiceModeLineForAgent, bindVoiceModeLineChat, openVoiceModeLink } from '../../db/voice-mode-lines.js';
import { createVoiceModeAdapter, type VoiceModeChannelAdapter } from '../voice-mode.js';
import { createVoiceCatalog } from '../voice-mode-tts-catalog.js';
import { createCallHandlers, callAvailability, callDeps, startCall } from './calls.js';
import { readSignedBody } from '../../modules/device-auth/verify.js';
import { createVoiceHandlers } from './voice.js';
import type { AppHandler } from './routes.js';
import type { ConversationRow } from './db.js';
import './db.js';
import type { MessagingGroup } from '../../types.js';
import fixtures from './app-contract.fixtures.json' with { type: 'json' };
import tts from '../voice-mode-tts.fixtures.json' with { type: 'json' };

const c: ConversationRow = {
  id: 'conv_test',
  user_id: 'telegram:test',
  agent_group_id: 'ag-test',
  messaging_group_id: 'mg-test',
  seq: 1,
  last_message_json: null,
  created_at: 1,
};
const group = {
  id: c.messaging_group_id,
  channel_type: 'app',
  platform_id: c.id,
  name: 'Stan (app)',
  is_group: 0,
  instance: 'app',
} as MessagingGroup;
const deps = { getConversation: async (id: string) => (id === c.id ? c : undefined), setAppHooks: vi.fn() };
let adapter: VoiceModeChannelAdapter;
let handlers: ReturnType<typeof createCallHandlers>;
let picker: ReturnType<typeof createVoiceHandlers>;
let gate: Promise<void> | null;
let rooms: number;
let failRoom: boolean;
let deleted: number;
let chatPresent: boolean;
const requestBody = { conversationId: c.id, attemptId: fixtures.callGrant.attemptId, voiceProtocol: 6, jev: null };
async function request(
  handler: AppHandler,
  body?: unknown,
  params: Record<string, string> = {},
  agents = [c.agent_group_id],
  method = 'POST',
  url = '/',
) {
  let status = 0,
    text = '';
  const headers: Record<string, unknown> = {};
  const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
    headers: {
      authorization: fixtures.signing.vectors[0].authorization.replace(
        /bh=[a-f0-9]+/,
        `bh=${createHash('sha256')
          .update(body === undefined ? '' : JSON.stringify(body))
          .digest('hex')}`,
      ),
    },
    method,
    url,
  }) as IncomingMessage;
  const res = {
    setHeader: (k: string, v: unknown) => {
      headers[k] = v;
    },
    writeHead: (s: number) => {
      status = s;
    },
    end: (s = '') => {
      text = s;
    },
  } as unknown as ServerResponse;
  await handler({ req, res, params, identity: { userId: c.user_id, deviceId: 'dev-test', agentIds: agents } });
  return { status, body: text ? JSON.parse(text) : null, headers };
}
beforeEach(async () => {
  vi.stubEnv('APP_LIVEKIT_URL', 'wss://lk.opx.one');
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: c.agent_group_id,
    name: 'Stan',
    folder: 'n5-test',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await createUser({ id: c.user_id, kind: 'telegram', display_name: 'Tester', created_at: new Date().toISOString() });
  await grantRole({
    user_id: c.user_id,
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: new Date().toISOString(),
  });
  chatPresent = true;
  gate = null;
  rooms = 0;
  deleted = 0;
  failRoom = false;
  adapter = createVoiceModeAdapter({
    publicUrl: 'http://127.0.0.1:4800',
    maxCallsPerHour: 1,
    providerKeys: { gemini: 'test' },
    catalog: createVoiceCatalog({
      keys: { gemini: 'test' },
      fetch: vi.fn(async (input) => {
        if (new URL(input instanceof Request ? input.url : String(input)).searchParams.get('page_size') === '2')
          return Response.json({
            voices: tts.catalogGemini.voices.map((v) => ({
              id: v.id,
              display_name: v.name,
              language_code: v.language,
              gender: v.gender,
              description: v.description,
            })),
            next_page_token: 'p100',
          });
        return Response.json({
          voices: [
            { id: 'en-us-techagent-4', display_name: 'Tech Advisor 4', language_code: 'en-US', gender: 'male' },
            { id: 'achernar', display_name: 'Achernar', language_code: 'en-US', gender: 'female' },
            { id: 'alnilam', display_name: 'Alnilam', language_code: 'en-US', gender: 'male' },
          ],
        });
      }),
    }),
    livekit: {
      url: 'ws://127.0.0.1:4802',
      apiKey: 'test',
      apiSecret: 'test-secret',
      api: {
        async createRoom() {
          rooms++;
          await gate;
          if (failRoom) throw new Error('room');
          return {};
        },
        async deleteRoom() {
          deleted++;
        },
        async createDispatch() {
          return {};
        },
        async updateRoomMetadata() {},
      },
      mirrorApi: {
        boundChat: async () => (chatPresent ? { group, threadId: null } : null),
        groupsFor: async () => [group],
        adapter: () => undefined,
      },
    },
  });
  state.adapter = adapter;
  await adapter.setup({ onInbound: vi.fn(), onInboundEvent: vi.fn(), onMetadata: vi.fn(), onAction: vi.fn() });
  handlers = createCallHandlers(deps);
  picker = createVoiceHandlers(deps);
});
afterEach(async () => {
  await adapter.teardown();
  await closeDb();
  vi.unstubAllEnvs();
});
it('opens once concurrently, retries with a fresh token and ends idempotently', async () => {
  const [a, b] = await Promise.all([
    request(handlers.startCall, requestBody),
    request(handlers.startCall, requestBody),
  ]);
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  expect(rooms).toBe(1);
  expect(a.body.callId).toBe(b.body.callId);
  expect(a.body.token === b.body.token).toBe(false);
  expect(a.body).toMatchObject({
    protocol: 6,
    url: fixtures.callGrant.url,
    agent: 'Stan',
    attemptId: requestBody.attemptId,
  });
  const line = (await getVoiceModeLineForAgent(c.agent_group_id))!;
  expect(line.messaging_group_id).toBe(c.messaging_group_id);
  expect('token' in (await openVoiceModeLink(line, Buffer.alloc(32, 7)))).toBe(true);
  expect((await request(handlers.endCall, { reason: 'hangup' }, { callId: a.body.callId })).status).toBe(204);
  expect((await request(handlers.endCall, { reason: 'hangup' }, { callId: a.body.callId })).status).toBe(204);
  expect(await request(handlers.startCall, requestBody)).toMatchObject(fixtures.callErrors.stopped);
});
it('cancels during room setup and before a late start', async () => {
  let release!: () => void;
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const starting = request(handlers.startCall, requestBody);
  await vi.waitFor(() => expect(rooms).toBe(1));
  expect(
    (await request(handlers.cancelCallAttempt, { reason: 'no-agent' }, { attemptId: requestBody.attemptId })).status,
  ).toBe(204);
  release();
  expect((await starting).body.error).toBe('stopped');
  expect(deleted).toBe(1);
  const id = '11111111-1111-4111-8111-111111111111';
  await request(handlers.cancelCallAttempt, { reason: 'hangup' }, { attemptId: id });
  expect((await request(handlers.startCall, { ...requestBody, attemptId: id })).body.error).toBe('stopped');
  expect(rooms).toBe(1);
});
it('does not rebind on a limit refusal', async () => {
  await request(handlers.startCall, requestBody);
  await bindVoiceModeLineChat({
    agentGroupId: c.agent_group_id,
    callerUserId: c.user_id,
    messagingGroupId: 'old-chat',
    threadId: null,
  });
  const result = await request(handlers.startCall, {
    ...requestBody,
    attemptId: '22222222-2222-4222-8222-222222222222',
  });
  expect(result.status).toBe(429);
  expect(result.body).toEqual({ ...fixtures.callErrors.limit.body, retryAfter: Number(result.headers['Retry-After']) });
  expect(Number(result.headers['Retry-After'])).toBeGreaterThan(0);
  expect((await getVoiceModeLineForAgent(c.agent_group_id))?.messaging_group_id).toBe('old-chat');
});
it('enforces protocol, device scope, ownership, and room failures', async () => {
  expect(await request(handlers.startCall, { ...requestBody, voiceProtocol: 5 })).toMatchObject(
    fixtures.callErrors.protocol,
  );
  expect(await request(handlers.startCall, requestBody, {}, [])).toMatchObject(fixtures.errors.forbidden);
  failRoom = true;
  const result = await request(handlers.startCall, requestBody);
  expect(result.status).toBe(502);
  expect(result).toMatchObject(fixtures.callErrors.room);
  const { getDb } = await import('../../db/connection.js');
  await getDb().run('UPDATE voice_mode_lines SET owner_user_id = ?', 'telegram:other');
  expect((await callAvailability(c.user_id, c.agent_group_id)).callRefusal).toEqual(
    fixtures.conversationCallRefused.callRefusal,
  );
  expect((await request(picker.getVoice, undefined, { id: c.id }, undefined, 'GET')).status).toBe(403);
});
it('reads the default without creating a line, saves a voice, and protects the picker', async () => {
  const view = await request(picker.getVoice, undefined, { id: c.id }, undefined, 'GET');
  expect(view.status).toBe(200);
  expect(view.body).toEqual(tts.ttsViewNew);
  expect(await getVoiceModeLineForAgent(c.agent_group_id)).toBeUndefined();
  const saved = await request(
    picker.patchVoice,
    { provider: 'gemini', model: 'gemini-3.8-flash-lite-tts', voice: 'achernar' },
    { id: c.id },
    undefined,
    'PATCH',
  );
  expect(saved.status).toBe(200);
  expect(saved.body).toEqual(tts.ttsView);
  expect((await request(picker.getVoice, undefined, { id: c.id }, [], 'GET')).status).toBe(404);
  const invalid = await request(picker.patchVoice, { provider: 'bad' }, { id: c.id }, undefined, 'PATCH');
  expect(invalid.status).toBe(400);
  expect(invalid.body).toMatchObject({ error: 'invalid', field: 'provider', message: expect.any(String) });
});

it('returns no-chat, offline, not-found and attempt-conflict without extra rooms', async () => {
  chatPresent = false;
  const noChat = await request(handlers.startCall, requestBody);
  expect(noChat.status).toBe(409);
  expect(noChat).toMatchObject(fixtures.callErrors.noChat);
  chatPresent = true;
  const { getDb } = await import('../../db/connection.js');
  await getDb().run('UPDATE app_call_attempts SET conversation_id = ?', 'another-conversation');
  expect(await request(handlers.startCall, requestBody)).toMatchObject(fixtures.errors.attemptConflict);
  expect((await request(handlers.startCall, { ...requestBody, conversationId: 'unknown' })).status).toBe(404);
  expect((await request(handlers.endCall, { reason: 'hangup' }, { callId: 'someone-elses-call' })).status).toBe(404);
  await adapter.teardown();
  expect(await request(handlers.startCall, requestBody)).toMatchObject(fixtures.callErrors.voiceOffline);
  expect((await request(picker.getVoice, undefined, { id: c.id }, undefined, 'GET')).status).toBe(503);
});
it('shapes picker provider and query errors for paired clients', async () => {
  const result = await request(picker.listVoices, undefined, { id: c.id }, undefined, 'GET', '/?provider=elevenlabs');
  expect(result.status).toBe(503);
  expect(result.body).toMatchObject({
    error: 'provider_unavailable',
    provider: 'elevenlabs',
    message: fixtures.callErrors.providerUnavailable.body.message,
  });
  const invalid = await request(picker.listVoices, undefined, { id: c.id }, undefined, 'GET', '/?provider=bad');
  expect(invalid.status).toBe(400);
  expect(invalid).toMatchObject(fixtures.errors.badRequest);
});

it('starts through the module export with the conversation seam faked and jev omitted', async () => {
  const seam = vi.spyOn(callDeps, 'getConversation').mockImplementation(deps.getConversation);
  const auth = await vi.importActual<typeof import('../../modules/device-auth/verify.js')>(
    '../../modules/device-auth/verify.js',
  );
  vi.mocked(readSignedBody).mockImplementationOnce(auth.readSignedBody);
  try {
    const result = await request(startCall, {
      conversationId: c.id,
      attemptId: requestBody.attemptId,
      voiceProtocol: 6,
    });
    expect(result.status).toBe(200);
    expect(rooms).toBe(1);
    const { getDb } = await import('../../db/connection.js');
    expect(await getDb().get('SELECT jev FROM app_call_attempts')).toEqual({ jev: null });
  } finally {
    seam.mockRestore();
  }
});
it('ends and cancels offline, normalizing unknown and missing reasons to hangup', async () => {
  const started = await request(handlers.startCall, requestBody);
  const end = vi.spyOn(adapter, 'endAppCall');
  await adapter.teardown();
  expect((await request(handlers.endCall, { reason: 'future-reason' }, { callId: started.body.callId })).status).toBe(
    204,
  );
  expect((await request(handlers.endCall, {}, { callId: started.body.callId })).status).toBe(204);
  expect((await request(handlers.cancelCallAttempt, {}, { attemptId: requestBody.attemptId })).status).toBe(204);
  expect(end).not.toHaveBeenCalled();
  const { getDb } = await import('../../db/connection.js');
  expect(await getDb().get('SELECT state, reason FROM app_call_attempts')).toEqual({
    state: 'stopped',
    reason: 'hangup',
  });
});
it('unknown reasons end a live call with hangup grace', async () => {
  const started = await request(handlers.startCall, requestBody);
  const end = vi.spyOn(adapter, 'endAppCall');
  expect((await request(handlers.endCall, { reason: ['hangup'] }, { callId: started.body.callId })).status).toBe(204);
  expect(end).toHaveBeenCalledWith(expect.any(String), started.body.callId, 'hangup', { grace: true });
  expect((await request(handlers.cancelCallAttempt, [], { attemptId: requestBody.attemptId })).status).toBe(400);
});
it('refuses another owner and stops the failed opening attempt', async () => {
  await request(picker.patchVoice, { reset: true }, { id: c.id }, undefined, 'PATCH');
  const { getDb } = await import('../../db/connection.js');
  await getDb().run('UPDATE voice_mode_lines SET owner_user_id = ?', 'telegram:other');
  expect(await request(handlers.startCall, requestBody)).toMatchObject(fixtures.callErrors.noLine);
  expect(await getDb().get('SELECT state FROM app_call_attempts')).toEqual({ state: 'stopped' });
  expect(rooms).toBe(0);
});
it('hides real conversations and calls owned by another user', async () => {
  const started = await request(handlers.startCall, requestBody);
  const { getDb } = await import('../../db/connection.js');
  await getDb().run('UPDATE app_call_attempts SET user_id = ?', 'telegram:other');
  expect(await request(handlers.endCall, {}, { callId: started.body.callId })).toMatchObject(fixtures.errors.notFound);
  const other = createCallHandlers({ ...deps, getConversation: async () => ({ ...c, user_id: 'telegram:other' }) });
  expect(await request(other.startCall, requestBody)).toMatchObject(fixtures.errors.notFound);
});
it('lists Gemini voices in the picker fixture shape', async () => {
  const result = await request(
    picker.listVoices,
    undefined,
    { id: c.id },
    undefined,
    'GET',
    '/?provider=gemini&limit=2',
  );
  expect(result.status).toBe(200);
  expect(result.body).toEqual(tts.catalogGemini);
});

it('does not create a line on a refused picker save', async () => {
  expect((await request(picker.patchVoice, { provider: 'bad' }, { id: c.id }, undefined, 'PATCH')).status).toBe(400);
  expect(
    (
      await request(
        picker.patchVoice,
        { provider: 'elevenlabs', model: 'eleven_v4', voice: 'bIHbv24MWmeRgasZH58o' },
        { id: c.id },
        undefined,
        'PATCH',
      )
    ).status,
  ).toBe(503);
  expect(await getVoiceModeLineForAgent(c.agent_group_id)).toBeUndefined();
});
