/**
 * Prompt 44 — GET   /api/v1/inventory/goods-dispatches/[id] — detail (data:read)
 *             PATCH /api/v1/inventory/goods-dispatches/[id] — DRAFT-only edit (data:write)
 *
 * There is deliberately NO generic status mutation here: post/cancel go
 * through their dedicated endpoints. businessId/status/snapshots/creator/
 * postedAt are structurally absent from the PATCH schema.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { isValidEntityId } from "@/lib/entity-routes";
import { getGoodsDispatch, updateGoodsDispatch } from "@/lib/inventory/goods-dispatch/service";
import { goodsDispatchUpdateSchema } from "@/lib/inventory/goods-dispatch/schema";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // A malformed id can never exist as a dispatch — resolve to 404 (no leak).
  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Goods dispatch not found.");
  }

  const detail = await getGoodsDispatch({ businessId: ctx.businessId, id });
  return ok(detail);
});

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Goods dispatch not found.");
  }

  const input = await parseBody(req, goodsDispatchUpdateSchema);
  const row = await updateGoodsDispatch({
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
