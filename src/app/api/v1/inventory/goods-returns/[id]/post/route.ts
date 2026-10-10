/**
 * Prompt 43 — POST /api/v1/inventory/goods-returns/[id]/post (data:write)
 *
 * §43/§48 — posting runs ONE atomic transaction: stock decrements,
 * negative InventoryAdjustments, POSTED status, postedAt and the audit row
 * all commit together or not at all (§52). §74-analog — postedAt is
 * server-generated. §53 — at most one successful transition; concurrent
 * posts serialize on the shared write transaction.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { isValidEntityId } from "@/lib/entity-routes";
import { postGoodsReturn } from "@/lib/inventory/goods-return/service";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Goods return not found.");
  }

  const row = await postGoodsReturn({
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
    totalReturnedQty: row.totalReturnedQty,
    stockChanges: row.stockChanges,
  });
});
