/**
 * Prompt 48 — PATCH  /api/v1/supplier-bills/[id]/lines/[lineId] — edit a
 *                     draft line's qty/price (data:write, audited, DRAFT-only).
 *             DELETE /api/v1/supplier-bills/[id]/lines/[lineId] — remove a
 *                     draft line (data:write, audited, DRAFT-only).
 * The line's PO line NEVER changes (§6). Totals are recomputed server-side
 * after every mutation (§9).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import {
  removeSupplierBillLine,
  updateSupplierBillLine,
  mapPureSupplierBillDomainError,
} from "@/lib/supplier-bills/service";
import { supplierBillLineUpdateSchema } from "@/lib/supplier-bills/schema";
import { isValidEntityId } from "@/lib/entity-routes";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string; lineId: string }> };

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id, lineId } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id) || !isValidEntityId(lineId)) {
    throw new ApiError(404, "SUPPLIER_BILL_NOT_FOUND", "Supplier bill not found.");
  }

  const input = await parseBody(req, supplierBillLineUpdateSchema);
  try {
    const bill = await updateSupplierBillLine({
      businessId: ctx.businessId,
      userId: ctx.userId,
      id,
      lineId,
      billedQty: input.billedQty,
      unitPriceMinor: input.unitPriceMinor,
      ip: req.headers.get("x-forwarded-for"),
      userAgent: req.headers.get("user-agent"),
    });
    return ok(bill);
  } catch (error) {
    mapPureSupplierBillDomainError(error);
  }
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id, lineId } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id) || !isValidEntityId(lineId)) {
    throw new ApiError(404, "SUPPLIER_BILL_NOT_FOUND", "Supplier bill not found.");
  }

  try {
    const bill = await removeSupplierBillLine({
      businessId: ctx.businessId,
      userId: ctx.userId,
      id,
      lineId,
      ip: req.headers.get("x-forwarded-for"),
      userAgent: req.headers.get("user-agent"),
    });
    return ok(bill);
  } catch (error) {
    mapPureSupplierBillDomainError(error);
  }
});
