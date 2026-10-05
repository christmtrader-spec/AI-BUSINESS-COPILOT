/**
 * GET /api/v1/reports/aging — receivables/payables AGING (§2 row 15).
 *
 * Thin JSON renderer over the SHARED aging engine (src/lib/aging-report.ts —
 * A11 single source of calculation). Response shape: { ok, data: {
 * generatedAt, timezone, asOf, truncated, receivables, payables } }.
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { buildAgingReport } from "@/lib/aging-report";

export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest) => {
  const ctx = await getAuthContext(_req);
  requirePermission(ctx, "data:read");

  const report = await buildAgingReport(ctx.businessId);
  return ok(report);
});
