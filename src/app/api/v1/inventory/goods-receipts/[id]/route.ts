/**
 * Prompt 42 — GET   /api/v1/inventory/goods-receipts/[id] — detail (data:read)
 *             PATCH /api/v1/inventory/goods-receipts/[id] — DRAFT-only edit (data:write)
 *
 * There is deliberately NO generic status mutation here (§7): post/cancel
 * go through their dedicated endpoints. businessId/status/snapshots/
 * creator/postedAt are structurally absent from the PATCH schema (§107).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { isValidEntityId } from "@/lib/entity-routes";
import { getGoodsReceipt, updateGoodsReceipt } from "@/lib/inventory/goods-receipt/service";
import { goodsReceiptUpdateSchema } from "@/lib/inventory/goods-receipt/schema";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // A malformed id can never exist as a receipt — resolve to 404 (no leak).
  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Goods receipt not found.");
  }

  const detail = await getGoodsReceipt({ businessId: ctx.businessId, id });
  return ok(detail);
});

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Goods receipt not found.");
  }

  const input = await parseBody(req, goodsReceiptUpdateSchema);
  const row = await updateGoodsReceipt({
    businessId: ctx.businessId,
    userId: ctx.userId,
    id,
    reference: input.reference,
    notes: input.notes,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(row);
});
