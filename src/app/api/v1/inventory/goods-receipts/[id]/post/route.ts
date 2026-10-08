/**
 * Prompt 42 — POST /api/v1/inventory/goods-receipts/[id]/post (data:write)
 *
 * §39/§72 — posting runs ONE atomic transaction: stock updates, positive
 * InventoryAdjustments, POSTED status, postedAt and the audit row all
 * commit together or not at all (§40). §74 — postedAt is server-generated.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { isValidEntityId } from "@/lib/entity-routes";
import { postGoodsReceipt } from "@/lib/inventory/goods-receipt/service";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Goods receipt not found.");
  }

  const row = await postGoodsReceipt({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({
    id: row.id,
    reference: row.reference,
    status: row.status,
    postedAt: row.postedAt,
    lineCount: row.lineCount,
    totalReceivedQty: row.totalReceivedQty,
  });
});
