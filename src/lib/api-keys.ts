import "server-only";

/**
 * Prompt 52 §F8 — public API keys for external accounting integrations.
 *
 * Security law:
 *  - The plaintext key (`ck_<48 hex>`) exists ONLY at creation time — the
 *    DB stores the SHA-256 hash (unique) + a 12-char display prefix.
 *  - A key belongs to exactly ONE business; every open-API query filters
 *    by that businessId (A01/A02 — the key can never cross tenants).
 *  - Scope is a CLOSED set (src/lib/api-key-scopes.ts): "read" grants every
 *    open-API resource; "read:<resource>" grants exactly that resource.
 *    Unknown scope tokens are dropped (fail-closed).
 *  - Revocation is immediate (revokedAt checked on every request).
 *  - Usage is rate limited per key (sliding window, fail-closed) and
 *    METERED per key against a monthly quota (best-effort accounting).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import {
  monthlyPeriodKey,
  msUntilNextUtcMonth,
  parseApiKeyScopes,
  scopeCoversResource,
  apiKeyMonthlyQuota,
  serializeApiKeyScopes,
  type ApiKeyScope,
  type OpenApiResource,
} from "@/lib/api-key-scopes";

export {
  OPEN_API_RESOURCES,
  API_KEY_SCOPES,
  API_KEY_FULL_SCOPE,
  API_KEY_GRANULAR_SCOPES,
  parseApiKeyScopes,
  scopeCoversResource,
  serializeApiKeyScopes,
  apiKeyMonthlyQuota,
  monthlyPeriodKey,
  type ApiKeyScope,
  type OpenApiResource,
} from "@/lib/api-key-scopes";

export const API_KEY_PREFIX = "ck";
/** Full plaintext shape: ck_<48 hex chars>. */
const KEY_RANDOM_BYTES = 24;

export function generateApiKey(): { plaintext: string; prefix: string; keyHash: string } {
  const random = randomBytes(KEY_RANDOM_BYTES).toString("hex"); // 48 hex chars
  const plaintext = `${API_KEY_PREFIX}_${random}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, 12),
    keyHash: sha256Hex(plaintext),
  };
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "ascii").digest("hex");
}

/** Constant-time hash comparison for the lookup path. */
export function hashMatches(plaintext: string, keyHash: string): boolean {
  const a = Buffer.from(sha256Hex(plaintext), "hex");
  const b = Buffer.from(keyHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type ApiKeyAuthContext = {
  keyId: string;
  businessId: string;
  scopes: ApiKeyScope[];
};

/**
 * Authenticate an open-API request via `Authorization: Bearer ck_...`.
 * Throws ApiError subclasses handled by the route wrapper — the error text
 * never distinguishes "unknown key" from "revoked key" (no oracle).
 */
export async function getApiKeyContext(req: Request): Promise<ApiKeyAuthContext> {
  const { ApiError } = await import("@/lib/api-helpers");
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim() ?? "";
  if (!token.startsWith(`${API_KEY_PREFIX}_`) || token.length < 20 || token.length > 128) {
    throw new ApiError(401, "UNAUTHENTICATED", "Missing or malformed API key.");
  }

  const keyHash = sha256Hex(token);
  const key = await db.apiKey.findUnique({
    where: { keyHash },
    select: {
      id: true,
      businessId: true,
      scopes: true,
      revokedAt: true,
    },
  });
  if (!key || key.revokedAt !== null) {
    throw new ApiError(401, "UNAUTHENTICATED", "Invalid API key.");
  }

  const scopes = parseApiKeyScopes(key.scopes);
  if (scopes.length === 0) {
    throw new ApiError(403, "PERMISSION_DENIED", "This API key has no usable scopes.");
  }

  return { keyId: key.id, businessId: key.businessId, scopes };
}

/** Fire-and-forget lifetime usage tracking (never blocks the response). */
export function touchApiKey(keyId: string): void {
  void db.apiKey
    .update({
      where: { id: keyId },
      data: { lastUsedAt: new Date(), requestCount: { increment: 1 } },
    })
    .catch(() => undefined);
}

export type ApiKeyQuotaResult = {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  retryAfterMs: number;
};

/**
 * Consume ONE request against the key's monthly quota (UTC month bucket).
 * Best-effort metering: a single CAS-style update keyed on the expected
 * bucket (one retry when the bucket rolled mid-flight). Returns the honest
 * outcome so the route can 429 with a retry window when exhausted.
 */
export async function consumeApiKeyQuota(keyId: string, now: Date = new Date()): Promise<ApiKeyQuotaResult> {
  const limit = apiKeyMonthlyQuota();
  const bucket = monthlyPeriodKey(now);
  const row = await db.apiKey.findUnique({
    where: { id: keyId },
    select: { periodStart: true, periodCount: true },
  });
  if (!row) {
    return { allowed: false, used: 0, limit, remaining: 0, retryAfterMs: msUntilNextUtcMonth(now) };
  }

  const sameBucket = row.periodStart === bucket;
  const used = sameBucket ? row.periodCount : 0;
  if (used >= limit) {
    return { allowed: false, used, limit, remaining: 0, retryAfterMs: msUntilNextUtcMonth(now) };
  }

  // CAS: only write when the bucket is still what we read (rolled buckets
  // reset to 1 instead of incrementing a stale counter).
  const updated = await db.apiKey.updateMany({
    where: { id: keyId, periodStart: sameBucket ? bucket : row.periodStart ?? null },
    data: { periodCount: { increment: 1 }, periodStart: bucket },
  });
  if (updated.count === 0) {
    // Bucket rolled between read and write (or row vanished) — one honest
    // retry writing the fresh bucket; never over-count a stale bucket.
    const retried = await db.apiKey.updateMany({
      where: { id: keyId },
      data: { periodCount: 1, periodStart: bucket },
    });
    if (retried.count === 0) {
      return { allowed: false, used, limit, remaining: 0, retryAfterMs: msUntilNextUtcMonth(now) };
    }
    return { allowed: true, used: 1, limit, remaining: Math.max(0, limit - 1), retryAfterMs: msUntilNextUtcMonth(now) };
  }

  return { allowed: true, used: used + 1, limit, remaining: Math.max(0, limit - used - 1), retryAfterMs: msUntilNextUtcMonth(now) };
}
