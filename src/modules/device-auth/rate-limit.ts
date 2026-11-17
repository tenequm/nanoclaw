import { getDb } from '../../db/connection.js';
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
  const db = getDb();
  await db.run('DELETE FROM device_auth_rate_limits WHERE reset_at <= ?', now);
  const row = await db.get<{ count: number; reset_at: number }>(
    `INSERT INTO device_auth_rate_limits (bucket_key, count, reset_at) VALUES (?, 1, ?)
     ON CONFLICT (bucket_key) DO UPDATE SET count = device_auth_rate_limits.count + 1 RETURNING count, reset_at`,
    key,
    now + windowMs,
  );
  return { allowed: row!.count <= limit, retryAfter: Math.max(1, Math.ceil((row!.reset_at - now) / 1000)) };
}
