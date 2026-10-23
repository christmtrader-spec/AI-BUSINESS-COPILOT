import "server-only";

/**
 * Platform setup key service — R68 ("fix the platform access dead end").
 *
 * THE single sanctioned write path for PlatformSetupKey. The model:
 * with ZERO operators the R67 invite flow cannot start (its minter requires
 * an existing super admin) — the console is an honest dead end. The offline
 * CLI mints ONE single-use, expiring setup key; an authenticated, registry-
 * fresh session redeems it at the console setup gate and becomes the first
 * PLATFORM_SUPER_ADMIN. MFA enforcement is NOT bypassed (per-request gate).
 *
 * LAWS (§9/§60/§61/§81):
 *  - NO public bootstrap route, NO default credentials, NO auto-creation.
 *    Minting happens ONLY in the offline CLI (`scripts/platform-setup-key.ts`),
 *    which refuses when ANY operator exists. The redeem route requires a
 *    live session AND the raw key — the key IS the authorization (§161
 *    anonymous-with-token pattern, upgraded: token + session + zero-state).
 *  - Opaque 32-byte base64url key; only its SHA-256 hash is persisted and
 *    the hash IS the unique lookup. The raw key NEVER appears in any audit,
 *    log, event payload, or API response — display-once law (§60), disclosed
 *    exactly once by the CLI to the operator running it.
 *  - Single-use + expiring + optional boundEmail; redemption is transactional
 *    exactly-once (conditional claim inside the operator-creation tx, so the
 *    loser rolls back clean — same shape as R67 invite redemption).
 *  - The endpoint self-disables FOREVER once the first operator exists:
 *    every status/activate call re-checks operators === 0 server-side.
 *  - Timing-safe comparison over fixed-length digests (never the raw key).
 *  - SecurityEvent vocabulary is extended with fixed constants (§423); the
 *    raw key never enters SecurityEvent or audit payloads (§14/§90).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";
import { platformAudit } from "@/lib/platform/audit";
import { recordSecurityEvent, SECURITY_EVENTS } from "@/lib/auth/security-events/service";

/** 72h — mirrors the R67 operator-invite window (documented policy §16). */
export const SETUP_KEY_TTL_MS = 72 * 60 * 60 * 1000;

/** Maximum TTL the CLI may request (7 days) — bounded exposure window. */
export const SETUP_KEY_MAX_TTL_HOURS = 168;

/** Setup key body schema — the redeem route accepts ONLY this shape. */
export const setupKeyRedeemSchema = z.object({
  key: z.string().trim().min(32).max(120),
});

export type SetupKeyRedeemInput = z.infer<typeof setupKeyRedeemSchema>;

export function generateSetupKey(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSetupKey(rawKey: string): string {
  return createHash("sha256").update(`platform-setup-key-v1:${rawKey.trim()}`).digest("hex");
}

/** Timing-safe equality over two SHA-256 hex digests (equal length). */
function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Cold-start predicate — TRUE only while the platform has zero operators.
 * Re-checked server-side on EVERY status/activate/mint call; the first
 * successful claim flips it forever.
 */
export async function isPlatformSetupRequired(): Promise<boolean> {
  return (await db.platformOperator.count()) === 0;
}

/* ------------------------------ mint (CLI) ------------------------------- */

export type MintSetupKeyInput = {
  boundEmail?: string | null;
  ttlHours?: number;
};

/**
 * Mint a setup key. OFFLINE-ONLY (called by scripts/platform-setup-key.ts):
 * refuses when any operator exists — after cold start, access is granted via
 * the super-admin invite flow (R67) or the sanctioned operator CLI (§61).
 * Returns the raw key EXACTLY ONCE to the caller (display-once law).
 */
export async function mintSetupKey(input: MintSetupKeyInput = {}) {
  if (!(await isPlatformSetupRequired())) {
    throw new ApiError(
      403,
      "SETUP_UNAVAILABLE",
      "Platform setup is closed — operators already exist. Use the super-admin invite flow.",
    );
  }
  const ttlHours = input.ttlHours ?? SETUP_KEY_TTL_MS / (60 * 60 * 1000);
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > SETUP_KEY_MAX_TTL_HOURS) {
    throw new ApiError(422, "SETUP_TTL_INVALID", `TTL must be between 0 and ${SETUP_KEY_MAX_TTL_HOURS} hours.`);
  }
  const boundEmail = input.boundEmail?.trim().toLowerCase() || null;
  const rawKey = generateSetupKey();
  const row = await db.platformSetupKey.create({
    data: {
      keyHash: hashSetupKey(rawKey),
      boundEmail,
      expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
    },
    select: { id: true, expiresAt: true },
  });
  await recordSecurityEvent({
    eventType: SECURITY_EVENTS.platformSetupKeyMinted,
    userId: null,
    ip: null,
    userAgent: null,
    success: true,
    reasonCode: null,
  });
  // The raw key exists ONLY in this return value — never persisted (§14).
  return { id: row.id, key: rawKey, expiresAt: row.expiresAt, boundEmail };
}

