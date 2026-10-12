/**
 * Prompt 47 — POST /api/v1/sales-quotations/[id]/convert — ACCEPTED →
 * CONVERTED + exactly ONE CONFIRMED SalesOrder (§13).
 *
 * ONE atomic transaction: quotation reload + already-converted guard
 * FIRST (one stable conflict for every race loser, DB-unique backed §7),
 * status law, complete-line proof, canonical totals, snapshot validation,
 * order + lines copied from the FROZEN snapshots, quotation → CONVERTED,
 * two audit events, commit together. NO Sale invoice, NO Payment, NO
 * receivable, NO InventoryAdjustment, NO stock change (§13 invariants).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { convertSalesQuotationToOrder } from "@/lib/sales-quotations/service";
import { SALES_QUOTATION_ERROR_CODES } from "@/lib/sales-quotations/types";
import { isValidEntityId } from "@/lib/entity-routes";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, SALES_QUOTATION_ERROR_CODES.NOT_FOUND, "Sales quotation not found.");
  }
  const result = await convertSalesQuotationToOrder({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    timezone: ctx.business.timezone || "UTC",
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({
    quotationId: result.quotationId,
    quotationReference: result.quotationReference,
    salesOrder: {
      id: result.salesOrder.id,
      reference: result.salesOrder.reference,
      status: result.salesOrder.status,
      confirmedAt: result.salesOrder.confirmedAt?.toISOString() ?? null,
    },
  });
});
