/**
 * Prompt 41 — POST /api/v1/purchase-orders/[id]/lines (data:write, §34/§58).
 * DRAFT-only. The server owns snapshots, tenant scope and totals — the
 * client submits ONLY productId + orderedQty + unitPriceMinor (§85/§146).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { isValidEntityId } from "@/lib/entity-routes";
import { addPurchaseOrderLine } from "@/lib/purchase-orders/service";
import { purchaseOrderLineCreateSchema } from "@/lib/purchase-orders/schema";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Purchase order not found.");
  }

  const input = await parseBody(req, purchaseOrderLineCreateSchema);
  const line = await addPurchaseOrderLine({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    productId: input.productId,
    orderedQty: input.orderedQty,
    unitPriceMinor: input.unitPriceMinor,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(line, 201);
});
