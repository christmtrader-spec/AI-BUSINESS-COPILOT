/**
 * GET /api/v1/customers/[id]/statement/export — Customer Statement CSV (§77).
 *
 * Security (§78): authentication + membership + data:read + tenant scope —
 * identical to the statement itself; on top of that the EXISTING CSV export
 * conventions apply (§80/§81): the CSV_EXPORT billing entitlement gate and
 * the report-export rate limit (10 / 5 min / user).
 *
 * The CSV is built from the SAME statement engine as the API (§132/§133);
 * the export covers the WHOLE from..to range, never just one page (§184).
 *
 * AUDIT (§116/§121): the shared "data.export" convention of every CSV
 * export in this product is reused — with NO party identity in the record
 * (statement type + calendar range only). No "statement.view" audit event
 * exists; viewing stays un-audited read-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { ApiError, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { assertFeatureAccess } from "@/lib/billing";
import { isValidEntityId } from "@/lib/entity-routes";
import { buildStatementCsv } from "@/lib/statements/export";
import {
  parseStatementQuery,
  resolveStatementRange,
  StatementValidationError,
} from "@/lib/statements/schema";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

const STATEMENT_EXPORT_RATE_LIMIT = 10;
const STATEMENT_EXPORT_RATE_WINDOW_MS = 5 * 60_000;

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // Existing CSV export billing convention (§80 — same as report exports).
  await assertFeatureAccess(ctx.businessId, "CSV_EXPORT");

  const rl = rateLimit(`statement-export:${ctx.userId}`, STATEMENT_EXPORT_RATE_LIMIT, STATEMENT_EXPORT_RATE_WINDOW_MS);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many exports in a short time. Please wait a moment.", {
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
    throw new ApiError(404, "NOT_FOUND", "Customer not found.");
  }

  const timeZone = ctx.business.timezone || "UTC";
  const range = resolveStatementRange(input.from, input.to, timeZone);

  let csvResult;
  try {
    csvResult = await buildStatementCsv(
      {
        kind: "CUSTOMER",
        businessId: ctx.businessId,
        partyId: id,
        from: range.from,
        to: range.to,
        timeZone,
        locale: input.locale,
      },
      ctx.business.decimalPrecision ?? 2,
    );
  } catch (error) {
    // Cursor decode/bind errors surface from the shared engine (§48) — 422.
    if (error instanceof StatementValidationError) {
      throw new ApiError(422, "VALIDATION_ERROR", error.message, { field: error.field });
    }
    throw error;
  }
  const { csv, filename, eventCount, closingBalanceMinor } = csvResult;

  // §121/§122 — safe record: operation + type + range; NO party id/name.
  void audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "data.export",
    entityType: "StatementCSV",
    entityId: null,
    after: { format: "csv", statementType: "customer", from: range.from, to: range.to, eventCount, closingBalanceMinor },
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });

  // §81/§143 — BOM'd UTF-8 CSV, safe filename (type + calendar range only).
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
});
