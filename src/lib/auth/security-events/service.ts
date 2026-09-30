import "server-only";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { logWarn } from "@/lib/observability/logger";

/**
 * SecurityEvent service — Prompt 30 §88/§89/§90/§91/§423/§443/§444.
 *
 * Durable, per-user security ACTIVITY (distinct from the domain AuditLog —
 * §479 keeps those separate — and from stdout operational logs, §82).
 *
 * LAWS:
 *  - FIXED event vocabulary (§423). Names are constants in this module;
 *    client input can NEVER introduce an event name or a reason code.
 *  - Data minimization (§90): NEVER a password, OTP, recovery code, reset
 *    token, MFA secret, request body, AI prompt/response, or raw IP.
 *  - IP is stored HASHED (§75/§89: ipHash). Hashing limits casual exposure;
 *    it is NOT claimed to be strong anonymization (IPv4 space is enumerable)
 *    — documented honestly in docs/security/session-management.md.
 *  - userAgent is bounded to 255 chars before persistence (§233).
 *  - Event creation is fire-safe: a failed event write must never break the
 *    primary security operation — it is logged as a safe operational warn.
 *  - Attack-bound (§141): events are only written from paths that are
 *    themselves rate-limited; this service adds no unbounded writes.
 */

export const SECURITY_EVENTS = {
  loginSuccess: "auth.login.success",
  loginFailed: "auth.login.failed",
  logout: "auth.logout",
  sessionRevoked: "auth.session.revoked",
  sessionRevokedAll: "auth.session.revoked_all",
  mfaEnrollmentStarted: "auth.mfa.enrollment_started",
  mfaEnabled: "auth.mfa.enabled",
  mfaDisabled: "auth.mfa.disabled",
  mfaRecoveryCodesGenerated: "auth.mfa.recovery_codes_generated",
  mfaRecoveryCodeUsed: "auth.mfa.recovery_code_used",
  mfaLoginChallengeCreated: "auth.mfa.login_challenge_created",
  mfaLoginSucceeded: "auth.mfa.login_succeeded",
  mfaLoginFailed: "auth.mfa.login_failed",
  emailVerificationRequested: "auth.email_verification.requested",
  emailVerificationSent: "auth.email_verification.sent",
  emailVerificationCompleted: "auth.email_verification.completed",
  emailVerificationFailed: "auth.email_verification.failed",
  passwordChanged: "auth.password.changed",
  passwordResetCompleted: "auth.password.reset_completed",
  stepUpPasswordVerified: "auth.stepup.password_verified",
  stepUpMfaVerified: "auth.stepup.mfa_verified",
} as const;

export type SecurityEventType =
  (typeof SECURITY_EVENTS)[keyof typeof SECURITY_EVENTS];

/** Fixed reason codes (§91) — never client-supplied, never attacker-facing. */
export const SECURITY_EVENT_REASONS = {
  invalidCredentials: "INVALID_CREDENTIALS",
  rateLimited: "RATE_LIMITED",
  mfaRequired: "MFA_REQUIRED",
  mfaFailed: "MFA_FAILED",
  unknownUser: "UNKNOWN_USER",
  deliveryFailed: "DELIVERY_FAILED",
  tokenExpired: "TOKEN_EXPIRED",
  tokenInvalid: "TOKEN_INVALID",
} as const;

/** Hash an IP for storage (§75). Salted with a fixed application constant —
 * the honest limitation (IPv4 enumeration) is documented, not denied. */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip || ip === "unknown") return null;
  return createHash("sha256").update(`ipsecsalt-v1:${ip}`).digest("hex");
}

/** Bound the user-agent snapshot (§233) — arbitrary header values are never
 * stored raw or unbounded. */
export function boundUserAgent(ua: string | null | undefined): string | null {
  const value = (ua ?? "").trim();
  if (!value) return null;
  return value.slice(0, 255);
}

export type SecurityEventInput = {
  eventType: SecurityEventType;
  userId?: string | null;
  /** SAFE session reference: the UserSession row id — never a raw token. */
  sessionId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  success: boolean;
  reasonCode?: string | null;
};

/**
 * Persist one security activity record. Fire-safe: never throws into the
 * security flow that triggered it (§322 — logging failure must not prevent
 * the security operation when durable audit is independently available).
 *
 * Returns the created row id (or null on failure). Prompt 32 uses it as the
 * DURABLE sourceEventId for derived notifications (§29/§333) — a stable
 * server identity, never a timestamp.
 */
export async function recordSecurityEvent(input: SecurityEventInput): Promise<string | null> {
  try {
    const created = await db.securityEvent.create({
      data: {
        eventType: input.eventType,
        userId: input.userId ?? null,
        sessionId: input.sessionId ?? null,
        ipHash: hashIp(input.ip),
        userAgent: boundUserAgent(input.userAgent),
        success: input.success,
        reasonCode: input.reasonCode ?? null,
      },
      select: { id: true },
    });
    return created.id;
  } catch (error) {
    logWarn("security.event_write_failed", {
      eventType: input.eventType,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}
