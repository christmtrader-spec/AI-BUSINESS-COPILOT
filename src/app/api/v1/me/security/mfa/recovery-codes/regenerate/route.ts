/**
 * POST /api/v1/me/security/mfa/recovery-codes/regenerate — replace the
 * recovery set (Prompt 30 §61, §164, §212, §248).
 *
 * Requires (§61/§164): FRESH session + current password + current MFA
 * (TOTP preferred; a recovery code is NOT accepted here — §61 recommends
 * password + MFA, and allowing codes to mint codes would let a single
 * surviving code perpetuate access).
 *
 * §212 — each regeneration invalidates ALL previous unused codes inside
 * the same transaction that inserts the new set: a double-click can never
 * produce two ambiguous active sets. Old codes stop working immediately
 * (§248 — the UI warns). Raw codes returned EXACTLY ONCE (§104/§466).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { ApiError, getClientIp, ok, parseBody, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertFreshSession } from "@/lib/auth-security";
import { rateLimit } from "@/lib/rate-limit";
import {
  assertMfaFeatureAvailable,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyMfaCodeForCredential,
} from "@/lib/auth/mfa/service";
import { RECOVERY_CODES_COUNT } from "@/lib/auth/config";
import { StepUpError, verifyPasswordNow } from "@/lib/auth/step-up";
import { SECURITY_EVENTS, recordSecurityEvent } from "@/lib/auth/security-events/service";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  password: z.string().min(1).max(200),
  mfaCode: z.string().trim().min(6).max(12),
});

export const POST = route(async (req: NextRequest) => {
  const session = await getServerSession(authOptions);
  const userId = await assertFreshSession(session);
  const ip = getClientIp(req);

  const rl = rateLimit(`mfa-recovery-regen:${userId}:${ip}`, 5, 15 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "MFA_RATE_LIMITED", "Too many attempts. Please wait a moment.");
  }

  assertMfaFeatureAvailable();

  const input = await parseBody(req, bodySchema);

  const credential = await db.mfaCredential.findUnique({
    where: { userId },
    select: { id: true, userId: true, encryptedSecret: true, enabledAt: true, lastUsedTotpStep: true },
  });
  if (!credential || credential.enabledAt == null) {
    throw new ApiError(400, "MFA_NOT_ENABLED", "Two-factor authentication is not enabled.");
  }

  // §61/§164 — password first (real check), then the current TOTP.
  try {
    await verifyPasswordNow(userId, input.password, {
      ip,
      userAgent: req.headers.get("user-agent"),
    });
  } catch (error) {
    if (error instanceof StepUpError && error.code === "INVALID_CURRENT_PASSWORD") {
      throw new ApiError(400, "INVALID_CURRENT_PASSWORD", "The password is incorrect.");
    }
    throw error;
  }

  const result = await verifyMfaCodeForCredential(credential, input.mfaCode, {
    enforceReplay: false,
  });
  if (!result.ok) {
    throw new ApiError(400, "MFA_INVALID_CODE", "Invalid authentication code.");
  }

  // §212 — one transaction: kill ALL unused old codes, insert the new set.
  const newCodes = generateRecoveryCodes(RECOVERY_CODES_COUNT);
  await db.$transaction(async (tx) => {
    await tx.mfaRecoveryCode.deleteMany({ where: { userId, usedAt: null } });
    await tx.mfaRecoveryCode.createMany({
      data: newCodes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })),
    });
    await tx.auditLog.create({
      data: {
        businessId: null,
        actorId: userId,
        action: "auth.mfa_recovery_codes_regenerated",
        entityType: "User",
        entityId: userId,
        afterJson: JSON.stringify({ recoveryCodes: RECOVERY_CODES_COUNT }),
        ip: ip === "unknown" ? null : ip,
        userAgent: req.headers.get("user-agent")?.slice(0, 255) ?? null,
      },
    });
  });

  await recordSecurityEvent({
    eventType: SECURITY_EVENTS.mfaRecoveryCodesGenerated,
    userId,
    success: true,
    reasonCode: "REGENERATED",
    ip,
    userAgent: req.headers.get("user-agent"),
  });

  // §104/§466 — raw codes returned EXACTLY ONCE; hashes only in the DB.
  return ok({ recoveryCodes: newCodes });
});
