/**
 * Prompt 47 — PATCH  /api/v1/sales-quotations/[id]/lines/[lineId] — DRAFT-only
 *             DELETE /api/v1/sales-quotations/[id]/lines/[lineId] — DRAFT-only
 *
 * Line updates may change qty and/or the offered unitPriceMinor — never
 * the product, never the historical snapshots (§12). All mutations
 * re-check the discount law against the canonical subtotal (§11).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { removeSalesQuotationLine, updateSalesQuotationLine } from "@/lib/sales-quotations/service";
import { salesQuotationLineUpdateSchema } from "@/lib/sales-quotations/schema";
import { SALES_QUOTATION_ERROR_CODES } from "@/lib/sales-quotations/types";
import { isValidEntityId } from "@/lib/entity-routes";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string; lineId: string }> };

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id, lineId } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, SALES_QUOTATION_ERROR_CODES.NOT_FOUND, "Sales quotation not found.");
  }
  const input = await parseBody(req, salesQuotationLineUpdateSchema);
  const row = await updateSalesQuotationLine({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    lineId,
    qty: input.qty,
    unitPriceMinor: input.unitPriceMinor,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({ id: row.id });
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id, lineId } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, SALES_QUOTATION_ERROR_CODES.NOT_FOUND, "Sales quotation not found.");
  }
  const row = await removeSalesQuotationLine({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    lineId,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(row);
});
