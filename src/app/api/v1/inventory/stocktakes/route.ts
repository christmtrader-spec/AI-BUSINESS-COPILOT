/**
 * Prompt 40 — /api/v1/inventory/stocktakes
 *
 * POST §24 — create a DRAFT stocktake (reference/notes; countType closed to
 * SELECTED; server sets businessId + createdByUserId + status).
 * GET  §25 — paginated list; q searches reference ONLY (never notes);
 * status/from/to filters; pageSize default 25 max 100; never unbounded.
 *
 * Security (§53/§54): authentication + membership + permission; the tenant
 * comes exclusively from getAuthContext(). rbac: view=data:read, mutations=
 * data:write. No new permission; NOT finance:manage.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { createStocktake, listStocktakes } from "@/lib/inventory/stocktake/service";
import { stocktakeCreateSchema, stocktakeListQuerySchema } from "@/lib/inventory/stocktake/schema";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write"); // §53

  const input = await parseBody(req, stocktakeCreateSchema);
  const row = await createStocktake({
    businessId: ctx.businessId, // §54 — server-derived tenant scope
    userId: ctx.userId,
    reference: input.reference,
    notes: input.notes,
    countType: input.countType,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok({ id: row.id, reference: row.reference, status: row.status }, 201);
});

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read"); // §53

  let parsed;
  try {
    parsed = stocktakeListQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  } catch {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid stocktake list query.");
  }
  const result = await listStocktakes({
    businessId: ctx.businessId,
    q: parsed.q,
    status: parsed.status,
    from: parsed.from,
    to: parsed.to,
    page: parsed.page ?? 1,
    pageSize: parsed.pageSize ?? 25, // §25 — default 25, max 100 (schema)
  });
  return ok(result);
});
