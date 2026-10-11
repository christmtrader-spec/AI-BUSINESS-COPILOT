/**
 * Prompt 44 — POST /api/v1/inventory/goods-dispatches/[id]/lines (data:write)
 *
 * Line create — TWO explicit source modes:
 *  - STANDALONE (P44): productId + qty + reasonCode; snapshots derive from
 *    the tenant-scoped Product row.
 *  - ORDER-BASED (Prompt 45 §41): salesOrderLineId + qty ONLY — the
 *    product, snapshots, customer context and SALE reason derive from the
 *    linked sales order (server-controlled; injected productId/reasonCode
 *    is rejected).
 * DRAFT-only; duplicate product → 409; advisory remaining/availability
 * checks (only POST is authoritative).
 */
import { NextRequest } from "next/server";
import { ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { addGoodsDispatchLine } from "@/lib/inventory/goods-dispatch/service";
import { goodsDispatchLineCreateSchema } from "@/lib/inventory/goods-dispatch/schema";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const input = await parseBody(req, goodsDispatchLineCreateSchema);
  const row = await addGoodsDispatchLine({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    productId: input.productId,
    salesOrderLineId: input.salesOrderLineId,
    qty: input.qty,
    reasonCode: input.reasonCode,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({ id: row.id }, 201);
});
