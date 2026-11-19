import { createServer, IncomingMessage, ServerResponse, type Server } from 'node:http';
import { Socket, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes, sign, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { initDb, closeDb, getDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { canonicalSigningText, bodySHA256 } from '../app/contract.js';
import { parseCidrs } from '../../modules/device-auth/gate.js';
import { dispatchPeer } from './index.js';
import { closeStreams } from './stream.js';
import { enrollMachine, revokeMachine } from './store.js';
import * as env from '../../env.js';
import { eventHead, sweepPeers } from './lifecycle.js';
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
  dir = mkdtempSync(join(tmpdir(), 'nanoclaw-a2-peer-routes-'));
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
  instance: randomBytes(16).toString('base64url'),
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
  function putSession(session: string) {
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
    return call('PUT', '/peer/sessions/' + session, body);
  }
  async function register(session = key) {
    const result = await putSession(session);
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
  return { id, call, header, key, epoch, putSession, register, send, replay };
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
  expect(events.map((e) => e.kind).slice(0, 3)).toEqual(['endpoint', 'endpoint', 'message']);
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
  const idle = await b.call('POST', '/peer/reports', {
    epoch: b.epoch,
    reports: [{ kind: 'idle', id: message.id, session: b.key, at: Date.now() }],
  });
  expect(idle.status).toBe(200);
  expect(await getDb().get("SELECT seq FROM peer_events WHERE kind='idle'")).toBeUndefined();
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
  const otherInstance = { ...hello, instance: randomBytes(16).toString('base64url') };
  expect(await (await b.call('POST', '/peer/hello', otherInstance)).json()).toMatchObject({ error: 'machine_in_use' });
  const takeover = await (await b.call('POST', '/peer/hello', { ...otherInstance, takeover: true })).json();
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
  const otherKey = '52-bbbbcccc';
  await b.register(otherKey);
  for (const state of ['accepted', 'denied', 'expired', 'delivered', 'refused', 'dropped', 'unknown']) {
    const message = a.send({ address });
    expect((await a.call('POST', '/peer/messages', message)).status).toBe(200);
    const report = {
      kind: 'state',
      id: message.id,
      session: b.key,
      state,
      reason: state === 'dropped' ? 'future_drop_reason' : null,
      at: Date.now(),
    };
    const submit = (daemon: typeof a, record: typeof report) =>
      daemon.call('POST', '/peer/reports', { epoch: daemon.epoch, reports: [record] });
    expect(await (await submit(a, report)).json()).toMatchObject({ results: [{ applied: false, state: null }] });
    expect(await (await submit(b, { ...report, session: otherKey })).json()).toMatchObject({
      results: [{ applied: false, state: null }],
    });
    expect(
      (
        await a.call('POST', '/peer/heartbeat', {
          epoch: a.epoch,
          cursor: await eventHead(),
          sessions: [{ key: a.key, status: 'idle' }],
        })
      ).status,
    ).toBe(200);
    expect(await getDb().get('SELECT state FROM peer_messages WHERE id=?', message.id)).toEqual({ state: 'queued' });
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
  expect(await result.json()).toMatchObject({ results: [{ applied: false, state: null }] });
});

it('keeps the live epoch and log across a lost hello and hub restart, and retries under the new daemon epoch', async () => {
  const a = await machine('one'),
    b = await machine('two');
  await a.register();
  const address = await b.register();
  const first = (await (await a.call('POST', '/peer/hello', hello)).json()) as HelloResponse;
  expect(first).toMatchObject({ epoch: 1, settings: { acceptWindowMs: 8000 }, log: expect.stringMatching(/^lg_/) });
  const m = a.send({ address });
  expect((await a.call('POST', '/peer/messages', m)).status).toBe(200);
  await closeDb();
  await runMigrations(await initDb(dbFile));
  const again = await (await a.call('POST', '/peer/hello', { ...hello, resumeEpoch: null, takeover: true })).json();
  expect(again).toMatchObject({ epoch: 1, log: first.log });
  const epoch = 2;
  expect(
    await (
      await a.call('POST', '/peer/hello', { ...hello, instance: randomBytes(16).toString('base64url'), takeover: true })
    ).json(),
  ).toMatchObject({ epoch });
  expect(
    await (
      await a.call('POST', '/peer/messages', {
        ...m,
        epoch,
        origin: 'human',
        fromMode: null,
        hopChain: ['a'.repeat(24)],
      })
    ).json(),
  ).toMatchObject({ message: { id: m.id, state: 'queued' } });
  for (const changed of [{ text: 'different' }, { from: { session: '44-aaaaaaaa' } }, { to: { address: 'different' } }])
    expect(await (await a.call('POST', '/peer/messages', { ...m, epoch, ...changed })).json()).toMatchObject({
      error: 'id_conflict',
    });
  const n = b.send({ address: 'review@test:one' });
  expect((await b.call('POST', '/peer/messages', n)).status).toBe(200);
  const reconnect = await b.replay();
  const burst = await reconnect.through('synchronized');
  expect(burst.filter((e) => e.kind === 'message').map((e) => e.id)).toEqual([m.id]);
  await reconnect.close();
  const ack = { kind: 'state', id: m.id, session: b.key, state: 'held', reason: null, at: Date.now() };
  await b.call('POST', '/peer/reports', { epoch: b.epoch, reports: [ack] });
  const taken = (await (
    await b.call('POST', '/peer/hello', { ...hello, instance: randomBytes(16).toString('base64url'), takeover: true })
  ).json()) as HelloResponse;
  const raw = await b.call('GET', '/peer/events?after=0&epoch=' + taken.epoch);
  const reader = raw.body!.pipeThrough(new TextDecoderStream()).getReader();
  let wire = '';
  while (!wire.includes('event: synchronized')) wire += (await reader.read()).value;
  const frames = wire.split('\n\n');
  expect(frames[0]).toMatch(/^event: endpoint\n/);
  expect(frames.some((f) => f.startsWith('id: ') && f.includes('event: message') && f.includes(m.id))).toBe(true);
  await reader.cancel();
  await closeDb();
  await runMigrations(await initDb(join(dir, 'another.db')));
  expect(await getDb().get('SELECT id FROM peer_log')).not.toEqual({ id: first.log });
});

it('accepts signatures at both clock boundaries and rejects one second beyond each', async () => {
  const { verifyPeerRequest } = await import('./store.js');
  const a = await machine('clock');
  const now = Date.now();
  for (const skew of [-121, -120, 120, 121]) {
    const socket = new Socket();
    try {
      const req = new IncomingMessage(socket);
      req.method = 'GET';
      req.url = '/peer/peers';
      req.headers.authorization = a.header('GET', req.url, '', Math.floor(now / 1000) + skew);
      if (Math.abs(skew) === 120) expect((await verifyPeerRequest(req, now)).machine.id).toBe(a.id);
      else await expect(verifyPeerRequest(req, now)).rejects.toMatchObject({ body: { error: 'stale_timestamp' } });
    } finally {
      socket.destroy();
    }
  }
});

it('charges refused machine sends and refuses to end an unregistered key', async () => {
  const a = await machine('limited');
  await a.register();
  expect(
    await (await a.call('POST', '/peer/sessions/23-aaaaaaaa/end', { epoch: 1, reason: 'exited' })).json(),
  ).toMatchObject({ error: 'unknown_session' });
  for (let attempt = 0; attempt < 60; attempt++)
    expect((await a.call('POST', '/peer/messages', a.send({ address: 'absent' }))).status).toBe(404);
  const exhausted = await a.call('POST', '/peer/messages', a.send({ address: 'absent' }));
  expect(exhausted.status).toBe(429);
  expect(Number(exhausted.headers.get('Retry-After'))).toBeGreaterThan(0);
});

it('keeps the live owner and stream on a refused hello, and restores a lapsed owner only by hello', async () => {
  const a = await machine('epochs');
  const features = ['agents', 'sessions', 'hop-limit'];
  expect(await (await fetch(base + '/peer/hello')).json()).toMatchObject({ features });
  expect(await (await a.call('POST', '/peer/hello', hello)).json()).toMatchObject({ features });
  const stream = await a.replay();
  await stream.through('synchronized');
  const owner = () =>
    getDb().get('SELECT epoch,instance,epoch_seen_at,last_seen_at FROM peer_machines WHERE id=?', a.id);
  const next = { ...hello, instance: randomBytes(16).toString('base64url'), takeover: true };
  const before = await owner();
  const min = vi.spyOn(env, 'envValue').mockImplementation((key) => (key === 'PEER_MIN_AMESH' ? '1.0.0' : undefined));
  try {
    const refused = await a.call('POST', '/peer/hello', next);
    expect(refused.status).toBe(426);
    expect(await refused.json()).toMatchObject({ error: 'upgrade_required' });
    expect(await owner()).toEqual(before);
  } finally {
    min.mockRestore();
  }
  const lapse = () => getDb().run('UPDATE peer_machines SET epoch_seen_at=0 WHERE id=?', a.id);
  const beat = (epoch: number) => a.call('POST', '/peer/heartbeat', { epoch, cursor: 0, sessions: [] });
  await lapse();
  expect((await beat(a.epoch)).status).toBe(200);
  for (const r of [await beat(9), await a.call('GET', '/peer/events?after=0&epoch=9')]) {
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: 'superseded', epoch: a.epoch });
  }
  // A successful reconnect closes this specific stream; its earlier refused hello left it live.
  expect((await a.call('POST', '/peer/hello', hello)).status).toBe(200);
  await stream.close();
  await lapse();
  for (const r of [await beat(a.epoch), await a.call('GET', '/peer/events?after=0&epoch=9')]) {
    expect(r.status).toBe(409);
    const error = await r.json();
    expect(error).toMatchObject({ error: 'superseded' });
    expect(error).not.toHaveProperty('epoch');
  }
  expect(await (await a.call('POST', '/peer/hello', hello)).json()).toMatchObject({ epoch: a.epoch });
  expect((await beat(a.epoch)).status).toBe(200);
  await lapse();
  expect(await (await a.call('POST', '/peer/hello', { ...next, takeover: false })).json()).toMatchObject({
    epoch: a.epoch + 1,
  });
});

