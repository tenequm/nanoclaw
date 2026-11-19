import { createServer, IncomingMessage, ServerResponse, type Server } from 'node:http';
import { Socket, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes, sign, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { initDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { canonicalSigningText, bodySHA256 } from '../app/contract.js';
import { parseCidrs } from '../../modules/device-auth/gate.js';
import { dispatchPeer } from './index.js';
import { closeStreams } from './stream.js';
import { enrollMachine, revokeMachine } from './store.js';
import { sweepPeers } from './lifecycle.js';
import type {
  HelloResponse,
  SessionRegisterResponse,
  SendResponse,
  HelloRequest,
  PeerEvent,
  SendRequest,
  SessionRegisterRequest,
} from './types.js';

const policy = {
  trustedProxies: parseCidrs('172.18.0.2/32', 'test'),
  allowedClients: parseCidrs('100.64.0.0/10', 'test'),
};
let server: Server, base: string, dir: string, dbFile: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'peer-routes-'));
  dbFile = join(dir, 'test.db');
  await runMigrations(await initDb(dbFile));
  server = createServer((req, res) => void dispatchPeer(req, res, policy));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});
afterEach(async () => {
  closeStreams();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
});
const hello: HelloRequest = {
  resumeEpoch: null,
  takeover: false,
  amesh: { version: '0.1.0', os: 'test', arch: 'test' },
  claudeCode: { nativeCheck: 'ok', versions: [], peerProtocol: 1 },
  capabilities: ['receipts'],
};
async function machine(name: string) {
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const id = await enrollMachine(name, keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'));
  function header(method: string, path: string, body = '', ts = Math.floor(Date.now() / 1000)) {
    const nonce = randomBytes(16).toString('base64url'),
      bodyHash = bodySHA256(body);
    const text = canonicalSigningText({ method, target: path, protocol: 1, ts, nonce, bodyHash, deviceId: id });
    const signature = sign('sha256', Buffer.from(text), keys.privateKey).toString('base64url');
    return ['HeyDan-Sig v=1', 'p=1', 'd=' + id, 't=' + ts, 'n=' + nonce, 'bh=' + bodyHash, 's=' + signature].join(',');
  }
  function call(method: string, path: string, data?: unknown) {
    const body = data === undefined ? undefined : JSON.stringify(data);
    return fetch(base + path, {
      method,
      body,
      headers: { authorization: header(method, path, body) },
      signal: AbortSignal.timeout(4000),
    });
  }
  const init = await call('POST', '/peer/hello', hello);
  expect(init.status).toBe(200);
  const epoch = ((await init.json()) as HelloResponse).epoch;
  const key = '42-1234abcd';
  async function register(session = key) {
    const body: SessionRegisterRequest = {
      epoch,
      name: 'review',
      nameSource: 'user',
      sessionId: 'test',
      project: 'test',
      status: 'idle',
      entrypoint: 'test',
      claudeCode: 'test',
      startedAt: 0,
    };
    const result = await call('PUT', '/peer/sessions/' + session, body);
    expect(result.status).toBe(200);
    return ((await result.json()) as SessionRegisterResponse).session.address;
  }
  function send(to: SendRequest['to'], session = key): SendRequest {
    return {
      epoch,
      id: randomUUID(),
      from: { session },
      to,
      text: 'test message',
      origin: 'unknown',
      fromMode: 'prompting',
      hopChain: [],
      notifyWhenIdle: false,
      failureNotice: false,
    };
  }
  async function replay(after = 0) {
    const response = await call('GET', '/peer/events?after=' + after + '&epoch=' + epoch);
    expect(response.status).toBe(200);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    async function through(kind: string) {
      const events: PeerEvent[] = [];
      for (;;) {
        const index = buffer.indexOf('\n\n');
        if (index < 0) {
          const { value, done } = await reader.read();
          if (done) throw new Error('Peer stream ended early');
          buffer += value;
          continue;
        }
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = block.split('\n').find((line) => line.startsWith('data: '));
        if (!data) continue;
        const event: PeerEvent = JSON.parse(data.slice(6));
        events.push(event);
        if (event.kind === kind) return events;
      }
    }
    return { through, close: () => reader.cancel() };
  }
  return { id, call, header, key, epoch, register, send, replay };
}

it('routes between two enrolled machines and authorizes a reply only from the addressed session', async () => {
  const a = await machine('one'),
    b = await machine('two');
  await a.register();
  const address = await b.register();
  const unrelated = '43-1234abcd';
  expect(await b.register(unrelated)).toBe('review-2@test:two');
  const message = a.send({ address });
  expect((await a.call('POST', '/peer/messages', message)).status).toBe(200);
  const stream = await b.replay();
  const events = await stream.through('synchronized');
  expect(events.map((e) => e.kind).slice(0, 2)).toEqual(['endpoint', 'message']);
  const incoming = events.find((e) => e.kind === 'message')!;
  expect(incoming).toMatchObject({ session: b.key, id: message.id, fromMode: 'prompting', hop: { count: 1 } });
  const reply = b.send({ endpoint: incoming.endpoint.id });
  const outsider = await b.call('POST', '/peer/messages', { ...reply, from: { session: unrelated } });
  expect(outsider.status).toBe(403);
  expect(await outsider.json()).toMatchObject({ error: 'not_a_party' });
  expect((await b.call('POST', '/peer/messages', reply)).status).toBe(200);
  const back = await a.replay();
  const response = (await back.through('synchronized')).find((e) => e.kind === 'message');
  expect(response).toMatchObject({ session: a.key, id: reply.id, hop: { count: 2 } });
  const duplicate = await b.call('POST', '/peer/messages', reply);
  expect(duplicate.status).toBe(200);
  expect(await (await b.call('POST', '/peer/messages', { ...reply, text: 'changed' })).json()).toMatchObject({
    error: 'id_conflict',
  });
  expect((await getDb().get<{ n: number }>('SELECT count(*) AS n FROM peer_messages'))!.n).toBe(2);
  await back.close();
  await stream.close();
});

it('refuses unsigned, stale, mismatched body, replay across restart and revoked requests; revocation ends the stream', async () => {
  const a = await machine('one'),
    path = '/peer/peers';
  expect((await fetch(base + path)).status).toBe(401);
  const signed = async (h: string) => fetch(base + path, { headers: { authorization: h } });
  const stale = await signed(a.header('GET', path, '', Math.floor(Date.now() / 1000) - 121));
  expect(await stale.json()).toMatchObject({ error: 'stale_timestamp' });
  const header = a.header('GET', path);
  expect((await signed(header)).status).toBe(200);
  await closeDb();
  await runMigrations(await initDb(dbFile));
  expect(await (await signed(header)).json()).toMatchObject({ error: 'replayed' });
  const bad = await fetch(base + '/peer/heartbeat', {
    method: 'POST',
    headers: { authorization: a.header('POST', '/peer/heartbeat', '{}') },
    body: '{ }',
  });
  expect(await bad.json()).toMatchObject({ error: 'bad_body' });
  const s = await a.replay();
  await s.through('synchronized');
  await revokeMachine(a.id);
  expect((await s.through('revoked')).at(-1)).toMatchObject({ kind: 'revoked', machine: a.id });
  expect(await (await a.call('GET', path)).json()).toMatchObject({ error: 'machine_revoked' });
  await s.close();
});

it('refuses LAN and container requests directly and through the voice proxy', async () => {
  for (const [ip, forwarded] of [
    ['192.168.1.4', '100.64.1.2'],
    ['172.17.0.3', '100.64.1.2'],
    ['172.18.0.2', '100.64.1.2, 172.18.0.1'],
    ['172.18.0.2', '192.168.1.4'],
  ]) {
    const socket = new Socket();
    Object.defineProperty(socket, 'remoteAddress', { value: ip });
    const req = new IncomingMessage(socket);
    req.url = '/peer/hello';
    req.method = 'GET';
    req.headers['x-forwarded-for'] = forwarded;
    const res = new ServerResponse(req);
    await dispatchPeer(req, res, policy);
    expect(res.statusCode).toBe(403);
    socket.destroy();
  }
});

it('fences epochs, rejects future cursors, expires offline messages and omits them during replay', async () => {
  const a = await machine('one'),
    b = await machine('two');
  await a.register();
  const address = await b.register();
  const before = await b.replay();
  await before.through('synchronized');
  expect(await (await b.call('POST', '/peer/hello', hello)).json()).toMatchObject({ error: 'machine_in_use' });
  const takeover = await (await b.call('POST', '/peer/hello', { ...hello, takeover: true })).json();
  expect(takeover).toMatchObject({ epoch: 2 });
  expect((await before.through('superseded')).at(-1)).toMatchObject({ epoch: 1, by: 2 });
  await before.close();
  expect(await (await b.call('POST', '/peer/heartbeat', { epoch: 1, cursor: 0, sessions: [] })).json()).toMatchObject({
    error: 'superseded',
  });
  expect(await (await b.call('GET', '/peer/events?after=999&epoch=2')).json()).toMatchObject({ error: 'bad_cursor' });
  await getDb().run('UPDATE peer_machines SET last_seen_at=0 WHERE id=?', b.id);
  await sweepPeers();
  const message = a.send({ address });
  const result = (await (await a.call('POST', '/peer/messages', message)).json()) as SendResponse;
  expect(result.message.to.status).toBe('offline');
  await sweepPeers(result.message.expiresAt + 1);
  const sender = await a.replay();
  expect(await sender.through('synchronized')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'delivery', id: message.id, state: 'dropped', reason: 'queue_expired' }),
    ]),
  );
  await sender.close();
  const replay = await b.call('GET', '/peer/events?after=0&epoch=2');
  const reader = replay.body!.getReader();
  let frames = '';
  while (!frames.includes('event: synchronized')) frames += new TextDecoder().decode((await reader.read()).value);
  expect(frames).not.toContain('event: message');
  await reader.cancel();
});

