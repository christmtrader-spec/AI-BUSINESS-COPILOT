/**
 * Prompt 45 — POST /api/v1/sales-orders/[id]/dispatches — create a DRAFT
 * GoodsDispatch linked to the SalesOrder (data:write).
 *
 * §40 — the linked dispatch creation is ONE atomic transaction: order
 * re-validation (CONFIRMED + dispatchable remaining), the DRAFT document
 * with the customer context derived from the ORDER (§34) and its own
 * business-unique reference (§35), plus the transactional audit. NO stock
 * mutation, NO financial record (§40/§96).
 *
 * Line adds happen through the ESTABLISHED P44 dispatch line endpoint,
 * which recognizes order-linked dispatches (salesOrderLineId + qty only).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { createLinkedDispatch } from "@/lib/sales-orders/service";
import { salesOrderDispatchCreateSchema } from "@/lib/sales-orders/schema";
import { isValidEntityId } from "@/lib/entity-routes";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Sales order not found.");
  }
  const input = await parseBody(req, salesOrderDispatchCreateSchema);
  const row = await createLinkedDispatch({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    notes: input.notes ?? null,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({ id: row.id, reference: row.reference, status: row.status }, 201);
});
