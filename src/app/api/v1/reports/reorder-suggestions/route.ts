/**
 * GET /api/v1/reports/reorder-suggestions — Prompt 55 (§X2).
 *
 * Low-stock top-up suggestions: for every ACTIVE, non-deleted product at
 * or below its low-stock threshold, the SERVER computes suggestedQty
 * (= threshold − stock, min 1) and the estimated top-up cost in integer
 * minor units. A decision aid only — nothing is ever created or adjusted.
 *
 * Permission: data:read (all roles) — a drill-down of the BASIC summary
 * low-stock signal (same entitlement stance as the inventory-valuation
 * drill-down, ADR 0051 §7 — no new entitlement).
 * Security: authentication + membership via getAuthContext()
 * (server-derived businessId — a client businessId is never accepted),
 * rate-limited, private no-store, bounded complete scan (over-cap →
 * controlled 413).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { ReorderReportTooLargeError, buildReorderSuggestions } from "@/lib/reorder";

export const dynamic = "force-dynamic";

const REORDER_RATE_LIMIT = 60;
const REORDER_RATE_WINDOW_MS = 60_000;

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  const rl = rateLimit(
    `report-reorder:${ctx.userId}:${ctx.businessId}`,
    REORDER_RATE_LIMIT,
    REORDER_RATE_WINDOW_MS,
  );
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many report requests. Please slow down.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  let report;
  try {
    report = await buildReorderSuggestions(ctx.businessId, {
      currencyCode: ctx.business.currencyCode,
      decimalPrecision: ctx.business.decimalPrecision ?? 2,
    });
  } catch (error) {
    if (error instanceof ReorderReportTooLargeError) {
      // A partial scan is NEVER served as complete (ADR 0051 §8 law).
      throw new ApiError(
        413,
        "REPORT_TOO_LARGE",
        "This business has more products than the reorder report can process completely.",
      );
    }
    throw error;
  }

  const response = ok(report);
  response.headers.set("Cache-Control", "private, no-store"); // confidential purchasing data
  return response;
});
