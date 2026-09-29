/**
 * POST /api/v1/me/security/sessions/revoke-current — explicit sign-out
 * hook (Prompt 30 §79, §84, §88).
 *
 * Best-effort server companion to NextAuth's client signOut: revokes the
 * CURRENT registered session (so the device cannot be resurrected from a
 * stolen cookie copy) and records the durable auth.logout activity event.
 * Failure-safe: the client signs out regardless.
 */
import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertFreshSession, assertSessionRegistry } from "@/lib/auth-security";
import { SECURITY_EVENTS, recordSecurityEvent } from "@/lib/auth/security-events/service";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest) => {
  // Prompt 30-F §61 — mutation endpoints enforce the limiter BEFORE work.
  // Tolerant failure semantics are preserved (the client signs out
  // regardless — see below), but hammering the endpoint is bounded.
  const rl = rateLimit(`session-signout:${getClientIp(req)}`, 30, 15 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please wait a moment.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const session = await getServerSession(authOptions);
  // Deliberately tolerant: a legacy/edge-case session still gets signed out
  // client-side; we only enrich with revocation when the registry knows us.
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!session || !userId) return ok({ revoked: false });

  const registryId = await assertSessionRegistry(session, userId).catch(() => null);
  let revoked = false;
  if (registryId) {
    const claimed = await db.userSession
      .updateMany({
        where: { id: registryId, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      .catch(() => ({ count: 0 }));
    revoked = claimed.count === 1;
  }

  await recordSecurityEvent({
    eventType: SECURITY_EVENTS.logout,
    userId,
    sessionId: registryId,
    success: true,
    ip: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });

  return ok({ revoked });
});
