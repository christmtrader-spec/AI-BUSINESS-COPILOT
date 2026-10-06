/**
 * Prompt 41 — dedicated lifecycle transition factory (§15/§42/§215).
 * One thin route per transition; NO generic status PATCH exists anywhere.
 * The service re-checks the current status inside the transaction (§61).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { isValidEntityId } from "@/lib/entity-routes";
import { transitionPurchaseOrder } from "@/lib/purchase-orders/service";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export function transitionRoute(op: "send" | "confirm" | "close" | "cancel") {
  return route(async (req: NextRequest, { params }: RouteParams) => {
    const { id } = await params;
    const ctx = await getAuthContext(req);
    requirePermission(ctx, "data:write");

    if (!isValidEntityId(id)) {
      throw new ApiError(404, "NOT_FOUND", "Purchase order not found.");
    }

    const row = await transitionPurchaseOrder({
      businessId: ctx.businessId,
      userId: ctx.userId,
      id,
      op,
      ip: req.headers.get("x-forwarded-for"),
      userAgent: req.headers.get("user-agent"),
    });
    return ok(row);
  });
}
