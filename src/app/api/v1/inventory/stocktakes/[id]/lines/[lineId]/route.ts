/**
 * Prompt 40 — /api/v1/inventory/stocktakes/[id]/lines/[lineId]
 *
 * DELETE §29 — remove a line. DRAFT-only (lines are preparation data until
 * counting begins). No soft delete for lines; after COUNTING no removal.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { removeStocktakeLine } from "@/lib/inventory/stocktake/service";
import { isValidEntityId } from "@/lib/entity-routes";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string; lineId: string }> };

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id, lineId } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write"); // §53

  if (!isValidEntityId(id) || !isValidEntityId(lineId)) {
    throw new ApiError(404, "NOT_FOUND", "Stocktake line not found.");
  }

  const row = await removeStocktakeLine({
    businessId: ctx.businessId,
    userId: ctx.userId,
    stocktakeId: id,
    lineId,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(row);
});
