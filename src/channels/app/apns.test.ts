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
let now: number;
let requests: { headers: IncomingHttpHeaders; body: string; port: number }[];
let answers: { status: number; reason?: string }[];
let cleanup: Array<() => Promise<void>>;
let client: ReturnType<typeof createApnsClient>;
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const warn = vi.fn();
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'n4-apns-'));
  writeFileSync(join(directory, 'key.p8'), pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  now = 1_800_000_000_000;
  requests = [];
  answers = [];
  cleanup = [];
  warn.mockClear();
  async function server(port: number) {
    const server = createServer();
    const sessions = new Set<ServerHttp2Session>();
    server.on('session', (session) => {
      sessions.add(session);
    });
    server.on('stream', (stream, headers) => {
      let data = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        data += chunk;
      });
      stream.on('end', () => {
        requests.push({ headers, body: data, port });
        const answer = answers.shift() ?? { status: 200 };
        stream.respond({ ':status': answer.status });
        stream.end(answer.reason ? JSON.stringify({ reason: answer.reason }) : '');
      });
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    cleanup.push(async () => {
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return `http://127.0.0.1:${port}`;
  }
  const sandbox = await server(4704);
  const production = await server(4705);
  client = createApnsClient({
    config: {
      teamId: 'team',
      topic: 'com.tenequm.HeyDan',
      sandbox: { keyId: 'sandbox', keyPath: join(directory, 'key.p8') },
      production: { keyId: 'production', keyPath: join(directory, 'key.p8') },
    },
    origins: { sandbox, production },
    now: () => now,
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
  expect(requests[3].port).toBe(4705);
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
