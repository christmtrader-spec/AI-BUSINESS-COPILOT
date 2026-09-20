/**
 * POST /api/v1/auth/password-change — change the signed-in user's password
 * (Prompt 18 §5). Identity comes EXCLUSIVELY from the authenticated session
 * (never userId/email from the body). Flow:
 *   verify current password → reject same-password reuse → validate policy
 *   → hash (bcrypt-12) → update + bump sessionVersion in ONE transaction
 *   → audit auth.password_changed.
 * All existing sessions die (session-version mismatch on their next request)
 * — the documented policy is "require re-authentication" for both change
 * and reset, which a single version counter enforces honestly.
 */
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { ApiError, getClientIp, ok, parseBody, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { assertFreshSession, passwordSchema } from "@/lib/auth-security";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1).max(200),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const POST = route(async (req: NextRequest) => {
  const session = await getServerSession(authOptions);
  const userId = await assertFreshSession(session);

  // Brute-force guard on the CURRENT-password check (per user + ip).
  const rl = rateLimit(`pwd-change:${userId}:${getClientIp(req)}`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Please wait a moment and try again.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const input = await parseBody(req, bodySchema);

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true },
  });
  if (!user) {
    throw new ApiError(401, "SESSION_INVALIDATED", "This session is no longer valid. Please sign in again.");
  }

  const currentOk = await bcrypt.compare(input.currentPassword, user.passwordHash);
  if (!currentOk) {
    // Deliberately vague: never disclose WHY the current-password check failed.
    throw new ApiError(400, "INVALID_CURRENT_PASSWORD", "The current password is incorrect.");
  }

  // §5.5 — reject reuse of the exact current password.
  const sameAsCurrent = await bcrypt.compare(input.newPassword, user.passwordHash);
  if (sameAsCurrent) {
    throw new ApiError(
      422,
      "PASSWORD_UNCHANGED",
      "The new password must be different from the current password.",
    );
  }

  const newPasswordHash = await bcrypt.hash(input.newPassword, 12);

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash: newPasswordHash, sessionVersion: { increment: 1 } },
    });
    await audit(
      {
        businessId: null,
        actorId: userId,
        action: "auth.password_changed",
        entityType: "User",
        entityId: userId,
        after: { sessionsInvalidated: true },
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
  });

  // Safe response: no secrets, no tokens. The client signs the user out.
  return ok({ changed: true, sessionsInvalidated: true });
});
