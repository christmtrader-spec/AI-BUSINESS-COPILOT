/**
 * Prompt 43 — POST /api/v1/inventory/goods-returns  (create draft — data:write)
 *             GET  /api/v1/inventory/goods-returns  (bounded list  — data:read)
 *
 * §56 — create derives tenant scope, supplier snapshot, receipt reference
 * snapshot, PO reference snapshot and creator from the SERVER (never
 * client input §22/§25/§56). §13 — returns against DRAFT/CANCELLED
 * receipts are 422; foreign receipts → 404. §72 — the list is
 * DB-paginated (pageSize ≤ 100), never findMany+slice.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { createGoodsReturn, listGoodsReturns } from "@/lib/inventory/goods-return/service";
import {
  goodsReturnCreateSchema,
  goodsReturnListQuerySchema,
} from "@/lib/inventory/goods-return/schema";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write"); // §69

  const input = await parseBody(req, goodsReturnCreateSchema);
  const row = await createGoodsReturn({
    businessId: ctx.businessId, // §67 — server-derived tenant scope
    userId: ctx.userId,
    goodsReceiptId: input.goodsReceiptId,
    reference: input.reference, // undefined → §20 generation
    notes: input.notes ?? null,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({ id: row.id, reference: row.reference, status: row.status }, 201);
});

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read"); // §69

  let parsed;
  try {
    parsed = goodsReturnListQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  } catch {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid goods return list query.");
  }
  const result = await listGoodsReturns({
    businessId: ctx.businessId,
    q: parsed.q,
    status: parsed.status,
    goodsReceiptId: parsed.goodsReceiptId,
    from: parsed.from,
    to: parsed.to,
    timezone: ctx.business.timezone || "UTC", // §22-§23 — AUTH ctx only, never the client
    page: parsed.page ?? 1,
    pageSize: parsed.pageSize ?? 25,
  });
  return ok(result);
});
