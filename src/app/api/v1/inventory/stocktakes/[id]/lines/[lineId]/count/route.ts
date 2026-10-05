/**
 * Prompt 40 — /api/v1/inventory/stocktakes/[id]/lines/[lineId]/count
 *
 * POST §30 — record a physical count. Server transaction:
 * load stocktake → verify status (COUNTING|REVIEW, §31 — supports recount)
 * → verify line → verify product tenant/active → read CURRENT stockQty
 * (§15 — snapshot; client NEVER supplies it) → validate countedQty (§17,
 * schema) → derive variance (§16/§18) → snapshot product metadata (§19)
 * → record counter + countedAt. Recount replaces the line in place and
 * audits inventory.stocktake.recount with safe before/after metadata (§32/§33).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { countStocktakeLine } from "@/lib/inventory/stocktake/service";
import { stocktakeCountSchema } from "@/lib/inventory/stocktake/schema";
import { isValidEntityId } from "@/lib/entity-routes";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string; lineId: string }> };

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id, lineId } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write"); // §53

  if (!isValidEntityId(id) || !isValidEntityId(lineId)) {
    throw new ApiError(404, "NOT_FOUND", "Stocktake line not found.");
  }

  const input = await parseBody(req, stocktakeCountSchema); // §17 — int 0..1e9
  const row = await countStocktakeLine({
    businessId: ctx.businessId,
    userId: ctx.userId,
    stocktakeId: id,
    lineId,
    countedQty: input.countedQty,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(row);
});
