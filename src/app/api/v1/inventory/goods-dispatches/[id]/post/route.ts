/**
 * Prompt 44 — POST /api/v1/inventory/goods-dispatches/[id]/post (data:write)
 *
 * Posting runs ONE atomic transaction: stock decrements, negative
 * InventoryAdjustments, POSTED status, postedAt and the audit row all
 * commit together or not at all. postedAt is server-generated. At most
 * one successful transition; concurrent posts serialize on the shared
 * write transaction.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { isValidEntityId } from "@/lib/entity-routes";
import { postGoodsDispatch } from "@/lib/inventory/goods-dispatch/service";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Goods dispatch not found.");
  }

  const row = await postGoodsDispatch({
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
    totalDispatchedQty: row.totalDispatchedQty,
    stockChanges: row.stockChanges,
  });
});
