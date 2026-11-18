import './db.js';
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { getDb } from '../../db/connection.js';
import {
  APP_PROTOCOL,
  parseAuthorization,
  verifyRequestSignature,
  type ErrorBody,
} from '../../channels/app/contract.js';
import { hasAdminPrivilege } from '../permissions/db/user-roles.js';
import type { DeviceRow } from './db.js';
import { consumeRateLimit } from './rate-limit.js';
import { clientAddress } from './gate.js';
import { log } from '../../log.js';

export interface DeviceIdentity {
  deviceId: string;
  userId: string;
  agentIds: string[];
}
export class AuthError extends Error {
  constructor(
    public status: number,
    public body: ErrorBody,
  ) {
    super(body.error);
  }
}
export function authError(status: number, error: string, message: string, extra: Partial<ErrorBody> = {}): AuthError {
  return new AuthError(status, { error, message, ...extra });
}
export async function enforceRateLimit(key: string, limit: number, now = Date.now()): Promise<void> {
  const result = await consumeRateLimit(key, limit, 600_000, now);
  if (!result.allowed)
    throw authError(429, 'rate_limited', 'Too many requests. Try again shortly.', { retryAfter: result.retryAfter });
}
export async function getLiveDevice(deviceId: string): Promise<DeviceRow | undefined> {
  return getDb().get<DeviceRow>('SELECT * FROM device_auth_devices WHERE id = ? AND revoked_at IS NULL', deviceId);
}
export async function liveDevices(userId: string): Promise<DeviceRow[]> {
  return getDb().all<DeviceRow>('SELECT * FROM device_auth_devices WHERE user_id = ? AND revoked_at IS NULL', userId);
}
export async function reachableAgentIds(deviceId: string): Promise<string[]> {
  const device = await getLiveDevice(deviceId);
  if (!device) return [];
  const rows = await getDb().all<{ agent_group_id: string }>(
    `SELECT u.agent_group_id FROM device_auth_user_agents u
    JOIN agent_groups a ON a.id = u.agent_group_id WHERE u.user_id = ? AND
    (NOT EXISTS (SELECT 1 FROM device_auth_device_agents WHERE device_id = ?) OR
     EXISTS (SELECT 1 FROM device_auth_device_agents d WHERE d.device_id = ? AND d.agent_group_id = u.agent_group_id))`,
    device.user_id,
    deviceId,
    deviceId,
  );
  const ids: string[] = [];
  for (const row of rows) if (await hasAdminPrivilege(device.user_id, row.agent_group_id)) ids.push(row.agent_group_id);
  return ids;
}
const listeners = new Set<(deviceId: string) => void>();
export function onDeviceRevoked(listener: (deviceId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export async function revokeDevice(deviceId: string): Promise<'revoked' | 'already_revoked' | 'not_found'> {
  const result = await getDb().run(
    'UPDATE device_auth_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    Date.now(),
    deviceId,
  );
  if (!result.changes) {
    return (await getDb().get('SELECT id FROM device_auth_devices WHERE id = ?', deviceId))
      ? 'already_revoked'
      : 'not_found';
  }
  log.info('Device revoked', { deviceId });
  for (const listener of listeners) {
    try {
      listener(deviceId);
    } catch (error) {
      log.warn('Device revocation listener failed', { kind: error instanceof Error ? error.name : typeof error });
    }
  }
  return 'revoked';
}
export async function verifyRequest(req: IncomingMessage, now = Date.now()): Promise<DeviceIdentity> {
  try {
    const fields = parseAuthorization(req.headers.authorization);
    if (!fields) throw authError(401, 'bad_signature', 'The request signature is not valid.');
    const db = getDb();
    const device = await db.get<DeviceRow>('SELECT * FROM device_auth_devices WHERE id = ?', fields.deviceId);
    if (!device) throw authError(401, 'unknown_device', 'This device is not paired.');
    if (device.revoked_at !== null) throw authError(401, 'device_revoked', 'This device was unpaired.');
    if (Math.abs(Math.floor(now / 1000) - fields.ts) > 120)
      throw authError(401, 'stale_timestamp', 'The request is too old or too new.', { serverTime: now });
    if (fields.protocol !== APP_PROTOCOL)
      throw authError(426, 'protocol', 'Update Hey Dan to keep chatting.', { protocol: APP_PROTOCOL });
    if (
      !verifyRequestSignature(
        { ...fields, method: req.method ?? '', target: req.url ?? '' },
        fields.signature,
        device.public_key,
      )
    )
      throw authError(401, 'bad_signature', 'The request signature is not valid.');
    await db.run('DELETE FROM device_auth_nonces WHERE expires_at < ?', Math.floor(now / 1000));
    const inserted = await db.run(
      `INSERT INTO device_auth_nonces (device_id, nonce, signed_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      device.id,
      fields.nonce,
      fields.ts,
      fields.ts + 120,
    );
    if (!inserted.changes) throw authError(401, 'replayed', 'This request was already used.');
    await db.run(
      'UPDATE device_auth_devices SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)',
      now,
      device.id,
      now - 60_000,
    );
    return { deviceId: device.id, userId: device.user_id, agentIds: await reachableAgentIds(device.id) };
  } catch (error) {
    // This masks repeated auth failures, not work: valid requests still pass from a shared address.
    if (error instanceof AuthError) await enforceRateLimit(`auth:${clientAddress(req)}`, 60, now);
    throw error;
  }
}
export async function readBody(req: IncomingMessage, maxBytes: number, bodyHash?: string): Promise<Buffer> {
  const tooLarge = () => authError(413, 'too_large', 'The request body is too large.', { maxBytes });
  if (Number(req.headers['content-length']) > maxBytes) throw tooLarge();
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw tooLarge();
    hash.update(bytes);
    chunks.push(bytes);
  }
  if (bodyHash !== undefined && hash.digest('hex') !== bodyHash)
    throw authError(400, 'bad_body', 'The request body does not match its signature.');
  return Buffer.concat(chunks);
}
export async function readSignedBody(req: IncomingMessage, bodyHash: string, maxBytes: number): Promise<Buffer> {
  return readBody(req, maxBytes, bodyHash);
}
