/**
 * `ncl voice-lines set|remove`: the operator's link between a voice line and
 * its owner's chat user, which /voice relies on to hand out only the runner's
 * own line.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-voice-lines' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-voice-lines';

import { closeDb, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getVoiceLine, setVoiceLineTarget } from '../../db/voice-lines.js';
import { upsertUser } from '../../modules/permissions/db/users.js';
import { dispatch } from '../dispatch.js';
import './voice-lines.js';

const run = (command: string, args: Record<string, unknown>, from: 'host' | 'agent' = 'host') =>
  dispatch(
    { id: `req-${command}`, command, args },
    from === 'host'
      ? { caller: 'host' }
      : { caller: 'agent', sessionId: 's-1', agentGroupId: 'ag-1', messagingGroupId: 'mg-dm' },
  );

describe('ncl voice-lines', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await runMigrations(await initTestDb());
    await createMessagingGroup({
      id: 'mg-line',
      channel_type: 'voice',
      platform_id: 'voice:0123456789ab',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });
    for (const id of ['telegram:1', 'telegram:2']) {
      await upsertUser({ id, kind: 'telegram', display_name: null, created_at: new Date().toISOString() });
    }
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('names the owner, keeps the /voice chat on a re-run, and clears it for a new owner', async () => {
    expect((await run('voice-lines-set', { line: 'voice:0123456789ab', owner: 'telegram:1' })).ok).toBe(true);
    expect(
      await setVoiceLineTarget({
        lineMessagingGroupId: 'mg-line',
        ownerUserId: 'telegram:1',
        targetMessagingGroupId: 'mg-dm',
        threadId: null,
      }),
    ).toBe(true);
    await run('voice-lines-set', { line: 'voice:0123456789ab', owner: 'telegram:1' });
    expect(await getVoiceLine('mg-line')).toMatchObject({
      owner_user_id: 'telegram:1',
      target_messaging_group_id: 'mg-dm',
    });
    await run('voice-lines-set', { line: 'voice:0123456789ab', owner: 'telegram:2' });
    expect(await getVoiceLine('mg-line')).toMatchObject({
      owner_user_id: 'telegram:2',
      target_messaging_group_id: null,
    });
    // The old owner can no longer point the line anywhere.
    expect(
      await setVoiceLineTarget({
        lineMessagingGroupId: 'mg-line',
        ownerUserId: 'telegram:1',
        targetMessagingGroupId: 'mg-dm',
        threadId: null,
      }),
    ).toBe(false);
    expect((await run('voice-lines-remove', { line: 'voice:0123456789ab' })).ok).toBe(true);
    expect(await getVoiceLine('mg-line')).toBeUndefined();
  });

  it('refuses unknown lines and users, and every agent', async () => {
    expect((await run('voice-lines-set', { line: 'voice:ffffffffffff', owner: 'telegram:1' })).ok).toBe(false);
    expect((await run('voice-lines-set', { line: 'voice:0123456789ab', owner: 'telegram:9' })).ok).toBe(false);
    expect((await run('voice-lines-set', { line: 'voice:0123456789ab', owner: 'telegram:1' }, 'agent')).ok).toBe(false);
    expect(await getVoiceLine('mg-line')).toBeUndefined();
  });
});