it('replays stored sends before membership, target, hop and rate decisions', async () => {
  const a = await machine('sender'),
    b = await machine('receiver');
  await a.register();
  const message = a.send({ address: await b.register() });
  const send = (data: SendRequest) => a.call('POST', '/peer/messages', data);
  const original = (await (await send(message)).json()) as SendResponse;
  expect(original.message.state).toBe('queued');
  await getDb().run('UPDATE peer_conversations SET hops=20');
  await getDb().run('UPDATE device_auth_rate_limits SET count=60 WHERE bucket_key=?', 'peer-send:' + a.id);
  async function unchangedReplay(state: string) {
    const head = await eventHead();
    const count = () =>
      getDb().get('SELECT count FROM device_auth_rate_limits WHERE bucket_key=?', 'peer-send:' + a.id);
    expect(await (await send(message)).json()).toEqual({ message: { ...original.message, state } });
    const conflict = await send({ ...message, text: 'changed' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: 'id_conflict' });
    expect(await count()).toEqual({ count: 60 });
    expect(await eventHead()).toBe(head);
    expect(await getDb().get('SELECT hops FROM peer_conversations')).toEqual({ hops: 20 });
  }
  await unchangedReplay('queued');
  for (const daemon of [b, a])
    expect(
      (await daemon.call('POST', '/peer/sessions/' + daemon.key + '/end', { epoch: daemon.epoch, reason: 'exited' }))
        .status,
    ).toBe(200);
  await unchangedReplay('dropped');
});

