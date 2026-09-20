/**
 * In-memory rate limiter — Constitution A14 (MVP scope: single process).
 * Sliding window per key. Deliberately simple; a distributed limiter
 * would be introduced with an ADR if/when multi-instance deployment lands.
 */

type Bucket = { hits: number[] };

const buckets = new Map<string, Bucket>();

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
};

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);

  if (bucket.hits.length >= limit) {
    buckets.set(key, bucket);
    const oldest = bucket.hits[0] ?? now;
    return { allowed: false, remaining: 0, retryAfterMs: windowMs - (now - oldest) };
  }

  bucket.hits.push(now);
  buckets.set(key, bucket);

  // opportunistic cleanup
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) {
      if (b.hits.every((t) => now - t >= windowMs)) buckets.delete(k);
    }
  }

  return {
    allowed: true,
    remaining: limit - bucket.hits.length,
    retryAfterMs: 0,
  };
}

export function rateLimitResponse(retryAfterMs: number) {
  return {
    status: 429,
    retryAfterMs,
  };
}
