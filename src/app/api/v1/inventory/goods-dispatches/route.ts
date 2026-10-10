/**
 * Prompt 44 — POST /api/v1/inventory/goods-dispatches  (create draft — data:write)
 *             GET  /api/v1/inventory/goods-dispatches  (bounded list  — data:read)
 *
 * Create derives tenant scope, the customer snapshot and creator from the
 * SERVER (never client input). The list is DB-paginated (pageSize ≤ 100),
 * never findMany+slice; date filters interpret from/to in the
 * AUTHENTICATED business timezone (never the client's).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { createGoodsDispatch, listGoodsDispatches } from "@/lib/inventory/goods-dispatch/service";
import {
  goodsDispatchCreateSchema,
  goodsDispatchListQuerySchema,
} from "@/lib/inventory/goods-dispatch/schema";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const input = await parseBody(req, goodsDispatchCreateSchema);
  const row = await createGoodsDispatch({
    businessId: ctx.businessId, // server-derived tenant scope
    userId: ctx.userId,
    customerId: input.customerId, // optional; validated + snapshotted server-side
    reference: input.reference, // undefined → server generation
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
    parsed = goodsDispatchListQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  } catch {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid goods dispatch list query.");
  }
  const result = await listGoodsDispatches({
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
