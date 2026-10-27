/**
 * GET /api/v1/activity?limit=8 — workspace activity feed.
 *
 * The dashboard's "Recent activity" card: one endpoint that unions the
 * latest sales, expenses and payments (each already proven tenant-scoped
 * by getAuthContext) into a single recency-sorted list. The merge logic
 * lives in lib/activity.ts (pure, unit-testable); figures are ledger
 * verbatim — the UI only narrates them (Rule 05 / A08).
 *
 * Permission: data:read (all roles) — same gate as the reports summary.
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { buildActivityFeed, normalizeActivityLimit } from "@/lib/activity";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  const limit = normalizeActivityLimit(new URL(req.url).searchParams.get("limit"));
  const items = await buildActivityFeed(ctx.businessId, limit);

  return ok({ items });
});
