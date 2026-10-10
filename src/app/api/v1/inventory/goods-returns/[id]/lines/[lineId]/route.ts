/**
 * Prompt 43 — PATCH  /api/v1/inventory/goods-returns/[id]/lines/[lineId] (data:write)
 *             DELETE /api/v1/inventory/goods-returns/[id]/lines/[lineId] (data:write)
 *
 * §58 — PATCH allows ONLY returnedQty + reasonCode on a DRAFT return (no
 * source-line/product/snapshot mutation ever). §60 — DELETE is DRAFT-only.
 * Both re-derive every authority server-side.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { isValidEntityId } from "@/lib/entity-routes";
import { removeGoodsReturnLine, updateGoodsReturnLine } from "@/lib/inventory/goods-return/service";
import { goodsReturnLineUpdateSchema } from "@/lib/inventory/goods-return/schema";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string; lineId: string }> };

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id, lineId } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id) || !isValidEntityId(lineId)) {
    throw new ApiError(404, "NOT_FOUND", "Return line not found.");
  }

  const input = await parseBody(req, goodsReturnLineUpdateSchema);
  const row = await updateGoodsReturnLine({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    lineId,
    returnedQty: input.returnedQty,
    reasonCode: input.reasonCode,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(row);
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id, lineId } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id) || !isValidEntityId(lineId)) {
    throw new ApiError(404, "NOT_FOUND", "Return line not found.");
  }

  const row = await removeGoodsReturnLine({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    lineId,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(row);
});
