/**
 * Delivery race tests.
 *
 * The active poll (1s, running sessions) and the sweep poll (60s, all
 * active sessions) both call deliverSessionMessages. A running session
 * sits in both result sets, so the two timer chains can race on the same
 * outbound row — read-undelivered → call channel API → markDelivered. The
 * INSERT OR IGNORE in markDelivered makes the DB write idempotent, but
 * the channel API has already fired twice → user sees the message twice.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-delivery', GROUPS_DIR: '/tmp/nanoclaw-test-delivery/groups' };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { getDeliveredIds } from './mailbox/sqlite/session-db.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { resolveSession, resolveTaskSession, withMailboxSession } from './session-manager.js';
import {
  deliverSessionMessages,
  registerDeliveryBatchPreview,
  registerPostDeliveryHook,
  setDeliveryAdapter,
} from './delivery.js';
import { createChannelDeliveryAdapter } from './channels/channel-registry.js';
import { createDestination } from './modules/agent-to-agent/db/agent-destinations.js';
import { getAgentMailbox } from './mailbox/index.js';
import { log } from './log.js';

function openInboundDb(agentGroupId: string, sessionId: string): Database.Database {
  return new Database(inboundDbPath(agentGroupId, sessionId));
}

function now(): string {
  return new Date().toISOString();
}

async function seedAgentAndChannel(): Promise<void> {
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

function insertOutbound(agentGroupId: string, sessionId: string, msgId: string): void {
  insertOperation(agentGroupId, sessionId, msgId, { text: 'hello' });
}

function insertOperation(agentGroupId: string, sessionId: string, msgId: string, content: unknown): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, datetime('now'), 'chat', 'telegram:123', 'telegram', ?)`,
  ).run(msgId, JSON.stringify(content));
  db.close();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('deliverSessionMessages — concurrent invocations', () => {
  it('logs mailbox failures with session context and retries on the next poll', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    const err = new Error('mailbox unavailable');
    const sessionSpy = vi.spyOn(getAgentMailbox(), 'session').mockRejectedValueOnce(err);
    const logSpy = vi.spyOn(log, 'error').mockImplementation(() => {});

    try {
      await deliverSessionMessages(session);
      expect(logSpy).toHaveBeenCalledWith('Session mailbox delivery failed', {
        agentGroupId: 'ag-1',
        sessionId: session.id,
        err,
      });

      await deliverSessionMessages(session);
      expect(sessionSpy).toHaveBeenCalledTimes(2);
    } finally {
      sessionSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('delivers a message exactly once when active and sweep polls overlap', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-1');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        // Hold long enough that the second concurrent caller can race the
        // read-undelivered → markDelivered window.
        await new Promise((r) => setTimeout(r, 100));
        return 'plat-msg-1';
      },
    });

    // Two concurrent calls — simulating active (1s) and sweep (60s) polls
    // hitting the same running session at the same moment.
    await Promise.all([deliverSessionMessages(session), deliverSessionMessages(session)]);

    expect(calls).toHaveLength(1);
  });

  it('still delivers on a subsequent call after the first finishes', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-first');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);
    expect(calls).toHaveLength(1);

    // Insert a second outbound message and deliver again — the lock from
    // the first call must have been released.
    insertOutbound('ag-1', session.id, 'out-second');
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(2);
  });

  it('does not re-deliver when retried after a successful send (cleanup-after-send safety)', async () => {
    // If something post-send throws (e.g. outbox cleanup), the message has
    // still landed on the user's screen — the catch path must not trigger
    // a re-send. We simulate by having the adapter succeed on the first
    // call and recording how many times it's invoked across two attempts.
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-once');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);
    // Re-invoke — should be idempotent because the message is now in the
    // delivered table; the channel adapter must not be called again.
    await deliverSessionMessages(session);

    expect(callCount).toBe(1);
  });
});

describe('deliverSessionMessages — malformed row containment', () => {
  it('a row that fails strict parsing does not block the rest of the queue', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');

    // A non-integer seq fails parseOutboundRecord's strict integer check —
    // the adapter must fall back to a best-effort read instead of throwing
    // out of getDueMessages and starving every later message.
    const db = new Database(outboundDbPath('ag-1', session.id));
    db.prepare(
      `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, content)
       VALUES ('out-bad', 3.5, datetime('now'), 'chat', 'telegram:123', 'telegram', ?)`,
    ).run(JSON.stringify({ text: 'weird row' }));
    db.close();
    insertOutbound('ag-1', session.id, 'out-good');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, content) {
        calls.push(content);
        return 'plat-msg';
      },
    });

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(2);
    const delivered = await withMailboxSession('ag-1', session.id, (mailbox) => mailbox.getDeliveredIds());
    expect(delivered.has('out-good')).toBe(true);
    expect(delivered.has('out-bad')).toBe(true);

    expect(warn).toHaveBeenCalledTimes(1);
    await deliverSessionMessages(session);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('deliverSessionMessages — retry and permanent failure', () => {
  it('retries on adapter failure and marks failed after MAX_DELIVERY_ATTEMPTS (3)', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-flaky');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        throw new Error('network timeout');
      },
    });

    // Attempt 1
    await deliverSessionMessages(session);
    expect(callCount).toBe(1);

    // Attempt 2
    await deliverSessionMessages(session);
    expect(callCount).toBe(2);

    // Attempt 3 — should mark as permanently failed
    await deliverSessionMessages(session);
    expect(callCount).toBe(3);

    // Attempt 4 — message is now in delivered (as failed), adapter not called
    await deliverSessionMessages(session);
    expect(callCount).toBe(3);

    // Verify the message is in the delivered table with 'failed' status
    const delivered = await withMailboxSession('ag-1', session.id, (mailbox) => mailbox.getDeliveredIds());
    expect(delivered.has('out-flaky')).toBe(true);
  });

  it('does not acknowledge a message when no channel adapter is registered (#2995)', async () => {
    // Regression: the real bridge used to return undefined when the exact
    // adapter lookup missed, and drainSession marked the row delivered with
    // platform_message_id=NULL even though no send happened. The bridge must
    // throw so the row takes the normal retry → failed path. Uses the REAL
    // createChannelDeliveryAdapter with an empty registry — the state after
    // an adapter factory returns null (missing credentials) at startup.
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-offline');

    setDeliveryAdapter(createChannelDeliveryAdapter());

    // Attempt 1 — must NOT be acknowledged as delivered
    await deliverSessionMessages(session);
    expect(
      await withMailboxSession('ag-1', session.id, (mailbox) => mailbox.getDeliveredIds().has('out-offline')),
    ).toBe(false);

    // Attempts 2 and 3 — exhausts MAX_DELIVERY_ATTEMPTS
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    // The row must end as status='failed', never 'delivered'
    const deliveryDb = new Database(inboundDbPath('ag-1', session.id), { readonly: true });
    const row = deliveryDb.prepare('SELECT * FROM delivered WHERE message_out_id = ?').get('out-offline') as
      | { status: string; platform_message_id: string | null }
      | undefined;
    deliveryDb.close();
    expect(row).toBeDefined();
    expect(row!.status).toBe('failed');
    expect(row!.platform_message_id).toBeNull();
  });

  it('clears attempt counter on successful delivery', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-retry-ok');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        if (callCount === 1) throw new Error('transient');
        return 'plat-ok';
      },
    });

    // Attempt 1 — fails
    await deliverSessionMessages(session);
    expect(callCount).toBe(1);

    // Attempt 2 — succeeds
    await deliverSessionMessages(session);
    expect(callCount).toBe(2);

    // Attempt 3 — not called, message already delivered
    await deliverSessionMessages(session);
    expect(callCount).toBe(2);
  });
});

describe('deliverSessionMessages — instance resolution', () => {
  it('delivers via the origin session instance when sibling rows share (channel_type, platform_id)', async () => {
    await createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    // Two instances own the same chat address. The named row sorts before
    // 'slack', so a plain by-platform lookup (default-instance-first) would
    // pick mg-default — only origin-session preference selects mg-tester.
    await createMessagingGroup({
      id: 'mg-default',
      channel_type: 'slack',
      platform_id: 'slack:C1',
      name: 'Default',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-tester',
      channel_type: 'slack',
      platform_id: 'slack:C1',
      instance: 'alpha-tester',
      name: 'Tester',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    const { session } = await resolveSession('ag-1', 'mg-tester', null, 'shared');
    const db = new Database(outboundDbPath('ag-1', session.id));
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES ('out-inst', datetime('now'), 'chat', 'slack:C1', 'slack', ?)`,
    ).run(JSON.stringify({ text: 'hi' }));
    db.close();

    const instances: Array<string | undefined> = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, _content, _files, instance) {
        instances.push(instance);
        return 'plat-1';
      },
    });

    await deliverSessionMessages(session);
    expect(instances).toEqual(['alpha-tester']);
  });

  it('default session passes the backfilled default instance (= channel_type)', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-default-inst');

    const instances: Array<string | undefined> = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, _content, _files, instance) {
        instances.push(instance);
        return 'plat-2';
      },
    });

    await deliverSessionMessages(session);
    expect(instances).toEqual(['telegram']);
  });
});

describe('deliverSessionMessages — permission check', () => {
  it('rejects delivery to an unauthorized channel destination', async () => {
    await seedAgentAndChannel();

    // Create a second messaging group that the agent is NOT wired to
    await createMessagingGroup({
      id: 'mg-2',
      channel_type: 'discord',
      platform_id: 'discord:456',
      name: 'Unauthorized Chat',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    // Session is on mg-1 (telegram)
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');

    // Insert an outbound message targeting mg-2 (discord) — not the origin chat
    const outDb = new Database(outboundDbPath('ag-1', session.id));
    outDb
      .prepare(
        `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, datetime('now'), 'chat', 'discord:456', 'discord', ?)`,
      )
      .run('out-unauth', JSON.stringify({ text: 'sneaky' }));
    outDb.close();

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, content) {
        calls.push(content);
        return 'plat-msg';
      },
    });

    // Deliver 3 times to exhaust retries
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    // Adapter never called — permission check throws before reaching it
    expect(calls).toHaveLength(0);

    // Message is marked as permanently failed
    const delivered = await withMailboxSession('ag-1', session.id, (mailbox) => mailbox.getDeliveredIds());
    expect(delivered.has('out-unauth')).toBe(true);
  });

  it("authorizes and delivers via the sender's own instance when sibling instances share a platform address", async () => {
    await seedAgentAndChannel();

    // Two sibling messaging groups share one physical channel address but
    // belong to different adapter instances (e.g. two bot identities in the
    // same multi-bot room). "alpha" sorts before "zulu" lexically, so a
    // plain by-platform lookup with no instance hint would pick "alpha" —
    // the wrong sibling for this sender.
    await createMessagingGroup({
      id: 'mg-sib-alpha',
      channel_type: 'discord',
      platform_id: 'discord:999',
      instance: 'alpha',
      name: 'Shared Room',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-sib-zulu',
      channel_type: 'discord',
      platform_id: 'discord:999',
      instance: 'zulu',
      name: 'Shared Room',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    // The sender is only authorized against its own ("zulu") sibling.
    await createDestination({
      agent_group_id: 'ag-1',
      local_name: 'room',
      target_type: 'channel',
      target_id: 'mg-sib-zulu',
      created_at: now(),
    });

    // Session origin is mg-1 (telegram) — not the shared room, so the
    // origin-session shortcut doesn't apply here.
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');

    const outDb = new Database(outboundDbPath('ag-1', session.id));
    outDb
      .prepare(
        `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, datetime('now'), 'chat', 'discord:999', 'discord', ?)`,
      )
      .run('out-shared-room', JSON.stringify({ text: 'hello room' }));
    outDb.close();

    const calls: Array<{ content: string; instance: string | undefined }> = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, content, _files, instance) {
        calls.push({ content, instance });
        return 'plat-room';
      },
    });

    await deliverSessionMessages(session);

    // Delivered exactly once, through the sender's own ("zulu") instance —
    // not the lexically-first ("alpha") sibling.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.instance).toBe('zulu');

    const inDb = openInboundDb('ag-1', session.id);
    const delivered = getDeliveredIds(inDb);
    inDb.close();
    expect(delivered.has('out-shared-room')).toBe(true);
  });

  it('still authorizes and delivers an ordinary single-instance non-origin channel destination', async () => {
    await seedAgentAndChannel();

    // A second, single-instance channel the agent is legitimately wired to
    // (the common case: broadcasting from a DM session to a wired channel —
    // no sibling instances, no ambiguity, exactly one row for this address).
    await createMessagingGroup({
      id: 'mg-broadcast',
      channel_type: 'discord',
      platform_id: 'discord:789',
      name: 'Team Channel',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    await createDestination({
      agent_group_id: 'ag-1',
      local_name: 'team-channel',
      target_type: 'channel',
      target_id: 'mg-broadcast',
      created_at: now(),
    });

    // Session is on mg-1 (telegram) — not the origin of the broadcast target.
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');

    const outDb = new Database(outboundDbPath('ag-1', session.id));
    outDb
      .prepare(
        `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, datetime('now'), 'chat', 'discord:789', 'discord', ?)`,
      )
      .run('out-broadcast', JSON.stringify({ text: 'status update' }));
    outDb.close();

    const calls: Array<{ content: string; instance: string | undefined }> = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, content, _files, instance) {
        calls.push({ content, instance });
        return 'plat-broadcast';
      },
    });

    await deliverSessionMessages(session);

    // Unaffected by the destination-preferring resolution: single-instance
    // installs have exactly one row per address, so behavior is unchanged —
    // delivered once, through the channel's (default) instance.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.instance).toBe('discord');

    const inDb = openInboundDb('ag-1', session.id);
    const delivered = getDeliveredIds(inDb);
    inDb.close();
    expect(delivered.has('out-broadcast')).toBe(true);
  });
});

describe('deliverSessionMessages — task_log rows (one-door task delivery)', () => {
  it('appends to the series run log and never calls the adapter', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveTaskSession('ag-1', 'daily-digest-a1b2');

    const db = new Database(outboundDbPath('ag-1', session.id));
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, content)
       VALUES ('log-1', datetime('now'), 'task_log', ?)`,
    ).run(JSON.stringify({ text: 'checked feeds; nothing new' }));
    db.close();

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_c, _p, _t, _k, content) {
        calls.push(content);
        return 'pm';
      },
    });
    await deliverSessionMessages(session);

    expect(calls).toHaveLength(0); // a run-log line is not a delivery
    const logFile = `${TEST_DIR}/groups/test-agent/tasks/daily-digest-a1b2.md`;
    expect(fs.existsSync(logFile)).toBe(true);
    const line = fs.readFileSync(logFile, 'utf8').trim();
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} — checked feeds; nothing new$/);
    // Marked delivered — the row is not retried.
    const delivered = await withMailboxSession('ag-1', session.id, (mailbox) => mailbox.getDeliveredIds());
    expect(delivered.has('log-1')).toBe(true);
  });
});

describe('deliverSessionMessages — batch preview hooks', () => {
  it('hooks see the whole undelivered batch before row processing; a throwing hook never breaks delivery', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'bp-1');
    insertOutbound('ag-1', session.id, 'bp-2');

    const seen: Array<{ kinds: string[]; sessionId: string }> = [];
    registerDeliveryBatchPreview((batch, s) => {
      seen.push({ kinds: batch.map((m) => m.kind), sessionId: s.id });
    });
    registerDeliveryBatchPreview(() => {
      throw new Error('hook exploded');
    });

    const sent: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        sent.push(content);
        return undefined;
      },
    });

    await deliverSessionMessages(session);

    expect(seen.length).toBe(1);
    expect(seen[0].kinds).toEqual(['chat', 'chat']);
    expect(seen[0].sessionId).toBe(session.id);
    expect(sent.length).toBe(2); // the throwing hook did not block delivery
  });
});

describe('deliverSessionMessages — post-delivery hooks', () => {
  function insertOutboundRow(
    agentGroupId: string,
    sessionId: string,
    msgId: string,
    kind: string,
    timestamp: string,
    content: Record<string, unknown> = { text: 'hello' },
  ): void {
    const db = new Database(outboundDbPath(agentGroupId, sessionId));
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, ?, ?, 'telegram:123', 'telegram', ?)`,
    ).run(msgId, timestamp, kind, JSON.stringify(content));
    db.close();
  }

  function passthroughAdapter(): void {
    setDeliveryAdapter({
      async deliver() {
        return 'pm';
      },
    });
  }

  it('fires only for user-facing kinds — system and task_log rows are skipped', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    // Unknown system action: handled internally, marked delivered, no hook.
    insertOutboundRow('ag-1', session.id, 'pd-sys', 'system', '2026-01-01T00:00:01.000Z', { action: 'nope' });
    // task_log outside a task session: ignored + marked delivered, no hook.
    insertOutboundRow('ag-1', session.id, 'pd-log', 'task_log', '2026-01-01T00:00:02.000Z', { text: 'log line' });
    insertOutboundRow('ag-1', session.id, 'pd-chat', 'chat', '2026-01-01T00:00:03.000Z');

    const seen: string[] = [];
    registerPostDeliveryHook((msg) => {
      if (msg.id.startsWith('pd-')) seen.push(msg.id);
    });
    passthroughAdapter();

    await deliverSessionMessages(session);

    expect(seen).toEqual(['pd-chat']);
    // All three rows were still marked delivered.
    const delivered = getDeliveredIds(openInboundDb('ag-1', session.id));
    expect(delivered.has('pd-sys')).toBe(true);
    expect(delivered.has('pd-log')).toBe(true);
    expect(delivered.has('pd-chat')).toBe(true);
  });

  it('firstDelivery is true exactly on the first delivered row of a fresh session', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutboundRow('ag-1', session.id, 'fd-1', 'chat', '2026-01-01T00:00:01.000Z');
    insertOutboundRow('ag-1', session.id, 'fd-2', 'chat', '2026-01-01T00:00:02.000Z');

    const seen: Array<{ id: string; firstDelivery: boolean; sessionId: string }> = [];
    registerPostDeliveryHook((msg, s, info) => {
      if (msg.id.startsWith('fd-')) seen.push({ id: msg.id, firstDelivery: info.firstDelivery, sessionId: s.id });
    });
    passthroughAdapter();

    await deliverSessionMessages(session);
    expect(seen).toEqual([
      { id: 'fd-1', firstDelivery: true, sessionId: session.id },
      { id: 'fd-2', firstDelivery: false, sessionId: session.id },
    ]);

    // A later drain of the same session never reports firstDelivery again.
    insertOutboundRow('ag-1', session.id, 'fd-3', 'chat', '2026-01-01T00:00:03.000Z');
    await deliverSessionMessages(session);
    expect(seen[2]).toEqual({ id: 'fd-3', firstDelivery: false, sessionId: session.id });
  });

  it('a throwing hook never breaks delivery or markDelivered', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutboundRow('ag-1', session.id, 'th-1', 'chat', '2026-01-01T00:00:01.000Z');
    insertOutboundRow('ag-1', session.id, 'th-2', 'chat', '2026-01-01T00:00:02.000Z');

    registerPostDeliveryHook(() => {
      throw new Error('hook exploded');
    });
    // A hook registered after the throwing one still runs.
    const after: string[] = [];
    registerPostDeliveryHook((msg) => {
      if (msg.id.startsWith('th-')) after.push(msg.id);
    });

    const sent: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        sent.push(content);
        return 'pm';
      },
    });

    await deliverSessionMessages(session);

    expect(sent).toHaveLength(2); // the throwing hook did not block delivery
    expect(after).toEqual(['th-1', 'th-2']);
    const delivered = getDeliveredIds(openInboundDb('ag-1', session.id));
    expect(delivered.has('th-1')).toBe(true);
    expect(delivered.has('th-2')).toBe(true);
  });
});

/**
 * A reaction the platform will not accept used to die inside the adapter with
 * a log line: the agent was told nothing and believed it had reacted (live,
 * `white_check_mark` twice in one day). Delivery now resolves the emoji
 * against the adapter's fixed set and reports back into the same session.
 */
