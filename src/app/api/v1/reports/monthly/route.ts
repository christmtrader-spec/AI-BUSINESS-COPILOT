/**
 * GET /api/v1/reports/monthly?months=3|6|12
 *
 * Phase 06 — month-over-month comparison series. Deterministic server
 * computation (Rule 05): every figure is bucketed from recorded
 * transactions in the business timezone; the UI only narrates.
 *
 * Permission: data:read (all roles).
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { buildMonthlyBreakdown, normalizeReportMonths } from "@/lib/reports";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  const url = new URL(req.url);
  const months = normalizeReportMonths(url.searchParams.get("months"));

  return ok(await buildMonthlyBreakdown(ctx.businessId, months));
});
