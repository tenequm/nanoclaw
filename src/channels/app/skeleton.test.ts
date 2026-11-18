import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { canonicalSigningText } from './contract.js';
import { consumeRateLimit } from '../../modules/device-auth/rate-limit.js';
import { onDeviceRevoked } from '../../modules/device-auth/verify.js';
import { Socket } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { closeDb, initDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { schemaTables as appTables } from './db.js';
import { schemaTables as deviceTables } from '../../modules/device-auth/db.js';
import { routes, dispatchApp } from './routes.js';
import { registerRootHandler } from '../../webhook-server.js';
import { createAppAdapter } from './index.js';
import { getRegisteredChannelNames } from '../channel-registry.js';
import { readAppConfig, configuredFeatures, resetAppConfigCache } from './config.js';
import { envValue } from '../../env.js';
import fixtures from './app-contract.fixtures.json' with { type: 'json' };

vi.mock('../../webhook-server.js', () => ({ registerRootHandler: vi.fn() }));
vi.mock('../../env.js', async (original) => {
  const env = await original<typeof import('../../env.js')>();
  return { ...env, envValue: vi.fn(env.envValue) };
});
let databaseDirectory: string | undefined;
afterEach(async () => {
  await closeDb();
  if (databaseDirectory) rmSync(databaseDirectory, { recursive: true, force: true });
  databaseDirectory = undefined;
  vi.restoreAllMocks();
});

async function request(method: string, target: string, peer = '127.0.0.1', authorization?: string, body?: unknown) {
  const req = new IncomingMessage(new Socket());
  Object.defineProperty(req.socket, 'remoteAddress', { value: peer });
  req.method = method;
  req.url = target;
  if (authorization) req.headers.authorization = authorization;
  if (body !== undefined) {
    req.push(JSON.stringify(body));
    req.push(null);
  }
  const res = new ServerResponse(req);
  let output = '';
  vi.spyOn(res, 'end').mockImplementation(((body: string) => {
    output = body ?? '';
    return res;
  }) as typeof res.end);
  await dispatchApp({ req, res, params: {} });
  return {
    status: res.statusCode,
    body: output ? JSON.parse(output) : null,
    ...(res.getHeader('Retry-After') ? { retryAfter: res.getHeader('Retry-After') } : {}),
  };
}
it('serves hello with the contract shape without credentials', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(fixtures.hello.serverTime);
  expect(await request('GET', '/app/hello')).toEqual({ status: 200, body: { ...fixtures.hello, features: [] } });
});
it('reads the configuration for unsigned hello requests at most once a minute', async () => {
  resetAppConfigCache();
  const now = vi.spyOn(performance, 'now').mockReturnValue(1_000_000);
  vi.mocked(envValue).mockClear();
  await request('GET', '/app/hello');
  const reads = vi.mocked(envValue).mock.calls.length;
  expect(reads).toBeGreaterThan(0);
  await request('GET', '/app/hello');
  now.mockReturnValue(1_059_999);
  await request('GET', '/app/hello');
  expect(vi.mocked(envValue)).toHaveBeenCalledTimes(reads);
  now.mockReturnValue(1_060_000);
  await request('GET', '/app/hello');
  expect(vi.mocked(envValue)).toHaveBeenCalledTimes(reads * 2);
});
it.each(routes.filter((route) => route.signed))('$method $path requires a signature', async (route) => {
  const db = await initDb(':memory:', { role: 'test' });
  await runMigrations(db);
  expect(await request(route.method, route.path.replace(/:[A-Za-z]+/g, 'test'))).toEqual(fixtures.errors.badSignature);
});
it('refuses a non-loopback peer', async () => {
  expect((await request('GET', '/app/hello', '192.168.1.2')).status).toBe(403);
});
it('rejects unknown routes and methods without reading a body', async () => {
  expect((await request('POST', '/app/hello')).status).toBe(404);
  expect((await request('GET', '/app/hellox')).status).toBe(404);
});
it('registers the adapter and safely accepts an offline stub delivery', async () => {
  expect(getRegisteredChannelNames()).toContain('app');
  const adapter = createAppAdapter();
  expect(adapter.isConnected()).toBe(false);
  await adapter.setup({ onInbound: vi.fn(), onInboundEvent: vi.fn(), onMetadata: vi.fn(), onAction: vi.fn() });
  expect(registerRootHandler).toHaveBeenCalledWith('app', expect.any(Function));
  expect(adapter.isConnected()).toBe(true);
  await adapter.teardown();
  expect(adapter.isConnected()).toBe(false);
  await expect(adapter.deliver('conv_test', null, { kind: 'text', content: 'test' })).resolves.toBeUndefined();
});
it('applies all schemas across boots and enforces durable deduplication', async () => {
  databaseDirectory = mkdtempSync(join(tmpdir(), 'app-schema-'));
  const target = join(databaseDirectory, 'test.db');
  let db = await initDb(target, { role: 'test' });
  await runMigrations(db);
  for (const table of [...appTables, ...deviceTables]) expect(await db.hasTable(table)).toBe(true);
  await db.run(
    'INSERT INTO device_auth_nonces (device_id, nonce, signed_at, expires_at) VALUES (?, ?, ?, ?)',
    'd',
    'n',
    1,
    121,
  );
  await closeDb();
  db = await initDb(target, { role: 'test' });
  await runMigrations(db);
  await expect(
    db.run(
      'INSERT INTO device_auth_nonces (device_id, nonce, signed_at, expires_at) VALUES (?, ?, ?, ?)',
      'd',
      'n',
      1,
      121,
    ),
  ).rejects.toThrow();
  expect(await db.all('SELECT device_id, nonce FROM device_auth_nonces')).toEqual([{ device_id: 'd', nonce: 'n' }]);
});
it('advertises only configured features and derives a domain-separated ticket key', () => {
  expect(configuredFeatures(readAppConfig(() => undefined))).toEqual([]);
  const env: Record<string, string> = {
    NANOCLAW_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    APP_LIVEKIT_URL: 'wss://example.test',
    APP_APNS_TEAM_ID: 'team',
    APP_APNS_SANDBOX_KEY_ID: 'key',
    APP_APNS_SANDBOX_KEY_PATH: '/test.p8',
  };
  const config = readAppConfig((key) => env[key]);
  expect(configuredFeatures(config)).toEqual(['files', 'calls', 'voice-picker']);
  expect(config.ticketKey).toHaveLength(32);
  expect(config.ticketKey).not.toEqual(Buffer.alloc(32, 7));
  expect(config.apns.production).toBeNull();
  expect(config.apns.topic).toBeNull();
});

