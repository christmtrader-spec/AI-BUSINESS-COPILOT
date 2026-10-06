/**
 * Prompt 41 — POST /api/v1/purchase-orders   (create draft — data:write)
 *             GET  /api/v1/purchase-orders   (bounded list  — data:read)
 *
 * §45/§47 — tenant scope comes ONLY from getAuthContext; client businessId
 * is structurally impossible to submit (§145). §22/§164 — the currency
 * snapshot, supplier snapshot and totals are server-derived. §13 — a blank
 * reference generates PO-<date>-<token> server-side.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { createPurchaseOrder, listPurchaseOrders } from "@/lib/purchase-orders/service";
import {
  purchaseOrderCreateSchema,
  purchaseOrderListQuerySchema,
} from "@/lib/purchase-orders/schema";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write"); // §46

  const input = await parseBody(req, purchaseOrderCreateSchema);
  const row = await createPurchaseOrder({
    businessId: ctx.businessId, // §47 — server-derived tenant scope
    userId: ctx.userId,
    supplierId: input.supplierId,
    reference: input.reference, // undefined → §13 generation
    orderedAt: input.orderedAt,
    expectedDate: input.expectedDate ?? null,
    notes: input.notes ?? null,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({ id: row.id, reference: row.reference, status: row.status }, 201);
});

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read"); // §46

  let parsed;
  try {
    parsed = purchaseOrderListQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  } catch {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid purchase order list query.");
  }
  const result = await listPurchaseOrders({
    businessId: ctx.businessId,
    q: parsed.q,
    status: parsed.status,
    from: parsed.from,
    to: parsed.to,
    page: parsed.page ?? 1,
    pageSize: parsed.pageSize ?? 25,
  });
  return ok(result);
});
