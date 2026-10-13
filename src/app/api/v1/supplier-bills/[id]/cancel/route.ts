/**
 * Prompt 48 — POST /api/v1/supplier-bills/[id]/cancel — DRAFT-only cancel
 * (data:write, audited). A pure document transition: NO expense, NO
 * payment, NO statement movement, NO inventory anything (§10). POSTED is
 * immutable in this phase — cancellation is rejected (INVALID_TRANSITION).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { cancelSupplierBill, mapPureSupplierBillDomainError } from "@/lib/supplier-bills/service";
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

  try {
    const result = await cancelSupplierBill({
      businessId: ctx.businessId,
      userId: ctx.userId,
      id,
      ip: req.headers.get("x-forwarded-for"),
      userAgent: req.headers.get("user-agent"),
    });
    return ok(result);
  } catch (error) {
    mapPureSupplierBillDomainError(error);
  }
});