/* ----------------------------- redeem (API) ------------------------------ */

export type ActivateSetupKeyInput = {
  key: string;
  userId: string;
  email: string;
  ip?: string | null;
  userAgent?: string | null;
};

/**
 * Redeem a setup key for the CALLING SESSION's user. The operator row is
 * created for the already-authenticated account — the account owner keeps
 * THEIR password; nothing about the account changes except the platform
 * grant. Failures are recorded as SecurityEvents with fixed reason codes.
 */
export async function activateSetupKey(input: ActivateSetupKeyInput) {
  const rawKey = input.key.trim();
  const keyHash = hashSetupKey(rawKey);

  try {
    const result = await db.$transaction(async (tx) => {
      // The zero-state gate re-checks INSIDE the transaction: two racing
      // redemptions cannot both pass — the loser's operator insert would
      // violate the PlatformOperator.userId unique anyway (belt+braces).
      if ((await tx.platformOperator.count()) > 0) {
        throw new ApiError(403, "SETUP_UNAVAILABLE", "Platform setup is closed — operators already exist.");
      }

      const row = await tx.platformSetupKey.findUnique({ where: { keyHash } });
      if (!row || !hashesEqual(row.keyHash, keyHash)) {
        throw new ApiError(404, "SETUP_KEY_INVALID", "This setup key is not valid.");
      }
      if (row.usedAt !== null) {
        throw new ApiError(409, "SETUP_KEY_USED", "This setup key was already used.");
      }
      if (row.expiresAt.getTime() < Date.now()) {
        throw new ApiError(410, "SETUP_KEY_EXPIRED", "This setup key has expired. Mint a new one offline.");
      }
      if (row.boundEmail && row.boundEmail !== input.email.trim().toLowerCase()) {
        throw new ApiError(403, "SETUP_KEY_BOUND_MISMATCH", "This setup key is bound to a different account.");
      }

      // Exactly-once claim FIRST (conditional update): a concurrent redeem
      // loses here and rolls the whole transaction back (no operator).
      const claim = await tx.platformSetupKey.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date(), usedByUserId: input.userId },
      });
      if (claim.count !== 1) {
        throw new ApiError(409, "SETUP_KEY_USED", "This setup key was already used.");
      }

      const operator = await tx.platformOperator.create({
        data: { userId: input.userId, role: "PLATFORM_SUPER_ADMIN", active: true },
        select: { id: true, role: true },
      });
      return { operator, keyId: row.id };
    });

    await recordSecurityEvent({
      eventType: SECURITY_EVENTS.platformSetupClaimed,
      userId: input.userId,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      success: true,
      reasonCode: null,
    });
    await platformAudit({
      operatorId: null,
      operatorRole: null,
      action: "platform.setup_key_claimed",
      entityType: "PlatformSetupKey",
      entityId: result.keyId,
      targetUserId: input.userId,
      reason: null,
      after: { role: result.operator.role },
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
    return { operatorId: result.operator.id, role: result.operator.role };
  } catch (err) {
    if (!(err instanceof ApiError) || err.status >= 500) throw err;
    await recordSecurityEvent({
      eventType: SECURITY_EVENTS.platformSetupClaimFailed,
      userId: input.userId,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      success: false,
      reasonCode: err.code,
    });
    throw err;
  }
}