it('notifies both native parties on the first stopped reply, then waits for a reset', async () => {
  const a = await machine('one'),
    b = await machine('two');
  const source = await a.register();
  const target = await b.register();
  await a.call('POST', '/peer/messages', a.send({ address: target }));
  const ep = (await getDb().get<{ id: string }>('SELECT id FROM peer_endpoints WHERE machine_id=?', b.id))!.id;
  for (let episode = 0; episode < 2; episode++) {
    await getDb().run('UPDATE peer_conversations SET hops=20');
    const head = await eventHead();
    const start = b.send({ address: source });
    if (episode === 1) {
      expect((await b.call('POST', '/peer/messages', start)).status).toBe(409);
    }
    const first = b.send({ endpoint: ep });
    for (const reply of [first, b.send({ endpoint: ep })]) {
      const r = await b.call('POST', '/peer/messages', reply);
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({ error: 'hop_limit' });
    }
    const limits = await getDb().all<{ machine_id: string; payload: string }>(
      "SELECT machine_id,payload FROM peer_events WHERE seq>? AND kind='limit' ORDER BY seq",
      head,
    );
    expect(limits.map((e) => [e.machine_id, JSON.parse(e.payload).stopped])).toEqual([
      [a.id, { id: episode === 1 ? start.id : first.id, direction: 'in' }],
      [b.id, { id: first.id, direction: 'out' }],
    ]);
    expect(
      (await a.call('POST', '/peer/sessions/' + a.key + '/human', { epoch: a.epoch, at: Date.now(), source: 'prompt' }))
        .status,
    ).toBe(200);
  }
});

