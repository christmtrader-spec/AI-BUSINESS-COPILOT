/**
 * GET /api/v1/reports/performance — Prompt 50 (§11) advanced drill-down.
 *
 * Source-level detail behind the summary KPIs, grouped by CLOSED
 * dimensions only:
 *   kind=sales     groupBy=product|customer|day|month
 *   kind=expenses  groupBy=category|supplier|day|month
 *   kind=cashflow  row-level Payment page (keyset cursor)
 *
 * Range: strict custom business-local dates from/to (inclusive), max 366
 * local calendar days (§4). Timezone comes from the authenticated business
 * — a client timezone is never accepted (L3).
 *
 * Security (§14):
 *   - authentication + membership via getAuthContext() (server-derived
 *     businessId — no client-controlled scope, ever);
 *   - data:read permission;
 *   - ADVANCED_REPORTS entitlement enforced SERVER-SIDE (§11) — a plan
 *     without it gets the canonical billing 403, never the data;
 *   - strict parameter validation → 422; ReportRangeError mapping;
 *   - bounded queries (scan cap + group cap + keyset pagination);
 *   - private, no-store (confidential financial data).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { assertFeatureAccess } from "@/lib/billing";
import {
  buildCashFlowPage,
  buildExpensePerformance,
  buildSalesPerformance,
  isExpenseGroupBy,
  isSalesGroupBy,
  parsePerformanceLimit,
  parsePerformanceRange,
  ReportRangeError,
} from "@/lib/report-performance";

export const dynamic = "force-dynamic";

const PERFORMANCE_RATE_LIMIT = 30;
const PERFORMANCE_RATE_WINDOW_MS = 60_000;

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // §11 — server-side entitlement gate. UI hiding is never the enforcement.
  await assertFeatureAccess(ctx.businessId, "ADVANCED_REPORTS");

  const rl = rateLimit(
    `report-performance:${ctx.userId}:${ctx.businessId}`,
    PERFORMANCE_RATE_LIMIT,
    PERFORMANCE_RATE_WINDOW_MS,
  );
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many report requests. Please slow down.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  // §11.5 — strict query validation before any query executes.
  const params = req.nextUrl.searchParams;
  const kind = (params.get("kind") ?? "").trim();
  if (kind !== "sales" && kind !== "expenses" && kind !== "cashflow") {
    throw new ApiError(422, "VALIDATION_ERROR", "kind must be sales, expenses or cashflow.", {
      field: "kind",
    });
  }

  let window;
  try {
    window = parsePerformanceRange(
      ctx.business.timezone || "UTC",
      params.get("from"),
      params.get("to"),
      new Date(),
    );
  } catch (error) {
    if (error instanceof ReportRangeError) {
      throw new ApiError(422, "INVALID_REPORT_RANGE", error.message, { field: error.field });
    }
    throw error;
  }

  let limit;
  try {
    limit = parsePerformanceLimit(params.get("limit"));
  } catch (error) {
    if (error instanceof ReportRangeError) {
      throw new ApiError(422, "VALIDATION_ERROR", error.message, { field: error.field });
    }
    throw error;
  }

  const groupByRaw = (params.get("groupBy") ?? "").trim();

  if (kind === "sales") {
    if (!isSalesGroupBy(groupByRaw)) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "groupBy must be one of product, customer, day, month.",
        { field: "groupBy" },
      );
    }
    const report = await buildSalesPerformance(ctx.businessId, window, groupByRaw);
    const response = ok(report);
    response.headers.set("Cache-Control", "private, no-store"); // confidential financial data
    return response;
  }

  if (kind === "expenses") {
    if (!isExpenseGroupBy(groupByRaw)) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "groupBy must be one of category, supplier, day, month.",
        { field: "groupBy" },
      );
    }
    const report = await buildExpensePerformance(ctx.businessId, window, groupByRaw);
    const response = ok(report);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }

  // cashflow — optional direction filter + keyset cursor pagination.
  const directionRaw = (params.get("direction") ?? "").trim();
  if (directionRaw && directionRaw !== "IN" && directionRaw !== "OUT") {
    throw new ApiError(422, "VALIDATION_ERROR", "direction must be IN or OUT.", {
      field: "direction",
    });
  }
  const cursorRaw = params.get("cursor");
  const cursor = cursorRaw && cursorRaw.trim() !== "" ? cursorRaw.trim() : null;
  // Cursor decode/bind errors surface from the page build — mapped to the
  // canonical 422 exactly like the aging/statement routes (never a 500).
  let page;
  try {
    page = await buildCashFlowPage(
      ctx.businessId,
      window,
      directionRaw === "IN" ? "IN" : directionRaw === "OUT" ? "OUT" : null,
      limit,
      cursor,
    );
  } catch (error) {
    if (error instanceof ReportRangeError) {
      throw new ApiError(422, "VALIDATION_ERROR", error.message, { field: error.field });
    }
    throw error;
  }
  const response = ok(page);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
});
