/**
 * Prompt 47 — POST /api/v1/sales-quotations/[id]/accept — SENT → ACCEPTED.
 *
 * §8/§9/§2.7 — allowed only while the offer is still WITHIN its validity
 * period in the authenticated business timezone (server clock; the check
 * re-runs INSIDE the write transaction). Records an authorized internal
 * user's declaration of customer acceptance — NOT a verified portal
 * signature. NO SalesOrder is created until the explicit conversion.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { acceptSalesQuotation } from "@/lib/sales-quotations/service";
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
  const row = await acceptSalesQuotation({
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
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
  });
});
