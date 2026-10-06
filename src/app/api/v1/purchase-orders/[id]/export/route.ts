/**
 * Prompt 41 — GET /api/v1/purchase-orders/[id]/export — per-order CSV (§97).
 *
 * Conventions reused verbatim from the established per-entity CSV exports:
 *  - CSV_EXPORT entitlement gate (§98/§162) — no second entitlement;
 *  - export rate limit 10 / 5min / user (§100/§161);
 *  - locale=en|fa with an explicit 422 for any other value (§100/§240);
 *  - safe 404 for malformed/foreign ids BEFORE any data is read (§101/§245);
 *  - audit "data.export" with counts only — no supplier names, no totals,
 *    no internal ids in the audit body (§159);
 *  - Cache-Control: no-store (§160); attachment Content-Disposition.
 *
 * Read-only law (§199): exporting never mutates the order — no updatedAt
 * change, no lifecycle write; the audit row is the only write.
 */
import { NextRequest, NextResponse } from "next/server";
import { ApiError, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { assertFeatureAccess } from "@/lib/billing";
import { isValidEntityId } from "@/lib/entity-routes";
import { buildPurchaseOrderCsv } from "@/lib/purchase-orders/export";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

const PURCHASE_ORDER_EXPORT_RATE_LIMIT = 10;
const PURCHASE_ORDER_EXPORT_RATE_WINDOW_MS = 5 * 60_000;

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // Billing gate (§98/§162) — same as every other CSV export in the product.
  await assertFeatureAccess(ctx.businessId, "CSV_EXPORT");

  const rl = rateLimit(
    `purchase-order-export:${ctx.userId}`,
    PURCHASE_ORDER_EXPORT_RATE_LIMIT,
    PURCHASE_ORDER_EXPORT_RATE_WINDOW_MS,
  );
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many exports in a short time. Please wait a moment.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  // A malformed id can never exist as an order — resolve to 404 (no leak).
  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Purchase order not found.");
  }

  // §100/§240 — locale is strict: absent → en; "fa" → fa; anything else → 422.
  const localeParam = req.nextUrl.searchParams.get("locale");
  if (localeParam !== null && localeParam !== "en" && localeParam !== "fa") {
    throw new ApiError(422, "VALIDATION_ERROR", "Unsupported export locale.");
  }
  const locale: "en" | "fa" = localeParam === "fa" ? "fa" : "en";

  const { csv, filename, reference, lineCount, truncated } = await buildPurchaseOrderCsv({
    businessId: ctx.businessId,
    id,
    locale,
  });

  void audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "data.export",
    entityType: "PurchaseOrderCSV",
    entityId: null, // §159 — business-facing reference lives in `after`
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
