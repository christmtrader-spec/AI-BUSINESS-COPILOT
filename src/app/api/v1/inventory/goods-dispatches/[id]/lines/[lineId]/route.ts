/**
 * Prompt 44 — PATCH/DELETE /api/v1/inventory/goods-dispatches/[id]/lines/[lineId]
 *
 * PATCH  — DRAFT-only qty/reasonCode update (no product reassignment, no
 *          snapshot mutation). DELETE — DRAFT-only line removal.
 */
import { NextRequest } from "next/server";
import { ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import {
  removeGoodsDispatchLine,
  updateGoodsDispatchLine,
} from "@/lib/inventory/goods-dispatch/service";
import { goodsDispatchLineUpdateSchema } from "@/lib/inventory/goods-dispatch/schema";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string; lineId: string }> };

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id, lineId } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const input = await parseBody(req, goodsDispatchLineUpdateSchema);
  const row = await updateGoodsDispatchLine({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    lineId,
    qty: input.qty,
    reasonCode: input.reasonCode,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(row);
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id, lineId } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const row = await removeGoodsDispatchLine({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    lineId,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(row);
});
