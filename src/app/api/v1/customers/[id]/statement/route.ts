/**
 * GET /api/v1/customers/[id]/statement — Customer Statement (§33).
 *
 * A DERIVED transaction view over this customer's sales and received
 * payments — NOT a ledger (§1/§278). Read-only: no POST/PATCH/DELETE
 * exists for statements (§51).
 *
 * Security (§33/§49/§50/§52/§53/§126/§128):
 *   - authentication + membership via getAuthContext() (server-derived
 *     businessId — never a client-supplied scope, §126);
 *   - data:read permission (all roles; no new permission, §50);
 *   - foreign-tenant or soft-deleted customer → 404 (never 403/leak, §49);
 *   - normal authenticated read rate limit (reused limiter, no second one);
 *   - Cache-Control: private, no-store (confidential financial data, §53);
 *   - errors follow the shared contract (401/403/404/422/429, §128).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { isValidEntityId } from "@/lib/entity-routes";
import { buildStatement } from "@/lib/statements/engine";
import { toStatementResponse } from "@/lib/statements/dto";
import {
  parseStatementQuery,
  resolveStatementRange,
  StatementValidationError,
} from "@/lib/statements/schema";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

const STATEMENT_RATE_LIMIT = 30;
const STATEMENT_RATE_WINDOW_MS = 60_000;

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // §52 — normal authenticated read limits on the shared limiter.
  const rl = rateLimit(`statement:${ctx.userId}:${ctx.businessId}`, STATEMENT_RATE_LIMIT, STATEMENT_RATE_WINDOW_MS);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many statement requests. Please slow down.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  // §94/§95/§129 — strict query validation before any query executes.
  let input;
  try {
    input = parseStatementQuery(req.nextUrl.searchParams);
  } catch (error) {
    if (error instanceof StatementValidationError) {
      throw new ApiError(422, "VALIDATION_ERROR", error.message, { field: error.field });
    }
    throw error;
  }

  // A malformed id can never exist as a party — resolve to 404 (no leak).
  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Customer not found.");
  }

  const timeZone = ctx.business.timezone || "UTC";
  const range = resolveStatementRange(input.from, input.to, timeZone);

  let result;
  try {
    result = await buildStatement({
      kind: "CUSTOMER",
      businessId: ctx.businessId, // server-derived scope (§126)
      partyId: id,
      from: range.from,
      to: range.to,
      timeZone,
      limit: input.limit,
      cursor: input.cursor,
      locale: input.locale,
    });
  } catch (error) {
    // Cursor decode/bind errors surface from the engine (§48) — map to 422.
    if (error instanceof StatementValidationError) {
      throw new ApiError(422, "VALIDATION_ERROR", error.message, { field: error.field });
    }
    throw error;
  }

  const response = ok(toStatementResponse(result));
  response.headers.set("Cache-Control", "private, no-store"); // §53
  return response;
});
