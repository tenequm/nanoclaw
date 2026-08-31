/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 *
 * The stamp is published through session_state in outbound.db, not module
 * state — the MCP server runs as a separate stdio subprocess from the poll
 * loop, so it can only see the stamp through the shared DB. These tests seed
 * it the same way the poll-loop process does (a direct DB write) rather than
 * via any in-memory helper, so they exercise the real process boundary.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { sendMediaGroup, sendMessage } from './core.js';

let testRoot: string;
let agentDir: string;
let outboxDir: string;

/**
 * Publish the a2a reply stamp the way the poll loop does: a direct write to
 * session_state in outbound.db. `ageMs` back-dates updated_at to exercise the
 * staleness guard MCP tools apply when reading it.
 */
function publishInReplyTo(id: string, ageMs = 0): void {
  const updatedAt = new Date(Date.now() - ageMs).toISOString();
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('current_in_reply_to', id, updatedAt);
}

beforeEach(() => {
  initTestSessionDb();
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-core-tools-'));
  agentDir = path.join(testRoot, 'agent');
  outboxDir = path.join(testRoot, 'outbox');
  fs.mkdirSync(agentDir, { recursive: true });
  process.env.NANOCLAW_OUTBOX_DIR = outboxDir;
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
  delete process.env.NANOCLAW_OUTBOX_DIR;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps the batch in_reply_to (published via the DB) on outbound rows', async () => {
    publishInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // Nothing published to session_state — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });

  it('ignores a stale stamp left behind by a killed container', async () => {
    publishInReplyTo('inbound-msg-1', 60 * 60 * 1000); // an hour old

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

describe('send_media_group MCP tool', () => {
  it('rejects item counts outside 2-10 without creating an outbox directory', async () => {
    const tooFew = await sendMediaGroup.handler({ to: 'peer', items: [{ path: 'one.jpg' }] });
    const tooMany = await sendMediaGroup.handler({
      to: 'peer',
      items: Array.from({ length: 11 }, (_, index) => ({ path: `${index}.jpg` })),
    });

    expect(tooFew.isError).toBe(true);
    expect(tooMany.isError).toBe(true);
    expect(fs.existsSync(outboxDir)).toBe(false);
  });

  it('rejects a missing file without creating an outbox directory', async () => {
    const existing = path.join(agentDir, 'existing.jpg');
    fs.writeFileSync(existing, 'existing');

    const result = await sendMediaGroup.handler({
      to: 'peer',
      items: [{ path: existing }, { path: path.join(agentDir, 'missing.jpg') }],
    });

    expect(result.isError).toBe(true);
    expect(fs.existsSync(outboxDir)).toBe(false);
  });

  it('keeps colliding basenames as distinct files and paths', async () => {
    const firstDir = path.join(agentDir, 'first');
    const secondDir = path.join(agentDir, 'second');
    fs.mkdirSync(firstDir, { recursive: true });
    fs.mkdirSync(secondDir, { recursive: true });
    const first = path.join(firstDir, 'shared.jpg');
    const second = path.join(secondDir, 'shared.jpg');
    fs.writeFileSync(first, 'first');
    fs.writeFileSync(second, 'second');

    await sendMediaGroup.handler({ to: 'peer', items: [{ path: first }, { path: second }] });

    const row = getUndeliveredMessages()[0];
    const content = JSON.parse(row.content) as { items: Array<{ path: string }>; files: string[] };
    expect(content.files).toEqual(['0-shared.jpg', '1-shared.jpg']);
    expect(content.items.map((item) => item.path)).toEqual(content.files);
    expect(fs.readFileSync(path.join(outboxDir, row.id, content.files[0]), 'utf8')).toBe('first');
    expect(fs.readFileSync(path.join(outboxDir, row.id, content.files[1]), 'utf8')).toBe('second');
  });

  it('writes the operation, items, and files payload consumed by the host', async () => {
    const first = path.join(agentDir, 'first.jpg');
    const second = path.join(agentDir, 'second.jpg');
    fs.writeFileSync(first, 'first');
    fs.writeFileSync(second, 'second');

    await sendMediaGroup.handler({
      to: 'peer',
      items: [{ path: first, caption: 'First' }, { path: second }],
    });

    const content = JSON.parse(getUndeliveredMessages()[0].content);
    expect(content).toEqual({
      operation: 'send_media_group',
      items: [{ path: 'first.jpg', caption: 'First' }, { path: 'second.jpg' }],
      files: ['first.jpg', 'second.jpg'],
    });
  });
});
