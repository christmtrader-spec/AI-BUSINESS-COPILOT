/**
 * Prompt 48 — GET  /api/v1/supplier-bills  (bounded list   — data:read)
 *             POST /api/v1/supplier-bills  (create draft   — data:write)
 *
 * Create derives tenant scope, the supplier/PO/currency snapshots and the
 * creator from the SERVER (never client input §5/§15). Creating a draft
 * bill NEVER mutates stock, finance, or creates a payable (§10).
 * The list is DB-paginated (pageSize ≤ 100), never findMany+slice; date
 * filters are canonical date-only calendar windows.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { createSupplierBill, listSupplierBills } from "@/lib/supplier-bills/service";
import { supplierBillCreateSchema, supplierBillListQuerySchema } from "@/lib/supplier-bills/schema";
import { mapPureSupplierBillDomainError } from "@/lib/supplier-bills/service";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const input = await parseBody(req, supplierBillCreateSchema);
  const row = await createSupplierBill({
    businessId: ctx.businessId, // server-derived tenant scope
    userId: ctx.userId,
    purchaseOrderId: input.purchaseOrderId,
    reference: input.reference, // undefined → server generation (SB-…)
    supplierInvoiceReference: input.supplierInvoiceReference ?? null,
    billDate: input.billDate,
    dueDate: input.dueDate,
    discountMinor: input.discountMinor,
    internalNotes: input.internalNotes ?? null,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({ id: row.id, reference: row.reference, status: row.status }, 201);
});

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  let parsed;
  try {
    parsed = supplierBillListQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  } catch {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid supplier bill list query.");
  }
  try {
    const result = await listSupplierBills({
      businessId: ctx.businessId,
      q: parsed.q,
      supplierId: parsed.supplierId,
      purchaseOrderId: parsed.purchaseOrderId,
      status: parsed.status,
      billDateFrom: parsed.billDateFrom,
      billDateTo: parsed.billDateTo,
      dueDateFrom: parsed.dueDateFrom,
      dueDateTo: parsed.dueDateTo,
      page: parsed.page ?? 1,
      pageSize: parsed.pageSize ?? 25,
    });
    return ok(result);
  } catch (error) {
    mapPureSupplierBillDomainError(error);
  }
});