it('passes a signed fixture and identity to its handler and contains unexpected failures', async () => {
  const db = await initDb(':memory:', { role: 'test' });
  await runMigrations(db);
  const vector = fixtures.signing.vectors[0];
  vi.spyOn(Date, 'now').mockReturnValue(fixtures.hello.serverTime);
  await db.run(
    'INSERT INTO device_auth_devices (id,user_id,name,public_key,app_json,created_at) VALUES (?,?,?,?,?,?)',
    vector.deviceId,
    'u',
    'test',
    fixtures.testKey.publicKeySpki,
    '{}',
    1,
  );
  const route = routes.find((route) => route.path === vector.target.split('?')[0] && route.method === vector.method)!;
  const handler = vi.spyOn(route, 'handler').mockImplementation(async ({ identity, res }) => {
    expect(identity).toEqual({ deviceId: vector.deviceId, userId: 'u', agentIds: [] });
    res.end('{}');
  });
  expect((await request(vector.method, vector.target, undefined, vector.authorization)).status).toBe(200);
  expect(handler).toHaveBeenCalledOnce();
  await db.run('DELETE FROM device_auth_nonces');
  handler.mockRejectedValue(new Error('private failure detail'));
  expect(await request(vector.method, vector.target, undefined, vector.authorization)).toEqual({
    status: 500,
    body: { error: 'internal', message: 'The request could not be completed.' },
  });
});
it('returns Retry-After through dispatch', async () => {
  const db = await initDb(':memory:', { role: 'test' });
  await runMigrations(db);
  vi.spyOn(Date, 'now').mockReturnValue(fixtures.hello.serverTime);
  for (let i = 0; i < 10; i++) await consumeRateLimit('pair:127.0.0.1', 10, 600000);
  expect(await request('POST', '/app/pair')).toMatchObject({
    status: 429,
    retryAfter: '600',
    body: { error: 'rate_limited', retryAfter: 600 },
  });
});
it('pairs, revokes through dispatch, then refuses the revoked device', async () => {
  const db = await initDb(':memory:', { role: 'test' });
  await runMigrations(db);
  await db.run(
    'INSERT INTO device_auth_pairing_codes (code_hash,user_id,agent_ids_json,created_at,expires_at) VALUES (?,?,?,?,?)',
    createHash('sha256').update(fixtures.pairLink.code).digest('hex'),
    'u',
    '[]',
    Date.now(),
    Date.now() + 600000,
  );
  const paired = await request('POST', '/app/pair', undefined, undefined, fixtures.pairRequest);
  expect(paired.status).toBe(200);
  const deviceId = paired.body.deviceId as string;
  const authorization = (method: string, target: string) => {
    const fields = {
      protocol: 1,
      method,
      target,
      ts: Math.floor(Date.now() / 1000),
      nonce: randomBytes(16).toString('base64url'),
      bodyHash: createHash('sha256').update('').digest('hex'),
      deviceId,
    };
    const signature = sign(
      'sha256',
      Buffer.from(canonicalSigningText(fields)),
      fixtures.testKey.privateKeyPkcs8Pem,
    ).toString('base64url');
    return `HeyDan-Sig v=1,p=1,d=${deviceId},t=${fields.ts},n=${fields.nonce},bh=${fields.bodyHash},s=${signature}`;
  };
  const listener = vi.fn();
  const off = onDeviceRevoked(listener);
  try {
    expect(await request('DELETE', '/app/devices/me', undefined, authorization('DELETE', '/app/devices/me'))).toEqual({
      status: 204,
      body: null,
    });
    expect(listener).toHaveBeenCalledExactlyOnceWith(deviceId);
    expect(await request('GET', '/app/conversations', undefined, authorization('GET', '/app/conversations'))).toEqual(
      fixtures.errors.deviceRevoked,
    );
  } finally {
    off();
  }
});

