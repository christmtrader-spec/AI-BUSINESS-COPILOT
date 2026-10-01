/**
 * GET /api/v1/crm/summary — CRM dashboard metrics (§34).
 *
 * All values are CRM FORECAST metrics scoped to the caller's business
 * (§83). Weighted pipeline uses exact integer math (§35). These values
 * NEVER enter sales/receivable/report aggregates (§1/§71 — tested).
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { computeCrmSummary } from "@/lib/crm";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");
  return ok(await computeCrmSummary(ctx.businessId));
});
