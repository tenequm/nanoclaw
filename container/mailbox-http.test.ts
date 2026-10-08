/**
 * End to end: the real host mailbox (SQLite storage + HTTP endpoint) driven by
 * the real runner client. Lives here because it spans both packages; the
 * runner client is plain TypeScript over fetch, so it runs under Node too.
 */
import fs from 'fs';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: `/tmp/nanoclaw-mailbox-http-e2e-${process.pid}` }));
vi.mock('../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../src/config.js')>('../src/config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

import { HttpServedAgentMailbox, type MailboxHttpSettings } from '../src/mailbox/http/index.js';
import { RUNNER_OPS } from '../src/mailbox/http/runner-ops.js';
import { MAILBOX_HTTP_PROTOCOL as HOST_PROTOCOL } from '../src/mailbox/http/server.js';
import { heartbeatPath } from '../src/session-manager.js';
import {
  HttpAgentMailbox,
  MAILBOX_HTTP_PROTOCOL as RUNNER_PROTOCOL,
  MailboxTransportError,
} from './agent-runner/src/mailbox/http/index.js';

const KEY = { agentGroupId: 'ag-e2e', sessionId: 'sess-e2e' };

let host: HttpServedAgentMailbox;
let runners: HttpAgentMailbox[];

function chat(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'chat' as const,
    timestamp: new Date().toISOString(),
    platformId: 'room',
    channelType: 'test',
    threadId: null,
    content: JSON.stringify({ text: id }),
    processAfter: null,
    recurrence: null,
    ...overrides,
  };
}

async function spawnRunner(options = {}): Promise<HttpAgentMailbox> {
  const context = await host.runnerContext(KEY);
  const runner = new HttpAgentMailbox({ syncIntervalMs: 20, staleAfterMs: 1_000, ...options });
  runners.push(runner);
  await runner.start({ ...KEY, mailbox: JSON.parse(JSON.stringify(context)) });
  return runner;
}

beforeEach(async () => {
  runners = [];
  const settings: MailboxHttpSettings = {
    transport: 'http',
    bind: '127.0.0.1',
    port: 0,
    get url() {
      return `http://127.0.0.1:${host.address()!.port}`;
    },
  };
  host = new HttpServedAgentMailbox(undefined, () => settings);
  await host.listen();
  host.prepare(KEY);
  await host.session(KEY, async (mailbox) => {
    mailbox.setRouting({ channelType: 'test', platformId: 'room', threadId: null });
    mailbox.replaceDestinations([
      {
        name: 'room',
        displayName: 'Room',
        type: 'channel',
        channelType: 'test',
        platformId: 'room',
        agentGroupId: null,
      },
    ]);
  });
});

afterEach(async () => {
  for (const runner of runners) await runner.stop().catch(() => {});
  await host.close();
  await host.destroy(KEY);
});

