export interface RateLimitResult {
  allowed: boolean;
  retryAfter: number;
}
/** N1 implements durable rate-limit buckets. */
export async function consumeRateLimit(
  _key: string,
  _limit: number,
  _windowMs: number,
  _now = Date.now(),
): Promise<RateLimitResult> {
  throw new Error('not_implemented');
}
