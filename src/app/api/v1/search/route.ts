/**
 * GET /api/v1/search — Prompt 33 Universal Global Search (§9).
 *
 * Unified, tenant-safe discovery across the SIX tenant-scoped entity types
 * (Customer/Supplier/Product/Sale/Expense/Payment) for the CURRENT business.
 *
 * Authority chain (§3 — absolute):
 *   session → getAuthContext → verified membership → ctx.businessId → RBAC
 *   `data:read`. The X-Business-Id header is the ONLY business hint and is
 *   itself re-verified against the membership table; query params can never
 *   supply userId/businessId/tenantId/ownerId (they are not even read).
 *
 * Hygiene: rate limited 30 req/60s per user+business (§10), response is
 * `private, no-store` (§11), results are data-minimal DTOs (§21), and the
 * raw query is never logged (§22).
 */
import { NextRequest, NextResponse } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { searchBusiness } from "@/lib/search/service";
import { parseSearchParams, SearchValidationError } from "@/lib/search/schema";

export const dynamic = "force-dynamic";

/** Search rate limit (§10): 30 requests / 60 s per user+business. */
const SEARCH_RATE_LIMIT = 30;
const SEARCH_RATE_WINDOW_MS = 60_000;

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // §10 — limiter key includes userId AND businessId (never IP-only).
  const rl = rateLimit(
    `search:${ctx.userId}:${ctx.businessId}`,
    SEARCH_RATE_LIMIT,
    SEARCH_RATE_WINDOW_MS,
  );
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many search requests. Please slow down.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  let input;
  try {
    input = parseSearchParams(req.nextUrl.searchParams);
  } catch (error) {
    if (error instanceof SearchValidationError) {
      // §35 — standard validation envelope, standard code.
      throw new ApiError(422, "VALIDATION_ERROR", error.message, { field: error.field });
    }
    throw error;
  }

  // User's persisted locale resolves the single server-localized label
  // (Payment) exactly like the Prompt 32 notification renderer (§191).
  const user = await db.user.findUnique({
    where: { id: ctx.userId },
    select: { locale: true },
  });
  const locale = user?.locale === "fa" ? "fa" : "en";

  const data = await searchBusiness(ctx.businessId, input, { locale });

  const response = ok(data);
  // §11 — user/business-sensitive: private, no-store, never CDN-cached.
  response.headers.set("Cache-Control", "private, no-store");
  return response as NextResponse;
});
