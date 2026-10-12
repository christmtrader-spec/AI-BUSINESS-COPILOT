/**
 * Prompt 47 — POST /api/v1/sales-quotations/[id]/mark-sent — DRAFT → SENT.
 *
 * §10/§2.7 — marking sent REQUIRES at least one line, freezes the terms,
 * and records an INTERNAL user's declaration that the offer was sent
 * OUTSIDE the application. The application does NOT deliver email and no
 * part of this endpoint claims it did. sentAt is SERVER-generated.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { markSalesQuotationSent } from "@/lib/sales-quotations/service";
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
  const row = await markSalesQuotationSent({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    timezone: ctx.business.timezone || "UTC",
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({
    id: row.id,
    reference: row.reference,
    status: row.status,
    sentAt: row.sentAt?.toISOString() ?? null,
  });
});
