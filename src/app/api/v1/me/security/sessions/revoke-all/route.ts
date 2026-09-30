/**
 * POST /api/v1/me/security/sessions/revoke-all — sign out every OTHER
 * device (Prompt 30 §80, §119, §247).
 *
 * Requires: current password (VERIFY-NOW step-up) + typed confirmation
 * literal "SIGN OUT ALL" (§80/§247 — destructive confirmation, never
 * color-only §245). The CURRENT session stays signed in; every other
 * registered session is revoked. sessionVersion is NOT incremented here —
 * per-device revocation is the point (§82: sessionVersion stays the global
 * kill switch for password/reset/delete events).
 *
 * Duplicate protection (§210): revoke-all is naturally idempotent
 * (updateMany on revokedAt IS NULL).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { ApiError, getClientIp, ok, parseBody, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { assertFreshSession, assertSessionRegistry } from "@/lib/auth-security";
import { verifyPasswordNow, StepUpError } from "@/lib/auth/step-up";
import { revokeAllUserSessions } from "@/lib/auth/sessions/service";
import { SECURITY_EVENTS, recordSecurityEvent } from "@/lib/auth/security-events/service";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  password: z.string().min(1).max(200),
  /** §80 — exact typed confirmation (destructive action). */
  confirmation: z.literal("SIGN OUT ALL"),
});

export const POST = route(async (req: NextRequest) => {
  const session = await getServerSession(authOptions);
  const userId = await assertFreshSession(session);
  const currentRegistryId = await assertSessionRegistry(session, userId);
  const ip = getClientIp(req);

  const rl = rateLimit(`session-revoke-all:${userId}:${ip}`, 5, 15 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Please wait a moment.");
  }

  const input = await parseBody(req, bodySchema);

  try {
    // §118/§119 — real password verification, recorded as step-up activity.
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

  // §80/§247 — revoke all OTHER sessions; the CURRENT one stays signed in.
  const revokedCount = await revokeAllUserSessions(userId, {
    exceptSessionRowId: currentRegistryId ?? undefined,
  });

  const securityEventId = await recordSecurityEvent({
    eventType: SECURITY_EVENTS.sessionRevokedAll,
    userId,
    sessionId: currentRegistryId,
    success: true,
    reasonCode: `REVOKED_${revokedCount}`,
    ip,
    userAgent: req.headers.get("user-agent"),
  });
  // Prompt 32 §97 — in-app-only notification for global sign-out (email
  // deliberately unmapped to avoid notification noise).
  if (securityEventId && revokedCount > 0) {
    const { notifySessionsSignedOut } = await import("@/lib/notifications");
    notifySessionsSignedOut(userId, revokedCount, securityEventId);
  }

  return ok({ revokedCount, currentSessionKept: true });
});
