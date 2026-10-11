/**
 * Prompt 45 — POST /api/v1/sales-orders  (create draft — data:write)
 *             GET  /api/v1/sales-orders  (bounded list  — data:read)
 *
 * Create derives tenant scope, the currency snapshot, the customer
 * snapshot and creator from the SERVER (never client input §10/§25/§112).
 * The list is DB-paginated (pageSize ≤ 100), never findMany+slice; date
 * filters interpret from/to in the AUTHENTICATED business timezone.
 * Confirming or creating an order NEVER mutates stock or finance (§4/§30).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { createSalesOrder, listSalesOrders } from "@/lib/sales-orders/service";
import { salesOrderCreateSchema, salesOrderListQuerySchema } from "@/lib/sales-orders/schema";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const input = await parseBody(req, salesOrderCreateSchema);
  const row = await createSalesOrder({
    businessId: ctx.businessId, // server-derived tenant scope
    userId: ctx.userId,
    customerId: input.customerId, // optional; validated + snapshotted server-side
    reference: input.reference, // undefined → server generation (§14)
    orderDate: input.orderDate,
    expectedDate: input.expectedDate,
    discountMinor: input.discountMinor,
    notes: input.notes ?? null,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({ id: row.id, reference: row.reference, status: row.status }, 201);
});

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  let parsed;
  try {
    parsed = salesOrderListQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  } catch {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid sales order list query.");
  }
  const result = await listSalesOrders({
    businessId: ctx.businessId,
    q: parsed.q,
    status: parsed.status,
    customerId: parsed.customerId,
    from: parsed.from,
    to: parsed.to,
    timezone: ctx.business.timezone || "UTC", // AUTH ctx only, never the client
    page: parsed.page ?? 1,
    pageSize: parsed.pageSize ?? 25,
  });
  return ok(result);
});
