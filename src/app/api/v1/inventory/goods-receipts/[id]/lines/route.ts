/**
 * Prompt 42 — POST /api/v1/inventory/goods-receipts/[id]/lines (data:write)
 *
 * §63 — the client submits ONLY purchaseOrderLineId + receivedQty; the
 * server derives product identity, snapshots and remaining quantity from
 * the tenant-scoped PO line (§36 — a submitted productId is rejected by
 * the strict schema). §64 — DRAFT-only; §65 — PO must STILL be CONFIRMED.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { isValidEntityId } from "@/lib/entity-routes";
import { addGoodsReceiptLine } from "@/lib/inventory/goods-receipt/service";
import { goodsReceiptLineCreateSchema } from "@/lib/inventory/goods-receipt/schema";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Goods receipt not found.");
  }

  const input = await parseBody(req, goodsReceiptLineCreateSchema);
  const row = await addGoodsReceiptLine({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    purchaseOrderLineId: input.purchaseOrderLineId,
    receivedQty: input.receivedQty,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(row, 201);
});
