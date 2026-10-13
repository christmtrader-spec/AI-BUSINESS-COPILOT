/**
 * Prompt 48 — GET   /api/v1/supplier-bills/[id] — bill detail (data:read).
 *             PATCH /api/v1/supplier-bills/[id] — DRAFT-only header patch
 *             (data:write, audited). supplierId/purchaseOrderId/reference/
 *             status/totals/expenseId are NEVER patchable (§10).
 *
 * GET reads the linked payable state from the LIVE Expense (§12/§18) —
 * never a copied mutable balance on the bill.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { getSupplierBill, updateSupplierBill, mapPureSupplierBillDomainError } from "@/lib/supplier-bills/service";
import { supplierBillUpdateSchema } from "@/lib/supplier-bills/schema";
import { isValidEntityId } from "@/lib/entity-routes";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // A malformed id can never exist — resolve to 404 before any read.
  if (!isValidEntityId(id)) {
    throw new ApiError(404, "SUPPLIER_BILL_NOT_FOUND", "Supplier bill not found.");
  }

  const bill = await getSupplierBill({ businessId: ctx.businessId, id });
  return ok(bill);
});

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "SUPPLIER_BILL_NOT_FOUND", "Supplier bill not found.");
  }

  const input = await parseBody(req, supplierBillUpdateSchema);
  try {
    const bill = await updateSupplierBill({
      businessId: ctx.businessId,
      userId: ctx.userId,
      id,
      supplierInvoiceReference: input.supplierInvoiceReference,
      billDate: input.billDate,
      dueDate: input.dueDate,
      discountMinor: input.discountMinor,
      internalNotes: input.internalNotes ?? undefined,
      ip: req.headers.get("x-forwarded-for"),
      userAgent: req.headers.get("user-agent"),
    });
    return ok(bill);
  } catch (error) {
    mapPureSupplierBillDomainError(error);
  }
});
