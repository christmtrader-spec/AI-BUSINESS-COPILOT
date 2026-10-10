/**
 * Prompt 43 — GET   /api/v1/inventory/goods-returns/[id] — detail (data:read)
 *             PATCH /api/v1/inventory/goods-returns/[id] — DRAFT-only edit (data:write)
 *
 * There is deliberately NO generic status mutation here (§9): post/cancel
 * go through their dedicated endpoints. businessId/status/snapshots/
 * creator/postedAt are structurally absent from the PATCH schema (§59).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { isValidEntityId } from "@/lib/entity-routes";
import { getGoodsReturn, updateGoodsReturn } from "@/lib/inventory/goods-return/service";
import { goodsReturnUpdateSchema } from "@/lib/inventory/goods-return/schema";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // A malformed id can never exist as a return — resolve to 404 (no leak).
  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Goods return not found.");
  }

  const detail = await getGoodsReturn({ businessId: ctx.businessId, id });
  return ok(detail);
});

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Goods return not found.");
  }

  const input = await parseBody(req, goodsReturnUpdateSchema);
  const row = await updateGoodsReturn({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    reference: input.reference,
    notes: input.notes,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(row);
});
