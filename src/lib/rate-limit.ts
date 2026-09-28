/**
 * In-memory rate limiter — Constitution A14 (MVP scope: single process).
 *
 * Prompt 29 hardening (§74/§75/§76/§77):
 *  - PROCESS-LOCAL by design (§74): state lives in this process only. There
 *    is NO distributed protection — documented in
 *    docs/deployment/production-operations.md; a multi-instance deployment
 *    must introduce a shared limiter via ADR.
 *  - MEMORY-SAFE (§75): keys are normalized (length-capped + hashed when
 *    oversized so attacker-controlled keys cannot inflate memory), bucket
 *    count is HARD-CAPPED, entries per bucket are capped, and expired
 *    buckets are swept opportunistically AND forcibly when the cap is hit.
 *  - FAIL-SAFE (§76): the limiter can never crash the application — any
 *    internal error fails OPEN (request allowed) after emitting a safe
 *    warn-level log; state corruption cannot take the API down.
 *  - LIMIT DEFINITIONS (§77): sensitive limits stay at their call sites
 *    (each route owns its policy); shared helper `sensitiveLimits` keeps the
 *    commonly reused numbers centralized without forcing a refactor.
 */
import { createHash } from "node:crypto";
import { logWarn } from "@/lib/observability/logger";
import { OPERATIONAL_EVENTS } from "@/lib/observability/events";

type Bucket = { hits: number[]; insertedAt: number; windowMs: number };

const buckets = new Map<string, Bucket>();

/** Hard memory bounds (§75). */
const MAX_KEY_LENGTH = 200; // longer keys are hashed to a fixed size
const MAX_BUCKETS = 10_000;
const MAX_HITS_PER_BUCKET = 1_000;

function normalizeKey(key: string): string {
  if (key.length <= MAX_KEY_LENGTH) return key;
  // Hashing is deterministic: the SAME oversized key maps to ONE bucket.
  return `h:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

/** Remove buckets whose ENTIRE window has elapsed (per-bucket window). */
function sweep(now: number): number {
  let removed = 0;
  for (const [k, b] of buckets) {
    if (b.hits.length === 0 || b.hits.every((t) => now - t >= b.windowMs)) {
      buckets.delete(k);
      removed += 1;
    }
  }
  return removed;
}

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
};

const ALLOWED: RateLimitResult = { allowed: true, remaining: 0, retryAfterMs: 0 };

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  try {
    const now = Date.now();
    const normalized = normalizeKey(key);
    const bucket = buckets.get(normalized) ?? { hits: [], insertedAt: now, windowMs };
    bucket.hits = bucket.hits.filter((t) => now - t < windowMs);

    if (bucket.hits.length >= limit) {
      buckets.set(normalized, bucket);
      const oldest = bucket.hits[0] ?? now;
      return { allowed: false, remaining: 0, retryAfterMs: windowMs - (now - oldest) };
    }

    if (bucket.hits.length < MAX_HITS_PER_BUCKET) {
      bucket.hits.push(now);
    }
    buckets.set(normalized, bucket);

    // Opportunistic cleanup — bounded work, not every request.
    if (buckets.size > 5_000) {
      sweep(now);
    }

    // HARD CAP (§75): even with active buckets, memory is bounded. Oldest-
    // inserted buckets are evicted (Map preserves insertion order); a newly
    // evicted attacker key simply gets a fresh window — availability beats
    // an unbounded map, and this cannot crash the process (§76).
    if (buckets.size > MAX_BUCKETS) {
      for (const [k] of buckets) {
        buckets.delete(k);
        if (buckets.size <= MAX_BUCKETS * 0.9) break;
      }
      logWarn(OPERATIONAL_EVENTS.apiRequestRateLimited, {
        reason: "rate_limit_bucket_eviction",
        buckets: buckets.size,
      });
    }

    return {
      allowed: true,
      remaining: limit - bucket.hits.length,
      retryAfterMs: 0,
    };
  } catch (error) {
    // §76 — never crash the application from limiter state. Fail OPEN with a
    // safe diagnostic (no keys, no client-controlled content).
    logWarn(OPERATIONAL_EVENTS.apiRequestRateLimited, {
      reason: "rate_limit_internal_error",
      errorClass: error instanceof Error ? error.name : "unknown",
    });
    return { ...ALLOWED, remaining: limit };
  }
}

/** Ops/test introspection: current bucket count (bounded by MAX_BUCKETS, §75). */
export function rateLimiterBucketCount(): number {
  return buckets.size;
}

/** Centralized reuse points for sensitive limits (§77 documentation anchor). */
export const sensitiveLimits = {
  /** Password-reset request: per-IP per 15 min. */
  passwordResetIp: { limit: 5, windowMs: 15 * 60_000 },
  /** Password-reset request: per-account per hour. */
  passwordResetEmail: { limit: 3, windowMs: 60 * 60_000 },
  /** Health/readiness probes: per-IP per minute. */
  healthProbe: { limit: 30, windowMs: 60_000 },
} as const;

export function rateLimitResponse(retryAfterMs: number) {
  return {
    status: 429,
    retryAfterMs,
  };
}
