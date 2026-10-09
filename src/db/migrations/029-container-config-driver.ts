import type { PortableMigration } from './index.js';

/**
 * Per-group session runtime selection (ratified D1) and the kinds-ever-used
 * record (ruling 8b.3).
 *
 * `container_configs.driver`: NULL = the install default
 * (`NANOCLAW_RUNTIME_DRIVER`, itself defaulting to docker) — no backfill, so
 * every existing group keeps exactly the runtime it runs on today.
 *
 * `runtime_driver_kinds`: every kind this install has ever configured. Startup
 * discovery, adoption and the retained-object sweep iterate it, so residue
 * from a group flipped back to Docker stays visible to the host that made it.
 * Rows are only ever added; purging a kind is later migration tooling.
 */
export const migration029: PortableMigration = {
  version: 29,
  name: 'container-config-driver',
  async up(db) {
    await db.exec(`
      ALTER TABLE container_configs ADD COLUMN driver TEXT;
      CREATE TABLE IF NOT EXISTS runtime_driver_kinds (
        kind TEXT PRIMARY KEY,
        first_used_at TEXT NOT NULL
      );
    `);
  },
};
