/**
 * Security regression for the channel-inbound attachment path (#2828 sibling).
 *
 * `extractAttachmentFiles` (via `writeSessionMessage`) hardens the per-message
 * inbox subdir against pre-placed symlinks, but NOT the `inbox` root itself.
 * A compromised container can write inside its own session dir, so it can
 * replace `inbox` with a symlink pointing outside the session sandbox. The
 * existing guard then:
 *   - skips the lstat branch (it only lstats `inbox/<msgId>`, not `inbox`),
 *   - mkdirs `inbox/<msgId>` *through* the symlink,
 *   - passes the containment check, because it compares against
 *     `realpathSync(inboxRoot)` which has already followed the symlink, and
 *   - writes a brand-new file (the `wx` flag only blocks an existing dst).
 *
 * Result: the host writes attacker-influenced bytes outside the session root —
 * the same class of bug fixed for the A2A path in forwardAttachedFiles (#2828).
 *
 * This test asserts the SECURE behaviour (nothing written outside). It FAILS
 * against the current code, demonstrating the gap.
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-saveatt-gap' };
});

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { createSession } from './db/sessions.js';
import { initSessionFolder, sessionDir, writeSessionMessage } from './session-manager.js';
import type { Session } from './types.js';

const TEST_DIR = '/tmp/nanoclaw-test-saveatt-gap';
const AG = 'ag-saveatt';
const SESS = 'sess-saveatt';

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = await initTestDb();
  await runMigrations(db);

  await createAgentGroup({ id: AG, name: 'SaveAtt', folder: 'saveatt', agent_provider: null, created_at: now() });
  const sess: Session = {
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  };
  await createSession(sess);
  initSessionFolder(AG, SESS);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('extractAttachmentFiles — inbox-root symlink containment (#2828 sibling)', () => {
  it('does not write an attachment outside the session root via a symlinked inbox root', async () => {
    // Attacker-controlled location outside the session sandbox.
    const canaryDir = path.join(TEST_DIR, 'canary-outside');
    fs.mkdirSync(canaryDir, { recursive: true });

    // Container pre-places its whole `inbox` as a symlink pointing outside.
    const inboxRoot = path.join(sessionDir(AG, SESS), 'inbox');
    fs.rmSync(inboxRoot, { recursive: true, force: true });
    fs.symlinkSync(canaryDir, inboxRoot);

    const content = JSON.stringify({
      text: 'see attached',
      attachments: [{ name: 'pwn.txt', data: Buffer.from('attacker-bytes').toString('base64') }],
    });

    await writeSessionMessage(AG, SESS, {
      id: 'evil-inbox-root',
      kind: 'chat',
      timestamp: now(),
      platformId: 'whatsapp:123',
      channelType: 'whatsapp',
      threadId: null,
      content,
    });

    // SECURE expectation: nothing was written through the symlink to the
    // attacker-controlled canary location.
    const escaped = path.join(canaryDir, 'evil-inbox-root', 'pwn.txt');
    expect(fs.existsSync(escaped)).toBe(false);
    expect(fs.readdirSync(canaryDir)).toHaveLength(0);
  });
});

describe('extractAttachmentFiles — staged adapter downloads', () => {
  const STAGING = path.join(TEST_DIR, 'inbound-staging', 'telegram', 'stage-1');

  async function write(id: string, attachment: Record<string, unknown>): Promise<Record<string, unknown>> {
    await writeSessionMessage(AG, SESS, {
      id,
      kind: 'chat-sdk',
      timestamp: now(),
      platformId: 'telegram:123',
      channelType: 'telegram',
      threadId: null,
      content: JSON.stringify({ text: '', attachments: [attachment] }),
    });
    const db = new Database(path.join(sessionDir(AG, SESS), 'inbound.db'), { readonly: true });
    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get(id) as { content: string };
    db.close();
    return JSON.parse(row.content).attachments[0];
  }

  beforeEach(() => fs.mkdirSync(STAGING, { recursive: true }));

  it('copies a staged file into the inbox under its staged name, keeping the display name', async () => {
    const staged = path.join(STAGING, 'photo.jpg');
    fs.writeFileSync(staged, 'jpeg-bytes');

    const att = await write('-100:7:ag', { type: 'sticker', name: 'a sticker (from Pack)', stagedPath: staged });

    expect(att).toMatchObject({ name: 'a sticker (from Pack)', localPath: 'inbox/-100:7:ag/photo.jpg' });
    expect(att).not.toHaveProperty('stagedPath');
    expect(fs.readFileSync(path.join(sessionDir(AG, SESS), 'inbox', '-100:7:ag', 'photo.jpg'), 'utf8')).toBe(
      'jpeg-bytes',
    );
    // Copied, not moved: the same message can be routed to another session.
    expect(fs.existsSync(staged)).toBe(true);
  });

  it.each([
    ['a path outside the staging root', () => path.join(TEST_DIR, 'host-secret.txt')],
    [
      'a symlink inside the staging root pointing out',
      () => {
        const link = path.join(STAGING, 'link.txt');
        fs.symlinkSync(path.join(TEST_DIR, 'host-secret.txt'), link);
        return link;
      },
    ],
  ])('refuses %s and never lets the host path reach the container', async (_label, stagedPath) => {
    fs.writeFileSync(path.join(TEST_DIR, 'host-secret.txt'), 'secret');

    const att = await write('forged', { type: 'document', name: 'x.txt', stagedPath: stagedPath() });

    expect(att).not.toHaveProperty('stagedPath');
    expect(att).not.toHaveProperty('localPath');
    expect(fs.existsSync(path.join(sessionDir(AG, SESS), 'inbox', 'forged'))).toBe(false);
  });
});
