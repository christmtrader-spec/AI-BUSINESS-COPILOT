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
 * Permission: data:read (all roles — mirrors the Reports view).
 * Rate limited: 10 exports / 5 min / user. Audited: "data.export".
 */
import { NextRequest, NextResponse } from "next/server";
import { ApiError, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { fromMinor } from "@/lib/money";
import { buildReportSummary, normalizeReportDays } from "@/lib/reports";
import { csvCell } from "@/lib/csv";

export const dynamic = "force-dynamic";

function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

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
  const summary = await buildReportSummary(ctx.businessId, days);
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

  const csv = `\uFEFF${lines.join("\r\n")}\r\n`; // BOM so Excel opens UTF-8 cleanly
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const filename = `report-${business.slug || "business"}-${days}d-${stamp}.csv`;

  void audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "data.export",
    entityType: "ReportCSV",
    entityId: null,
    after: { format: "csv", days },
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
