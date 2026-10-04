/**
 * GET /api/v1/suppliers/[id]/statement — Supplier Statement (§34).
 *
 * Same derived-view semantics as the customer statement over this
 * supplier's bills and made payments (§2/§12/§13) — NOT a ledger (§1/§278).
 * Read-only (§51), tenant-scoped by the SERVER-derived businessId (§126),
 * 404 for foreign/deleted suppliers (§49/§99), rate limited (§52),
 * private/no-store (§53).
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

  const rl = rateLimit(`statement:${ctx.userId}:${ctx.businessId}`, STATEMENT_RATE_LIMIT, STATEMENT_RATE_WINDOW_MS);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many statement requests. Please slow down.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  let input;
  try {
    input = parseStatementQuery(req.nextUrl.searchParams);
  } catch (error) {
    if (error instanceof StatementValidationError) {
      throw new ApiError(422, "VALIDATION_ERROR", error.message, { field: error.field });
    }
    throw error;
  }

  if (!isValidEntityId(id)) {
    throw new ApiError(404, "NOT_FOUND", "Supplier not found.");
  }

  const timeZone = ctx.business.timezone || "UTC";
  const range = resolveStatementRange(input.from, input.to, timeZone);

  let result;
  try {
    result = await buildStatement({
      kind: "SUPPLIER",
      businessId: ctx.businessId,
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
