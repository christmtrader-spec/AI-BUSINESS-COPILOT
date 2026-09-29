import "server-only";
import { db } from "@/lib/db";
import { stepUpMaxAgeSeconds } from "@/lib/auth/config";
import { SECURITY_EVENTS, recordSecurityEvent } from "@/lib/auth/security-events/service";
import { verifyMfaCodeForCredential, userHasMfaEnabled } from "@/lib/auth/mfa/service";
import bcrypt from "bcryptjs";

/**
 * Step-up authentication — Prompt 30 §113-§118, §162-§164, §199.
 *
 * The SERVER is the only authority for "recently authenticated" (§116):
 * client timestamps, booleans and localStorage are never consulted. A
 * successful reauthentication is durably recorded as a SecurityEvent; a
 * destructive operation then checks for that event inside the configured
 * recent-auth window (§115 — MFA_STEP_UP_MAX_AGE_SECONDS, default 600s).
 *
 * Two sanctioned patterns (both funnel through the SAME password/MFA
 * verification helpers — §114):
 *   1. REQUIRE-RECENT: the caller verifies recency of a prior step-up
 *      (requireRecentPasswordAuth / requireRecentMfaAuth).
 *   2. VERIFY-NOW: the mutation carries the credentials in-body and calls
 *      verifyPasswordNow / verifyPasswordAndMfaNow — used by flows that
 *      already collect the current password (disable MFA, revoke-all,
 *      regenerate recovery codes, account deletion).
 *
 * Either way, EVERY high-risk operation listed in §118 passes through this
 * module — no bespoke auth checks scattered in routes.
 */

export class StepUpError extends Error {
  constructor(
    public code:
      | "MFA_REAUTH_REQUIRED"
      | "MFA_DISABLE_REAUTH_REQUIRED"
      | "INVALID_CURRENT_PASSWORD"
      | "MFA_INVALID_CODE",
    message: string,
  ) {
    super(message);
  }
}

/** The latest step-up event of the given type within the window (or null). */
async function latestStepUpEvent(
  userId: string,
  eventType: string,
): Promise<{ createdAt: Date } | null> {
  const event = await db.securityEvent.findFirst({
    where: { userId, eventType, success: true, createdAt: { gte: new Date(Date.now() - stepUpMaxAgeSeconds() * 1000) } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return event;
}

/** §114/§162 — recent password authentication within the window. */
export async function requireRecentPasswordAuth(userId: string): Promise<void> {
  const event = await latestStepUpEvent(userId, SECURITY_EVENTS.stepUpPasswordVerified);
  if (!event) {
    throw new StepUpError("MFA_REAUTH_REQUIRED", "Please confirm your password to continue.");
  }
}

/** §113/§164 — recent password AND recent MFA verification. */
export async function requireRecentStrongAuth(userId: string): Promise<void> {
  await requireRecentPasswordAuth(userId);
  const event = await latestStepUpEvent(userId, SECURITY_EVENTS.stepUpMfaVerified);
  if (!event) {
    throw new StepUpError("MFA_REAUTH_REQUIRED", "Please confirm your identity to continue.");
  }
}

/**
 * VERIFY-NOW password check (§118 flows that collect the password in-body).
 * Generic INVALID_CURRENT_PASSWORD — never discloses which factor failed
 * beyond the password itself.
 */
export async function verifyPasswordNow(
  userId: string,
  password: string,
  meta: { ip: string | null; userAgent: string | null } = { ip: null, userAgent: null },
): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true },
  });
  if (!user) throw new StepUpError("INVALID_CURRENT_PASSWORD", "The password is incorrect.");
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    await recordSecurityEvent({
      eventType: SECURITY_EVENTS.stepUpPasswordVerified,
      userId,
      success: false,
      reasonCode: "INVALID_PASSWORD",
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    throw new StepUpError("INVALID_CURRENT_PASSWORD", "The password is incorrect.");
  }
  await recordSecurityEvent({
    eventType: SECURITY_EVENTS.stepUpPasswordVerified,
    userId,
    success: true,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
}

/**
 * VERIFY-NOW MFA check (§118). Accepts a TOTP code; `allowRecoveryCode`
 * extends acceptance to a one-time recovery code (consumed on use —
 * §65: disable-MFA may be completed with password + recovery code).
 */
export async function verifyMfaNow(
  userId: string,
  code: string,
  meta: { ip: string | null; userAgent: string | null } = { ip: null, userAgent: null },
  opts: { allowRecoveryCode?: boolean } = {},
): Promise<void> {
  const { claimRecoveryCode, hashRecoveryCode } = await import("@/lib/auth/mfa/service");
  const credential = await db.mfaCredential.findUnique({
    where: { userId },
    select: { id: true, userId: true, encryptedSecret: true, enabledAt: true, lastUsedTotpStep: true },
  });
  const mfaActive = credential?.enabledAt != null;
  if (!mfaActive || !credential) {
    throw new StepUpError("MFA_INVALID_CODE", "The authentication code is invalid.");
  }

  // TOTP first (format-gated inside the service).
  const result = await verifyMfaCodeForCredential(
    { id: credential.id, userId: credential.userId, encryptedSecret: credential.encryptedSecret, enabledAt: credential.enabledAt, lastUsedTotpStep: credential.lastUsedTotpStep },
    code,
    { enforceReplay: false }, // step-up is session-bound; replay applies to login challenges (§45)
  );
  if (result.ok) {
    await recordSecurityEvent({
      eventType: SECURITY_EVENTS.stepUpMfaVerified,
      userId,
      success: true,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return;
  }
  if (result.reason === "DECRYPT_FAILED") {
    // verifyMfaCodeForCredential already threw the safe service error for
    // decryption failures; reaching here means it returned instead.
    throw new StepUpError("MFA_INVALID_CODE", "The authentication code is invalid.");
  }

  // Recovery-code fallback where policy allows (§65).
  if (opts.allowRecoveryCode) {
    const codeHash = hashRecoveryCode(code);
    const existsUnused = await db.mfaRecoveryCode.findFirst({
      where: { userId, codeHash, usedAt: null },
      select: { id: true },
    });
    if (existsUnused) {
      const claimed = await claimRecoveryCode(userId, code);
      if (claimed) {
        await recordSecurityEvent({
          eventType: SECURITY_EVENTS.mfaRecoveryCodeUsed,
          userId,
          success: true,
          reasonCode: "STEP_UP",
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        await recordSecurityEvent({
          eventType: SECURITY_EVENTS.stepUpMfaVerified,
          userId,
          success: true,
          reasonCode: "RECOVERY_CODE",
          ip: meta.ip,
          userAgent: meta.userAgent,
        });
        return;
      }
    }
  }

  await recordSecurityEvent({
    eventType: SECURITY_EVENTS.stepUpMfaVerified,
    userId,
    success: false,
    reasonCode: "MFA_FAILED",
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  throw new StepUpError("MFA_INVALID_CODE", "The authentication code is invalid.");
}

/** Convenience: password + MFA (TOTP or recovery) verified in one call. */
export async function verifyStrongAuthNow(
  userId: string,
  password: string,
  mfaCode: string,
  meta: { ip: string | null; userAgent: string | null } = { ip: null, userAgent: null },
  opts: { allowRecoveryCode?: boolean } = {},
): Promise<void> {
  await verifyPasswordNow(userId, password, meta);
  await verifyMfaNow(userId, mfaCode, meta, opts);
}

/** §147 — does the account currently require an MFA factor for delete? */
export async function accountRequiresMfaFactor(userId: string): Promise<boolean> {
  return userHasMfaEnabled(userId);
}
