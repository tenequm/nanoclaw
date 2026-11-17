import './db.js';
import { isIPv6 } from 'node:net';
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { log } from '../../log.js';

registerMigration({
  version: 1,
  name: 'module:device-auth:rate-limit-reset-idx',
  async up(db) {
    await db.exec('CREATE INDEX IF NOT EXISTS device_auth_rate_limits_reset_idx ON device_auth_rate_limits (reset_at)');
  },
});
const sweepTimes = new WeakMap<object, number>();

export function rateLimitAddress(address: string): string {
  if (!isIPv6(address)) return address;
  const canonical = new URL(`http://[${address.split('%', 1)[0]}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split('::');
  const start = left ? left.split(':') : [];
  const end = right ? right.split(':') : [];
  const words =
    right === undefined ? start : [...start, ...Array<string>(8 - start.length - end.length).fill('0'), ...end];
  // Dual-stack sockets must share the same bucket as the native IPv4 address.
  if (words.slice(0, 5).every((word) => word === '0') && words[5] === 'ffff') {
    const high = parseInt(words[6], 16),
      low = parseInt(words[7], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  return words.slice(0, 4).join(':') + '::/64';
}
export interface RateLimitResult {
  allowed: boolean;
  retryAfter: number;
}
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): Promise<RateLimitResult> {
  const separator = key.indexOf(':');
  const kind = key.slice(0, separator);
  const address = rateLimitAddress(key.slice(separator + 1));
  key = `${kind}:${address}`;
  const db = getDb();
  const lastSweep = sweepTimes.get(db);
  if (lastSweep === undefined || now - lastSweep >= 60_000) {
    sweepTimes.set(db, now);
    await db.run('DELETE FROM device_auth_rate_limits WHERE reset_at <= ?', now);
  }
  const row = await db.get<{ count: number; reset_at: number }>(
    `INSERT INTO device_auth_rate_limits (bucket_key, count, reset_at) VALUES (?, 1, ?)
     ON CONFLICT (bucket_key) DO UPDATE SET
       count = CASE WHEN device_auth_rate_limits.reset_at <= ? THEN 1 ELSE device_auth_rate_limits.count + 1 END,
       reset_at = CASE WHEN device_auth_rate_limits.reset_at <= ? THEN excluded.reset_at ELSE device_auth_rate_limits.reset_at END
     RETURNING count, reset_at`,
    key,
    now + windowMs,
    now,
    now,
  );
  if (row!.count === limit + 1) log.info('Device rate limit reached', { kind, address });
  return { allowed: row!.count <= limit, retryAfter: Math.max(1, Math.ceil((row!.reset_at - now) / 1000)) };
}
