/**
 * Prompt 42 — POST /api/v1/inventory/goods-receipts  (create draft — data:write)
 *             GET  /api/v1/inventory/goods-receipts  (bounded list  — data:read)
 *
 * §58 — create derives tenant scope, supplier snapshot, PO reference
 * snapshot and creator from the SERVER (never client input §22/§25/§58).
 * §11 — receipts against DRAFT/SENT/CLOSED/CANCELLED orders are 422.
 * §80 — the list is DB-paginated (pageSize ≤ 100), never findMany+slice.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { createGoodsReceipt, listGoodsReceipts } from "@/lib/inventory/goods-receipt/service";
import {
  goodsReceiptCreateSchema,
  goodsReceiptListQuerySchema,
} from "@/lib/inventory/goods-receipt/schema";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write"); // §93

  const input = await parseBody(req, goodsReceiptCreateSchema);
  const row = await createGoodsReceipt({
    businessId: ctx.businessId, // §89 — server-derived tenant scope
    userId: ctx.userId,
    purchaseOrderId: input.purchaseOrderId,
    reference: input.reference, // undefined → §59 generation
    notes: input.notes ?? null,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({ id: row.id, reference: row.reference, status: row.status }, 201);
});

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read"); // §93

  let parsed;
  try {
    parsed = goodsReceiptListQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  } catch {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid goods receipt list query.");
  }
  const result = await listGoodsReceipts({
    businessId: ctx.businessId,
    q: parsed.q,
    status: parsed.status,
    purchaseOrderId: parsed.purchaseOrderId,
    from: parsed.from,
    to: parsed.to,
    page: parsed.page ?? 1,
    pageSize: parsed.pageSize ?? 25,
  });
  return ok(result);
});
