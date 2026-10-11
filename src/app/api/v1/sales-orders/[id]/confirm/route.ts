/**
 * Prompt 45 — POST /api/v1/sales-orders/[id]/confirm — DRAFT → CONFIRMED.
 *
 * §4/§28/§29/§30 — confirmation is a pure COMMERCIAL commitment: it
 * requires a complete, materially valid line set and commits ONLY the
 * lifecycle transition + audit. NO stock mutation, NO reservation, NO
 * Sale, NO Payment, NO receivable, NO statement/aging row.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { confirmSalesOrder } from "@/lib/sales-orders/service";
import { isValidEntityId } from "@/lib/entity-routes";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Sales order not found.");
  }
  const row = await confirmSalesOrder({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({
    id: row.id,
    reference: row.reference,
    status: row.status,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
  });
});
