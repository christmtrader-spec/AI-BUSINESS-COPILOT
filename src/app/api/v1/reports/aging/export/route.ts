/**
 * GET /api/v1/reports/aging/export — Aging CSV (statement-CSV conventions).
 *
 * Security (§78): authentication + membership + data:read — identical to the
 * aging JSON; on top: the CSV_EXPORT billing entitlement gate (§34 — server
 * side reject, §80) and the report-export rate limit (10 / 5 min / user).
 *
 * Single source (A11): rows are rendered from the SAME buildAgingReport()
 * engine the UI JSON uses — never a second calculation.
 *
 * SHAPE (one table, machine-friendly):
 *   section,label,items,oldest_days,balance
 *   total,<Total outstanding>,<openCount>,,<money>
 *   bucket,<0–30 days>,<count>,,<money>            (always exactly 4 buckets)
 *   past_due,<Past due>,<count>,,<money>           (payables only, when present)
 *   party,<name | "—">,<openCount>,<oldestDays>,<money>   (top parties ≤ 8)
 *
 * Money law (A08): integer minor units → decimal string at the business
 * precision, once, at serialization. No currency symbol, no float math.
 * Filename: aging-<side>-<asOf YYYYMMDD>.csv (business-facing, safe).
 * Audited: "data.export" with side + asOf + counts (§121 — no party data).
 */
import { NextRequest, NextResponse } from "next/server";
import { ApiError, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { assertFeatureAccess } from "@/lib/billing";
import { fromMinor } from "@/lib/money";
import { csvCell, toCsv } from "@/lib/csv";
import { buildAgingReport } from "@/lib/aging-report";
import { messagesFor } from "@/i18n/messages";

export const dynamic = "force-dynamic";

const AGING_EXPORT_RATE_LIMIT = 10;
const AGING_EXPORT_RATE_WINDOW_MS = 5 * 60_000;

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // Billing gate (§34/§80) — identical to every other CSV export.
  await assertFeatureAccess(ctx.businessId, "CSV_EXPORT");

  const rl = rateLimit(`aging-export:${ctx.userId}`, AGING_EXPORT_RATE_LIMIT, AGING_EXPORT_RATE_WINDOW_MS);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many exports in a short time. Please wait a moment.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const url = req.nextUrl.searchParams;
  const sideRaw = (url.get("side") ?? "").trim().toLowerCase();
  if (sideRaw !== "receivables" && sideRaw !== "payables") {
    throw new ApiError(422, "VALIDATION_ERROR", "'side' must be 'receivables' or 'payables'.", {
      field: "side",
    });
  }
  const side: "receivables" | "payables" = sideRaw;
  const locale: "en" | "fa" = url.get("locale") === "fa" ? "fa" : "en";

  const report = await buildAgingReport(ctx.businessId);
  const data = report[side];
  const precision = ctx.business.decimalPrecision ?? 2;
  const money = (minor: number) => fromMinor(minor, precision).toFixed(precision);

  const m = messagesFor(locale).finance.aging;

  type Row = [string, string, number, string, string];
  const rows: Row[] = [];

  // Total row — the headline figure the card shows.
  rows.push(["total", m.csvTotal, data.openCount, "", money(data.totalMinor)]);

  // Bucket rows — always exactly 4, engine order (oldest last).
  const bucketLabelKeys = {
    D0_30: "bucket0_30",
    D31_60: "bucket31_60",
    D61_90: "bucket61_90",
    D90_PLUS: "bucket90Plus",
  } as const;
  for (const b of data.buckets) {
    rows.push(["bucket", m[bucketLabelKeys[b.key]], b.count, "", money(b.minor)]);
  }

  // Payables past-due slice — server-derived, exported when present.
  if (side === "payables" && data.pastDueCount != null) {
    rows.push(["past_due", m.csvPastDue, data.pastDueCount, "", money(data.pastDueMinor ?? 0)]);
  }

  // Top-party rows — balance desc (engine ordering), oldest age in days.
  for (const p of data.topParties) {
    rows.push(["party", p.name ?? m.noParty, p.openCount, String(p.oldestDays), money(p.balanceMinor)]);
  }

  const csv = toCsv(
    [m.csvSection, m.csvLabel, m.csvItems, m.csvOldestDays, m.csvBalance],
    rows,
  );
  const stamp = report.asOf.replace(/-/g, "");
  const filename = `aging-${side}-${stamp}.csv`;

  void audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "data.export",
    entityType: "AgingCSV",
    entityId: null,
    after: {
      format: "csv",
      side,
      asOf: report.asOf,
      openCount: data.openCount,
      totalMinor: data.totalMinor,
      rowCount: rows.length,
      truncated: report.truncated,
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
