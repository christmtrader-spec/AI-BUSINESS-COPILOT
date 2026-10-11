/**
 * Prompt 45 — POST /api/v1/sales-orders/[id]/invoice — issue the ONE
 * order-linked Sale invoice (data:write).
 *
 * §53/§54/§57/§58/§59 — ONE atomic transaction: full-dispatch proof, the
 * existing Sale/SaleItem authority (existing numbering convention), the
 * SalesOrder → COMPLETED transition and BOTH audit events. The client
 * submits NOTHING: items and totals derive from the order contract. The
 * linked invoice NEVER decrements stock and NEVER creates an
 * InventoryAdjustment (§58 — the dispatches own the inventory movement).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { issueOrderInvoice } from "@/lib/sales-orders/service";
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
  const result = await issueOrderInvoice({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(result, 201);
});
