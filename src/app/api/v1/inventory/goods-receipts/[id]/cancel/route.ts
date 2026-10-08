/**
 * Prompt 42 — POST /api/v1/inventory/goods-receipts/[id]/cancel (data:write)
 *
 * §75 — only DRAFT may cancel. Cancelling a draft is a pure document
 * transition: NO stock mutation, NO adjustment, NO financial write (§10).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { isValidEntityId } from "@/lib/entity-routes";
import { cancelGoodsReceipt } from "@/lib/inventory/goods-receipt/service";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Goods receipt not found.");
  }

  const row = await cancelGoodsReceipt({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(row);
});
