/**
 * Prompt 41 — GET   /api/v1/purchase-orders/[id] — detail + all lines (data:read)
 *             PATCH /api/v1/purchase-orders/[id] — DRAFT-only header edit (data:write)
 *
 * There is deliberately NO generic status mutation here (§42): lifecycle
 * changes go through the dedicated send/confirm/close/cancel endpoints.
 * businessId/supplierId/status/currency snapshot/creator/lifecycle
 * timestamps are structurally absent from the PATCH schema (§43).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { isValidEntityId } from "@/lib/entity-routes";
import { getPurchaseOrder, updatePurchaseOrder } from "@/lib/purchase-orders/service";
import { purchaseOrderUpdateSchema } from "@/lib/purchase-orders/schema";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // A malformed id can never exist as an order — resolve to 404 (no leak §48).
  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Purchase order not found.");
  }

  const detail = await getPurchaseOrder({ businessId: ctx.businessId, id });
  return ok(detail);
});

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Purchase order not found.");
  }

  const input = await parseBody(req, purchaseOrderUpdateSchema);
  const row = await updatePurchaseOrder({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    reference: input.reference,
    orderedAt: input.orderedAt,
    expectedDate: input.expectedDate,
    notes: input.notes,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(row);
});
