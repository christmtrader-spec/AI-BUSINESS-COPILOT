/**
 * GET /api/v1/reports/digest-preview — weekly digest PREVIEW for the owner.
 *
 * Builds the same digest the operator cron (scripts/send-weekly-digest.mjs)
 * would email — stats + html/text — for the CURRENT business and returns it
 * WITHOUT sending anything. This is a request-path READ ONLY: no email
 * provider is touched here (the OPERATOR-SCHEDULED pattern forbids
 * request-path sends; the preview endpoint exists so the owner can see
 * exactly what the weekly email will contain).
 *
 * Permission: settings:manage (OWNER/ADMIN). Rate limited: 5/hour per user
 * (the build runs several bounded aggregates — cheap but not free).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { buildWeeklyDigest } from "@/lib/email/digest";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:manage");

  const limit = rateLimit(`digest-preview:${ctx.userId}`, 5, 60 * 60_000);
  if (!limit.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many digest previews — please try again later.", {
      retryAfterMs: limit.retryAfterMs,
    });
  }

  // Read-only build for the caller's own business (A01/A02 — the context is
  // already membership-verified). NEVER sends an email from this path.
  const digest = await buildWeeklyDigest(ctx.businessId, { now: new Date() });

  return ok({
    window: { start: digest.stats.windowStart, end: digest.stats.windowEnd },
    computedAt: digest.stats.computedAt,
    stats: {
      salesCount: digest.stats.salesCount,
      salesTotalMinor: digest.stats.salesTotalMinor,
      collectedMinor: digest.stats.collectedMinor,
      expensesMinor: digest.stats.expensesMinor,
      receivablesMinor: digest.stats.receivablesMinor,
      receivablesCount: digest.stats.receivablesCount,
      lowStockCount: digest.stats.lowStockCount,
      lowStockNames: digest.stats.lowStockNames,
      topProduct: digest.stats.topProduct,
    },
    formatted: digest.formatted,
    html: digest.html,
    text: digest.text,
  });
});
