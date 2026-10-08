/**
 * Prompt 42 — PATCH  /api/v1/inventory/goods-receipts/[id]/lines/[lineId] (data:write)
 *             DELETE /api/v1/inventory/goods-receipts/[id]/lines/[lineId] (data:write)
 *
 * §68 — PATCH accepts ONLY receivedQty (no product/PO-line reassignment,
 * no snapshot mutation). §69 — DELETE is DRAFT-only. Both are 409 on
 * POSTED/CANCELLED receipts (§8/§10 immutability).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { isValidEntityId } from "@/lib/entity-routes";
import {
  removeGoodsReceiptLine,
  updateGoodsReceiptLine,
} from "@/lib/inventory/goods-receipt/service";
import { goodsReceiptLineUpdateSchema } from "@/lib/inventory/goods-receipt/schema";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string; lineId: string }> };

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id, lineId } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id) || !isValidEntityId(lineId)) {
    throw new ApiError(404, "NOT_FOUND", "Goods receipt not found.");
  }

  const input = await parseBody(req, goodsReceiptLineUpdateSchema);
  const row = await updateGoodsReceiptLine({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    lineId,
    receivedQty: input.receivedQty,
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
    throw new ApiError(404, "NOT_FOUND", "Goods receipt not found.");
  }

  const row = await removeGoodsReceiptLine({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    lineId,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(row);
});
