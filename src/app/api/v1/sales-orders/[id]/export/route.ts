/**
 * Prompt 45 — GET /api/v1/sales-orders/[id]/export — per-order CSV (§114/§115)
 *
 * Conventions reused verbatim from the established per-entity CSV exports:
 *  - CSV_EXPORT entitlement gate — no second entitlement;
 *  - export rate limit 10 / 5min / user;
 *  - locale=en|fa with an explicit 422 for any other value;
 *  - safe 404 for malformed/foreign ids BEFORE any data is read;
 *  - audit "data.export" with counts only;
 *  - Cache-Control: no-store; attachment Content-Disposition.
 */
import { NextRequest, NextResponse } from "next/server";
import { ApiError, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { assertFeatureAccess } from "@/lib/billing";
import { isValidEntityId } from "@/lib/entity-routes";
import { buildSalesOrderCsv } from "@/lib/sales-orders/export";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

const SALES_ORDER_EXPORT_RATE_LIMIT = 10;
const SALES_ORDER_EXPORT_RATE_WINDOW_MS = 5 * 60_000;

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // Billing gate — same as every other CSV export in the product.
  await assertFeatureAccess(ctx.businessId, "CSV_EXPORT");

  const rl = rateLimit(
    `sales-order-export:${ctx.userId}`,
    SALES_ORDER_EXPORT_RATE_LIMIT,
    SALES_ORDER_EXPORT_RATE_WINDOW_MS,
  );
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many exports in a short time. Please wait a moment.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  // A malformed id can never exist as an order — resolve to 404 (no leak).
  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Sales order not found.");
  }

  // Locale is strict: absent → en; "fa" → fa; anything else → 422.
  const localeParam = req.nextUrl.searchParams.get("locale");
  if (localeParam !== null && localeParam !== "en" && localeParam !== "fa") {
    throw new ApiError(422, "VALIDATION_ERROR", "Unsupported export locale.");
  }
  const locale: "en" | "fa" = localeParam === "fa" ? "fa" : "en";

  const { csv, filename, reference, lineCount, truncated } = await buildSalesOrderCsv({
    businessId: ctx.businessId,
    id,
    locale,
  });

  void audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "data.export",
    entityType: "SalesOrderCSV",
    entityId: null, // business-facing reference lives in `after`
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