describe('deliverSessionMessages — reaction fallback and feedback', () => {
  interface NoteRow {
    kind: string;
    channel_type: string | null;
    platform_id: string | null;
    thread_id: string | null;
    trigger: number;
    content: string;
  }

  function insertReaction(agentGroupId: string, sessionId: string, msgId: string, emoji: string): void {
    insertOperation(agentGroupId, sessionId, msgId, { operation: 'reaction', messageId: '4242', emoji });
  }

  function notes(sessionId: string): NoteRow[] {
    const db = openInboundDb('ag-1', sessionId);
    const rows = db
      .prepare(
        `SELECT kind, channel_type, platform_id, thread_id, trigger, content FROM messages_in
          WHERE id LIKE 'reaction-note-%' ORDER BY seq ASC`,
      )
      .all() as NoteRow[];
    db.close();
    return rows;
  }

  /** Telegram-shaped resolver: ✅ substitutes to 👌, 🍕 has no stand-in. */
  function reactionAdapter(delivered: string[]): void {
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        delivered.push(content);
        return 'plat-msg-1';
      },
      resolveReaction(_channelType, emoji) {
        const allowed = ['👍', '👌', '👀'];
        if (allowed.includes(emoji)) return { emoji, substituted: false, platform: 'Telegram', allowed };
        if (emoji === '✅' || emoji === 'white_check_mark') {
          return { emoji: '👌', substituted: true, platform: 'Telegram', allowed };
        }
        return { emoji: null, substituted: false, platform: 'Telegram', allowed };
      },
    });
  }

  it('delivers the substituted glyph and tells the agent what went out instead', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertReaction('ag-1', session.id, 'out-sub', 'white_check_mark');

    const delivered: string[] = [];
    reactionAdapter(delivered);
    await deliverSessionMessages(session);

    expect(delivered).toHaveLength(1);
    expect(JSON.parse(delivered[0]!).emoji).toBe('👌');

    const rows = notes(session.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.content).text).toBe(
      'Your reaction "white_check_mark" is not in Telegram\'s allowed set; sent 👌 instead.',
    );
  });

  it('drops an unmappable reaction, delivers nothing, and reports the allowed set', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertReaction('ag-1', session.id, 'out-drop', '🍕');

    const delivered: string[] = [];
    reactionAdapter(delivered);
    await deliverSessionMessages(session);

    expect(delivered).toEqual([]);
    const rows = notes(session.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.content).text).toBe(
      'Your reaction "🍕" was not sent: Telegram only allows a fixed reaction set. Allowed: 👍 👌 👀.',
    );
    // Marked delivered all the same — nothing is retryable about an illegal emoji.
    const inDb = openInboundDb('ag-1', session.id);
    expect(getDeliveredIds(inDb).has('out-drop')).toBe(true);
    inDb.close();
  });

  it('notes are non-waking context rows, never a chat surface', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertReaction('ag-1', session.id, 'out-shape', '🍕');
    reactionAdapter([]);
    await deliverSessionMessages(session);

    const [row] = notes(session.id);
    // trigger=0: rides along as context, never wakes a container. channel_type
    // 'agent' + null platform id: not a chat surface, so it is never routed,
    // judged or echo-fanned. kind 'chat', NOT 'system' — the container's poll
    // loop filters 'system' rows out of agent batches.
    expect(row!.trigger).toBe(0);
    expect(row!.kind).toBe('chat');
    expect(row!.channel_type).toBe('agent');
    expect(row!.platform_id).toBeNull();
    expect(row!.thread_id).toBeNull();
    expect(JSON.parse(row!.content).sender).toBe('system');
  });

  it('an exact match is delivered byte-identical, with no note', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertReaction('ag-1', session.id, 'out-exact', '👀');

    const delivered: string[] = [];
    reactionAdapter(delivered);
    await deliverSessionMessages(session);

    expect(JSON.parse(delivered[0]!).emoji).toBe('👀');
    expect(notes(session.id)).toEqual([]);
  });

  it('does not claim a substituted glyph was sent when the send fails', async () => {
    // The note phrases a completed action ("sent 👌 instead"), so writing it
    // before deliver() would leave the agent believing in a send that a failed
    // delivery never made — and after MAX_DELIVERY_ATTEMPTS nothing retracts it.
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertReaction('ag-1', session.id, 'out-subfail', 'white_check_mark');

    setDeliveryAdapter({
      deliver() {
        throw new Error('telegram down');
      },
      resolveReaction(_channelType, emoji) {
        const allowed = ['👍', '👌', '👀'];
        if (emoji === 'white_check_mark') return { emoji: '👌', substituted: true, platform: 'Telegram', allowed };
        return { emoji, substituted: false, platform: 'Telegram', allowed };
      },
    });
    await deliverSessionMessages(session);

    expect(notes(session.id)).toEqual([]);
  });

  it('an adapter with no fixed set forwards the emoji untouched', async () => {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertReaction('ag-1', session.id, 'out-free', '🍕');

    const delivered: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        delivered.push(content);
        return 'plat-msg-1';
      },
    });
    await deliverSessionMessages(session);

    expect(JSON.parse(delivered[0]!).emoji).toBe('🍕');
    expect(notes(session.id)).toEqual([]);
  });
});