afterAll(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

describe('HTTP mailbox transport, host and runner together', () => {
  it('agree on the protocol, and the host serves every op the runner sends', async () => {
    expect(RUNNER_PROTOCOL).toBe(HOST_PROTOCOL);
    const sent = new Set<string>();
    const runner = await spawnRunner();
    const { operations } = runner;
    operations.markMessages([], 'completed');
    operations.markScriptSkipped([]);
    operations.setState('k', 'v');
    operations.deleteState('k');
    operations.setContainerToolInFlight('Bash', 1);
    operations.clearContainerToolInFlight();
    operations.markContainerTurn('idle');
    operations.clearStaleProcessingAcks();
    runner.heartbeat();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      for (const { op } of (JSON.parse(String(init?.body)) as { ops: Array<{ op: string }> }).ops) sent.add(op);
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      await operations.writeMessageOut({ id: 'out-ops', kind: 'chat', content: '{}' });
      await runner.run(() => undefined);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect([...sent].sort()).toEqual(
      [
        'clearContainerToolInFlight',
        'clearStaleProcessingAcks',
        'deleteState',
        'heartbeat',
        'markContainerTurn',
        'markMessages',
        'markScriptSkipped',
        'setContainerToolInFlight',
        'setState',
        'snapshot',
        'writeMessageOut',
      ].sort(),
    );
    for (const op of sent) expect(Object.hasOwn(RUNNER_OPS, op), op).toBe(true);
  });

  it('carries a full turn: inbound, claim, reply, delivery bookkeeping', async () => {
    await host.session(KEY, (mailbox) => mailbox.insertMessage(chat('in-1')));
    const runner = await spawnRunner();
    const { operations } = runner;

    expect(operations.getSessionRouting()).toEqual({ channelType: 'test', platformId: 'room', threadId: null });
    expect(operations.findDestinationByName('room')?.displayName).toBe('Room');
    const batch = operations.getPendingMessages(10, true);
    expect(batch.map((m) => m.id)).toEqual(['in-1']);

    operations.markMessages(['in-1'], 'processing');
    operations.setState('current_reply_route', '{"inReplyTo":"in-1"}');
    operations.markContainerTurn('working');
    const sequence = await operations.writeMessageOut({
      id: 'out-1',
      kind: 'chat',
      platformId: 'room',
      channelType: 'test',
      inReplyTo: 'in-1',
      content: '{"text":"hello back"}',
    });
    expect(sequence % 2).toBe(1);

    // Durable on resolve: the host sees the reply and everything queued before it.
    await host.session(KEY, (mailbox) => {
      expect(mailbox.getDueMessages().map((m) => m.id)).toEqual(['out-1']);
      expect(mailbox.getProcessingClaims().map((claim) => claim.messageId)).toEqual(['in-1']);
      expect(mailbox.getState?.('current_reply_route')?.value).toBe('{"inReplyTo":"in-1"}');
      expect(mailbox.getContainerState()?.turn).toBe('working');
      mailbox.markDelivered('out-1', 'platform-out-1');
    });

    await runner.run(() => operations.markMessages(['in-1'], 'completed'));
    await host.session(KEY, (mailbox) => {
      mailbox.applyProcessingAcks(mailbox.getTerminalProcessingAcks());
      expect(mailbox.countDueMessages()).toBe(0);
    });

    await runner.run(() => undefined);
    expect(operations.getPendingMessages(10, false)).toEqual([]);
    expect(operations.getMessageIdBySeq(sequence), 'delivered row maps to its platform id').toBe('platform-out-1');
    expect(operations.getUndeliveredMessages().map((m) => m.id)).toEqual(['out-1']);
    expect(operations.getLatestInboundRoute('test', 'room')).toEqual({ threadId: null, inReplyTo: 'in-1' });
  });

  it('resolves reply targets for pending messages exactly as the host stores them', async () => {
    await host.session(KEY, async (mailbox) => {
      await mailbox.insertMessage(chat('in-1'));
      await mailbox.insertMessage(chat('in-2', { content: JSON.stringify({ text: 'q', replyTo: { id: 'in-1' } }) }));
    });
    const runner = await spawnRunner();
    const [first] = runner.operations.getPendingMessages(10, false);
    expect(runner.operations.findSeqByPlatformMessageId('test', 'room', 'in-1')).toBe(first.sequence);
  });

  it('carries the heartbeat to the file the host sweep reads', async () => {
    const runner = await spawnRunner();
    const file = heartbeatPath(KEY.agentGroupId, KEY.sessionId);
    fs.rmSync(file, { force: true });
    runner.heartbeat();
    await runner.run(() => undefined);
    await vi.waitFor(() => expect(fs.existsSync(file)).toBe(true));
  });

  it('fences out a replaced container: its next exchange is refused and it fails closed', async () => {
    const old = await spawnRunner();
    await spawnRunner(); // respawn rotates the session token
    const refused = await old.run(() => undefined).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(MailboxTransportError);
    expect(old.shouldRestartAfter(refused)).toBe(true);
    expect(() => old.operations.getPendingMessages(10, false)).toThrow('unauthorized');
  });

  it('refuses a session the host never prepared, without creating its storage', async () => {
    const key = { agentGroupId: 'ag-e2e', sessionId: 'sess-missing' };
    const context = await host.runnerContext(key);
    const runner = new HttpAgentMailbox({ syncIntervalMs: 20, staleAfterMs: 1_000 });
    await expect(runner.start({ ...key, mailbox: context })).rejects.toThrow('no_mailbox');
    expect(await host.exists(key)).toBe(false);
    await host.destroy(key);
  });
});
