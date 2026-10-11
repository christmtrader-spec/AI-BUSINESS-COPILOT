/**
 * Prompt 45 — POST /api/v1/sales-orders/[id]/cancel — DRAFT/CONFIRMED → CANCELLED.
 *
 * §49/§99 — a CONFIRMED order can only be cancelled when NO posted linked
 * dispatch quantity exists AND no linked invoice exists (checked INSIDE
 * the shared write transaction). Stock that has left the business is
 * never reversed here (no automatic dispatch reversal, §49).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { cancelSalesOrder } from "@/lib/sales-orders/service";
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
  const row = await cancelSalesOrder({
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
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  });
});
