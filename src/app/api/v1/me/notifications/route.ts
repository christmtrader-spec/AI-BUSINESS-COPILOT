/**
 * GET /api/v1/me/notifications — the CURRENT user's notification list
 * (Prompt 32 §53/§54). Identity comes EXCLUSIVELY from the session (§19);
 * only allowlisted filters are honored; responses are private/no-store
 * (§241). Localized title/body are rendered server-side in the user's
 * persisted locale (§191/§192 — keys are stored, text is not).
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { assertFreshSession } from "@/lib/auth-security";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { listNotifications } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const session = await getServerSession(authOptions);
  const userId = await assertFreshSession(session);

  const rl = rateLimit(`notif-list:${userId}`, 60, 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please slow down.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { locale: true },
  });
  const locale = user?.locale === "fa" ? "fa" : "en";

  // §197/§198 — the business filter is later constrained to CURRENT
  // memberships inside the query service; the raw membership list is the
  // read-time authority.
  const memberships = await db.businessMember.findMany({
    where: { userId },
    select: { businessId: true },
  });

  const result = await listNotifications(userId, req.nextUrl.searchParams, locale, memberships);

  const response = ok(result);
  response.headers.set("Cache-Control", "private, no-store");
  return response as NextResponse;
});
