/**
 * GET /api/v1/reports/summary?days=7|30|90
 *
 * Phase 04 — deterministic report aggregates. Every figure is computed
 * by the SERVER from recorded transactions (Rule 05 / A11-A13): the AI
 * copilot and the UI only narrate these numbers, never invent them.
 * The computation lives in lib/reports.ts — shared with the copilot
 * grounding pipeline (single source of truth).
 *
 * Permission: data:read (all roles).
 * Billing (§35): when the plan carries ADVANCED_REPORTS, the response
 * additionally includes the deterministic `advanced` insights block;
 * the server OMITS it otherwise — UI hiding is never the enforcement (§26).
 * Existing basic reports remain available to EVERY plan (§35).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { hasEntitlement } from "@/lib/billing";
import { buildAdvancedInsights } from "@/lib/reports-advanced";
import { buildReportSummary, normalizeReportDays } from "@/lib/reports";
import { ReportRangeError, resolveCustomRange } from "@/lib/report-periods";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  const url = new URL(req.url);
  const days = normalizeReportDays(url.searchParams.get("days"));

  // Prompt 52 §F4 — optional explicit local-day window (from/to YYYY-MM-DD,
  // inclusive; used by the Jalali calendar presets). Both bounds must arrive
  // together; validation errors map to 422 INVALID_REPORT_RANGE exactly like
  // the performance route.
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  let custom: { from: string; to: string } | undefined;
  if (fromRaw !== null || toRaw !== null) {
    if (fromRaw === null || toRaw === null) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "from and to must be provided together.",
        { field: fromRaw === null ? "from" : "to" },
      );
    }
    custom = { from: fromRaw, to: toRaw };
  }

  // Validate the custom window up-front so range errors surface as a clean
  // 422 BEFORE the (potentially heavy) aggregation runs.
  if (custom) {
    try {
      resolveCustomRange(ctx.business.timezone || "UTC", custom.from, custom.to, new Date());
    } catch (error) {
      if (error instanceof ReportRangeError) {
        throw new ApiError(422, "INVALID_REPORT_RANGE", error.message, { field: error.field });
      }
      throw error;
    }
  }

  const summary = await buildReportSummary(ctx.businessId, days, custom);

  // Billing gate (§35/§26): the advanced block exists in the payload ONLY
  // when the plan entitles it — fresh server-side check (§111).
  const advancedEntitled = await hasEntitlement(ctx.businessId, "ADVANCED_REPORTS");
  if (!advancedEntitled) {
    return ok({ ...summary, advancedAvailable: false });
  }
  const advanced = await buildAdvancedInsights(ctx.businessId, days, custom);
  return ok({ ...summary, advancedAvailable: true, advanced });
});
