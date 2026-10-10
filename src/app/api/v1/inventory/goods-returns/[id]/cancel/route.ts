/**
 * Prompt 43 — POST /api/v1/inventory/goods-returns/[id]/cancel (data:write)
 *
 * §9/§12 — only DRAFT returns can be cancelled; cancellation is terminal
 * and a pure document transition: NO stock mutation, NO adjustment, NO
 * financial anything.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { isValidEntityId } from "@/lib/entity-routes";
import { cancelGoodsReturn } from "@/lib/inventory/goods-return/service";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Goods return not found.");
  }

  const row = await cancelGoodsReturn({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(row);
});
