import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { closeDb, initDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import {
  verifyRequest,
  readSignedBody,
  reachableAgentIds,
  revokeDevice,
  onDeviceRevoked,
  liveDevices,
  getLiveDevice,
} from './verify.js';
import { handlePair, mintPairingLink } from './pairing.js';
import { appPeerAllowed, clientAddress } from './gate.js';
import { resetAppConfigCache } from '../../channels/app/config.js';
import { log } from '../../log.js';
import { envValue } from '../../env.js';
import { consumeRateLimit, rateLimitAddress } from './rate-limit.js';
import f from '../../channels/app/app-contract.fixtures.json' with { type: 'json' };

vi.mock('../../env.js', () => ({ envValue: vi.fn((key: string) => process.env[key]), readEnvFile: () => ({}) }));
vi.mock('../../router.js', () => ({ registerMessageInterceptor: vi.fn() }));
const now = f.hello.serverTime;
let dir: string;
const first = f.signing.vectors[0];
function request(v = first, body?: string) {
  const req = new IncomingMessage(new Socket());
  Object.defineProperty(req.socket, 'remoteAddress', { value: '127.0.0.1', configurable: true });
  req.method = v.method;
  req.url = v.target;
  req.headers.authorization = v.authorization;
  if (body !== undefined) {
    req.push(body);
    req.push(null);
  }
  return req;
}
async function seedDevice(id = first.deviceId) {
  await getDb().run(
    'INSERT INTO device_auth_devices (id,user_id,name,public_key,app_json,created_at) VALUES (?,?,?,?,?,?)',
    id,
    'u',
    'Test',
    f.testKey.publicKeySpki,
    '{}',
    now,
  );
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'device-auth-'));
  const db = await initDb(join(dir, 'db'), { role: 'test' });
  await runMigrations(db);
  await seedDevice();
});
afterEach(async () => {
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetAppConfigCache();
});
it.each(f.signing.vectors.filter((v) => !v.name.startsWith('bad-') && !v.name.startsWith('replay-')))(
  'accepts $name',
  async (v) => {
    expect((await verifyRequest(request(v), now)).deviceId === v.deviceId).toBe(true);
    await expect(readSignedBody(request(v, v.body), v.bodyHash, 4096)).resolves.toHaveLength(Buffer.byteLength(v.body));
  },
);
it.each(f.signing.vectors.filter((v) => v.name.startsWith('bad-')))('refuses $name in contract order', async (v) => {
  if (v.deviceId !== first.deviceId) await seedDevice(v.deviceId);
  const error = v.protocol !== 1 ? f.errors.protocol : f.errors.badSignature;
  await expect(verifyRequest(request(v), now)).rejects.toMatchObject(error);
});
it('keeps nonce replay protection across reopen and signature malleation', async () => {
  const original = f.signing.vectors.find((v) => v.name === 'post-json')!;
  const altered = f.signing.vectors.find((v) => v.name === 'replay-malleated-signature')!;
  await verifyRequest(request(original), now);
  await expect(verifyRequest(request(altered), now)).rejects.toMatchObject(f.errors.replayed);
  await closeDb();
  await initDb(join(dir, 'db'), { role: 'test' });
  await expect(verifyRequest(request(altered), now)).rejects.toMatchObject(f.errors.replayed);
});
it.each([-121, -120, 120, 121])('enforces clock boundary %i', async (delta) => {
  const promise = verifyRequest(request(), now + delta * 1000);
  if (Math.abs(delta) === 120) await expect(promise).resolves.toBeDefined();
  else
    await expect(promise).rejects.toMatchObject({
      status: 401,
      body: { error: 'stale_timestamp', serverTime: now + delta * 1000 },
    });
});
it('rejects a revoked device and notifies revocation listeners once', async () => {
  const listener = vi.fn();
  const off = onDeviceRevoked(listener);
  await revokeDevice(first.deviceId);
  expect(listener).toHaveBeenCalledOnce();
  off();
  await expect(verifyRequest(request(), now)).rejects.toMatchObject(f.errors.deviceRevoked);
  expect(await getLiveDevice(first.deviceId)).toBeUndefined();
  expect(await liveDevices('u')).toEqual([]);
});
it('rejects altered and oversized bodies before reading oversized content length', async () => {
  await expect(readSignedBody(request(first, 'changed'), first.bodyHash, 4096)).rejects.toMatchObject(f.errors.badBody);
  const req = request();
  req.headers['content-length'] = '4097';
  const read = vi.spyOn(req, Symbol.asyncIterator);
  await expect(readSignedBody(req, first.bodyHash, 4096)).rejects.toMatchObject({
    status: 413,
    body: { error: 'too_large' },
  });
  expect(read).not.toHaveBeenCalled();
});
it('masks failed authentication and expires durable buckets', async () => {
  for (let i = 0; i < 60; i++) await consumeRateLimit('auth:127.0.0.1', 60, 600000, now);
  const req = request();
  req.headers.authorization = 'invalid';
  await expect(verifyRequest(req, now)).rejects.toMatchObject({
    status: 429,
    body: { error: 'rate_limited', retryAfter: 600 },
  });
  await expect(verifyRequest(request(), now)).resolves.toMatchObject({ deviceId: first.deviceId });
  expect((await consumeRateLimit('auth:127.0.0.1', 60, 600000, now + 600000)).allowed).toBe(true);
});
it('uses the trusted rightmost forwarded hop and ignores Forwarded and untrusted peers', () => {
  vi.spyOn(performance, 'now').mockReturnValue(1e12);
  vi.stubEnv('VOICE_MODE_TRUSTED_PROXY_CIDRS', '172.18.0.0/16');
  const req = request();
  Object.defineProperty(req.socket, 'remoteAddress', { value: '172.18.0.2', configurable: true });
  req.headers['x-forwarded-for'] = '1.2.3.4, 8.8.8.8, 172.18.0.3';
  req.headers.forwarded = 'for=9.9.9.9';
  expect(appPeerAllowed(req)).toBe(true);
  expect(clientAddress(req)).toBe('8.8.8.8');
  req.headers['x-forwarded-for'] = '172.18.0.3';
  expect(clientAddress(req)).toBe('172.18.0.2');
  req.headers['x-forwarded-for'] = `8.8.8.8, ${'x'.repeat(3000)}`;
  expect(clientAddress(req)).toBe('172.18.0.2');
  Object.defineProperty(req.socket, 'remoteAddress', { value: '192.168.1.2' });
  expect(appPeerAllowed(req)).toBe(false);
  expect(clientAddress(req)).toBe('192.168.1.2');
});
async function seedCode(expires = Date.now() + 600000) {
  await getDb().run(
    'INSERT INTO device_auth_pairing_codes (code_hash,user_id,agent_ids_json,created_at,expires_at) VALUES (?,?,?,?,?)',
    createHash('sha256').update(f.pairLink.code).digest('hex'),
    'u',
    '[]',
    now,
    expires,
  );
}
async function pair(body: unknown = f.pairRequest) {
  const req = request(first, JSON.stringify(body)),
    res = new ServerResponse(req);
  let answer: Record<string, unknown> = {};
  vi.spyOn(res, 'end').mockImplementation(((text: string) => {
    answer = JSON.parse(text);
    return res;
  }) as typeof res.end);
  await handlePair({ req, res, params: {} });
  return { status: res.statusCode, body: answer };
}
it('pairs the fixture once under concurrency', async () => {
  await seedCode();
  const outcomes = await Promise.allSettled([pair(), pair()]);
  expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  const success = outcomes.find((o) => o.status === 'fulfilled')! as PromiseFulfilledResult<
    Awaited<ReturnType<typeof pair>>
  >;
  expect(Object.keys(success.value.body).sort()).toEqual(Object.keys(f.pairResponse).sort());
  expect(success.value.status).toBe(200);
  const failure = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
  expect(failure.reason).toMatchObject(f.errors.invalidCode);
});
it('rejects tampered proof, expired code and excess pairing attempts', async () => {
  await seedCode(Date.now() - 1);
  await expect(pair({ ...f.pairRequest, ...f.pairProofTampered })).rejects.toMatchObject(f.errors.badProof);
  await expect(pair()).rejects.toMatchObject(f.errors.invalidCode);
  for (let i = 0; i < 8; i++) await expect(pair()).rejects.toMatchObject(f.errors.invalidCode);
  await expect(pair()).rejects.toMatchObject({ status: 429, body: { error: 'rate_limited' } });
});
it('limits reachability to enrolled device agents and current admin roles', async () => {
  const db = getDb();
  await db.run("INSERT INTO users (id,kind,created_at) VALUES ('u','human','now')");
  for (const id of ['a', 'b']) {
    await db.run('INSERT INTO agent_groups (id,name,folder,created_at) VALUES (?,?,?,?)', id, id, id, 'now');
    await db.run("INSERT INTO user_roles (user_id,role,agent_group_id,granted_at) VALUES ('u','admin',?,'now')", id);
    await db.run("INSERT INTO device_auth_user_agents (user_id,agent_group_id,created_at) VALUES ('u',?,?)", id, now);
  }
  await db.run('INSERT INTO device_auth_device_agents (device_id,agent_group_id) VALUES (?,?)', first.deviceId, 'a');
  expect(await reachableAgentIds(first.deviceId)).toEqual(['a']);
  vi.stubEnv('APP_PUBLIC_BASE', 'https://example.test');
  const link = await mintPairingLink('u', ['a']);
  expect(link.startsWith('https://example.test/app/pair#')).toBe(true);
  await db.run("DELETE FROM user_roles WHERE agent_group_id='a'");
  expect(await reachableAgentIds(first.deviceId)).toEqual([]);
  await expect(mintPairingLink('u', ['a'])).rejects.toThrow('administer');
});
it('caches proxy reads and parsing, refreshing changed policy after a minute', () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(2e12);
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
  vi.stubEnv('VOICE_MODE_TRUSTED_PROXY_CIDRS', 'invalid,172.18.0.0/16');
  vi.mocked(envValue).mockClear();
  const req = request();
  Object.defineProperty(req.socket, 'remoteAddress', { value: '172.18.0.2' });
  expect(appPeerAllowed(req)).toBe(true);
  clientAddress(req);
  expect(vi.mocked(envValue)).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(2e12 + 60000);
  expect(appPeerAllowed(req)).toBe(true);
  expect(warn).toHaveBeenCalledTimes(1);
  vi.stubEnv('VOICE_MODE_TRUSTED_PROXY_CIDRS', '');
  clock.mockReturnValue(2e12 + 120000);
  expect(appPeerAllowed(req)).toBe(false);
});
it('groups IPv6 by /64 and normalizes mapped IPv4', async () => {
  expect(rateLimitAddress('2001:db8:1:2::1')).toBe(rateLimitAddress('2001:0db8:0001:0002:ffff::2'));
  expect(rateLimitAddress('2001:db8:1:3::1')).not.toBe(rateLimitAddress('2001:db8:1:2::1'));
  expect(rateLimitAddress('::ffff:192.0.2.1')).toBe('192.0.2.1');
  expect(rateLimitAddress('::ffff:c000:201')).toBe('192.0.2.1');
  await consumeRateLimit('pair:2001:db8:1:2::1', 1, 600000, now);
  expect((await consumeRateLimit('pair:2001:db8:1:2::2', 1, 600000, now)).allowed).toBe(false);
});
it('resets the caller atomically and sweeps other buckets only once a minute', async () => {
  const db = getDb();
  await consumeRateLimit('pair:caller', 1, 1000, now);
  await db.run("INSERT INTO device_auth_rate_limits VALUES ('pair:expired', 1, ?)", now);
  const results = await Promise.all([
    consumeRateLimit('pair:caller', 1, 1000, now + 1000),
    consumeRateLimit('pair:caller', 1, 1000, now + 1000),
  ]);
  expect(results.filter((result) => result.allowed)).toHaveLength(1);
  expect(await db.get("SELECT * FROM device_auth_rate_limits WHERE bucket_key='pair:expired'")).toBeDefined();
  await consumeRateLimit('pair:caller', 1, 1000, now + 60000);
  expect(await db.get("SELECT * FROM device_auth_rate_limits WHERE bucket_key='pair:expired'")).toBeUndefined();
});
it('logs safe audit fields once per pairing, revocation and limit crossing', async () => {
  const info = vi.spyOn(log, 'info').mockImplementation(() => {});
  await seedCode();
  const result = await pair();
  const deviceId = result.body.deviceId as string;
  expect(info).toHaveBeenCalledWith('Device paired', { deviceId, userId: 'u', address: '127.0.0.1' });
  await revokeDevice(deviceId);
  await revokeDevice(deviceId);
  await consumeRateLimit('pair:192.0.2.1', 1, 600000, now);
  await consumeRateLimit('pair:192.0.2.1', 1, 600000, now);
  await consumeRateLimit('pair:192.0.2.1', 1, 600000, now);
  expect(info.mock.calls).toEqual([
    ['Device paired', { deviceId, userId: 'u', address: '127.0.0.1' }],
    ['Device revoked', { deviceId }],
    ['Device rate limit reached', { kind: 'pair', address: '192.0.2.1' }],
  ]);
});
it('copies the pairing subset into device grants and the response', async () => {
  const db = getDb();
  await db.run("INSERT INTO users (id,kind,created_at) VALUES ('u','human','now')");
  await db.run("INSERT INTO user_roles (user_id,role,granted_at) VALUES ('u','owner','now')");
  for (const id of ['a', 'b']) {
    await db.run('INSERT INTO agent_groups (id,name,folder,created_at) VALUES (?,?,?,?)', id, id, id, 'now');
    await db.run("INSERT INTO device_auth_user_agents VALUES ('u',?,?)", id, now);
  }
  await seedCode();
  await db.run(`UPDATE device_auth_pairing_codes SET agent_ids_json='["a"]'`);
  const result = await pair();
  expect(result.body.agents).toEqual([{ id: 'a', name: 'a' }]);
  expect(
    await db.all(
      'SELECT agent_group_id FROM device_auth_device_agents WHERE device_id=?',
      result.body.deviceId as string,
    ),
  ).toEqual([{ agent_group_id: 'a' }]);
});
