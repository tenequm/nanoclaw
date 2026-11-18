import { registerMigration } from '../../db/migrations/index.js';

export interface DeviceRow {
  id: string;
  user_id: string;
  name: string;
  public_key: string;
  app_json: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}
export interface PairingCodeRow {
  code_hash: string;
  user_id: string;
  agent_ids_json: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

registerMigration({
  version: 1,
  name: 'module:device-auth:initial',
  async up(db) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS device_auth_devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, public_key TEXT NOT NULL, app_json TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS device_auth_device_agents (device_id TEXT NOT NULL, agent_group_id TEXT NOT NULL, PRIMARY KEY (device_id, agent_group_id));
      CREATE TABLE IF NOT EXISTS device_auth_user_agents (user_id TEXT NOT NULL, agent_group_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, agent_group_id));
      CREATE TABLE IF NOT EXISTS device_auth_pairing_codes (code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_ids_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER);
      CREATE TABLE IF NOT EXISTS device_auth_nonces (device_id TEXT NOT NULL, nonce TEXT NOT NULL, signed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (device_id, nonce));
      CREATE TABLE IF NOT EXISTS device_auth_rate_limits (bucket_key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS device_auth_nonces_idx_0 ON device_auth_nonces (expires_at);
      CREATE INDEX IF NOT EXISTS device_auth_pairing_codes_idx_1 ON device_auth_pairing_codes (expires_at);
      CREATE INDEX IF NOT EXISTS device_auth_rate_limits_reset_idx ON device_auth_rate_limits (reset_at);
    `);
  },
});
