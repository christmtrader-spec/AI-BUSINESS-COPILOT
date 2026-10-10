/**
 * Prompt 44 — POST /api/v1/inventory/goods-dispatches/[id]/cancel (data:write)
 *
 * Cancelling a DRAFT is a pure document transition: NO stock mutation,
 * NO adjustment, NO financial anything. POSTED is immutable; CANCELLED
 * is terminal.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { isValidEntityId } from "@/lib/entity-routes";
import { cancelGoodsDispatch } from "@/lib/inventory/goods-dispatch/service";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Goods dispatch not found.");
  }

  const row = await cancelGoodsDispatch({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(row);
});
