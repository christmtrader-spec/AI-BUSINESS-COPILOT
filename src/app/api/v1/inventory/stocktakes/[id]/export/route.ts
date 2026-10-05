/**
 * Prompt 40 round 2 — GET /api/v1/inventory/stocktakes/[id]/export
 *
 * Stocktake detail as an accountant-friendly CSV (§76–§83 conventions).
 *
 * Security (§78): authentication + membership + data:read — identical to the
 * stocktake detail; on top: the CSV_EXPORT billing entitlement gate (§34/§80)
 * and the export rate limit (10 / 5 min / user).
 *
 * Coverage (§184): the CSV is built from the SAME line store as the detail
 * API (stocktakeLineDto — one source of truth) and covers ALL lines, never
 * one page (bounded by the stocktake line cap §61 — provably complete).
 *
 * Audit (§116/§121): the shared "data.export" record — reference + status +
 * line counts only; NO product names, NO internal ids in the audit body.
 */
import { NextRequest, NextResponse } from "next/server";
import { ApiError, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { assertFeatureAccess } from "@/lib/billing";
import { isValidEntityId } from "@/lib/entity-routes";
import { buildStocktakeCsv } from "@/lib/inventory/stocktake/export";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

const STOCKTAKE_EXPORT_RATE_LIMIT = 10;
const STOCKTAKE_EXPORT_RATE_WINDOW_MS = 5 * 60_000;

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // Billing gate (§34/§80) — same as every other CSV export in the product.
  await assertFeatureAccess(ctx.businessId, "CSV_EXPORT");

  const rl = rateLimit(
    `stocktake-export:${ctx.userId}`,
    STOCKTAKE_EXPORT_RATE_LIMIT,
    STOCKTAKE_EXPORT_RATE_WINDOW_MS,
  );
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many exports in a short time. Please wait a moment.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  // A malformed id can never exist as a stocktake — resolve to 404 (no leak).
  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Stocktake not found.");
  }

  const locale: "en" | "fa" = req.nextUrl.searchParams.get("locale") === "fa" ? "fa" : "en";

  const { csv, filename, reference, lineCount, truncated } = await buildStocktakeCsv({
    businessId: ctx.businessId,
    id,
    locale,
  });

  void audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "data.export",
    entityType: "StocktakeCSV",
    entityId: null, // §121 — business-facing reference lives in `after`, no internal ids
    after: { format: "csv", reference, lineCount, truncated },
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
});
