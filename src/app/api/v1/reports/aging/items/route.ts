/**
 * GET /api/v1/reports/aging/items — DETAILED AGING (Prompt 49 §7).
 *
 * The open source documents behind the aggregate aging: individual open
 * Sale invoices (receivables) / open Expense payables (payables), each with
 * its authoritative amounts, business-local age, canonical aging bucket and
 * (payables) the stated-due-date past-due fact.
 *
 * SINGLE CALCULATION SOURCE (§3.2): rendered by buildAgingDetailPage() —
 * the ONLY detailed-aging engine; buckets/ages/past-due reuse
 * src/lib/aging.ts. No React component or route re-derives a bucket.
 *
 * Security (§20):
 *   - authentication + membership via getAuthContext() (server-derived
 *     businessId — never a client-supplied scope);
 *   - data:read permission;
 *   - partyId is resolved INSIDE the tenant — foreign/deleted party → 404
 *     (never an existence leak, same law as the statement routes);
 *   - cursors are signed + filter-bound — a foreign/side/party/bucket
 *     cursor is rejected with the canonical 422;
 *   - private, no-store (confidential financial data);
 *   - normal authenticated read rate limit (statement limiter convention).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import {
  buildAgingDetailPage,
  parseAgingDetailQuery,
  AgingDetailValidationError,
} from "@/lib/aging-details";

export const dynamic = "force-dynamic";

const AGING_DETAIL_RATE_LIMIT = 30;
const AGING_DETAIL_RATE_WINDOW_MS = 60_000;

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  const rl = rateLimit(
    `aging-detail:${ctx.userId}:${ctx.businessId}`,
    AGING_DETAIL_RATE_LIMIT,
    AGING_DETAIL_RATE_WINDOW_MS,
  );
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many aging requests. Please slow down.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  // §7 — strict query validation before any query executes.
  let input;
  try {
    input = parseAgingDetailQuery(req.nextUrl.searchParams);
  } catch (error) {
    if (error instanceof AgingDetailValidationError) {
      throw new ApiError(422, "VALIDATION_ERROR", error.message, { field: error.field });
    }
    throw error;
  }

  // Cursor decode/bind errors surface from the page build (§7.1) — mapped to
  // the canonical 422 exactly like the statement routes map their engine
  // validation errors (never a 500, never a fallback page).
  let page;
  try {
    page = await buildAgingDetailPage({
      side: input.side,
      businessId: ctx.businessId, // server-derived scope (§20)
      partyId: input.partyId,
      bucket: input.bucket,
      pastDue: input.pastDue,
      timeZone: ctx.business.timezone || "UTC",
      now: new Date(),
      limit: input.limit,
      cursor: input.cursor,
    });
  } catch (error) {
    if (error instanceof AgingDetailValidationError) {
      throw new ApiError(422, "VALIDATION_ERROR", error.message, { field: error.field });
    }
    throw error;
  }

  const response = ok({
    party: page.party,
    summary: page.summary,
    items: page.items,
    nextCursor: page.nextCursor,
    pageTruncated: page.pageTruncated,
  });
  response.headers.set("Cache-Control", "private, no-store"); // confidential financial data
  return response;
});
