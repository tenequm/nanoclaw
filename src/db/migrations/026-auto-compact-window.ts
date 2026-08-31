import type { PortableMigration } from './index.js';

/**
 * Re-adds the per-agent auto-compact-window column the v2.3.0 upstream
 * migration dropped from the code. The applied identity is the ORIGINAL fork
 * migration name, so installs that ran the old fork (where the column and its
 * values still physically exist) skip this and keep their data; fresh installs
 * create the column. NULL = the agent-runner's 165k default.
 */
export const migration026: PortableMigration = {
  version: 26,
  name: 'container-configs-auto-compact-window',
  async up(db) {
    await db.exec('ALTER TABLE container_configs ADD COLUMN auto_compact_window INTEGER');
  },
};
