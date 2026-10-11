/**
 * Prompt 45 — POST /api/v1/sales-orders/[id]/lines — add an order line
 * (data:write, DRAFT-only §26/§27).
 *
 * The product is resolved SERVER-side from the tenant-scoped active rows
 * (§20); snapshots freeze at add time; the price defaults from
 * Product.salePriceMinor and persists as the AGREED order price (§21).
 * No stock, no reservation, no financial mutation (§4/§29/§30).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { addSalesOrderLine } from "@/lib/sales-orders/service";
import { salesOrderLineCreateSchema } from "@/lib/sales-orders/schema";
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
  const input = await parseBody(req, salesOrderLineCreateSchema);
  const row = await addSalesOrderLine({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    productId: input.productId,
    orderedQty: input.orderedQty,
    unitPriceMinor: input.unitPriceMinor,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({ id: row.id }, 201);
});
