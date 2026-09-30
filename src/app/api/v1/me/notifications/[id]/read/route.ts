/**
 * POST /api/v1/me/notifications/[id]/read — mark ONE notification read
 * (Prompt 32 §51). Ownership is enforced by the ownership-scoped lookup
 * (§183/§184): another user's id is simply not found (404 — no existence
 * leak).
 */
import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { assertFreshSession } from "@/lib/auth-security";
import { rateLimit } from "@/lib/rate-limit";
import { markNotificationRead } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export const POST = route(
  async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const session = await getServerSession(authOptions);
    const userId = await assertFreshSession(session);

    const rl = rateLimit(`notif-read:${userId}`, 120, 60_000);
    if (!rl.allowed) {
      throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please slow down.", {
        retryAfterMs: rl.retryAfterMs,
      });
    }

    const { id } = await ctx.params;
    const updated = await markNotificationRead(userId, id);
    if (!updated) {
      throw new ApiError(404, "NOTIFICATION_NOT_FOUND", "Notification not found.");
    }
    return ok({ read: true });
  },
);
