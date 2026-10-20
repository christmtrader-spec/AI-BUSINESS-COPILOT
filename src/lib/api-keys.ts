import "server-only";

/**
 * Prompt 52 §F8 — public API keys for external accounting integrations.
 *
 * Security law:
 *  - The plaintext key (`ck_<48 hex>`) exists ONLY at creation time — the
 *    DB stores the SHA-256 hash (unique) + a 12-char display prefix.
 *  - A key belongs to exactly ONE business; every open-API query filters
 *    by that businessId (A01/A02 — the key can never cross tenants).
 *  - Scope is a closed set ("read" only in this release).
 *  - Revocation is immediate (revokedAt checked on every request).
 *  - Usage is rate limited per key (sliding window, fail-closed for keys).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";

export const API_KEY_PREFIX = "ck";
/** Full plaintext shape: ck_<48 hex chars>. */
const KEY_RANDOM_BYTES = 24;

export type ApiKeyScopes = "read";

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
  scopes: ApiKeyScopes[];
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

  const scopes = key.scopes.split(",").filter((s): s is ApiKeyScopes => s === "read");
  if (scopes.length === 0) {
    throw new ApiError(403, "PERMISSION_DENIED", "This API key has no usable scopes.");
  }

  return { keyId: key.id, businessId: key.businessId, scopes };
}

/** Fire-and-forget usage tracking (never blocks the response). */
export function touchApiKey(keyId: string): void {
  void db.apiKey
    .update({
      where: { id: keyId },
      data: { lastUsedAt: new Date(), requestCount: { increment: 1 } },
    })
    .catch(() => undefined);
}

export const OPEN_API_RESOURCES = ["customers", "products", "sales"] as const;
export type OpenApiResource = (typeof OPEN_API_RESOURCES)[number];
