/**
 * GET /api/v1/open/[resource] — PUBLIC API surface for external accounting
 * integrations (Prompt 52 §F8).
 *
 * Auth: `Authorization: Bearer ck_...` (API key — NOT a user session).
 * The key's business owns every returned row (A01/A02 by construction).
 * Scopes (R61-3): "read" covers every resource; "read:<resource>" covers
 * exactly one — a key without the resource's scope gets 403 BEFORE any
 * data is touched or quota is consumed. Monthly per-key quota on top of
 * the 120/min sliding-window rate limit. Resources: customers | products
 * | sales — bounded to the 500 most recent non-deleted rows, minimal field
 * sets (no secrets, no scoping internals).
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
  consumeApiKeyQuota,
  scopeCoversResource,
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

  // R61-3 scope gate — BEFORE any data access and BEFORE quota consumption:
  // a denied request must neither read rows nor burn the caller's quota.
  if (!scopeCoversResource(keyCtx.scopes, resource as OpenApiResource)) {
    throw new ApiError(
      403,
      "PERMISSION_DENIED",
      `This API key is not scoped for "${resource}".`,
    );
  }

  // R61-3 monthly quota — metered per key (UTC month bucket).
  const quota = await consumeApiKeyQuota(keyCtx.keyId);
  if (!quota.allowed) {
    throw new ApiError(
      429,
      "QUOTA_EXCEEDED",
      `API key monthly quota exhausted (${quota.limit} requests). Resets at the start of the next UTC month.`,
      { retryAfterMs: quota.retryAfterMs },
    );
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
  res.headers.set("x-quota-limit", String(quota.limit));
  res.headers.set("x-quota-remaining", String(quota.remaining));
  return res;
});
