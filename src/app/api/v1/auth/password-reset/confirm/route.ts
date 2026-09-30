/**
 * POST /api/v1/auth/password-reset/confirm — complete credential recovery
 * (Prompt 18 §28/§29). Validates the raw token from the emailed link:
 *   format → SHA-256 → single atomic consume → password update.
 *
 * Concurrency law (§29): the token row is claimed with a conditional
 * `updateMany({ where: { id, usedAt: null, expiresAt: { gt: now } } })`
 * inside the same transaction that updates the password — two simultaneous
 * confirmations race on `usedAt: null`, exactly one wins, the loser rolls
 * back with a generic error. A consumed token can never be reused.
 *
 * Session law (§45): the user's sessionVersion is incremented in the same
 * transaction, so every previously issued JWT fails the freshness check on
 * its next request. NO new session is created here — the user signs in.
 */
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { ApiError, getClientIp, ok, parseBody, route } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import {
  hashResetToken,
  isPlausibleResetToken,
  passwordSchema,
} from "@/lib/auth-security";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    token: z.string().min(20).max(200),
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1).max(200),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const POST = route(async (req: NextRequest) => {
  const input = await parseBody(req, bodySchema);
  const ip = getClientIp(req);

  // §12 — hard cap on token-guessing/verification attempts per IP.
  const rl = rateLimit(`pwd-reset-confirm:${ip}`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Please wait a moment and try again.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  // Format check is constant-time-ish and rejects garbage BEFORE hashing.
  if (!isPlausibleResetToken(input.token)) {
    throw new ApiError(400, "INVALID_RESET_TOKEN", "This reset link is invalid or has expired.");
  }
  const tokenHash = hashResetToken(input.token);

  // Rate-limit per token hash too (targeted brute force on one link).
  const rlToken = rateLimit(`pwd-reset-token:${tokenHash.slice(0, 16)}`, 5, 15 * 60_000);
  if (!rlToken.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Please wait a moment and try again.", {
      retryAfterMs: rlToken.retryAfterMs,
    });
  }

  const now = new Date();

  try {
    await db.$transaction(async (tx) => {
      const token = await tx.passwordResetToken.findUnique({
        where: { tokenHash },
        select: { id: true, userId: true },
      });
      // Generic failure: expired / used / unknown are indistinguishable
      // from the outside (§11 applied to the confirm step as well).
      if (!token) throw new Error("TOKEN_DEAD");

      // Atomic single-use claim — the heart of §29.
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: token.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) throw new Error("TOKEN_DEAD");

      const user = await tx.user.findUnique({
        where: { id: token.userId },
        select: { id: true },
      });
      if (!user) throw new Error("TOKEN_DEAD");

      const passwordHash = await bcrypt.hash(input.newPassword, 12);
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, sessionVersion: { increment: 1 } },
      });

      // Prompt 30 §361 — registry reflects the global invalidation.
      await tx.userSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      // Prompt 30 §439 — password reset invalidates outstanding MFA login
      // challenges (the version binding would reject them anyway, §438).
      await tx.mfaLoginChallenge.deleteMany({ where: { userId: user.id } });

      await audit(
        {
          businessId: null,
          actorId: user.id,
          // §20/§21 — no token material, no password in metadata.
          action: "auth.password_reset_completed",
          entityType: "User",
          entityId: user.id,
          after: { sessionsInvalidated: true },
          ip,
          userAgent: req.headers.get("user-agent"),
        },
        tx,
      );

      return undefined;
    });

    // Prompt 30 §88 — durable security activity (§320: after transition).
    const { SECURITY_EVENTS, recordSecurityEvent } = await import(
      "@/lib/auth/security-events/service"
    );
    const resetUser = await db.passwordResetToken.findFirst({
      where: { tokenHash },
      select: { userId: true },
    });
    if (resetUser) {
      const securityEventId = await recordSecurityEvent({
        eventType: SECURITY_EVENTS.passwordResetCompleted,
        userId: resetUser.userId,
        success: true,
        ip,
        userAgent: req.headers.get("user-agent"),
      });
      // Prompt 32 §92 — mandatory security notification, fire-safe, after
      // commit. The reset token is NEVER part of the notification (§404).
      if (securityEventId) {
        const { notifyPasswordResetCompleted } = await import("@/lib/notifications");
        notifyPasswordResetCompleted(resetUser.userId, securityEventId);
      }
    }

    return ok({
      message: `Your password has been changed. Your previous sessions were signed out — please sign in with your new password.`,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "TOKEN_DEAD") {
      throw new ApiError(400, "INVALID_RESET_TOKEN", "This reset link is invalid or has expired.");
    }
    throw error;
  }
});
