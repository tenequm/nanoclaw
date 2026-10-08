import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { SqliteAgentMailbox } from '../sqlite/index.js';
import type { AgentMailbox, MailboxSessionKey } from '../types.js';
import { HttpAgentMailbox, MailboxTransportError, parseHttpMailboxContext } from './index.js';
import { ContextSelectedAgentMailbox, selectMailboxTransport } from './select.js';

type Op = { op: string; args: unknown[] };
type Handler = (ops: Op[], request: Request) => Response | Promise<Response>;

let server: ReturnType<typeof Bun.serve>;
let handler: Handler;
let requests: Array<{ ops: Op[]; headers: Headers }>;
let mailboxes: HttpAgentMailbox[];

function inbound(id: string, sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sequence,
    kind: 'chat',
    timestamp: '2026-01-01T00:00:00.000Z',
    status: 'pending',
    processAfter: null,
    recurrence: null,
    seriesId: id,
    tries: 0,
    trigger: true,
    platformId: 'room',
    channelType: 'test',
    threadId: null,
    content: '{"text":"hi"}',
    sourceSessionId: null,
    onWake: false,
    ...overrides,
  };
}

function outbound(id: string, sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sequence,
    inReplyTo: null,
    timestamp: '2026-01-01T00:00:01.000Z',
    deliverAfter: null,
    recurrence: null,
    kind: 'chat',
    platformId: 'room',
    channelType: 'test',
    threadId: null,
    content: '{"text":"out"}',
    ...overrides,
  };
}

let snapshotState: Record<string, unknown>;

function snapshot() {
  return {
    cursor: { inbound: 10, outbound: 11, delivered: 1 },
    pending: [],
    claimed: {},
    inbound: [],
    outbound: [],
    delivered: [],
    latestRoutes: [],
    replySeqs: [],
    destinations: [],
    routing: { channelType: 'test', platformId: 'room', threadId: null },
    state: [],
    ...snapshotState,
  };
}

/** The stub host: answers every op with null except snapshot, and writeMessageOut with a sequence. */
const defaultHandler: Handler = (ops) =>
  Response.json({
    results: ops.map(({ op }) => (op === 'snapshot' ? snapshot() : op === 'writeMessageOut' ? 13 : null)),
  });

function key(mailbox: unknown = { transport: 'http', protocol: 1, url: server.url.href + 'mailbox/v1', token: 'tok' }) {
  return { agentGroupId: 'ag', sessionId: 'sess', mailbox } satisfies MailboxSessionKey;
}

async function started(options = {}): Promise<HttpAgentMailbox> {
  const mailbox = new HttpAgentMailbox({ syncIntervalMs: 10, staleAfterMs: 300, ...options });
  mailboxes.push(mailbox);
  await mailbox.start(key());
  return mailbox;
}

const allOps = () => requests.flatMap((request) => request.ops.map(({ op }) => op)).filter((op) => op !== 'snapshot');
const settle = () => Bun.sleep(40);

beforeEach(() => {
  requests = [];
  mailboxes = [];
  snapshotState = {};
  handler = defaultHandler;
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const body = (await request.json()) as { ops: Op[] };
      requests.push({ ops: body.ops, headers: request.headers });
      return handler(body.ops, request);
    },
  });
});

afterEach(async () => {
  handler = defaultHandler;
  for (const mailbox of mailboxes) await mailbox.stop().catch(() => {});
  server.stop(true);
});

describe('HTTP mailbox context', () => {
  test('rejects the legacy null sentinel and malformed or mismatched contexts', async () => {
    await expect(new HttpAgentMailbox().start(null)).rejects.toThrow('requires the host session context');
    expect(() => parseHttpMailboxContext({ transport: 'http', protocol: 1, url: 'ftp://x', token: 't' })).toThrow();
    expect(() => parseHttpMailboxContext({ transport: 'http', protocol: 1, url: 'http://x', token: '' })).toThrow();
    expect(() => parseHttpMailboxContext({ transport: 'http', protocol: 2, url: 'http://x', token: 't' })).toThrow(
      'protocol mismatch',
    );
  });

  test('authenticates every request with the session key and token', async () => {
    await started();
    const { headers } = requests[0];
    expect(headers.get('authorization')).toBe('Bearer tok');
    expect(headers.get('x-nanoclaw-agent-group')).toBe('ag');
    expect(headers.get('x-nanoclaw-session')).toBe('sess');
    expect(requests[0].ops).toEqual([{ op: 'snapshot', args: [null] }]);
  });
});

