import { appendEvent, appTransaction } from './log.js';
import * as apns from './apns.js';
import type { Message } from './contract.js';
import * as deviceAuth from '../../modules/device-auth/verify.js';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initDb, closeDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { getRegisteredMigrations, runMigrations } from '../../db/migrations/index.js';
import type { EventRow } from './db.js';
import { pushTokenHandler, subscribePush, type PushDependencies } from './push.js';
import { readAppConfig, resetAppConfigCache } from './config.js';
import fixtures from './app-contract.fixtures.json' with { type: 'json' };
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let db: DbDriver;
let directory: string;
let event: (event: EventRow) => void;
let stop: (() => void) | undefined;
let deps: PushDependencies;
vi.mock('../../env.js', async (original) => ({
  ...(await original<typeof import('../../env.js')>()),
  envValue: (key: string) => process.env[key],
}));
vi.mock('./apns.js', () => ({ sendPush: vi.fn(async () => ({ status: 200, clearToken: false })) }));
const send = vi.fn(async () => ({ status: 200, clearToken: false }));
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'app-push-'));
  db = await initDb(join(directory, 'test.db'), { role: 'test' });
  await runMigrations(
    db,
    getRegisteredMigrations().filter((migration) => migration.name !== 'module:app:push-topic'),
  );
  send.mockClear();
  deps = {
    onEventAppended: (listener) => {
      event = listener;
      return vi.fn();
    },
    badgeFor: async (_user, ids) => ({ kind: 'badge', rev: 1, unreadTotal: ids.length === 1 ? 3 : 7 }),
    plainPreview: (text) => text,
  };
  vi.spyOn(deviceAuth, 'liveDevices').mockImplementation(async () =>
    ['first', 'second', 'other', 'revoked', 'empty'].map((id) => ({
      id,
      user_id: 'user',
      revoked_at: id === 'revoked' ? 1 : null,
      name: '',
      public_key: '',
      app_json: '',
      created_at: 0,
      last_seen_at: null,
    })),
  );
  vi.spyOn(deviceAuth, 'reachableAgentIds').mockImplementation(async (id) =>
    id === 'other' ? ['ag_other'] : ['ag_taylor', ...(id === 'second' ? ['ag_extra'] : [])],
  );
  for (const id of ['first', 'second', 'other', 'revoked'])
    await db.run(
      'INSERT INTO app_push_tokens (device_id, token, environment, updated_at) VALUES (?, ?, ?, ?)',
      id,
      id,
      'sandbox',
      1,
    );
  await runMigrations(db);
  vi.stubEnv('APP_APNS_TOPIC', 'com.example.client');
  vi.stubEnv('APP_APNS_TOPICS', ` com.example.extra, ${fixtures.pushTokenRequest.topic} , `);
});
afterEach(async () => {
  stop?.();
  stop = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetAppConfigCache();
  await closeDb();
  rmSync(directory, { recursive: true, force: true });
});
function start(overrides: Parameters<typeof subscribePush>[1] = {}) {
  stop = subscribePush(deps, {
    db: () => db,
    config: () => ({ ...readAppConfig(), publicBase: 'https://app.example.com' }),
    send,
    agent: async () => ({
      id: 'ag_taylor',
      name: 'Taylor',
      folder: 'taylor',
      agent_provider: 'claude',
      created_at: '',
    }),
    ...overrides,
  });
}
function emit(entity: unknown = fixtures.messages.agentWithFiles, kind = 'message') {
  event({
    seq: 2102,
    user_id: 'user',
    agent_group_id: 'ag_taylor',
    conversation_id: 'conv_taylor01',
    entity_id: 'msg_2102',
    kind,
    entity_json: JSON.stringify(entity),
    created_at: 0,
  });
}
it('pushes to an upgraded device and a beta installation with their own topics and badges', async () => {
  expect(await register(fixtures.pushTokenRequest, 'second')).toBe(204);
  start();
  emit();
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  const calls = send.mock.calls as unknown as Array<[unknown, string, typeof fixtures.pushPayload.body]>;
  expect(calls).toEqual(
    expect.arrayContaining([
      [{ token: 'first', environment: 'sandbox', topic: 'com.example.client' }, 'msg_2102', fixtures.pushPayload.body],
      [
        fixtures.pushTokenRequest,
        'msg_2102',
        { ...fixtures.pushPayload.body, aps: { ...fixtures.pushPayload.body.aps, badge: 7 } },
      ],
    ]),
  );
});
it.each(['/', '///'])('normalizes the push host with trailing %s', async (suffix) => {
  vi.stubEnv('APP_PUBLIC_BASE', `https://app.example.com${suffix}`);
  start({ config: () => readAppConfig() });
  emit();
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  for (const call of send.mock.calls as unknown as Array<[unknown, string, typeof fixtures.pushPayload.body]>)
    expect(call[2].hd.h).toBe('https://app.example.com');
});
it('ignores updates, reactions, host and voice lines but pushes questions', async () => {
  expect(await register(fixtures.pushTokenRequest, 'second')).toBe(204);
  start();
  const message = fixtures.messages.agentWithFiles;
  emit({ ...message, seq: message.seq + 1 });
  emit({ ...message, seq: message.seq + 2, reactions: [{ emoji: 'x', by: 'user' }] });
  for (const role of ['user', 'host']) emit({ ...message, role });
  for (const voice of ['caller', 'spoken']) emit({ ...message, voice });
  emit(fixtures.questions.open, 'question');
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  for (const call of send.mock.calls as unknown as Array<[unknown, string, typeof fixtures.pushPayload.body]>)
    expect(call[2].hd.k).toBe('question');
  expect(send).toHaveBeenCalledWith(fixtures.pushTokenRequest, fixtures.questions.open.id, expect.anything());
});
it('clears rejected and revoked tokens', async () => {
  start({ send: async () => ({ status: 410, clearToken: true, reason: 'Unregistered' }) });
  emit();
  await vi.waitFor(async () =>
    expect(await db.get('SELECT * FROM app_push_tokens WHERE device_id = ?', 'first')).toBeUndefined(),
  );
  await db.run(
    "INSERT INTO device_auth_devices (id,user_id,name,public_key,app_json,created_at) VALUES ('other','user','Test','test','{}',0)",
  );
  expect(await deviceAuth.revokeDevice('other')).toBe('revoked');
  await vi.waitFor(async () =>
    expect(await db.get('SELECT * FROM app_push_tokens WHERE device_id = ?', 'other')).toBeUndefined(),
  );
});
it('warns once without public base and never sends', async () => {
  const warn = vi.fn();
  start({ config: () => readAppConfig(() => undefined), warn });
  emit();
  emit();
  await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
  expect(send).not.toHaveBeenCalled();
});
async function register(input: unknown, deviceId = 'first') {
  const req = new IncomingMessage(new Socket());
  req.headers.authorization = fixtures.signing.vectors[0].authorization;
  const res = new ServerResponse(req);
  vi.spyOn(res, 'end').mockImplementation(() => res);
  await pushTokenHandler(
    () => db,
    async () => Buffer.from(JSON.stringify(input)),
  )({ req, res, params: {}, identity: { deviceId, userId: 'user', agentIds: ['ag_taylor'] } });
  return res.statusCode;
}
it('stores the fixture, transfers duplicate tokens atomically and accepts simulator lengths', async () => {
  expect(await register(fixtures.pushTokenRequest)).toBe(204);
  expect(await register(fixtures.pushTokenRequest, 'second')).toBe(204);
  expect(await db.get('SELECT * FROM app_push_tokens WHERE device_id = ?', 'first')).toBeUndefined();
  expect(await db.get('SELECT token, environment, topic FROM app_push_tokens WHERE device_id = ?', 'second')).toEqual(
    fixtures.pushTokenRequest,
  );
  expect(await register({ token: 'ab'.repeat(80), environment: 'production' })).toBe(204);
});
it.each([undefined, 'com.example.unlisted'])('falls back when re-registering with topic %s', async (topic) => {
  expect(await register(fixtures.pushTokenRequest)).toBe(204);
  expect(await register({ ...fixtures.pushTokenRequest, topic })).toBe(204);
  start();
  emit();
  await vi.waitFor(() =>
    expect(send).toHaveBeenCalledWith(
      { ...fixtures.pushTokenRequest, topic: 'com.example.client' },
      expect.any(String),
      expect.anything(),
    ),
  );
});
it('uses the default when a registered topic leaves the allowlist', async () => {
  expect(await register(fixtures.pushTokenRequest)).toBe(204);
  vi.stubEnv('APP_APNS_TOPICS', '');
  start();
  emit();
  await vi.waitFor(() =>
    expect(send).toHaveBeenCalledWith(
      { ...fixtures.pushTokenRequest, topic: 'com.example.client' },
      expect.any(String),
      expect.anything(),
    ),
  );
});
it.each([
  null,
  {},
  { token: 'ab'.repeat(15), environment: 'sandbox' },
  { token: 'ab'.repeat(513), environment: 'sandbox' },
  { token: 'A'.repeat(64), environment: 'sandbox' },
  { token: 'a'.repeat(33), environment: 'sandbox' },
  { token: 'ab'.repeat(32), environment: 'test' },
])('rejects malformed registration %#', async (input) => {
  expect(await register(input)).toBe(400);
});
it('rechecks access after queued work and bounds sends in flight', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = vi.fn(async () => {
    await held;
    return { status: 200, clearToken: false };
  });
  start({ send: slow, concurrency: 1 });
  emit();
  await vi.waitFor(() => expect(slow).toHaveBeenCalledTimes(1));
  vi.mocked(deviceAuth.reachableAgentIds).mockImplementation(async () => []);
  release();
  await vi.waitFor(() => expect(slow).toHaveResolvedTimes(1));
  expect(slow).toHaveBeenCalledTimes(1);
});
it('preserves a topic-only replacement while a rejection is in flight', async () => {
  const replacement = fixtures.pushTokenRequest.topic;
  start({
    concurrency: 1,
    send: async () => {
      await db.run("UPDATE app_push_tokens SET topic = ? WHERE device_id = 'first'", replacement);
      return { status: 400, clearToken: true, reason: 'DeviceTokenNotForTopic' };
    },
  });
  emit();
  await vi.waitFor(async () => {
    expect(await db.get("SELECT token FROM app_push_tokens WHERE device_id = 'second'")).toBeUndefined();
    expect(await db.get("SELECT topic FROM app_push_tokens WHERE device_id = 'first'")).toEqual({ topic: replacement });
  });
});
it('preserves a registration replaced while a rejection was in flight', async () => {
  start({
    send: async () => {
      await db.run('UPDATE app_push_tokens SET token = ?, updated_at = 2 WHERE device_id = ?', 'replacement', 'first');
      return { status: 400, clearToken: true, reason: 'BadDeviceToken' };
    },
  });
  emit();
  await vi.waitFor(async () =>
    expect(await db.get('SELECT token FROM app_push_tokens WHERE device_id = ?', 'first')).toEqual({
      token: 'replacement',
    }),
  );
});
it('bounds backlog when sends stall and reports overflow once', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const warn = vi.fn();
  start({
    send: async () => {
      await held;
      return { status: 200, clearToken: false };
    },
    capacity: 2,
    concurrency: 1,
    warn,
  });
  for (let i = 0; i < 20; i++) emit();
  expect(warn).toHaveBeenCalledExactlyOnceWith('QueueFull');
  stop?.();
  release();
});

