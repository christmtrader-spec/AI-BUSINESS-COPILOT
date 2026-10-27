/**
 * GET /api/v1/reports/export?days=7|30|90 — report data as CSV.
 *
 * Phase 06 — accountant-friendly export of the SAME deterministic
 * aggregates the Reports view shows (single source of truth:
 * buildReportSummary). No raw records, no personal data beyond
 * product/category names.
 *
 * Money law (A08): every amount is computed as integer minor units and
 * only converted to a decimal string at serialization time (toFixed at
 * the business precision) — never float arithmetic.
 *
 * R134 — a `previous_window` section rides along when the summary carries
 * its trend block (always, on the SAME buildReportSummary call — zero new
 * queries): the comparison window's exact range + its own KPI set, so an
 * accountant can diff both windows from the file alone. The section is
 * additive at the END of the document (older parsers that stop at the
 * known sections keep reading the same bytes they always did).
 *
 * Permission: data:read (all roles — mirrors the Reports view).
 * Billing (§34): CSV_EXPORT entitlement — server-side reject when false;
 * UI hiding alone is never the enforcement.
 * Rate limited: 10 exports / 5 min / user. Audited: "data.export".
 */
import { NextRequest, NextResponse } from "next/server";
import { ApiError, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { assertFeatureAccess } from "@/lib/billing";
import { fromMinor } from "@/lib/money";
import { buildReportSummary, normalizeReportDays } from "@/lib/reports";
import { ReportRangeError, resolveCustomRange } from "@/lib/report-periods";
import { ApiError as ApiErr } from "@/lib/api-helpers";
import { csvCell } from "@/lib/csv";

export const dynamic = "force-dynamic";

function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // Billing gate (§34): server-side CSV export rejects when the plan's
  // CSV_EXPORT entitlement is false — fresh read (§111).
  await assertFeatureAccess(ctx.businessId, "CSV_EXPORT");

  const limit = rateLimit(`report-export:${ctx.userId}`, 10, 5 * 60_000);
  if (!limit.allowed) {
    throw new ApiError(
      429,
      "RATE_LIMITED",
      "Too many exports in a short time. Please wait a moment.",
      { retryAfterMs: limit.retryAfterMs },
    );
  }

  const url = new URL(req.url);
  const days = normalizeReportDays(url.searchParams.get("days"));

  // Prompt 52 §F4 — optional explicit local-day window (Jalali presets);
  // identical validation to the summary route.
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  let custom: { from: string; to: string } | undefined;
  if (fromRaw !== null || toRaw !== null) {
    if (fromRaw === null || toRaw === null) {
      throw new ApiErr(422, "VALIDATION_ERROR", "from and to must be provided together.");
    }
    custom = { from: fromRaw, to: toRaw };
    try {
      resolveCustomRange(ctx.business.timezone || "UTC", custom.from, custom.to, new Date());
    } catch (error) {
      if (error instanceof ReportRangeError) {
        throw new ApiErr(422, "INVALID_REPORT_RANGE", error.message, { field: error.field });
      }
      throw error;
    }
  }

  const summary = await buildReportSummary(ctx.businessId, days, custom);
  const business = ctx.business;
  const precision = business.decimalPrecision ?? 2;

  // Integer-minor → decimal-string presentation (A08: no float math on
  // stored values; conversion happens once, deterministically, at output).
  const money = (minor: number) => fromMinor(minor, precision).toFixed(precision);

  const lines: string[] = [];
  const B = business.currencyCode;

  // Meta
  lines.push(csvRow(["section", "field", "value"]));
  lines.push(csvRow(["meta", "business", business.name]));
  lines.push(csvRow(["meta", "currency", B]));
  lines.push(csvRow(["meta", "range_days", days]));
  lines.push(csvRow(["meta", "from", summary.range.from]));
  lines.push(csvRow(["meta", "to", summary.range.to]));
  lines.push(csvRow(["meta", "timezone", summary.range.timezone]));
  lines.push(csvRow(["meta", "generated_at", new Date().toISOString()]));

  // KPIs
  lines.push(csvRow(["kpi", `revenue_issued_${B}`, money(summary.kpis.revenueMinor)]));
  lines.push(csvRow(["kpi", "sales_count", summary.kpis.salesCount]));
  lines.push(csvRow(["kpi", `cash_collected_${B}`, money(summary.kpis.collectedMinor)]));
  lines.push(csvRow(["kpi", `expenses_${B}`, money(summary.kpis.expensesMinor)]));
  lines.push(csvRow(["kpi", "expenses_count", summary.kpis.expensesCount]));
  lines.push(csvRow(["kpi", `paid_out_${B}`, money(summary.kpis.paidOutMinor)]));
  lines.push(csvRow(["kpi", `net_cash_${B}`, money(summary.kpis.netCashMinor)]));
  lines.push(csvRow(["kpi", `net_accrual_${B}`, money(summary.kpis.netAccrualMinor)]));

  // Daily timeline
  lines.push("");
  lines.push(csvRow(["daily", "date", `revenue_${B}`, `expenses_${B}`, `collected_${B}`, `paid_out_${B}`]));
  for (const d of summary.timeline) {
    lines.push(
      csvRow(["daily", d.date, money(d.revenueMinor), money(d.expenseMinor), money(d.collectedMinor), money(d.paidOutMinor)]),
    );
  }

  // Expenses by category
  lines.push("");
  lines.push(csvRow(["category", "name", `amount_${B}`]));
  for (const c of summary.expensesByCategory) {
    lines.push(csvRow(["category", c.category, money(c.totalMinor)]));
  }

  // Top products
  lines.push("");
  lines.push(csvRow(["product", "name", "qty", `revenue_${B}`]));
  for (const p of summary.topProducts) {
    lines.push(csvRow(["product", p.name, p.qty, money(p.revenueMinor)]));
  }

  // Outstanding + inventory
  lines.push("");
  lines.push(csvRow(["balance", "receivable_total", money(summary.outstanding.receivableMinor)]));
  lines.push(csvRow(["balance", "receivable_open_invoices", summary.outstanding.receivableCount]));
  lines.push(csvRow(["balance", "payable_total", money(summary.outstanding.payableMinor)]));
  lines.push(csvRow(["balance", "payable_open_bills", summary.outstanding.payableCount]));
  lines.push(csvRow(["inventory", "value_at_cost", money(summary.inventory.valueMinor)]));
  lines.push(csvRow(["inventory", "active_products", summary.inventory.productCount]));
  lines.push(csvRow(["inventory", "low_stock_items", summary.inventory.lowStockCount]));

  // R134 — previous-window comparison (the additive `trend` block, ONE
  // source of truth: the same buildReportSummary aggregates the panel and
  // the chips narrate). Field names mirror the kpi section exactly so a
  // spreadsheet diff of the two windows is a column-by-column operation.
  lines.push("");
  lines.push(csvRow(["previous_window", "from", summary.trend.previousRange.from]));
  lines.push(csvRow(["previous_window", "to", summary.trend.previousRange.to]));
  lines.push(csvRow(["previous_window", `revenue_issued_${B}`, money(summary.trend.revenuePrevMinor)]));
  lines.push(csvRow(["previous_window", "sales_count", summary.trend.salesCountPrev]));
  lines.push(csvRow(["previous_window", `cash_collected_${B}`, money(summary.trend.collectedPrevMinor)]));
  lines.push(csvRow(["previous_window", `expenses_${B}`, money(summary.trend.expensesPrevMinor)]));
  lines.push(csvRow(["previous_window", "expenses_count", summary.trend.expensesCountPrev]));
  lines.push(csvRow(["previous_window", `paid_out_${B}`, money(summary.trend.paidOutPrevMinor)]));
  lines.push(csvRow(["previous_window", `net_cash_${B}`, money(summary.trend.netCashPrevMinor)]));
  lines.push(csvRow(["previous_window", `net_accrual_${B}`, money(summary.trend.netAccrualPrevMinor)]));

  const csv = `\uFEFF${lines.join("\r\n")}\r\n`; // BOM so Excel opens UTF-8 cleanly
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const filename = `report-${business.slug || "business"}-${days}d-${stamp}.csv`;

  void audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "data.export",
    entityType: "ReportCSV",
    entityId: null,
    after: { format: "csv", days, previousWindow: true },
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
