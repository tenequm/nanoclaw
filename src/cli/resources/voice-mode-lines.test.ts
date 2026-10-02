/**
 * `ncl voice-lines set|add-owner|remove-owner|remove|list|get`: the operator's
 * link between a voice line and its owner's chat accounts, which /voice relies
 * on to hand out only the runner's own line.
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
import { getVoiceLine, getVoiceLineOwners, setVoiceLineTarget } from '../../db/voice-mode-lines.js';
import { upsertUser } from '../../modules/permissions/db/users.js';
import { dispatch } from '../dispatch.js';
import './voice-mode-lines.js';

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
      channel_type: 'voice-mode',
      platform_id: 'voice-mode:0123456789ab',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });
    for (const id of ['telegram:1', 'telegram:2', 'slack:U1']) {
      await upsertUser({ id, kind: id.split(':')[0], display_name: null, created_at: new Date().toISOString() });
    }
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('names the owner, keeps the /voice chat on a re-run, and clears it for a new owner', async () => {
    expect((await run('voice-lines-set', { line: 'voice-mode:0123456789ab', owner: 'telegram:1' })).ok).toBe(true);
    expect(
      await setVoiceLineTarget({
        lineMessagingGroupId: 'mg-line',
        ownerUserId: 'telegram:1',
        targetMessagingGroupId: 'mg-dm',
        threadId: null,
      }),
    ).toBe(true);
    await run('voice-lines-set', { line: 'voice-mode:0123456789ab', owner: 'telegram:1' });
    expect(await getVoiceLine('mg-line')).toMatchObject({ target_messaging_group_id: 'mg-dm' });
    expect(await getVoiceLineOwners('mg-line')).toEqual(['telegram:1']);
    await run('voice-lines-set', { line: 'voice-mode:0123456789ab', owner: 'telegram:2' });
    expect(await getVoiceLine('mg-line')).toMatchObject({ target_messaging_group_id: null });
    expect(await getVoiceLineOwners('mg-line')).toEqual(['telegram:2']);
    // The old owner can no longer point the line anywhere.
    expect(
      await setVoiceLineTarget({
        lineMessagingGroupId: 'mg-line',
        ownerUserId: 'telegram:1',
        targetMessagingGroupId: 'mg-dm',
        threadId: null,
      }),
    ).toBe(false);
    expect((await run('voice-lines-remove', { line: 'voice-mode:0123456789ab' })).ok).toBe(true);
    expect(await getVoiceLine('mg-line')).toBeUndefined();
    expect(await getVoiceLineOwners('mg-line')).toEqual([]);
  });

  it("gives one line several of its owner's accounts, any of which can point it, and shows them", async () => {
    await run('voice-lines-set', { line: 'voice-mode:0123456789ab', owner: 'telegram:1' });
    const added = await run('voice-lines-add-owner', { line: 'voice-mode:0123456789ab', owner: 'slack:U1' });
    expect(added).toMatchObject({ ok: true, data: { owners: ['slack:U1', 'telegram:1'] } });
    // Idempotent.
    expect((await run('voice-lines-add-owner', { line: 'voice-mode:0123456789ab', owner: 'slack:U1' })).ok).toBe(true);
    const point = (ownerUserId: string, targetMessagingGroupId: string) =>
      setVoiceLineTarget({ lineMessagingGroupId: 'mg-line', ownerUserId, targetMessagingGroupId, threadId: null });
    expect(await point('telegram:1', 'mg-dm')).toBe(true);
    expect(await point('slack:U1', 'mg-slack')).toBe(true);
    expect(await point('telegram:2', 'mg-other')).toBe(false);
    expect(await run('voice-lines-get-voice-mode:0123456789ab', {})).toMatchObject({
      ok: true,
      data: {
        line_messaging_group_id: 'mg-line',
        owners: ['slack:U1', 'telegram:1'],
        target_messaging_group_id: 'mg-slack',
      },
    });
    expect(await run('voice-lines-list', {})).toMatchObject({
      ok: true,
      data: [{ line_messaging_group_id: 'mg-line', owners: ['slack:U1', 'telegram:1'] }],
    });

    expect((await run('voice-lines-remove-owner', { line: 'voice-mode:0123456789ab', owner: 'telegram:2' })).ok).toBe(
      false,
    );
    expect((await run('voice-lines-remove-owner', { line: 'voice-mode:0123456789ab', owner: 'slack:U1' })).ok).toBe(
      true,
    );
    expect(await getVoiceLineOwners('mg-line')).toEqual(['telegram:1']);
    expect(await getVoiceLine('mg-line')).toMatchObject({ target_messaging_group_id: 'mg-slack' });
    expect(await point('slack:U1', 'mg-dm')).toBe(false);
    // The last owner goes only with the line.
    expect((await run('voice-lines-remove-owner', { line: 'voice-mode:0123456789ab', owner: 'telegram:1' })).ok).toBe(
      false,
    );
    expect(await getVoiceLineOwners('mg-line')).toEqual(['telegram:1']);
    // Re-setting an existing owner keeps the target and drops the other accounts.
    await run('voice-lines-add-owner', { line: 'voice-mode:0123456789ab', owner: 'slack:U1' });
    await run('voice-lines-set', { line: 'voice-mode:0123456789ab', owner: 'slack:U1' });
    expect(await getVoiceLineOwners('mg-line')).toEqual(['slack:U1']);
    expect(await getVoiceLine('mg-line')).toMatchObject({ target_messaging_group_id: 'mg-slack' });
  });

  it('refuses unknown lines and users, and every agent', async () => {
    expect((await run('voice-lines-set', { line: 'voice-mode:ffffffffffff', owner: 'telegram:1' })).ok).toBe(false);
    expect((await run('voice-lines-set', { line: 'voice-mode:0123456789ab', owner: 'telegram:9' })).ok).toBe(false);
    expect((await run('voice-lines-set', { line: 'voice-mode:0123456789ab', owner: 'telegram:1' }, 'agent')).ok).toBe(
      false,
    );
    expect((await run('voice-lines-add-owner', { line: 'voice-mode:0123456789ab', owner: 'slack:U9' })).ok).toBe(false);
    for (const command of ['voice-lines-add-owner', 'voice-lines-remove-owner']) {
      expect((await run(command, { line: 'voice-mode:0123456789ab', owner: 'telegram:1' }, 'agent')).ok).toBe(false);
    }
    expect((await run('voice-lines-list', {}, 'agent')).ok).toBe(false);
    expect(await getVoiceLine('mg-line')).toBeUndefined();
  });
});