describe('deliverSessionMessages — agent-scoped message ids', () => {
  /**
   * The agent addresses a message by its inbound ROW id, which the router
   * suffixed with the agent group to keep ids unique across the fan-out. The
   * platform has never seen that suffix: Slack passed the whole string to
   * reactions.add as a ts and got message_not_found (live, 2026-08-31).
   */
  async function deliveredContent(content: unknown): Promise<Record<string, unknown>> {
    await seedAgentAndChannel();
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOperation('ag-1', session.id, `out-${Math.random().toString(36).slice(2, 8)}`, content);

    let seen = '';
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, delivered) {
        seen = delivered;
        return 'plat-msg-1';
      },
    });
    await deliverSessionMessages(session);
    return JSON.parse(seen) as Record<string, unknown>;
  }

  it('strips the agent-group suffix from a reaction target', async () => {
    const payload = await deliveredContent({
      operation: 'reaction',
      messageId: '1788196934.001629:ag-1',
      emoji: 'thumbs_up',
    });
    expect(payload.messageId).toBe('1788196934.001629');
    expect(payload.emoji).toBe('thumbs_up');
  });

  it('strips it from an edit target too', async () => {
    const payload = await deliveredContent({ operation: 'edit', messageId: '1788196934.001629:ag-1', text: 'fixed' });
    expect(payload.messageId).toBe('1788196934.001629');
    expect(payload.text).toBe('fixed');
  });

  it('leaves an unscoped id alone', async () => {
    const payload = await deliveredContent({ operation: 'reaction', messageId: '1788196934.001629', emoji: 'eyes' });
    expect(payload.messageId).toBe('1788196934.001629');
  });

  it('leaves a message with no messageId byte-identical', async () => {
    const payload = await deliveredContent({ text: 'hello' });
    expect(payload).toEqual({ text: 'hello' });
  });
});
