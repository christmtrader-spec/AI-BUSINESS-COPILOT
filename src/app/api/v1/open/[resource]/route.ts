/**
 * GET /api/v1/open/[resource] — PUBLIC API surface for external accounting
 * integrations (Prompt 52 §F8).
 *
 * Auth: `Authorization: Bearer ck_...` (API key — NOT a user session).
 * The key's business owns every returned row (A01/A02 by construction).
 * Scope: "read" only. Rate limit: 120 requests/minute per key.
 * Resources: customers | products | sales — bounded to the 500 most recent
 * non-deleted rows, minimal field sets (no secrets, no scoping internals).
 *
 * The `route()` wrapper is NOT used here: it maps unauthenticated errors
 * fine, but open-API responses must be cache-banned and identify the key —
 * still, reusing the same envelope keeps clients simple.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import {
  OPEN_API_RESOURCES,
  getApiKeyContext,
  touchApiKey,
  type OpenApiResource,
} from "@/lib/api-keys";
import { rateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const MAX_ROWS = 500;

type RouteParams = { params: Promise<{ resource: string }> };

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { resource } = await params;
  if (!OPEN_API_RESOURCES.includes(resource as OpenApiResource)) {
    throw new ApiError(404, "NOT_FOUND", `Unknown resource "${resource}".`);
  }

  const keyCtx = await getApiKeyContext(req);

  // Per-key rate limit (fail-closed — a rejected request still counts).
  const limit = rateLimit(`open-api:${keyCtx.keyId}`, 120, 60_000);
  if (!limit.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "API key rate limit exceeded (120/min).", {
      retryAfterMs: limit.retryAfterMs,
    });
  }

  touchApiKey(keyCtx.keyId);

  let data: unknown;
  if (resource === "customers") {
    const rows = await db.customer.findMany({
      where: { businessId: keyCtx.businessId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: MAX_ROWS,
      select: { id: true, name: true, phone: true, email: true, createdAt: true },
    });
    data = rows;
  } else if (resource === "products") {
    const rows = await db.product.findMany({
      where: { businessId: keyCtx.businessId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: MAX_ROWS,
      select: {
        id: true,
        name: true,
        sku: true,
        unit: true,
        salePriceMinor: true,
        costPriceMinor: true,
        stockQty: true,
        isActive: true,
        createdAt: true,
      },
    });
    data = rows;
  } else {
    const rows = await db.sale.findMany({
      where: { businessId: keyCtx.businessId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: MAX_ROWS,
      select: {
        id: true,
        number: true,
        customerId: true,
        subtotalMinor: true,
        discountMinor: true,
        taxRateBp: true,
        taxMinor: true,
        totalMinor: true,
        paidMinor: true,
        status: true,
        issueDate: true,
        createdAt: true,
      },
    });
    data = rows;
  }

  const res = ok({ items: data });
  res.headers.set("cache-control", "no-store");
  res.headers.set("x-ratelimit-remaining", String(limit.remaining));
  return res;
});
