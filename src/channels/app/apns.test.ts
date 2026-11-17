import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingHttpHeaders, type ServerHttp2Session } from 'node:http2';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApnsClient } from './apns.js';
import fixtures from './app-contract.fixtures.json' with { type: 'json' };

const body = fixtures.pushPayload.body;
const destination = { token: fixtures.pushTokenRequest.token, environment: 'sandbox' as const };
let directory: string;
let sandboxPort: number;
let productionPort: number;
let sessionCount: number;
let behavior: 'normal' | 'drop' | 'hang' | 'goaway';
let now: number;
let requests: { headers: IncomingHttpHeaders; body: string; port: number }[];
let answers: { status: number; reason?: string }[];
let cleanup: Array<() => Promise<void>>;
let client: ReturnType<typeof createApnsClient>;
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const productionPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const warn = vi.fn();
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'n4-apns-'));
  writeFileSync(join(directory, 'key.p8'), pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(join(directory, 'production.p8'), productionPair.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });
  sessionCount = 0;
  behavior = 'normal';
  now = 1_800_000_000_000;
  requests = [];
  answers = [];
  cleanup = [];
  warn.mockClear();
  async function server() {
    const server = createServer();
    const sessions = new Set<ServerHttp2Session>();
    server.on('session', (session) => {
      sessions.add(session);
      sessionCount++;
    });
    server.on('stream', (stream, headers) => {
      stream.on('error', () => {});
      let data = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        data += chunk;
      });
      stream.on('end', () => {
        requests.push({ headers, body: data, port });
        if (behavior === 'drop') {
          stream.session!.destroy();
          return;
        }
        if (behavior === 'hang') return;
        if (behavior === 'goaway') stream.session!.goaway();
        const answer = answers.shift() ?? { status: 200 };
        stream.respond({ ':status': answer.status });
        stream.end(answer.reason ? JSON.stringify({ reason: answer.reason }) : '');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as import('node:net').AddressInfo).port;
    cleanup.push(async () => {
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return `http://127.0.0.1:${port}`;
  }
  const sandbox = await server();
  const production = await server();
  sandboxPort = Number(new URL(sandbox).port);
  productionPort = Number(new URL(production).port);
  client = createApnsClient({
    config: {
      teamId: 'team',
      topic: 'com.tenequm.HeyDan',
      sandbox: { keyId: 'sandbox', keyPath: join(directory, 'key.p8') },
      production: { keyId: 'production', keyPath: join(directory, 'production.p8') },
    },
    origins: { sandbox, production },
    now: () => now,
    timeoutMs: 100,
    sleep: async () => {},
    warn,
  });
});
afterEach(async () => {
  client.close();
  for (const close of cleanup) await close();
  rmSync(directory, { recursive: true, force: true });
});
it('sends the fixture over HTTP/2 and signs reusable per-environment ES256 tokens', async () => {
  const send = (environment = destination.environment as 'sandbox' | 'production') =>
    client.sendPush({ ...destination, environment }, 'msg_2102', body);
  await send();
  expect(requests[0].port).toBe(sandboxPort);
  expect(requests[0].headers).toMatchObject({
    ...fixtures.pushPayload.headers,
    ':method': 'POST',
    ':path': `/3/device/${destination.token}`,
  });
  expect(JSON.parse(requests[0].body)).toEqual(body);
  expect(requests[0].headers['apns-id']).toMatch(/^[0-9a-f-]{36}$/);
  const jwt = String(requests[0].headers.authorization).slice(7);
  const [header, claims, signature] = jwt.split('.');
  expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'sandbox' });
  expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({ iss: 'team', iat: now / 1000 });
  expect(
    verify(
      'sha256',
      Buffer.from(`${header}.${claims}`),
      { key: pair.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    ),
  ).toBe(true);
  now += 45 * 60_000 - 1;
  await send();
  expect(requests[1].headers.authorization).toBe(requests[0].headers.authorization);
  now++;
  await send();
  expect(requests[2].headers.authorization).not.toBe(requests[0].headers.authorization);
  await send('production');
  const [ph, pc, ps] = String(requests[3].headers.authorization).slice(7).split('.');
  expect(
    verify(
      'sha256',
      Buffer.from(ph + '.' + pc),
      { key: productionPair.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(ps, 'base64url'),
    ),
  ).toBe(true);
  expect(requests[3].port).toBe(productionPort);
  expect(
    JSON.parse(Buffer.from(String(requests[3].headers.authorization).slice(7).split('.')[0], 'base64url').toString())
      .kid,
  ).toBe('production');
});
it.each(['Unregistered', 'BadDeviceToken', 'ExpiredToken', 'DeviceTokenNotForTopic'])(
  'marks %s dead without retry',
  async (reason) => {
    answers.push({ status: reason === 'Unregistered' ? 410 : 400, reason });
    expect((await client.sendPush(destination, 'msg', body)).clearToken).toBe(true);
    expect(requests).toHaveLength(1);
  },
);
it('keeps tokens and warns for the wrong environment key', async () => {
  answers.push({ status: 403, reason: 'BadEnvironmentKeyInToken' });
  expect((await client.sendPush(destination, 'msg', body)).clearToken).toBe(false);
  expect(requests).toHaveLength(1);
  expect(warn).toHaveBeenCalledWith('sandbox', 'BadEnvironmentKeyInToken');
});
it.each(['ExpiredProviderToken', 'InvalidProviderToken'])('refreshes %s once', async (reason) => {
  await client.sendPush(destination, 'warmup', body);
  now += 20 * 60_000;
  requests = [];
  answers.push({ status: 403, reason }, { status: 403, reason });
  await client.sendPush(destination, 'msg', body);
  expect(requests).toHaveLength(2);
  expect(requests[0].headers.authorization).not.toBe(requests[1].headers.authorization);
});
it.each([429, 500, 503])('retries %s twice', async (status) => {
  answers.push(...Array.from({ length: 3 }, () => ({ status })));
  expect((await client.sendPush(destination, 'msg', body)).status).toBe(status);
  expect(requests).toHaveLength(3);
  expect(new Set(requests.map((r) => r.headers['apns-id'])).size).toBe(3);
  expect(new Set(requests.map((r) => r.headers['apns-collapse-id']))).toEqual(new Set(['msg']));
});
it('disables a missing key once and rejects oversized payloads', async () => {
  client.close();
  client = createApnsClient({ config: { teamId: null, topic: 'test', sandbox: null, production: null }, warn });
  for (let i = 0; i < 2; i++)
    expect((await client.sendPush(destination, 'msg', body)).reason).toBe('EnvironmentDisabled');
  expect(warn).toHaveBeenCalledTimes(1);
  expect(
    (
      await client.sendPush(destination, 'msg', {
        ...body,
        aps: { ...body.aps, alert: { title: 'x'.repeat(4096), body: '' } },
      })
    ).reason,
  ).toBe('PayloadTooLarge');
  expect(requests).toHaveLength(0);
});

it.each(['drop', 'hang'] as const)('evicts and retries a %s once on a fresh session', async (mode) => {
  behavior = mode;
  const result = await client.sendPush(destination, 'msg', body);
  expect(result).toMatchObject({ status: 0, clearToken: false });
  expect(result.reason).toMatch(/^Transport/);
  expect(requests).toHaveLength(2);
  expect(sessionCount).toBe(2);
  behavior = 'normal';
  expect((await client.sendPush(destination, 'msg', body)).status).toBe(200);
  expect(sessionCount).toBe(3);
});
it('reopens after GOAWAY', async () => {
  behavior = 'goaway';
  await client.sendPush(destination, 'msg', body);
  behavior = 'normal';
  await client.sendPush(destination, 'msg', body);
  expect(sessionCount).toBe(2);
});
it('does not refresh or retry a rejected token younger than twenty minutes', async () => {
  answers.push({ status: 403, reason: 'InvalidProviderToken' }, { status: 403, reason: 'InvalidProviderToken' });
  await client.sendPush(destination, 'msg', body);
  now += 20 * 60_000 - 1;
  await client.sendPush(destination, 'msg', body);
  expect(requests).toHaveLength(2);
  expect(requests[0].headers.authorization).toBe(requests[1].headers.authorization);
});
it('deduplicates concurrent refreshes of the same rejected token', async () => {
  await client.sendPush(destination, 'warmup', body);
  now += 20 * 60_000;
  requests = [];
  answers.push(...Array.from({ length: 4 }, () => ({ status: 403, reason: 'ExpiredProviderToken' })));
  await Promise.all(Array.from({ length: 4 }, () => client.sendPush(destination, 'msg', body)));
  expect(requests).toHaveLength(8);
  expect(new Set(requests.slice(0, 4).map((r) => r.headers.authorization)).size).toBe(1);
  expect(new Set(requests.slice(4).map((r) => r.headers.authorization)).size).toBe(1);
  expect(requests[4].headers.authorization).not.toBe(requests[0].headers.authorization);
});
