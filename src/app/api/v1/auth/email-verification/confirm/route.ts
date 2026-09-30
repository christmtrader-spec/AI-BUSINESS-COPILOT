/**
 * POST /api/v1/auth/email-verification/confirm — anonymous token claim
 * (Prompt 30 §18-§20, §130, §161, §249).
 *
 * The ONLY anonymous email-verification endpoint; it accepts a token (from
 * the emailed link), never an email address (§22 — no resend-by-email).
 *
 * Laws:
 *  - Constant format gate BEFORE any DB work (§130).
 *  - IP rate limit (§23): email-verify-confirm:<ip>.
 *  - Atomic single-use claim — exactly one concurrent request wins (§19).
 *  - Already-verified account with a valid token → safe idempotent result
 *    (§20); used/expired/unknown → GENERIC invalid result (§282) — token
 *    existence is never leaked.
 *  - Duplicate protection (§209): the second confirmation of the same
 *    token claims nothing and records no second verified event.
 *  - Audit + durable security event carry NO token material (§205).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, getClientIp, ok, parseBody, route } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import {
  cleanupEmailVerificationTokens,
  confirmEmailVerificationToken,
} from "@/lib/auth/email-verification/service";
import { SECURITY_EVENTS, recordSecurityEvent } from "@/lib/auth/security-events/service";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  token: z.string().min(20).max(200),
});

export const POST = route(async (req: NextRequest) => {
  const ip = getClientIp(req);

  // §23 — dedicated confirm limiter (token guessing is bounded per IP).
  const rl = rateLimit(`email-verify-confirm:${ip}`, 20, 15 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "EMAIL_VERIFICATION_RATE_LIMITED", "Too many attempts. Please try again later.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const input = await parseBody(req, bodySchema);

  const outcome = await confirmEmailVerificationToken(input.token);

  if (outcome === "INVALID_OR_EXPIRED") {
    // Generic — unknown, used and expired are indistinguishable (§20/§282).
    throw new ApiError(400, "EMAIL_VERIFICATION_TOKEN_INVALID", "This verification link is invalid or has expired.");
  }

  // Resolve the user for audit + event metadata (the service validated the
  // token against a real row; VERIFIED or ALREADY_VERIFIED imply one).
  const { hashResetToken } = await import("@/lib/auth-security");
  const row = await db.emailVerificationToken.findUnique({
    where: { tokenHash: hashResetToken(input.token) },
    select: { userId: true },
  });

  if (outcome === "VERIFIED" && row) {
    // §69/§136 — safe metadata only; §209 — exactly one completed event per
    // successful claim (the claim itself is the idempotency gate).
    const securityEventId = await recordSecurityEvent({
      eventType: SECURITY_EVENTS.emailVerificationCompleted,
      userId: row.userId,
      success: true,
      ip,
      userAgent: req.headers.get("user-agent"),
    });
    // Prompt 32 §95 — in-app-only notification (no redundant email).
    if (securityEventId) {
      const { notifyEmailVerified } = await import("@/lib/notifications");
      notifyEmailVerified(row.userId, securityEventId);
    }
    await audit({
      businessId: null,
      actorId: row.userId,
      action: "auth.email_verified",
      entityType: "User",
      entityId: row.userId,
      ip,
      userAgent: req.headers.get("user-agent"),
    });
    // §132 — bounded opportunistic cleanup after a successful claim.
    await cleanupEmailVerificationTokens(row.userId).catch(() => undefined);
  }

  // §20 — safe, non-secret outcome for both success flavors.
  return ok({
    verified: outcome === "VERIFIED",
    alreadyVerified: outcome === "ALREADY_VERIFIED_NO_TOKEN",
  });
});
