/**
 * Integration test for the voice channel's single reach-in: the self-registration import in the
 * `src/channels/index.ts` barrel. Importing the barrel runs voice-mode.ts's top-level
 * `registerChannelAdapter('voice-mode', …)`, which also brings in what hangs off the channel: the
 * `/voice` chat command and the `voice_mode_lines` table's module migration.
 *
 * Behavior, not structural: it imports the real barrel and asserts each registry actually holds
 * the entry, then runs the real default migration list. If the `import './voice-mode.js';` line is
 * deleted, or the barrel fails to evaluate (an uninstalled LiveKit package included), this goes red.
 *
 * Registration is a pure top-level call; the adapter reads `.env`, listens and registers its HTTP
 * routes only inside its factory and setup(), never at import.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration
import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { getVoiceModeLine } from '../db/voice-mode-lines.js';

afterEach(async () => {
  await closeDb();
});

describe('voice channel registration', () => {
  it('registers the channel and its table via the channel barrel', async () => {
    expect(getRegisteredChannelNames()).toContain('voice-mode');
    await runMigrations(await initTestDb());
    expect(await getVoiceModeLine('none')).toBeUndefined();
  });
});
