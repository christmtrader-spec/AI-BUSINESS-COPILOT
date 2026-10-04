/**
 * GET /api/v1/suppliers/[id]/statement/export — Supplier Statement CSV (§77).
 * Same engine, security and CSV conventions as the customer export (§78–§83)
 * over this supplier's bills and made payments.
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
    throw new ApiError(404, "NOT_FOUND", "Supplier not found.");
  }

  const timeZone = ctx.business.timezone || "UTC";
  const range = resolveStatementRange(input.from, input.to, timeZone);

  let csvResult;
  try {
    csvResult = await buildStatementCsv(
      {
        kind: "SUPPLIER",
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
    if (error instanceof StatementValidationError) {
      throw new ApiError(422, "VALIDATION_ERROR", error.message, { field: error.field });
    }
    throw error;
  }
  const { csv, filename, eventCount, closingBalanceMinor } = csvResult;

  void audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "data.export",
    entityType: "StatementCSV",
    entityId: null,
    after: { format: "csv", statementType: "supplier", from: range.from, to: range.to, eventCount, closingBalanceMinor },
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
});
