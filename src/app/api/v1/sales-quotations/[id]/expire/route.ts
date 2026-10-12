/**
 * Prompt 47 — POST /api/v1/sales-quotations/[id]/expire — SENT → EXPIRED.
 *
 * §9 — the EXPLICIT expire transition. Legal ONLY when the offer has
 * actually passed its validity date in the authenticated business
 * timezone (server clock; re-checked INSIDE the write transaction). A
 * valid offer can never be force-expired — the controlled 409 keeps the
 * law honest. Atomic and audited.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { expireSalesQuotation } from "@/lib/sales-quotations/service";
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
  const row = await expireSalesQuotation({
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
  });
});
