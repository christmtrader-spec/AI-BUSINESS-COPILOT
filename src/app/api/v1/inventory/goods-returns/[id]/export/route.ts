/**
 * Prompt 43 — GET /api/v1/inventory/goods-returns/[id]/export — per-return CSV (§103).
 *
 * Conventions reused verbatim from the established per-entity CSV exports:
 *  - CSV_EXPORT entitlement gate (§108) — no second entitlement;
 *  - export rate limit 10 / 5min / user (§109);
 *  - locale=en|fa with an explicit 422 for any other value (§103);
 *  - safe 404 for malformed/foreign ids BEFORE any data is read (§110);
 *  - audit "data.export" with counts only (§111);
 *  - Cache-Control: no-store (§106); attachment Content-Disposition.
 */
import { NextRequest, NextResponse } from "next/server";
import { ApiError, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { assertFeatureAccess } from "@/lib/billing";
import { isValidEntityId } from "@/lib/entity-routes";
import { buildGoodsReturnCsv } from "@/lib/inventory/goods-return/export";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

const GOODS_RETURN_EXPORT_RATE_LIMIT = 10;
const GOODS_RETURN_EXPORT_RATE_WINDOW_MS = 5 * 60_000;

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // Billing gate (§108) — same as every other CSV export in the product.
  await assertFeatureAccess(ctx.businessId, "CSV_EXPORT");

  const rl = rateLimit(
    `goods-return-export:${ctx.userId}`,
    GOODS_RETURN_EXPORT_RATE_LIMIT,
    GOODS_RETURN_EXPORT_RATE_WINDOW_MS,
  );
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many exports in a short time. Please wait a moment.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  // A malformed id can never exist as a return — resolve to 404 (no leak).
  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Goods return not found.");
  }

  // §103 — locale is strict: absent → en; "fa" → fa; anything else → 422.
  const localeParam = req.nextUrl.searchParams.get("locale");
  if (localeParam !== null && localeParam !== "en" && localeParam !== "fa") {
    throw new ApiError(422, "VALIDATION_ERROR", "Unsupported export locale.");
  }
  const locale: "en" | "fa" = localeParam === "fa" ? "fa" : "en";

  const { csv, filename, reference, lineCount, truncated } = await buildGoodsReturnCsv({
    businessId: ctx.businessId,
    id,
    locale,
  });

  void audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "data.export",
    entityType: "GoodsReturnCSV",
    entityId: null, // §111 — business-facing reference lives in `after`
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