it('prefers a local address, returns ambiguity candidates, and reserves bare names for agents', async () => {
  const a = await machine('one'),
    b = await machine('two'),
    c = await machine('three');
  const local = await a.register(),
    other = await b.register(),
    third = await c.register();
  const foreign = await a.register('43-1234abcd');
  const send = (address: string) => a.call('POST', '/peer/messages', a.send({ address }, '43-1234abcd'));
  expect(await (await send('review@test')).json()).toMatchObject({ message: { to: { address: local } } });
  expect(await (await send(other)).json()).toMatchObject({ message: { to: { address: other } } });
  for (const address of ['@test', foreign])
    expect(await (await send(address)).json()).toMatchObject({ error: 'bad_address' });
  expect(await (await send('review')).json()).toMatchObject({ error: 'not_found' });
  await a.call('POST', '/peer/sessions/' + a.key + '/end', { epoch: a.epoch, reason: 'exited' });
  expect(await (await send('review@test')).json()).toMatchObject({
    error: 'ambiguous',
    candidates: expect.arrayContaining([other, third]),
  });
  await c.call('POST', '/peer/sessions/' + c.key + '/end', { epoch: c.epoch, reason: 'exited' });
  expect(await (await send('review@test')).json()).toMatchObject({ message: { to: { address: other } } });
  expect(await (await send(third)).json()).toMatchObject({ error: 'not_running' });
});

