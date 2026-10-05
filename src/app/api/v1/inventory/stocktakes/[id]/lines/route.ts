/**
 * Prompt 40 — /api/v1/inventory/stocktakes/[id]/lines
 *
 * POST §27 — add a product to a DRAFT stocktake. The client supplies ONLY
 * productId (§16); eligibility is server-verified (§20/§21/§56/§57): same
 * business, not deleted, active. Duplicate product → 409
 * DUPLICATE_STOCKTAKE_PRODUCT (§28; DB unique constraint is the final
 * protection §48). Line cap enforced (§61) → 422 STOCKTAKE_LINE_LIMIT_REACHED.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { addStocktakeLine } from "@/lib/inventory/stocktake/service";
import { stocktakeAddLineSchema } from "@/lib/inventory/stocktake/schema";
import { isValidEntityId } from "@/lib/entity-routes";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write"); // §53

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Stocktake not found.");
  }

  const input = await parseBody(req, stocktakeAddLineSchema);
  const row = await addStocktakeLine({
    businessId: ctx.businessId,
    userId: ctx.userId,
    stocktakeId: id,
    productId: input.productId,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(row, 201);
});
