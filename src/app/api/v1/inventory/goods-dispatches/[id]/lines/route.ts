/**
 * Prompt 44 — POST /api/v1/inventory/goods-dispatches/[id]/lines (data:write)
 *
 * Line create: productId + qty + reasonCode. The product IS the
 * authoritative outbound source; snapshots derive server-side from the
 * tenant-scoped Product row. DRAFT-only; duplicate product → 409;
 * advisory availability check (only POST is authoritative).
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
    qty: input.qty,
    reasonCode: input.reasonCode,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({ id: row.id }, 201);
});
