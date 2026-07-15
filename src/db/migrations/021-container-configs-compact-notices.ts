import type { Migration } from './index.js';

/**
 * Per-agent compact-notice visibility. When 0, the agent-runner logs a
 * mid-turn auto-compaction instead of delivering the "Context compacted"
 * notice to the chat: operator telemetry does not belong in public channels.
 * NULL or 1 = keep delivering (the default).
 */
export const migration021: Migration = {
  version: 21,
  name: 'container-configs-compact-notices',
  up(db) {
    db.exec('ALTER TABLE container_configs ADD COLUMN compact_notices INTEGER');
  },
};
