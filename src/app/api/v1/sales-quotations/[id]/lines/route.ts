/**
 * Prompt 47 — POST /api/v1/sales-quotations/[id]/lines — add a line (data:write)
 *
 * DRAFT-only (§8/§11). The product must be active and belong to the
 * quotation's business (§6); snapshots are copied server-side (§12); the
 * offered price defaults from the live Product and is then FROZEN (§12).
 * Duplicate products are a stable 409 (§6/§11).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { addSalesQuotationLine } from "@/lib/sales-quotations/service";
import { salesQuotationLineCreateSchema } from "@/lib/sales-quotations/schema";
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
  const input = await parseBody(req, salesQuotationLineCreateSchema);
  const row = await addSalesQuotationLine({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    productId: input.productId,
    qty: input.qty,
    unitPriceMinor: input.unitPriceMinor,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({ id: row.id }, 201);
});
