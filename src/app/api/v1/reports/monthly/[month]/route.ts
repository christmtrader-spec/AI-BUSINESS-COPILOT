/**
 * GET /api/v1/reports/monthly/[month] — single-month drill-down.
 *
 * Companion to GET /api/v1/reports/monthly (the MoM table): clicking a
 * month row returns that month's sales/expenses lists plus totals
 * recomputed with the SAME localMonthKey bucketing as the table — the
 * numbers always match the row (A08 integer minors, deterministic).
 *
 * Permission: data:read (all roles).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { buildMonthDetail } from "@/lib/reports";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ month: string }> };

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { month } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  const detail = await buildMonthDetail(ctx.businessId, decodeURIComponent(month));
  if (!detail) {
    throw new ApiError(404, "NOT_FOUND", "Unknown month. Expected YYYY-MM.");
  }

  return ok(detail);
});
