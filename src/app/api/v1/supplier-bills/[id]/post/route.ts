/**
 * Prompt 48 — POST /api/v1/supplier-bills/[id]/post — THE atomic posting
 * transaction (data:write, strict-audited).
 *
 * Posting creates EXACTLY ONE linked Expense payable inside the SAME
 * transaction (§11) and mutates NOTHING else — no stock, no adjustment, no
 * receipt/return, no PO quantity, no payment, no sale (§11 immutable list).
 * The link to payments/statements/aging goes through the Expense only (§2).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { postSupplierBill, mapPureSupplierBillDomainError } from "@/lib/supplier-bills/service";
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
    const result = await postSupplierBill({
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
