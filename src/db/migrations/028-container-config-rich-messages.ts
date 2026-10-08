import type { PortableMigration } from './index.js';

/**
 * Per-agent-group `rich_messages` on `container_configs`: 1 lets the agent send
 * a message as a Telegram Rich Message (`send_message` with `rich: true`), 0
 * (the default) keeps every message on the normal entities path. The host
 * reads it at delivery, so a container cannot opt itself in.
 */
export const migration028: PortableMigration = {
  version: 28,
  name: 'container-config-rich-messages',
  async up(db) {
    await db.exec('ALTER TABLE container_configs ADD COLUMN rich_messages INTEGER NOT NULL DEFAULT 0');
  },
};