it('keeps reports scoped to the receiver and preserves the first final state, including new report values', async () => {
  const a = await machine('one'),
    b = await machine('two');
  await a.register();
  const address = await b.register();
  for (const state of ['accepted', 'denied', 'expired', 'delivered', 'refused', 'dropped', 'unknown']) {
    const message = a.send({ address });
    expect((await a.call('POST', '/peer/messages', message)).status).toBe(200);
    const report = { kind: 'state', id: message.id, session: b.key, state, reason: null, at: Date.now() };
    const submit = (daemon: typeof a, record: typeof report) =>
      daemon.call('POST', '/peer/reports', { epoch: daemon.epoch, reports: [record] });
    expect(await (await submit(a, report)).json()).toMatchObject({ results: [{ applied: false, state: 'unknown' }] });
    expect(await (await submit(b, { ...report, state: 'future_state' })).json()).toMatchObject({
      results: [{ applied: false, state: 'sent' }],
    });
    expect(await (await submit(b, report)).json()).toMatchObject({ results: [{ applied: true, state }] });
    expect(await (await submit(b, { ...report, state: 'held' })).json()).toMatchObject({
      results: [{ applied: false, state }],
    });
  }
  const result = await b.call('POST', '/peer/reports', {
    epoch: b.epoch,
    reports: [{ kind: 'future', id: randomUUID() }],
  });
  expect(await result.json()).toMatchObject({ results: [{ applied: false, state: 'unknown' }] });
});