it('snapshots only the remaining endpoint keys, closes on the last end and reopens on takeover', async () => {
  const a = await machine('source'),
    b = await machine('receiver');
  await a.register();
  const second = '43-1234abcd';
  for (const key of [b.key, second])
    expect((await a.call('POST', '/peer/messages', a.send({ address: await b.register(key) }))).status).toBe(200);
  const ep = (await getDb().get<{ id: string }>('SELECT id FROM peer_endpoints WHERE machine_id=?', b.id))!.id;
  async function snapshot() {
    const stream = await b.replay(await eventHead());
    try {
      return (await stream.through('synchronized')).filter((e) => e.kind === 'endpoint');
    } finally {
      await stream.close();
    }
  }
  expect(await snapshot()).toMatchObject([{ id: ep, sessions: [b.key, second], state: 'open' }]);
  async function end(key: string) {
    expect((await b.call('POST', '/peer/sessions/' + key + '/end', { epoch: b.epoch, reason: 'exited' })).status).toBe(
      200,
    );
  }
  await end(b.key);
  expect(await snapshot()).toMatchObject([{ id: ep, sessions: [second], state: 'open' }]);
  const head = await eventHead();
  await end(second);
  const closing = await b.replay(head);
  expect((await closing.through('synchronized')).filter((e) => e.kind === 'endpoint')).toMatchObject([
    { id: ep, state: 'closed', sessions: [] },
  ]);
  await closing.close();
  expect(await snapshot()).toEqual([]);
  const resumed = '44-abcdef12';
  await getDb().exec(`CREATE TRIGGER interrupt_reopen BEFORE INSERT ON peer_events WHEN NEW.kind='endpoint'
    BEGIN SELECT RAISE(ABORT,'test interrupted endpoint write'); END`);
  expect((await b.putSession(resumed)).status).toBe(500);
  expect(await getDb().get('SELECT id FROM peer_sessions WHERE key=?', resumed)).toBeUndefined();
  expect(await snapshot()).toEqual([]);
  await getDb().exec('DROP TRIGGER interrupt_reopen');
  await b.register(resumed);
  expect(await snapshot()).toMatchObject([{ id: ep, state: 'open', sessions: [resumed] }]);
});
