/**
 * Integration test for the voice channel's reach-in: the self-registration import in the
 * `src/channels/index.ts` barrel. Importing the barrel runs voice-mode.ts's top-level
 * `registerChannelAdapter('voice-mode', …)`, which also brings in what hangs off the channel: the
 * `/voice` chat command and the `voice_mode_lines` table's module migration.
 *
 * Behavior, not structural: it imports the real channel and modules barrels, asserts the channel
 * registry holds the entry, then runs core's default migration list and only afterwards loads the
 * skill's table helpers, so nothing but the barrel can have registered the migration. If the
 * `import './voice-mode.js';` line is deleted, the channel stops loading its table, or the barrel
 * fails to evaluate (an uninstalled LiveKit package included), this goes red. The command's and the
 * delivery hook's registrations are driven through core in voice-mode-command.test.ts and
 * voice-mode-route.test.ts.
 *
 * Registration is a pure top-level call; the adapter reads `.env`, listens and registers its HTTP
 * routes only inside its factory and setup(), never at import.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real channel barrel — triggers every channel's self-registration
import '../modules/index.js'; // the real modules barrel, as the host loads it
import { closeDb, getDb, initTestDb, runMigrations } from '../db/index.js';

afterEach(async () => {
  await closeDb();
});

describe('voice channel registration', () => {
  it('registers the channel, and its table through core default migrations', async () => {
    expect(getRegisteredChannelNames()).toContain('voice-mode');
    await runMigrations(await initTestDb());
    const applied = await getDb().all<{ name: string }>('SELECT name FROM schema_version');
    expect(applied.map((m) => m.name)).toContain('module:voice-mode:lines');

    const { findVoiceModeLineByToken, getVoiceModeLineForAgent, mintVoiceModeLine } =
      await import('../db/voice-mode-lines.js');
    const bind = { agentGroupId: 'ag-1', ownerUserId: 'telegram:1', messagingGroupId: 'mg-1', threadId: null };
    const first = await mintVoiceModeLine(bind);
    expect((await findVoiceModeLineByToken(first.token))?.line_id).toBe(first.line.line_id);
    const second = await mintVoiceModeLine(bind);
    expect(second.line.line_id).toBe(first.line.line_id);
    expect(await findVoiceModeLineByToken(first.token)).toBeUndefined();
    expect((await getVoiceModeLineForAgent('ag-1'))?.token_hash).toBe(second.line.token_hash);
  });
});
