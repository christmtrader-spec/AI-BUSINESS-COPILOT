/**
 * Prompt 40 — /api/v1/inventory/stocktakes/[id]
 *
 * GET §26 — detail: header + server-derived summary + PAGINATED lines
 * (§65 — default 50, max 100; the client never loads thousands of lines).
 * PATCH §52 — DRAFT-only edit of reference/notes. NEVER status/quantities —
 * those change exclusively through the dedicated transition endpoints (§9).
 *
 * Foreign stocktake → 404, no existence leakage (§55). FINALIZED/CANCELLED
 * are immutable (§50/§51) — PATCH fails with 422 for them.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { getStocktake, updateStocktake } from "@/lib/inventory/stocktake/service";
import { stocktakeLinesQuerySchema, stocktakeUpdateSchema } from "@/lib/inventory/stocktake/schema";
import { isValidEntityId } from "@/lib/entity-routes";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // A malformed id can never exist as a stocktake — resolve to 404 (no leak).
  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Stocktake not found.");
  }

  let parsed;
  try {
    parsed = stocktakeLinesQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  } catch {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid stocktake detail query.");
  }

  const result = await getStocktake({
    businessId: ctx.businessId,
    id,
    page: parsed.page ?? 1,
    pageSize: parsed.pageSize ?? 50, // §65 — default 50, max 100 (schema)
  });
  return ok(result);
});

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Stocktake not found.");
  }

  const input = await parseBody(req, stocktakeUpdateSchema);
  const row = await updateStocktake({
    businessId: ctx.businessId,
    userId: ctx.userId,
    stocktakeId: id,
    reference: input.reference,
    notes: input.notes,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });
  return ok(row);
});
