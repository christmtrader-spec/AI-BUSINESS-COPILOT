/**
 * Prompt 47 — GET /api/v1/sales-quotations/[id]/print — customer-facing
 * printable offer payload (data:read).
 *
 * §16 — an EXPLICITLY REDUCED projection served to the authorized print
 * view: snapshots, dates, prices, currency, discount, total,
 * customerNotes. Structurally ABSENT: internalNotes, database ids, audit
 * metadata, raw technical statuses. The route is tenant-authorized —
 * there is NO public/unauthenticated print URL and NO acceptance token
 * (§2.7/§16).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { getSalesQuotationPrintView } from "@/lib/sales-quotations/service";
import { SALES_QUOTATION_ERROR_CODES } from "@/lib/sales-quotations/types";
import { isValidEntityId } from "@/lib/entity-routes";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, SALES_QUOTATION_ERROR_CODES.NOT_FOUND, "Sales quotation not found.");
  }
  const print = await getSalesQuotationPrintView({
    businessId: ctx.businessId,
    id,
    timezone: ctx.business.timezone || "UTC",
  });
  return ok(print);
});