it('rechecks access after badge lookup before sending', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const badge = vi.fn(async () => {
    await held;
    return { kind: 'badge' as const, rev: 1, unreadTotal: 3 };
  });
  deps.badgeFor = badge;
  const access = vi.mocked(deviceAuth.reachableAgentIds);
  start();
  emit();
  await vi.waitFor(() => expect(badge).toHaveBeenCalledTimes(2));
  access.mockImplementation(async () => []);
  release();
  await vi.waitFor(() => expect(access).toHaveBeenCalledTimes(6));
  expect(send).not.toHaveBeenCalled();
});
it('logs rejected sends and actual token removals without payloads or tokens', async () => {
  const warn = vi.fn();
  start({ warn, send: async () => ({ status: 410, reason: 'Unregistered', clearToken: true }) });
  emit();
  await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(4));
  for (const deviceId of ['first', 'second']) {
    const fields = { deviceId, entityId: 'msg_2102', environment: 'sandbox', status: 410, reason: 'Unregistered' };
    expect(warn).toHaveBeenCalledWith('PushRejected', fields);
    expect(warn).toHaveBeenCalledWith('PushTokenCleared', fields);
  }
});

it('queues committed agent messages through the module-level push subscription', async () => {
  vi.stubEnv('APP_PUBLIC_BASE', 'https://app.example.com');
  await db.run("INSERT INTO agent_groups (id,name,folder,created_at) VALUES ('ag_taylor','Taylor','taylor','now')");
  vi.mocked(apns.sendPush).mockClear();
  const message = { ...fixtures.messages.agentMarkdown, seq: 0, order: 0 } as Message;
  await appTransaction(() => appendEvent(db, 'user', 'ag_taylor', message));
  await vi.waitFor(() => expect(apns.sendPush).toHaveBeenCalledTimes(2));
  expect(apns.sendPush).toHaveBeenCalledWith(
    { token: 'first', environment: 'sandbox', topic: 'com.example.client' },
    message.id,
    expect.objectContaining({
      hd: expect.objectContaining({ m: message.id, k: 'message', a: { id: 'ag_taylor', name: 'Taylor' } }),
    }),
  );
});