describe('HTTP mailbox reads (served from the replica)', () => {
  test('selects pending messages like the SQLite runner: wake rows first, newest context, no claims', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    snapshotState = {
      pending: [
        inbound('ctx-old', 2, { trigger: false }),
        inbound('wake-1', 4),
        inbound('ctx-new', 6, { trigger: false }),
        inbound('claimed', 8),
        inbound('later', 10, { processAfter: future }),
        inbound('on-wake', 12, { onWake: true }),
      ],
      claimed: { claimed: 'processing' },
    };
    const mailbox = await started();
    expect(mailbox.operations.getPendingMessages(2, false).map((m) => m.id)).toEqual(['wake-1', 'ctx-new']);
    expect(mailbox.operations.getPendingMessages(10, true).map((m) => m.id)).toEqual([
      'ctx-old',
      'wake-1',
      'ctx-new',
      'on-wake',
    ]);
  });

  test('answers lookups by id, seq, platform id and routing from the replica', async () => {
    snapshotState = {
      pending: [
        inbound('q-answer', 20, { kind: 'system', content: '{"questionId":"Q1","answer":"yes"}' }),
        inbound('cli-answer', 22, { kind: 'system', content: '{"requestId":"R1"}' }),
      ],
      inbound: [inbound('old', 2, { status: 'completed', threadId: 't-1' })],
      outbound: [outbound('out-1', 3), outbound('out-2', 5, { deliverAfter: '2999-01-01T00:00:00.000Z' })],
      delivered: [{ messageOutId: 'out-1', platformMessageId: 'platform-1' }],
      latestRoutes: [{ channelType: 'test', platformId: 'room', threadId: 't-1', inReplyTo: 'old' }],
      replySeqs: [{ channelType: 'test', platformId: 'room', platformMessageId: 'way-back', sequence: 1 }],
      destinations: [
        { name: 'room', displayName: null, type: 'channel', channelType: 'test', platformId: 'room', agentGroupId: null },
        { name: 'peer', displayName: 'Peer', type: 'agent', channelType: null, platformId: null, agentGroupId: 'ag-2' },
      ],
      state: [{ key: 'k', value: 'v', updatedAt: '2026-01-01T00:00:00.000Z' }],
    };
    const { operations } = await started();
    expect(operations.getMessageIn('old')?.threadId).toBe('t-1');
    expect(operations.findQuestionResponse('q1')?.id, 'LIKE is case-insensitive').toBe('q-answer');
    expect(operations.findCliResponse('R1')?.id).toBe('cli-answer');
    expect(operations.findCliResponse('R2')).toBeUndefined();
    expect(operations.getMessageIdBySeq(2)).toBe('old');
    expect(operations.getMessageIdBySeq(3), 'delivered outbound maps to its platform id').toBe('platform-1');
    expect(operations.getMessageIdBySeq(5)).toBe('out-2');
    expect(operations.getMessageIdBySeq(99)).toBeNull();
    expect(operations.getRoutingBySeq(2)).toEqual({ channelType: 'test', platformId: 'room', threadId: 't-1' });
    expect(operations.getLatestInboundRoute('test', 'room')).toEqual({ threadId: 't-1', inReplyTo: 'old' });
    expect(operations.getLatestInboundRoute('test', 'elsewhere')).toBeNull();
    expect(operations.findSeqByPlatformMessageId('test', 'room', 'way-back'), 'host-resolved').toBe(1);
    expect(operations.findSeqByPlatformMessageId('test', 'room', 'old'), 'window fallback, inbound').toBe(2);
    expect(operations.findSeqByPlatformMessageId('test', 'room', 'platform-1'), 'window fallback, outbound').toBe(3);
    expect(operations.findSeqByPlatformMessageId('test', 'room', 'nope')).toBeNull();
    expect(operations.getUndeliveredMessages().map((m) => m.id), 'deliverAfter in the future is not due').toEqual([
      'out-1',
    ]);
    expect(operations.getState('k')).toEqual({ value: 'v', updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(operations.getSessionRouting()).toEqual({ channelType: 'test', platformId: 'room', threadId: null });
    expect(operations.getDestinations().map((d) => d.name)).toEqual(['room', 'peer']);
    expect(operations.findDestinationByName('peer')?.agentGroupId).toBe('ag-2');
    expect(operations.findDestinationByRouting('agent', 'ag-2')?.name).toBe('peer');
    expect(operations.findDestinationByRouting('test', 'room')?.name).toBe('room');
  });

  test('a question answer this runner already claimed is not returned', async () => {
    snapshotState = {
      pending: [inbound('q', 2, { content: '{"questionId":"Q1"}' })],
      claimed: { q: 'completed' },
    };
    const { operations } = await started();
    expect(operations.findQuestionResponse('Q1')).toBeUndefined();
  });

  test('works without run(): the background sync keeps the replica fresh', async () => {
    const mailbox = await started();
    expect(mailbox.operations.getPendingMessages(10, false)).toEqual([]);
    snapshotState = { pending: [inbound('late', 2)] };
    await settle();
    expect(mailbox.operations.getPendingMessages(10, false).map((m) => m.id)).toEqual(['late']);
  });
});

describe('HTTP mailbox writes', () => {
  test('sync writes show up locally at once and reach the host in order', async () => {
    snapshotState = { pending: [inbound('m1', 2), inbound('m2', 4)] };
    const mailbox = await started();
    const { operations } = mailbox;
    operations.markMessages(['m1'], 'processing');
    operations.setState('k', 'v');
    operations.deleteState('k');
    operations.setState('kept', 'x');
    expect(operations.getPendingMessages(10, false).map((m) => m.id), 'read-your-writes').toEqual(['m2']);
    expect(operations.getState('kept')?.value).toBe('x');
    operations.setContainerToolInFlight('Bash', 1000);
    operations.markContainerTurn('working');
    operations.clearContainerToolInFlight();
    operations.markScriptSkipped([{ id: 'm2', reason: 'error' }]);
    operations.clearStaleProcessingAcks();
    await mailbox.run(() => undefined);
    expect(allOps()).toEqual([
      'markMessages',
      'setState',
      'deleteState',
      'setState',
      'setContainerToolInFlight',
      'markContainerTurn',
      'clearContainerToolInFlight',
      'markScriptSkipped',
      'clearStaleProcessingAcks',
    ]);
  });

  test('run() refreshes before the action and commits its writes before resolving', async () => {
    const mailbox = await started({ syncIntervalMs: 60_000 });
    snapshotState = { state: [{ key: 'route', value: 'r', updatedAt: '2026-01-01T00:00:00.000Z' }] };
    const seen = await mailbox.run(() => {
      mailbox.operations.setState('written', 'y');
      return mailbox.operations.getState('route')?.value;
    });
    expect(seen).toBe('r');
    expect(allOps()).toEqual(['setState']);
  });

  test('writeMessageOut resolves with the host-assigned sequence only after the host answered', async () => {
    const mailbox = await started();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    handler = async (ops, request) => {
      if (ops.some(({ op }) => op === 'writeMessageOut')) await gate;
      return defaultHandler(ops, request);
    };
    let settled = false;
    const write = mailbox.operations.writeMessageOut({ id: 'o1', kind: 'chat', content: '{}' }).then((sequence) => {
      settled = true;
      return sequence;
    });
    await settle();
    expect(settled).toBe(false);
    release();
    expect(await write).toBe(13);
  });

  test('rejects an invalid outbound draft before it is queued', async () => {
    const mailbox = await started();
    await expect(mailbox.operations.writeMessageOut({ id: 'o1', kind: 'chat' } as never)).rejects.toThrow();
    expect(allOps()).toEqual([]);
  });

  test('retries writes through a transient host outage', async () => {
    const mailbox = await started({ staleAfterMs: 5_000 });
    let failures = 3;
    handler = (ops, request) => (failures-- > 0 ? new Response('busy', { status: 503 }) : defaultHandler(ops, request));
    expect(await mailbox.operations.writeMessageOut({ id: 'o1', kind: 'chat', content: '{}' })).toBe(13);
    expect(mailbox.operations.getPendingMessages(10, false)).toEqual([]);
  });

  test('carries the heartbeat to the host instead of touching a file', async () => {
    const mailbox = await started();
    expect(mailbox.heartbeat()).toBe(true);
    mailbox.heartbeat();
    await settle();
    expect(allOps().filter((op) => op === 'heartbeat').length).toBeGreaterThanOrEqual(1);
  });
});

describe('HTTP mailbox fails closed', () => {
  test('a refused request poisons the mailbox: every op throws and the runner asks for a restart', async () => {
    snapshotState = { pending: [inbound('m1', 2)] };
    const mailbox = await started();
    handler = () => Response.json({ error: { code: 'unauthorized', message: 'session token mismatch' } }, { status: 401 });
    const write = mailbox.operations.writeMessageOut({ id: 'o1', kind: 'chat', content: '{}' });
    await expect(write).rejects.toThrow('unauthorized');
    let error: unknown;
    try {
      mailbox.operations.getPendingMessages(10, false);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(MailboxTransportError);
    expect(mailbox.shouldRestartAfter(error)).toBe(true);
    expect(() => mailbox.operations.setState('k', 'v')).toThrow('unauthorized');
    await expect(mailbox.run(() => 1)).rejects.toThrow('unauthorized');
  });

  test('an unreachable host never reads as an empty mailbox', async () => {
    snapshotState = { pending: [inbound('m1', 2)] };
    const mailbox = await started({ staleAfterMs: 150 });
    server.stop(true);
    expect(mailbox.operations.getPendingMessages(10, false).map((m) => m.id), 'last good snapshot').toEqual(['m1']);
    await Bun.sleep(400);
    expect(() => mailbox.operations.getPendingMessages(10, false)).toThrow(MailboxTransportError);
  });

  test('start() gives up loudly when the host never answers', async () => {
    server.stop(true);
    const mailbox = new HttpAgentMailbox({ syncIntervalMs: 10, staleAfterMs: 100 });
    await expect(mailbox.start(key())).rejects.toThrow(MailboxTransportError);
  });

  test('operations before start() throw instead of answering', () => {
    expect(() => new HttpAgentMailbox().operations.getDestinations()).toThrow('before start()');
  });
});

describe('context-selected composition', () => {
  test('selects the transport from the host context and rejects anything else', () => {
    expect(selectMailboxTransport(null)).toBe('sqlite');
    expect(selectMailboxTransport({ agentGroupId: 'a', sessionId: 's', mailbox: null })).toBe('sqlite');
    expect(selectMailboxTransport({ agentGroupId: 'a', sessionId: 's', mailbox: { transport: 'http' } })).toBe('http');
    expect(() => selectMailboxTransport({ agentGroupId: 'a', sessionId: 's', mailbox: { transport: 'smtp' } })).toThrow(
      'Invalid mailbox selection',
    );
    expect(() => selectMailboxTransport({ agentGroupId: 'a', sessionId: 's', mailbox: 'http' })).toThrow(
      'Invalid mailbox selection',
    );
  });

  test('behaves as SQLite before start and switches to HTTP when the context says so', async () => {
    const created: AgentMailbox[] = [];
    const sqlite = new SqliteAgentMailbox();
    const selected = new ContextSelectedAgentMailbox(
      () => sqlite,
      () => {
        const mailbox = new HttpAgentMailbox({ syncIntervalMs: 10, staleAfterMs: 300 });
        created.push(mailbox);
        mailboxes.push(mailbox);
        return mailbox;
      },
    );
    expect(selected.operations).toBe(sqlite.operations);
    expect(selected.heartbeat(), 'SQLite leaves the heartbeat file to the caller').toBe(false);
    await selected.start(key());
    expect(created).toHaveLength(1);
    expect(selected.operations).toBe(created[0].operations);
    expect(selected.heartbeat()).toBe(true);
    expect(selected.shouldRestartAfter(new MailboxTransportError('x', false))).toBe(true);
    await selected.stop();
  });

  test('the runner compose slot registers the context-selected mailbox', async () => {
    const source = await Bun.file(new URL('../compose.ts', import.meta.url)).text();
    expect(source).toContain('new ContextSelectedAgentMailbox(() => new SqliteAgentMailbox())');
  });

  test('every standalone entry point that touches the mailbox starts it first', async () => {
    const read = (relative: string) => Bun.file(new URL(relative, import.meta.url)).text();
    for (const entry of ['../../index.ts', '../../mcp-tools/index.ts', '../../cli/ncl.ts', '../../compact-instructions.ts']) {
      const source = await read(entry);
      expect(source, entry).toMatch(/modules\/index\.js'/);
      expect(source, entry).toContain('readMailboxContext()');
      expect(source, entry).toMatch(/mailbox\.start\(/);
    }
  });
});
