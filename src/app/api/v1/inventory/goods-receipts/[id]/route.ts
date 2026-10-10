/**
 * Prompt 42/43 — GET   /api/v1/inventory/goods-receipts/[id] — detail (data:read)
 *             PATCH /api/v1/inventory/goods-receipts/[id] — DRAFT-only edit (data:write)
 *
 * There is deliberately NO generic status mutation here (§7): post/cancel
 * go through their dedicated endpoints. businessId/status/snapshots/
 * creator/postedAt are structurally absent from the PATCH schema (§107).
 *
 * Prompt 43 (§86-§88) — the detail response carries ADDITIVE return facts
 * (per-line received/returned/returnable + bounded recent returns ≤ 10 +
 * the §87 CTA gate). The receipt DTO itself is UNCHANGED — a receipt is
 * never rewritten by returns.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { isValidEntityId } from "@/lib/entity-routes";
import { getGoodsReceipt, updateGoodsReceipt } from "@/lib/inventory/goods-receipt/service";
import { goodsReceiptUpdateSchema } from "@/lib/inventory/goods-receipt/schema";
import {
  getGoodsReceiptReturnFacts,
  listRecentReturnsForReceipt,
} from "@/lib/inventory/goods-return/service";

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

  // Prompt 43 (§86/§87/§88) — ADDITIVE return facts over the receipt's
  // own immutable lines. The per-line receivedQty in `detail.lines` is the
  // GROSS authority (§78/§126 — never rewritten by returns); returned /
  // returnable are DERIVED (§36). `returnable` gates the §87 CTA
  // (client-advisory; the server revalidates at line-add and post time).
  const [facts, recentReturns] = await Promise.all([
    getGoodsReceiptReturnFacts({
      businessId: ctx.businessId,
      receiptId: id,
      receivedLines: detail.lines.map((l) => ({ id: l.id, receivedQty: l.receivedQty })),
    }),
    listRecentReturnsForReceipt({ businessId: ctx.businessId, receiptId: id, take: 10 }),
  ]);

  return ok({
    ...detail,
    returns: {
      returnable: facts.returnable,
      lines: facts.lines,
      recent: recentReturns,
    },
  });
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
