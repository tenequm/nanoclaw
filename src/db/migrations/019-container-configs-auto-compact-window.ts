import type { Migration } from './index.js';

/**
 * Per-agent auto-compact window (tokens). When set, the agent-runner passes
 * it to the Claude provider as CLAUDE_CODE_AUTO_COMPACT_WINDOW, overriding
 * the provider's baked-in 165k default for that agent. NULL = keep default.
 */
export const migration019: Migration = {
  version: 19,
  name: 'container-configs-auto-compact-window',
  up(db) {
    db.exec('ALTER TABLE container_configs ADD COLUMN auto_compact_window INTEGER');
  },
};
