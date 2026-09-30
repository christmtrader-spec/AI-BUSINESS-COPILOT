/**
 * POST /api/v1/me/notifications/read-all — mark ALL of the CURRENT user's
 * unread notifications read in ONE bounded statement (§55/§219). Never
 * touches other users (§301). Idempotent and cheap (§245).
 */
import { getServerSession } from "next-auth";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { assertFreshSession } from "@/lib/auth-security";
import { rateLimit } from "@/lib/rate-limit";
import { markAllNotificationsRead } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export const POST = route(async () => {
  const session = await getServerSession(authOptions);
  const userId = await assertFreshSession(session);

  const rl = rateLimit(`notif-read-all:${userId}`, 30, 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please slow down.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const updated = await markAllNotificationsRead(userId);
  return ok({ updated });
});
