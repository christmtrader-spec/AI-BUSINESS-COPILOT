/**
 * POST /api/v1/me/security/sessions/[id]/revoke — per-device revocation
 * (Prompt 30 §78, §119, §126, §165, §210, §246, §283).
 *
 * The target session MUST belong to the caller — cross-account session ids
 * produce the SAME 404 (never a 403/404 distinction that would reveal
 * whether a foreign session id exists, §126/§283). Revoking the CURRENT
 * session is refused (use sign-out / revoke-current); revoking is otherwise
 * allowed without password (§119 "may require" — single-device revocation
 * is low-risk) but requires explicit UI confirmation (§246).
 *
 * Duplicate protection (§210): the conditional updateMany makes a second
 * revoke a safe no-op with an honest alreadyRevoked flag.
 */
import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { ApiError, getClientIp, ok, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertFreshSession, assertSessionRegistry } from "@/lib/auth-security";
import { rateLimit } from "@/lib/rate-limit";
import { SECURITY_EVENTS, recordSecurityEvent } from "@/lib/auth/security-events/service";

export const dynamic = "force-dynamic";

export const POST = route(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const session = await getServerSession(authOptions);
    const userId = await assertFreshSession(session);
    const currentRegistryId = await assertSessionRegistry(session, userId);
    const { id } = await ctx.params;

    const rl = rateLimit(`session-revoke:${userId}:${getClientIp(req)}`, 20, 15 * 60_000);
    if (!rl.allowed) {
      throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Please wait a moment.");
    }

    // §126/§165 — ownership is part of the lookup: a foreign id yields the
    // same NOT_FOUND as a nonexistent one (no existence oracle).
    const target = await db.userSession.findFirst({
      where: { id, userId },
      select: { id: true, revokedAt: true },
    });
    if (!target) {
      throw new ApiError(404, "SESSION_NOT_FOUND", "Session not found.");
    }
    if (currentRegistryId && target.id === currentRegistryId) {
      // §78-analog — revoking the CURRENT device is the sign-out flow.
      throw new ApiError(400, "SESSION_CURRENT", "Use sign out to end the current session.");
    }

    if (target.revokedAt === null) {
      const claimed = await db.userSession.updateMany({
        where: { id: target.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (claimed.count === 1) {
        await recordSecurityEvent({
          eventType: SECURITY_EVENTS.sessionRevoked,
          userId,
          sessionId: target.id,
          success: true,
          ip: getClientIp(req),
          userAgent: req.headers.get("user-agent"),
        });
      }
    }

    // §210 — idempotent, safe no-op when already revoked.
    return ok({ revoked: true, alreadyRevoked: target.revokedAt !== null });
  },
);
