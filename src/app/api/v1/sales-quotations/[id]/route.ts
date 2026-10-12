/**
 * Prompt 47 — GET   /api/v1/sales-quotations/[id] — quotation detail (data:read)
 *             PATCH /api/v1/sales-quotations/[id] — DRAFT-only header patch (data:write)
 *
 * Detail is a bounded, cap-proven read (§11) exposing BOTH persistedStatus
 * and effectiveStatus (§9) and the converted-order link ONLY when the
 * relation actually exists (§7). Header patches are DRAFT-only (§8/§10) —
 * status, currency snapshot, lifecycle timestamps and computed totals are
 * never client-authoritative (§15). There is deliberately NO DELETE: a
 * quotation is business history (§14).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { getSalesQuotation, updateSalesQuotation } from "@/lib/sales-quotations/service";
import { salesQuotationUpdateSchema } from "@/lib/sales-quotations/schema";
import { SALES_QUOTATION_ERROR_CODES } from "@/lib/sales-quotations/types";
import { isValidEntityId } from "@/lib/entity-routes";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // A malformed id can never exist as a quotation — safe 404 (no leak).
  if (!isValidEntityId(id)) {
    throw new ApiError(404, SALES_QUOTATION_ERROR_CODES.NOT_FOUND, "Sales quotation not found.");
  }
  const detail = await getSalesQuotation({
    businessId: ctx.businessId,
    id,
    timezone: ctx.business.timezone || "UTC",
  });
  return ok(detail);
});

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, SALES_QUOTATION_ERROR_CODES.NOT_FOUND, "Sales quotation not found.");
  }
  const input = await parseBody(req, salesQuotationUpdateSchema);
  const row = await updateSalesQuotation({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    customerId: input.customerId,
    reference: input.reference,
    quotationDate: input.quotationDate,
    validUntilDate: input.validUntilDate,
    expectedDeliveryDate: input.expectedDeliveryDate,
    discountMinor: input.discountMinor,
    // 3-STATE pass-through (§10): undefined = field absent (unchanged),
    // null = explicit clear, string = replace. Coalescing to null here would
    // turn EVERY partial patch into a notes wipe.
    customerNotes: input.customerNotes,
    internalNotes: input.internalNotes,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({ id: row.id, reference: row.reference, status: row.status });
});
