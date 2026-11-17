import { log } from '../../log.js';
import type { Message } from './contract.js';
import { appendEvent, appTransaction } from './log.js';
import { stopStatus } from './status.js';
import { initDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { dispatchApp } from './routes.js';
import * as deviceAuth from '../../modules/device-auth/verify.js';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { configureStream, openStream, type StreamDeps } from './stream.js';
import type { EventRow, ConversationRow } from './db.js';
import fixtures from './app-contract.fixtures.json' with { type: 'json' };

const frames = fixtures.stream.raw
  .trimEnd()
  .split('\n\n')
  .map((frame) => {
    const lines = frame.split('\n');
    return {
      frame: frame + '\n\n',
      kind: lines.find((l) => l.startsWith('event: '))?.slice(7),
      id: Number(lines.find((l) => l.startsWith('id: '))?.slice(4)),
      data: JSON.parse(lines.find((l) => l.startsWith('data: '))?.slice(6) ?? 'null'),
    };
  });
function row(seq: number): EventRow {
  const f = frames.find((f) => f.id === seq) ?? frames[0];
  return {
    seq,
    user_id: 'u',
    agent_group_id: seq === 124 ? 'other' : 'ag_stan',
    conversation_id: 'conv_stan01',
    entity_id: 'x',
    kind: f.kind!,
    entity_json: JSON.stringify(f.data),
    created_at: 0,
  };
}
function setup(device = 'd') {
  const events = new EventEmitter();
  let output = '';
  const res = Object.assign(new EventEmitter(), {
    writeHead: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((bytes: string) => {
      output += bytes;
      return true;
    }),
    destroy: vi.fn(() => {
      res.emit('close');
    }),
  });
  const subscribe = <T>(name: string, fn: (value: T) => void) => {
    events.on(name, fn);
    return () => {
      events.off(name, fn);
    };
  };
  vi.spyOn(deviceAuth, 'onDeviceRevoked').mockImplementation((fn) => subscribe('revoke', fn));
  vi.spyOn(deviceAuth, 'getLiveDevice').mockResolvedValue({} as Awaited<ReturnType<typeof deviceAuth.getLiveDevice>>);
  vi.spyOn(deviceAuth, 'reachableAgentIds').mockResolvedValue(['ag_stan']);
  const deps: StreamDeps = {
    lastEventSeq: async () => 129,
    readEventsAfter: async (after, limit) =>
      Array.from({ length: 11 }, (_, i) => row(i + 119))
        .filter((e) => e.seq > after)
        .slice(0, limit),
    onEventAppended: (fn) => subscribe('event', fn),
    onBadgeChanged: (fn) => subscribe('badge', fn),
    onStatusChanged: (fn) => subscribe('status', fn),
    conversationsFor: async (_user, agents) =>
      agents.includes('ag_stan') ? [{ id: 'conv_stan01', agent_group_id: 'ag_stan' } as ConversationRow] : [],
    statuses: async () => [fixtures.statuses.working],
    badgeFor: async () => ({ kind: 'badge', rev: 7, unreadTotal: 3 }),
  };
  const ctx = {
    req: {
      url: '/app/events?after=118',
      socket: { setTimeout: vi.fn(), setNoDelay: vi.fn() },
    } as unknown as IncomingMessage,
    res: res as unknown as ServerResponse,
    params: {},
    identity: { deviceId: device, userId: 'u', agentIds: ['ag_stan'] },
  };
  return { events, deps, ctx, res, output: () => output };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('matches the complete fixture byte for byte, including unknown kinds, badge and pings', async () => {
  vi.useFakeTimers();
  const s = setup();
  await openStream(s.ctx, s.deps);
  await vi.advanceTimersByTimeAsync(20_000);
  s.events.emit('event', row(130));
  s.events.emit('event', row(131));
  s.events.emit('status', fixtures.statuses.idle);
  s.deps.badgeFor = async () => ({ kind: 'badge', rev: 8, unreadTotal: 4 });
  s.events.emit('badge', 'u');
  await vi.advanceTimersByTimeAsync(20_000);
  expect(s.output()).toBe(fixtures.stream.raw);
  expect(s.res.writeHead).toHaveBeenCalledWith(
    200,
    expect.objectContaining({ 'X-Accel-Buffering': 'no', 'Cache-Control': 'no-store' }),
  );
  s.res.emit('close');
  expect(s.events.eventNames()).toEqual([]);
});
it('buffers appends and status during replay and sends the append only once', async () => {
  const s = setup();
  const read = s.deps.readEventsAfter;
  s.deps.readEventsAfter = async (...args) => {
    s.events.emit('event', row(130));
    s.events.emit('status', fixtures.statuses.idle);
    return [...(await read(...args)), row(130)];
  };
  await openStream(s.ctx, s.deps);
  expect(s.output().match(/id: 130/g)).toHaveLength(1);
  expect(s.output().indexOf('id: 130')).toBeGreaterThan(s.output().indexOf('event: synchronized'));
  expect(s.output().lastIndexOf('"rev":42')).toBeGreaterThan(s.output().indexOf('event: synchronized'));
  s.res.emit('close');
});
it('cancels mid-replay without leaking subscriptions or writing later', async () => {
  const s = setup();
  s.deps.readEventsAfter = async () => {
    s.res.emit('close');
    return [row(119)];
  };
  await openStream(s.ctx, s.deps);
  expect(s.output()).toBe('');
  expect(s.events.eventNames()).toEqual([]);
});
it('waits for drain, checks current access, and closes on the five-second revocation check', async () => {
  vi.useFakeTimers();
  const s = setup();
  await openStream(s.ctx, s.deps);
  s.res.write.mockImplementationOnce((bytes) => {
    expect(bytes).toContain('130');
    return false;
  });
  s.events.emit('event', row(130));
  await vi.advanceTimersByTimeAsync(0);
  s.events.emit('event', row(131));
  vi.mocked(deviceAuth.reachableAgentIds).mockResolvedValue([]);
  await vi.advanceTimersByTimeAsync(2_000);
  s.res.emit('drain');
  await vi.advanceTimersByTimeAsync(0);
  expect(s.output()).not.toContain('id: 131');
  vi.mocked(deviceAuth.getLiveDevice).mockResolvedValue(undefined);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(s.res.destroy).toHaveBeenCalled();
  expect(s.events.eventNames()).toEqual([]);
});
it('evicts the oldest fourth stream and closes immediately on revocation', async () => {
  const clients = [];
  for (let i = 0; i < 4; i++) {
    const s = setup();
    await openStream(s.ctx, s.deps);
    clients.push(s);
  }
  expect(clients[0].res.destroy).toHaveBeenCalled();
  for (const s of clients.slice(1)) {
    s.events.emit('revoke', 'd');
    expect(s.res.destroy).toHaveBeenCalled();
  }
});
it('delivers read-driven badge changes to both devices', async () => {
  vi.useFakeTimers();
  const clients = [setup('a'), setup('b')];
  for (const s of clients) {
    await openStream(s.ctx, s.deps);
    s.deps.badgeFor = async () => ({ kind: 'badge', rev: 8, unreadTotal: 0 });
    s.events.emit('badge', 'u');
  }
  await vi.advanceTimersByTimeAsync(0);
  for (const s of clients) {
    expect(s.output()).toContain('"unreadTotal":0');
    s.res.emit('close');
  }
});
it('drops a pending drain listener when revoked under backpressure', async () => {
  vi.useFakeTimers();
  const s = setup();
  await openStream(s.ctx, s.deps);
  s.res.write.mockReturnValue(false);
  s.events.emit('event', row(130));
  await vi.advanceTimersByTimeAsync(0);
  expect(s.res.listenerCount('drain')).toBe(1);
  s.events.emit('revoke', 'd');
  await vi.advanceTimersByTimeAsync(0);
  expect(s.res.listenerCount('drain')).toBe(0);
  expect(s.events.eventNames()).toEqual([]);
});
it('reconnects from the cursor without replaying old entities and hides other users', async () => {
  const s = setup();
  s.ctx.req.url = '/app/events?after=128';
  s.deps.readEventsAfter = async () => [{ ...row(129), user_id: 'another' }];
  await openStream(s.ctx, s.deps);
  expect(s.output()).not.toContain('id:');
  expect(s.output()).toContain('"seq":129');
  s.res.emit('close');
});

it('uses signed dispatch and real device access and revocation seams', async () => {
  const s = setup();
  vi.restoreAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(fixtures.hello.serverTime);
  const db = await initDb(':memory:', { role: 'test' });
  await runMigrations(db);
  const vector = fixtures.signing.vectors.find((v) => v.name === 'events-connect')!;
  try {
    await db.run(
      'INSERT INTO device_auth_devices (id,user_id,name,public_key,app_json,created_at) VALUES (?,?,?,?,?,?)',
      vector.deviceId,
      'u',
      'Test',
      fixtures.testKey.publicKeySpki,
      '{}',
      Date.now(),
    );
    await db.run("INSERT INTO users (id,kind,created_at) VALUES ('u','human','now')");
    await db.run("INSERT INTO agent_groups (id,name,folder,created_at) VALUES ('ag_stan','Test','test','now')");
    await db.run(
      "INSERT INTO user_roles (user_id,role,agent_group_id,granted_at) VALUES ('u','admin','ag_stan','now')",
    );
    await db.run("INSERT INTO device_auth_user_agents (user_id,agent_group_id,created_at) VALUES ('u','ag_stan',0)");
    s.ctx.req.method = 'GET';
    s.ctx.req.headers = { authorization: vector.authorization };
    Object.defineProperty(s.ctx.req.socket, 'remoteAddress', { value: '127.0.0.1' });
    configureStream(s.deps);
    await dispatchApp({ req: s.ctx.req, res: s.ctx.res, params: {} });
    expect(s.output()).toContain('event: synchronized');
    expect(s.output()).toContain('id: 129');
    await db.run("DELETE FROM user_roles WHERE user_id = 'u'");
    await vi.advanceTimersByTimeAsync(2_000);
    s.events.emit('event', row(130));
    await vi.advanceTimersByTimeAsync(0);
    expect(s.output()).not.toContain('id: 130');
    await deviceAuth.revokeDevice(vector.deviceId);
    expect(s.res.destroy).toHaveBeenCalled();
    expect(s.events.eventNames()).toEqual([]);
  } finally {
    s.res.emit('close');
    await closeDb();
  }
});

it('streams committed messages through the module-level event log wiring', async () => {
  const s = setup();
  const db = await initDb(':memory:', { role: 'test' });
  await runMigrations(db);
  configureStream();
  s.ctx.req.url = '/app/events?after=0';
  try {
    await openModuleStream();
    expect(s.output()).toContain('event: synchronized');
    const message = { ...fixtures.messages.agentMarkdown, id: 'msg_integration', seq: 0, order: 0 } as Message;
    await appTransaction(() => appendEvent(db, 'u', 'ag_stan', message));
    await vi.waitFor(() => expect(s.output()).toContain('msg_integration'));
    expect(s.output()).toContain('event: message');
  } finally {
    s.res.emit('close');
    await stopStatus();
    await closeDb();
  }
  async function openModuleStream() {
    const { streamEvents } = await import('./stream.js');
    await streamEvents(s.ctx);
  }
});

it('yields between replay pages and caches access for at most two seconds', async () => {
  const s = setup();
  s.ctx.req.url = '/app/events?after=0';
  s.deps.lastEventSeq = async () => 300;
  let yielded = false;
  setImmediate(() => {
    yielded = true;
  });
  s.deps.readEventsAfter = async (after, limit) => {
    if (after >= 100) expect(yielded).toBe(true);
    return Array.from({ length: Math.min(limit, 300 - after) }, (_, i) => ({
      ...row(119),
      seq: after + i + 1,
      kind: 'weather',
      entity_json: JSON.stringify({ seq: after + i + 1 }),
    }));
  };
  await openStream(s.ctx, s.deps);
  expect(deviceAuth.reachableAgentIds).toHaveBeenCalledTimes(1);
  vi.useFakeTimers();
  vi.mocked(deviceAuth.reachableAgentIds).mockResolvedValue([]);
  await vi.advanceTimersByTimeAsync(2_000);
  s.events.emit('event', { ...row(130), seq: 301 });
  await vi.advanceTimersByTimeAsync(0);
  expect(deviceAuth.reachableAgentIds).toHaveBeenCalledTimes(2);
  expect(s.output()).not.toContain('id: 301');
  s.res.emit('close');
});

it('destroys a stalled stream after 45 seconds and removes every subscription', async () => {
  vi.useFakeTimers();
  const s = setup();
  await openStream(s.ctx, s.deps);
  s.res.write.mockReturnValue(false);
  s.events.emit('event', row(130));
  await vi.advanceTimersByTimeAsync(44_999);
  expect(s.res.destroy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(s.res.destroy).toHaveBeenCalledOnce();
  expect(s.res.listenerCount('drain')).toBe(0);
  expect(s.events.eventNames()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
it('bounds pending events while the client is not draining', async () => {
  vi.useFakeTimers();
  const s = setup();
  await openStream(s.ctx, s.deps);
  s.res.write.mockReturnValue(false);
  s.events.emit('event', row(130));
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 257; i++) s.events.emit('event', row(131));
  expect(s.res.destroy).toHaveBeenCalledOnce();
  expect(s.events.eventNames()).toEqual([]);
  expect(s.res.listenerCount('drain')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('resets an ahead-of-log cursor to the synchronized watermark', async () => {
  vi.useFakeTimers();
  const s = setup();
  s.ctx.req.url = '/app/events?after=500';
  await openStream(s.ctx, s.deps);
  expect(s.output()).toContain('event: synchronized\ndata: {"seq":129}');
  s.events.emit('event', row(130));
  await vi.advanceTimersByTimeAsync(0);
  expect(s.output()).toContain('id: 130');
  s.res.emit('close');
});

it.each(['destroyed', 'writableEnded'])('does not subscribe when the response is already %s', async (flag) => {
  const s = setup();
  Object.assign(s.res, { [flag]: true });
  await openStream(s.ctx, s.deps);
  expect(s.events.eventNames()).toEqual([]);
  expect(s.res.eventNames()).toEqual([]);
  expect(s.res.write).not.toHaveBeenCalled();
});
it('cleans up when the response closes during an asynchronous replay read', async () => {
  const s = setup();
  s.deps.readEventsAfter = async () => {
    Object.assign(s.res, { destroyed: true });
    return [row(119)];
  };
  await openStream(s.ctx, s.deps);
  expect(s.res.write).not.toHaveBeenCalled();
  expect(s.events.eventNames()).toEqual([]);
  expect(s.res.listenerCount('drain')).toBe(0);
});

it.each(['replay', 'live'])('logs only device and error kind for malformed %s events', async (phase) => {
  vi.useFakeTimers();
  const s = setup();
  const logged = vi.spyOn(log, 'error').mockImplementation(() => {});
  const malformed = { ...row(130), entity_json: 'private message content' };
  if (phase === 'replay') s.deps.readEventsAfter = async () => [{ ...malformed, seq: 119 }];
  await openStream(s.ctx, s.deps);
  if (phase === 'live') {
    s.events.emit('event', malformed);
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(logged).toHaveBeenCalledWith('App stream failed', { deviceId: 'd', kind: 'SyntaxError' });
  expect(JSON.stringify(logged.mock.calls)).not.toContain('private message content');
  expect(s.res.destroy).toHaveBeenCalled();
});
