import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from '../db/index.js';
import { getRegisteredMigrations } from '../db/migrations/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../db/messaging-groups.js';
import { addMember } from '../modules/permissions/db/agent-group-members.js';
import { createUser } from '../modules/permissions/db/users.js';
import { resolveVoiceModeLine } from './voice-mode-line.js';

const stamp = () => new Date().toISOString();

// Every line is a voice_mode_lines row (voice-mode-line-roles.test.ts); a member user on a wired chat opens nothing.
describe('voice line access without a voice_mode_lines row (real central DB)', () => {
  async function memberLine(channel: string, id: string) {
    await createUser({ id, kind: channel, display_name: 'Ethan', created_at: stamp() });
    await addMember({ user_id: id, agent_group_id: 'voice-agent', added_by: null, added_at: stamp() });
    await createMessagingGroup({
      id: `mg-${id}`,
      channel_type: channel,
      platform_id: id,
      instance: channel,
      name: 'Personal call',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: stamp(),
    });
    await createMessagingGroupAgent({
      id: `wire-${id}`,
      messaging_group_id: `mg-${id}`,
      agent_group_id: 'voice-agent',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'known',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: stamp(),
    });
  }

  beforeEach(async () => {
    const db = await initTestDb();
    await runMigrations(db);
    await createAgentGroup({
      id: 'voice-agent',
      name: 'Casa',
      folder: 'voice-access-fixture',
      agent_provider: null,
      created_at: stamp(),
    });
  });
  afterEach(async () => {
    await closeDb();
  });

  it('resolves no line from before the voice-mode rename: its `voice` chat, member user and wiring open nothing', async () => {
    await memberLine('voice', 'voice:ethan-test');
    expect(await resolveVoiceModeLine('voice:ethan-test')).toBeNull();
  });

  it('resolves no membership line in the voice-mode namespace either', async () => {
    await memberLine('voice-mode', 'voice-mode:ethan-test');
    expect(await resolveVoiceModeLine('voice-mode:ethan-test')).toBeNull();
  });
});

describe('module:voice-mode:drop-legacy-lines (real migrations)', () => {
  const DROP = 'module:voice-mode:drop-legacy-lines';
  /** Read from the schema itself: the driver's hasTable caches a table it once saw. */
  const voiceTables = async (): Promise<string[]> =>
    (
      await getDb().all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'voice%' ORDER BY name",
      )
    ).map((row) => row.name);

  afterEach(async () => {
    await closeDb();
  });

  it('drops the legacy voice line tables, rows and all, from a DB that has them', async () => {
    const db = await initTestDb();
    await runMigrations(
      db,
      getRegisteredMigrations().filter((m) => m.name !== DROP),
    );
    await getDb().run(
      'INSERT INTO voice_lines (line_messaging_group_id, updated_at) VALUES (?, ?)',
      'mg-line',
      stamp(),
    );
    await getDb().run(
      'INSERT INTO voice_line_owners (line_messaging_group_id, owner_user_id) VALUES (?, ?)',
      'mg-line',
      'telegram:1',
    );
    expect(await voiceTables()).toEqual(['voice_line_owners', 'voice_lines', 'voice_mode_lines']);

    await runMigrations(db);
    expect(await voiceTables()).toEqual(['voice_mode_lines']);
    expect(await db.get('SELECT name FROM schema_version WHERE name = ?', DROP)).toEqual({ name: DROP });
  });

  it('leaves a fresh DB without them', async () => {
    await runMigrations(await initTestDb());
    expect(await voiceTables()).toEqual(['voice_mode_lines']);
  });
});
