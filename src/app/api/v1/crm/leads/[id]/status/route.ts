/**
 * POST /api/v1/crm/leads/[id]/status — dedicated status transition (§22).
 *
 * The generic PATCH NEVER changes status (§21). Closed transition map
 * (constants.LEAD_TRANSITIONS) → invalid transitions get 422
 * INVALID_STATUS_TRANSITION. CONVERTED here is reserved for the conversion
 * endpoint flow, but a direct CONVERTED transition through this endpoint
 * is intentionally NOT allowed for a plain status change (a bare status
 * change cannot set customerId/convertedAt correctly) — conversion must go
 * through /convert (§23).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { changeLeadStatus, getLeadDetail, isLeadStatus, leadStatusSchema } from "@/lib/crm";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");
  const { status } = await parseBody(req, leadStatusSchema);
  if (!isLeadStatus(status)) {
    throw new ApiError(422, "VALIDATION_ERROR", "Unknown lead status.", {
      field: "status",
    });
  }
  if (status === "CONVERTED") {
    // §23 — conversion is the dedicated atomic path (creates/links the
    // customer + timestamps); a bare status flip would corrupt invariants.
    throw new ApiError(
      422,
      "INVALID_STATUS_TRANSITION",
      "Use the conversion flow to convert a lead.",
      { to: "CONVERTED" },
    );
  }
  await changeLeadStatus(ctx.businessId, ctx.userId, id, status, {
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(await getLeadDetail(ctx.businessId, id));
});