it('advertises push only with a public base and a usable APNs environment', () => {
  databaseDirectory = mkdtempSync(join(tmpdir(), 'app-push-config-'));
  const keyPath = join(databaseDirectory, 'test.p8');
  const config = readAppConfig(() => undefined);
  config.apns.teamId = 'team';
  config.apns.topic = 'com.example.HeyDan';
  config.apns.sandbox = { keyId: 'key', keyPath };
  config.publicBase = 'https://example.test';
  expect(configuredFeatures(config)).not.toContain('push');
  writeFileSync(keyPath, 'invalid key');
  expect(configuredFeatures(config)).not.toContain('push');
  const wrong = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey;
  writeFileSync(keyPath, wrong.export({ type: 'pkcs8', format: 'pem' }));
  expect(configuredFeatures(config)).not.toContain('push');
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  writeFileSync(keyPath, key.export({ type: 'pkcs8', format: 'pem' }));
  expect(configuredFeatures(config)).toContain('push');
  config.apns.topic = null;
  expect(configuredFeatures(config)).not.toContain('push');
  config.apns.topic = 'com.example.HeyDan';
  config.publicBase = null;
  expect(configuredFeatures(config)).not.toContain('push');
  config.publicBase = 'https://example.test';
  config.apns.production = config.apns.sandbox;
  config.apns.sandbox = { keyId: 'missing', keyPath: join(databaseDirectory, 'missing') };
  expect(configuredFeatures(config)).toContain('push');
  config.apns.teamId = null;
  expect(configuredFeatures(config)).not.toContain('push');
});
