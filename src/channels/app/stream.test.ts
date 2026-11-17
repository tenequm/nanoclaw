import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { openStream, type StreamDeps } from './stream.js';
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
    end: vi.fn(() => {
      res.emit('close');
    }),
  });
  const subscribe = <T>(name: string, fn: (value: T) => void) => {
    events.on(name, fn);
    return () => {
      events.off(name, fn);
    };
  };
  const deps: StreamDeps = {
    lastEventSeq: async () => 129,
    readEventsAfter: async (after, limit) =>
      Array.from({ length: 11 }, (_, i) => row(i + 119))
        .filter((e) => e.seq > after)
        .slice(0, limit),
    onEventAppended: (fn) => subscribe('event', fn),
    onBadgeChanged: (fn) => subscribe('badge', fn),
    onStatusChanged: (fn) => subscribe('status', fn),
    onDeviceRevoked: (fn) => subscribe('revoke', fn),
    getLiveDevice: async () => ({}),
    reachableAgentIds: async () => ['ag_stan'],
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
  s.deps.reachableAgentIds = async () => [];
  s.res.emit('drain');
  await vi.advanceTimersByTimeAsync(0);
  expect(s.output()).not.toContain('id: 131');
  s.deps.getLiveDevice = async () => undefined;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(s.res.end).toHaveBeenCalled();
  expect(s.events.eventNames()).toEqual([]);
});
it('evicts the oldest fourth stream and closes immediately on revocation', async () => {
  const clients = [setup(), setup(), setup(), setup()];
  for (const s of clients) await openStream(s.ctx, s.deps);
  expect(clients[0].res.end).toHaveBeenCalled();
  for (const s of clients.slice(1)) {
    s.events.emit('revoke', 'd');
    expect(s.res.end).toHaveBeenCalled();
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
