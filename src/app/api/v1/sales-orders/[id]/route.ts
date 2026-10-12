/**
 * Prompt 45 — GET   /api/v1/sales-orders/[id] — order detail (data:read)
 *             PATCH /api/v1/sales-orders/[id] — DRAFT-only header patch (data:write)
 *
 * Detail is a bounded, cap-proven read (§106) with the per-line fulfillment
 * aggregates (§36) and the linked invoice ONLY when the relation actually
 * exists (§65/§91). Header patches are DRAFT-only (§26/§27) — status,
 * currency snapshot, lifecycle timestamps and computed totals are never
 * client-authoritative (§112).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { getSalesOrder, updateSalesOrder } from "@/lib/sales-orders/service";
import { salesOrderUpdateSchema } from "@/lib/sales-orders/schema";
import { isValidEntityId } from "@/lib/entity-routes";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // A malformed id can never exist as an order — safe 404 (no leak).
  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Sales order not found.");
  }
  const detail = await getSalesOrder({ businessId: ctx.businessId, id });
  return ok(detail);
});

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Sales order not found.");
  }
  const input = await parseBody(req, salesOrderUpdateSchema);
  const row = await updateSalesOrder({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    customerId: input.customerId,
    reference: input.reference,
    orderDate: input.orderDate,
    expectedDate: input.expectedDate,
    discountMinor: input.discountMinor,
    notes: input.notes ?? null,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({ id: row.id, reference: row.reference, status: row.status });
});
