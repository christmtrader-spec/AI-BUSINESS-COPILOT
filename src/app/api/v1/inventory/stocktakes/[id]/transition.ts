/**
 * Prompt 40 — transition route factory (§8/§9).
 *
 * Every lifecycle transition is a DEDICATED server-authoritative endpoint —
 * there is NO generic PATCH for status (§52). Invalid transitions fail with
 * 422 INVALID_STOCKTAKE_TRANSITION. FINALIZED/CANCELLED are terminal (§50/§51).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import {
  cancelStocktake,
  finalizeStocktake,
  reopenStocktake,
  reviewStocktake,
  startStocktake,
} from "@/lib/inventory/stocktake/service";
import { isValidEntityId } from "@/lib/entity-routes";

type TransitionOp = "start" | "reopen" | "review" | "finalize" | "cancel";

const OPS: Record<
  TransitionOp,
  (input: {
    businessId: string;
    userId: string;
    stocktakeId: string;
    ip?: string | null;
    userAgent?: string | null;
  }) => Promise<unknown>
> = {
  start: startStocktake,
  reopen: reopenStocktake,
  review: reviewStocktake,
  finalize: finalizeStocktake,
  cancel: cancelStocktake,
};

export function transitionRoute(op: TransitionOp) {
  return route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const ctx = await getAuthContext(req);
    requirePermission(ctx, "data:write"); // §53 — every transition is a mutation

    // A malformed id can never exist as a stocktake — resolve to 404 (no leak).
    if (!isValidEntityId(id)) {
      throw new ApiError(404, "NOT_FOUND", "Stocktake not found.");
    }

    const row = await OPS[op]({
      businessId: ctx.businessId, // §54 — tenant from auth context only
      userId: ctx.userId,
      stocktakeId: id,
      ip: req.headers.get("x-forwarded-for"),
      userAgent: req.headers.get("user-agent"),
    });
    return ok(row);
  });
}
