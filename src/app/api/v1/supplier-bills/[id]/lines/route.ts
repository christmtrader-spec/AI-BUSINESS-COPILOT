/**
 * Prompt 48 — POST /api/v1/supplier-bills/[id]/lines — add a draft line
 * (data:write, audited, DRAFT-only §10). The PO line is the procurement
 * product authority (§6); each PO line may appear at most once per bill;
 * billed quantities get the ADVISORY three-way availability check (§7 —
 * the posting transaction is the final authority).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { addSupplierBillLine, mapPureSupplierBillDomainError } from "@/lib/supplier-bills/service";
import { supplierBillLineAddSchema } from "@/lib/supplier-bills/schema";
import { isValidEntityId } from "@/lib/entity-routes";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "SUPPLIER_BILL_NOT_FOUND", "Supplier bill not found.");
  }

  const input = await parseBody(req, supplierBillLineAddSchema);
  try {
    const bill = await addSupplierBillLine({
      businessId: ctx.businessId,
      userId: ctx.userId,
      id,
      purchaseOrderLineId: input.purchaseOrderLineId,
      billedQty: input.billedQty,
      unitPriceMinor: input.unitPriceMinor,
      ip: req.headers.get("x-forwarded-for"),
      userAgent: req.headers.get("user-agent"),
    });
    return ok(bill, 201);
  } catch (error) {
    mapPureSupplierBillDomainError(error);
  }
});
