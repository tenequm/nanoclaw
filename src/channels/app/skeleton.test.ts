import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
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
import { readAppConfig, configuredFeatures } from './config.js';
import fixtures from './app-contract.fixtures.json' with { type: 'json' };

vi.mock('../../webhook-server.js', () => ({ registerRootHandler: vi.fn() }));
let databaseDirectory: string | undefined;
afterEach(async () => {
  await closeDb();
  if (databaseDirectory) rmSync(databaseDirectory, { recursive: true, force: true });
  databaseDirectory = undefined;
  vi.restoreAllMocks();
});

async function request(method: string, target: string) {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = target;
  const res = new ServerResponse(req);
  let output = '';
  vi.spyOn(res, 'end').mockImplementation(((body: string) => {
    output = body;
    return res;
  }) as typeof res.end);
  await dispatchApp({ req, res, params: {} });
  return { status: res.statusCode, body: JSON.parse(output) };
}
it('serves hello with the contract shape without credentials', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(fixtures.hello.serverTime);
  expect(await request('GET', '/app/hello')).toEqual({ status: 200, body: { ...fixtures.hello, features: [] } });
});
it.each(routes.filter((r) => !['N0', 'N3'].includes(r.lane)))('$method $path is an explicit stub', async (route) => {
  expect(await request(route.method, route.path.replace(/:[A-Za-z]+/g, 'test'))).toEqual({
    status: 501,
    body: { error: 'not_implemented', message: `This feature is awaiting ${route.lane}.` },
  });
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
  expect(configuredFeatures(config)).toEqual(['files', 'calls', 'voice-picker', 'push']);
  expect(config.ticketKey).toHaveLength(32);
  expect(config.ticketKey).not.toEqual(Buffer.alloc(32, 7));
  expect(config.apns.production).toBeNull();
  expect(config.apns.topic).toBe('com.tenequm.HeyDan');
});
