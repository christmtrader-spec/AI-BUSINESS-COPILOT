/**
 * Prompt 43 — POST /api/v1/inventory/goods-returns/[id]/lines (data:write)
 *
 * §57 — the client submits ONLY goodsReceiptLineId + returnedQty +
 * reasonCode. productId, snapshots, source receipt and returnable
 * quantity are SERVER-derived (§28/§30/§62). Line-add validation is
 * advisory — POST revalidates authoritatively (§62/§63).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { isValidEntityId } from "@/lib/entity-routes";
import { addGoodsReturnLine } from "@/lib/inventory/goods-return/service";
import { goodsReturnLineCreateSchema } from "@/lib/inventory/goods-return/schema";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write"); // §69

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Goods return not found.");
  }

  const input = await parseBody(req, goodsReturnLineCreateSchema);
  const row = await addGoodsReturnLine({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    goodsReceiptLineId: input.goodsReceiptLineId,
    returnedQty: input.returnedQty,
    reasonCode: input.reasonCode,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(row, 201);
});
