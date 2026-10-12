/**
 * Prompt 45 — PATCH  /api/v1/sales-orders/[id]/lines/[lineId] — DRAFT-only
 *             DELETE /api/v1/sales-orders/[id]/lines/[lineId] — DRAFT-only
 *
 * Line updates may change orderedQty and/or the agreed unitPriceMinor —
 * never the product, never the historical snapshots (§27). All mutations
 * re-check the discount law against the canonical subtotal (§23).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { removeSalesOrderLine, updateSalesOrderLine } from "@/lib/sales-orders/service";
import { salesOrderLineUpdateSchema } from "@/lib/sales-orders/schema";
import { isValidEntityId } from "@/lib/entity-routes";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string; lineId: string }> };

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id, lineId } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Sales order not found.");
  }
  const input = await parseBody(req, salesOrderLineUpdateSchema);
  const row = await updateSalesOrderLine({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    lineId,
    orderedQty: input.orderedQty,
    unitPriceMinor: input.unitPriceMinor,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({ id: row.id });
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id, lineId } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Sales order not found.");
  }
  const row = await removeSalesOrderLine({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    lineId,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(row);
});
