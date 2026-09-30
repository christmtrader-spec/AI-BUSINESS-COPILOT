/**
 * POST /api/v1/me/notifications/[id]/archive — archive as a UX state
 * (Prompt 32 §56/§118). NEVER a deletion: records persist for their
 * documented retention period (§370/§371).
 */
import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { assertFreshSession } from "@/lib/auth-security";
import { rateLimit } from "@/lib/rate-limit";
import { archiveNotification } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export const POST = route(
  async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const session = await getServerSession(authOptions);
    const userId = await assertFreshSession(session);

    const rl = rateLimit(`notif-archive:${userId}`, 60, 60_000);
    if (!rl.allowed) {
      throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please slow down.", {
        retryAfterMs: rl.retryAfterMs,
      });
    }

    const { id } = await ctx.params;
    const updated = await archiveNotification(userId, id);
    if (!updated) {
      throw new ApiError(404, "NOTIFICATION_NOT_FOUND", "Notification not found.");
    }
    return ok({ archived: true });
  },
);
