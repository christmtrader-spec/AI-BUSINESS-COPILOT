/**
 * POST /api/v1/me/security/mfa/setup/confirm — verify the first TOTP code
 * and ACTIVATE MFA (Prompt 30 §37 steps 5-12, §38, §107/§108, §215/§220).
 *
 * ATOMICITY LAW (§107/§215/§220): enabledAt, the full recovery-code set,
 * and the audit trail are written in ONE transaction. If recovery-code
 * persistence fails, MFA never becomes enabled (§220) and the response is
 * an honest error — never a partially-enabled state.
 *
 * RECOVERY SAFETY (§108): MFA is never enabled without a complete recovery
 * set (10 codes — RECOVERY_CODES_COUNT). The raw codes are returned EXACTLY
 * ONCE in this response (§60/§104); only SHA-256 hashes are stored (§59);
 * they are never logged (§14) and never redisplayed (§104).
 *
 * Pending-setup expiry (§39/§106): the pending credential must have been
 * created within the challenge TTL window — stale abandoned setups are
 * rejected here and pruned by scripts/prune-auth-security.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { ApiError, getClientIp, ok, parseBody, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertFreshSession } from "@/lib/auth-security";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import {
  assertMfaFeatureAvailable,
  assertMfaKeyConfigured,
  generateRecoveryCodes,
  hashRecoveryCode,
  isPlausibleTotpCode,
  verifyMfaCodeForCredential,
} from "@/lib/auth/mfa/service";
import { RECOVERY_CODES_COUNT } from "@/lib/auth/config";
import { SECURITY_EVENTS, recordSecurityEvent } from "@/lib/auth/security-events/service";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  code: z.string().trim().min(6).max(12),
  /** §60 — the user must explicitly confirm the codes were saved. */
  confirmedSaved: z.literal(true),
});

export const POST = route(async (req: NextRequest) => {
  const session = await getServerSession(authOptions);
  const userId = await assertFreshSession(session);
  const ip = getClientIp(req);

  const rl = rateLimit(`mfa-confirm:${userId}:${ip}`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "MFA_RATE_LIMITED", "Too many attempts. Please wait a moment.");
  }

  assertMfaFeatureAvailable();
  assertMfaKeyConfigured();

  const input = await parseBody(req, bodySchema);
  if (!isPlausibleTotpCode(input.code)) {
    throw new ApiError(400, "MFA_INVALID_CODE", "Invalid authentication code.");
  }

  const credential = await db.mfaCredential.findUnique({
    where: { userId },
    select: { id: true, userId: true, encryptedSecret: true, enabledAt: true, lastUsedTotpStep: true, updatedAt: true },
  });
  if (!credential) {
    throw new ApiError(400, "MFA_CHALLENGE_INVALID", "No two-factor setup is in progress. Start setup again.");
  }
  if (credential.enabledAt != null) {
    throw new ApiError(409, "MFA_ALREADY_ENABLED", "Two-factor authentication is already enabled.");
  }

  // §39 — bounded setup window: a pending credential older than the
  // challenge TTL is rejected (abandoned setups are never long-lived).
  const setupAgeMs = Date.now() - credential.updatedAt.getTime();
  const { mfaChallengeTtlSeconds } = await import("@/lib/auth/config");
  if (setupAgeMs > mfaChallengeTtlSeconds() * 1000) {
    throw new ApiError(400, "MFA_CHALLENGE_EXPIRED", "This setup session has expired. Start setup again.");
  }

  // §38 — MFA is NEVER enabled before a valid TOTP has been verified.
  const result = await verifyMfaCodeForCredential(credential, input.code, {
    enforceReplay: false, // enrollment is session-bound; replay applies to logins (§45)
  });
  if (!result.ok) {
    await recordSecurityEvent({
      eventType: SECURITY_EVENTS.mfaLoginFailed,
      userId,
      reasonCode: "ENROLLMENT_FAILED",
      success: false,
      ip,
      userAgent: req.headers.get("user-agent"),
    });
    throw new ApiError(400, "MFA_INVALID_CODE", "Invalid authentication code.");
  }

  // §58/§108 — generate the FULL recovery set before enabling.
  const recoveryCodes = generateRecoveryCodes(RECOVERY_CODES_COUNT);

  // §107/§215/§220 — ONE transaction: enable + recovery hashes + audit.
  // NOTE: lastUsedTotpStep stays NULL here — replay state (§45) is
  // established by LOGIN completions only; stamping the enrollment step
  // would falsely reject the first login inside the same 30s window.
  try {
    await db.$transaction(async (tx) => {
      const enabled = await tx.mfaCredential.updateMany({
        where: { id: credential.id, userId, enabledAt: null },
        data: { enabledAt: new Date() },
      });
      if (enabled.count !== 1) {
        throw new Error("MFA_ENABLE_RACE");
      }
      await tx.mfaRecoveryCode.createMany({
        data: recoveryCodes.map((code) => ({
          userId,
          codeHash: hashRecoveryCode(code),
        })),
      });
      await tx.auditLog.create({
        data: {
          businessId: null,
          actorId: userId,
          action: "auth.mfa_enabled",
          entityType: "User",
          entityId: userId,
          afterJson: JSON.stringify({ method: "TOTP", recoveryCodes: RECOVERY_CODES_COUNT }),
          ip: ip === "unknown" ? null : ip,
          userAgent: req.headers.get("user-agent")?.slice(0, 255) ?? null,
        },
      });
    });
  } catch (error) {
    // §220 — recovery persistence failed ⇒ MFA is NOT enabled. Honest error.
    const message = error instanceof Error ? error.message : "";
    if (message === "MFA_ENABLE_RACE") {
      throw new ApiError(409, "MFA_ALREADY_ENABLED", "Two-factor authentication is already enabled.");
    }
    throw new ApiError(500, "INTERNAL_ERROR", "Could not enable two-factor authentication. Please try again.");
  }

  // §68/§320 — events AFTER the successful state transition.
  await recordSecurityEvent({
    eventType: SECURITY_EVENTS.mfaEnabled,
    userId,
    success: true,
    ip,
    userAgent: req.headers.get("user-agent"),
  });
  await recordSecurityEvent({
    eventType: SECURITY_EVENTS.mfaRecoveryCodesGenerated,
    userId,
    success: true,
    reasonCode: "ENROLLMENT",
    ip,
    userAgent: req.headers.get("user-agent"),
  });

  // §363 — MFA enable invalidates all sessions (documented, tested):
  // every device re-authenticates WITH MFA. The current login included —
  // the UI signs the user out after showing the recovery codes.
  const { revokeAllUserSessions } = await import("@/lib/auth/sessions/service");
  await revokeAllUserSessions(userId);
  await db.user.update({
    where: { id: userId },
    data: { sessionVersion: { increment: 1 } },
    select: { sessionVersion: true },
  });

  // §60 — the ONLY response that ever contains raw recovery codes.
  return ok({
    enabled: true,
    recoveryCodes,
    sessionsInvalidated: true,
  });
});
