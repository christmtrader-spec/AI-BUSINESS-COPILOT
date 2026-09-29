/**
 * POST /api/v1/me/security/mfa/disable — high-risk MFA removal
 * (Prompt 30 §65/§66, §163, §211, §245, §319).
 *
 * Authorization chain (§163/§319): authenticated → FRESH session →
 * current password (VERIFY-NOW) → MFA proof (TOTP **or** a one-time
 * recovery code — §65) → typed confirmation literal "DISABLE MFA"
 * (§65/§245 — never color-only).
 *
 * After a successful disable (§66): sessionVersion++ AND every registered
 * session revoked — all devices (including this one) must sign in again.
 *
 * Duplicate protection (§211): a second disable finds no enabled
 * credential and returns the safe alreadyDisabled state — no duplicate
 * mutation, no duplicate session invalidation.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { ApiError, getClientIp, ok, parseBody, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertFreshSession } from "@/lib/auth-security";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { StepUpError, verifyStrongAuthNow } from "@/lib/auth/step-up";
import { SECURITY_EVENTS, recordSecurityEvent } from "@/lib/auth/security-events/service";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  password: z.string().min(1).max(200),
  mfaCode: z.string().trim().min(6).max(64),
  /** §65/§245 — exact typed confirmation, verified below (a zod literal
   * would collapse the mismatch into a generic 422; the handler returns the
   * precise CONFIRMATION_MISMATCH code instead). */
  confirmation: z.string().min(1).max(40),
});

export const POST = route(async (req: NextRequest) => {
  const session = await getServerSession(authOptions);
  const userId = await assertFreshSession(session);
  const ip = getClientIp(req);

  const rl = rateLimit(`mfa-disable:${userId}:${ip}`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "MFA_RATE_LIMITED", "Too many attempts. Please wait a moment.");
  }

  const input = await parseBody(req, bodySchema);

  const credential = await db.mfaCredential.findUnique({
    where: { userId },
    select: { id: true, enabledAt: true },
  });

  // §211 — already disabled: safe state response, no duplicate mutation.
  if (!credential || credential.enabledAt == null) {
    return ok({ disabled: true, alreadyDisabled: true });
  }

  const confirmationLiteral = "DISABLE MFA";
  if (input.confirmation !== confirmationLiteral) {
    throw new ApiError(422, "CONFIRMATION_MISMATCH", "Type DISABLE MFA to confirm.");
  }

  // §163/§319 — password + (TOTP | recovery code) verified for real.
  try {
    await verifyStrongAuthNow(
      userId,
      input.password,
      input.mfaCode,
      { ip, userAgent: req.headers.get("user-agent") },
      { allowRecoveryCode: true },
    );
  } catch (error) {
    if (error instanceof StepUpError) {
      if (error.code === "INVALID_CURRENT_PASSWORD") {
        throw new ApiError(400, "INVALID_CURRENT_PASSWORD", "The password is incorrect.");
      }
      throw new ApiError(400, "MFA_INVALID_CODE", "Invalid authentication code.");
    }
    throw error;
  }

  // §66 — disable + sessionVersion++ + revoke all sessions, atomically.
  await db.$transaction(async (tx) => {
    await tx.mfaCredential.delete({ where: { id: credential.id } });
    await tx.user.update({
      where: { id: userId },
      data: { sessionVersion: { increment: 1 } },
    });
    await tx.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        businessId: null,
        actorId: userId,
        action: "auth.mfa_disabled",
        entityType: "User",
        entityId: userId,
        afterJson: JSON.stringify({ sessionsInvalidated: true }),
        ip: ip === "unknown" ? null : ip,
        userAgent: req.headers.get("user-agent")?.slice(0, 255) ?? null,
      },
    });
  });

  // §68/§320 — durable events AFTER the state transition.
  await recordSecurityEvent({
    eventType: SECURITY_EVENTS.mfaDisabled,
    userId,
    success: true,
    ip,
    userAgent: req.headers.get("user-agent"),
  });

  return ok({ disabled: true, alreadyDisabled: false, sessionsInvalidated: true });
});
