/**
 * Prompt 41 — PATCH  /api/v1/purchase-orders/[id]/lines/[lineId] (data:write, §35)
 *             DELETE /api/v1/purchase-orders/[id]/lines/[lineId] (data:write, §36)
 *
 * Both are DRAFT-only. The line's product identity and snapshots are
 * immutable (§35/§166) — the client submits ONLY orderedQty/unitPriceMinor.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { isValidEntityId } from "@/lib/entity-routes";
import {
  removePurchaseOrderLine,
  updatePurchaseOrderLine,
} from "@/lib/purchase-orders/service";
import { purchaseOrderLineUpdateSchema } from "@/lib/purchase-orders/schema";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string; lineId: string }> };

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id, lineId } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id) || !isValidEntityId(lineId)) {
    throw new ApiError(404, "NOT_FOUND", "Purchase order line not found.");
  }

  const input = await parseBody(req, purchaseOrderLineUpdateSchema);
  const line = await updatePurchaseOrderLine({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    lineId,
    orderedQty: input.orderedQty,
    unitPriceMinor: input.unitPriceMinor,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(line);
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id, lineId } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id) || !isValidEntityId(lineId)) {
    throw new ApiError(404, "NOT_FOUND", "Purchase order line not found.");
  }

  const result = await removePurchaseOrderLine({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    lineId,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(result);
});
