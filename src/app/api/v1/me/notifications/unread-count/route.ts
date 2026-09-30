/**
 * GET /api/v1/me/notifications/unread-count — bounded unread count for the
 * CURRENT user (Prompt 32 §52/§107/§218). Indexed filter; no history scan.
 */
import { getServerSession } from "next-auth";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { assertFreshSession } from "@/lib/auth-security";
import { rateLimit } from "@/lib/rate-limit";
import { unreadNotificationCount } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const session = await getServerSession(authOptions);
  const userId = await assertFreshSession(session);

  const rl = rateLimit(`notif-count:${userId}`, 120, 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please slow down.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const count = await unreadNotificationCount(userId);
  return ok({ count });
});
