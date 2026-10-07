/**
 * Integration test for the voice channel's single reach-in: the self-registration
 * import in the `src/channels/index.ts` barrel. Importing the barrel runs voice-mode.ts's
 * top-level `registerChannelAdapter('voice-mode', …)`; without the import the channel is
 * silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains the channel. If the `import './voice-mode.js';` line is deleted, or
 * the barrel fails to evaluate for any reason, this goes red. A structural check of
 * the import line would falsely pass in that second case.
 *
 * Registration is a pure top-level call; the adapter reads `.env` and registers its
 * HTTP routes only inside its factory and setup(), never at import.
 */
import { describe, expect, it } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('voice channel registration', () => {
  it('registers voice via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('voice-mode');
  });

  it('registers the `voice` compatibility adapter that delivers to lines from before the rename', () => {
    expect(getRegisteredChannelNames()).toContain('voice');
  });
});
