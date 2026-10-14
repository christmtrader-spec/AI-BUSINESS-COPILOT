/**
 * GET /api/v1/reports/aging/items/export — DETAILED AGING CSV (Prompt 49 §14).
 *
 * A DEDICATED detailed export — it does NOT redefine the existing summary
 * aging CSV (/api/v1/reports/aging/export stays exactly what it was: total,
 * bucket summaries, past due, top parties ≤ 8).
 *
 * SINGLE SOURCE (§14): rows are rendered by collectAgingDetailRows() — the
 * SAME detailed engine the JSON endpoint uses. There is no second CSV
 * calculation and no second bucket law.
 *
 * COMPLETENESS LAW (§14): the export covers the WHOLE declared scope
 * (side + optional party + optional bucket + optional pastDue). If the scope
 * exceeds AGING_DETAIL_EXPORT_MAX_ROWS the export REJECTS with the stable
 * controlled error AGING_EXPORT_TOO_LARGE — a partial CSV with success
 * status is never returned.
 *
 * Columns (approved fields only — no notes, no profile data, no payment
 * metadata, no raw Prisma objects):
 *   source_type, reference, party, document_date, anchor_date, due_date,
 *   age_days, bucket, total, paid, outstanding [, past_due] [, supplier_bill]
 * (past_due / supplier_bill are payables-only columns.)
 *
 * Money law (A08): integer minor units → exact decimal string at the
 * business precision, once, at serialization. No currency symbol, no float.
 * Dates: business-local calendar "YYYY-MM-DD" day keys.
 * Filename: aging-<side>-detail-YYYYMMDD.csv (party-scoped:
 *           aging-<side>-party-YYYYMMDD.csv) — NO party names, no PII.
 * Audited: "data.export" with side + filters + counts (no party data).
 */
import { NextRequest, NextResponse } from "next/server";
import { ApiError, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { assertFeatureAccess } from "@/lib/billing";
import { fromMinor } from "@/lib/money";
import { toCsv } from "@/lib/csv";
import {
  collectAgingDetailRows,
  buildAgingDetailSummary,
  parseAgingDetailQuery,
  AgingDetailValidationError,
  AgingExportTooLargeError,
} from "@/lib/aging-details";
import { localDayKey } from "@/lib/aging";
import { messagesFor } from "@/i18n/messages";

export const dynamic = "force-dynamic";

const AGING_EXPORT_RATE_LIMIT = 10;
const AGING_EXPORT_RATE_WINDOW_MS = 5 * 60_000;

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // Billing gate (§34/§80) — identical to every other CSV export.
  await assertFeatureAccess(ctx.businessId, "CSV_EXPORT");

  const rl = rateLimit(`aging-detail-export:${ctx.userId}`, AGING_EXPORT_RATE_LIMIT, AGING_EXPORT_RATE_WINDOW_MS);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many exports in a short time. Please wait a moment.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  let input;
  try {
    input = parseAgingDetailQuery(req.nextUrl.searchParams);
  } catch (error) {
    if (error instanceof AgingDetailValidationError) {
      throw new ApiError(422, "VALIDATION_ERROR", error.message, { field: error.field });
    }
    throw error;
  }

  const timeZone = ctx.business.timezone || "UTC";
  const now = new Date();

  let items;
  let summary;
  try {
    items = await collectAgingDetailRows({
      side: input.side,
      businessId: ctx.businessId,
      partyId: input.partyId,
      bucket: input.bucket,
      pastDue: input.pastDue,
      timeZone,
      now,
      limit: 0, // unused by the collector (whole-scope walk)
      cursor: null,
    });
    summary = await buildAgingDetailSummary({
      side: input.side,
      businessId: ctx.businessId,
      partyId: input.partyId,
      bucket: null, // audit carries scope counts; summary mirrors the audit trail
      pastDue: false,
      timeZone,
      now,
      limit: 0,
      cursor: null,
    });
  } catch (error) {
    if (error instanceof AgingDetailValidationError) {
      throw new ApiError(422, "VALIDATION_ERROR", error.message, { field: error.field });
    }
    if (error instanceof AgingExportTooLargeError) {
      // §14 — reject with a stable controlled error; a user-facing
      // explanation, no partial body, no internal diagnostics.
      throw new ApiError(422, "AGING_EXPORT_TOO_LARGE", error.message, { cap: error.cap });
    }
    throw error;
  }

  const locale: "en" | "fa" = req.nextUrl.searchParams.get("locale") === "fa" ? "fa" : "en";
  const m = messagesFor(locale).finance.agingDetails;
  const precision = ctx.business.decimalPrecision ?? 2;
  const money = (minor: number) => fromMinor(minor, precision).toFixed(precision);
  const day = (iso: string | null) => (iso ? localDayKey(new Date(iso), timeZone) : "");

  const isPayables = input.side === "payables";
  const headers = isPayables
    ? [
        m.csvSourceType,
        m.csvReference,
        m.csvParty,
        m.csvDocumentDate,
        m.csvAnchorDate,
        m.csvDueDate,
        m.csvAgeDays,
        m.csvBucket,
        m.csvTotal,
        m.csvPaid,
        m.csvOutstanding,
        m.csvPastDue,
        m.csvSupplierBill,
      ]
    : [
        m.csvSourceType,
        m.csvReference,
        m.csvParty,
        m.csvDocumentDate,
        m.csvAnchorDate,
        m.csvDueDate,
        m.csvAgeDays,
        m.csvBucket,
        m.csvTotal,
        m.csvPaid,
        m.csvOutstanding,
      ];

  const bucketLabels: Record<string, string> = {
    D0_30: m.bucket0_30,
    D31_60: m.bucket31_60,
    D61_90: m.bucket61_90,
    D90_PLUS: m.bucket90Plus,
  };

  const rows = items.map((item) => {
    const base: Array<string | number> = [
      item.sourceType,
      item.reference,
      item.partyName ?? m.noParty,
      day(item.documentDate),
      day(item.anchorDate),
      day(item.dueDate),
      item.ageDays,
      bucketLabels[item.bucket] ?? item.bucket,
      money(item.totalMinor),
      money(item.paidMinor),
      money(item.outstandingMinor),
    ];
    if (isPayables) {
      base.push(item.pastDue ? m.pastDueYes : m.pastDueNo);
      base.push(item.supplierBillReference ?? "");
    }
    return base;
  });

  const csv = toCsv(headers, rows);
  const stamp = summary.asOf.replace(/-/g, "");
  // ASCII-only filename (ByteString law) — no party names, no locale text.
  const filename = input.partyId
    ? `aging-${input.side}-party-${stamp}.csv`
    : `aging-${input.side}-detail-${stamp}.csv`;

  void audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "data.export",
    entityType: "AgingDetailCSV",
    entityId: null,
    after: {
      format: "csv",
      side: input.side,
      asOf: summary.asOf,
      partyScoped: Boolean(input.partyId),
      bucket: input.bucket,
      pastDueOnly: input.pastDue,
      rowCount: rows.length,
      scopeTotalMinor: summary.totalOutstandingMinor,
      scopeOpenCount: summary.openItemCount,
    },
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
