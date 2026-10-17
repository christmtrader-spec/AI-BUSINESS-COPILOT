/**
 * GET /api/v1/reports/inventory-valuation — Prompt 51 (§5).
 *
 * Detailed breakdown of the operational inventory estimate the summary
 * already shows (summary.inventory.valueMinor = Σ stockQty × costPriceMinor
 * over every non-deleted product). Searchable, filtered, server-sorted,
 * paginated — every figure computed by the SERVER from Product rows
 * (Rule 05: the UI never invents numbers).
 *
 * BASIS (ADR 0051): a CURRENT OPERATIONAL ESTIMATE from two mutable
 * fields — explicitly not a historical or accounting asset valuation.
 *
 * Permission: data:read (all roles). This is a drill-down of the BASIC
 * summary KPI — the summary itself has no ADVANCED_REPORTS gate, so this
 * detail has none either (no new entitlement; ADR 0051 §7).
 * Security (§14 conventions): authentication + membership via
 * getAuthContext() (server-derived businessId — a client businessId is
 * never accepted), strict closed-vocabulary validation → 422, bounded
 * complete scan (over-cap → controlled 413), private no-store.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import {
  InventoryReportTooLargeError,
  buildInventoryValuationReport,
  parseInventoryFilters,
  parseInventoryPage,
} from "@/lib/inventory-valuation-report";
import { ReportRangeError } from "@/lib/report-periods";

export const dynamic = "force-dynamic";

const INVENTORY_RATE_LIMIT = 60;
const INVENTORY_RATE_WINDOW_MS = 60_000;

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  const rl = rateLimit(
    `report-inventory:${ctx.userId}:${ctx.businessId}`,
    INVENTORY_RATE_LIMIT,
    INVENTORY_RATE_WINDOW_MS,
  );
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many report requests. Please slow down.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const params = req.nextUrl.searchParams;
  let filters;
  let pageOpts;
  try {
    filters = parseInventoryFilters(params);
    pageOpts = parseInventoryPage(params);
  } catch (error) {
    if (error instanceof ReportRangeError) {
      throw new ApiError(422, "VALIDATION_ERROR", error.message, { field: error.field });
    }
    throw error;
  }

  let report;
  try {
    report = await buildInventoryValuationReport(
      ctx.businessId,
      filters,
      pageOpts.page,
      pageOpts.pageSize,
      {
        currencyCode: ctx.business.currencyCode,
        decimalPrecision: ctx.business.decimalPrecision ?? 2,
      },
    );
  } catch (error) {
    if (error instanceof InventoryReportTooLargeError) {
      // A partial total is NEVER served as complete (ADR 0051 §8).
      throw new ApiError(
        413,
        "REPORT_TOO_LARGE",
        "This business has more products than the valuation report can process completely.",
      );
    }
    throw error;
  }

  const response = ok(report);
  response.headers.set("Cache-Control", "private, no-store"); // confidential financial data
  return response;
});
