/**
 * POST /api/v1/me/notifications/[id]/unread — mark ONE notification unread
 * where useful (Prompt 32 §50). Same ownership law as the read endpoint.
 */
import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { assertFreshSession } from "@/lib/auth-security";
import { rateLimit } from "@/lib/rate-limit";
import { markNotificationUnread } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export const POST = route(
  async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const session = await getServerSession(authOptions);
    const userId = await assertFreshSession(session);

    const rl = rateLimit(`notif-unread:${userId}`, 60, 60_000);
    if (!rl.allowed) {
      throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please slow down.", {
        retryAfterMs: rl.retryAfterMs,
      });
    }

    const { id } = await ctx.params;
    const updated = await markNotificationUnread(userId, id);
    if (!updated) {
      throw new ApiError(404, "NOTIFICATION_NOT_FOUND", "Notification not found.");
    }
    return ok({ unread: true });
  },
);
