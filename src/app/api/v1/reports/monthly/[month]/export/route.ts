/**
 * GET /api/v1/reports/monthly/[month]/export — single-month drill-down CSV.
 *
 * Companion to GET /api/v1/reports/monthly/[month]: the month dialog's
 * "Export CSV" button.
 *
 * Prompt 50 (§10) — COMPLETE OR REJECT: the exporter no longer consumes the
 * bounded 25-row JSON preview. buildMonthDetailComplete() extracts ALL
 * qualifying month rows in bounded keyset chunks; when a section exceeds
 * MONTH_EXPORT_MAX_ROWS the export is REJECTED with a stable 413 — a
 * partial file with HTTP 200 is impossible. Exported totals and rows cover
 * the SAME month and criteria (GATE H).
 *
 * Prompt 50 (§10.1) — CSV_EXPORT entitlement: enforced server-side exactly
 * like the main summary export (same single entitlement; UI hiding is never
 * the enforcement, §34/§111).
 *
 * Money law (A08): integer minor units → decimal string only at
 * serialization. Permission: data:read. Rate limited: 10 / 5 min / user
 * (shared budget shape with reports/export). Audited: "data.export".
 */
import { NextRequest, NextResponse } from "next/server";
import { ApiError, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { assertFeatureAccess } from "@/lib/billing";
import { fromMinor } from "@/lib/money";
import { buildMonthDetailComplete } from "@/lib/reports";
import { csvCell } from "@/lib/csv";

export const dynamic = "force-dynamic";

function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

type RouteParams = { params: Promise<{ month: string }> };

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { month } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // §10.1 — server-side CSV export gate, same single entitlement as the
  // main report export (fresh read §111).
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

  // COMPLETE extraction (bounded keyset chunks) — never the 25-row preview.
  const complete = await buildMonthDetailComplete(ctx.businessId, decodeURIComponent(month));
  if (!complete) {
    throw new ApiError(404, "NOT_FOUND", "Unknown month. Expected YYYY-MM.");
  }
  if (complete.status === "too-large") {
    // §10 — controlled rejection, never a silently truncated success.
    throw new ApiError(
      413,
      "EXPORT_TOO_LARGE",
      `This month has more than ${complete.max} ${complete.section} to export. Use the Sales/Expenses module for the full list.`,
      { section: complete.section, max: complete.max },
    );
  }
  const rows = complete.rows;

  const business = ctx.business;
  const precision = business.decimalPrecision ?? 2;
  // Integer-minor → decimal-string presentation (A08).
  const money = (minor: number) => fromMinor(minor, precision).toFixed(precision);
  const B = business.currencyCode;

  const lines: string[] = [];

  // Meta
  lines.push(csvRow(["section", "field", "value"]));
  lines.push(csvRow(["meta", "business", business.name]));
  lines.push(csvRow(["meta", "currency", B]));
  lines.push(csvRow(["meta", "month", rows.month]));
  lines.push(csvRow(["meta", "timezone", rows.timezone]));
  lines.push(csvRow(["meta", "sales_rows", rows.sales.length]));
  lines.push(csvRow(["meta", "expense_rows", rows.expenses.length]));
  lines.push(csvRow(["meta", "generated_at", new Date().toISOString()]));

  // Totals — revenue/expenses/counts derive from the COMPLETE exported rows
  // themselves so the KPI section and row sections can never disagree
  // (§10.2); collected/paid-out are the actual Payment aggregates on the
  // SAME window (never derived from invoice totals, §2.2).
  let revenueMinor = 0;
  for (const s of rows.sales) revenueMinor += s.totalMinor;
  let expensesMinor = 0;
  for (const e of rows.expenses) expensesMinor += e.amountMinor;

  lines.push("");
  lines.push(csvRow(["kpi", `revenue_issued_${B}`, money(revenueMinor)]));
  lines.push(csvRow(["kpi", "sales_count", rows.sales.length]));
  lines.push(csvRow(["kpi", `expenses_${B}`, money(expensesMinor)]));
  lines.push(csvRow(["kpi", "expenses_count", rows.expenses.length]));
  lines.push(csvRow(["kpi", `collected_${B}`, money(rows.collectedMinor)]));
  lines.push(csvRow(["kpi", `paid_out_${B}`, money(rows.paidOutMinor)]));
  lines.push(csvRow(["kpi", `net_cash_${B}`, money(rows.collectedMinor - rows.paidOutMinor)]));
  lines.push(csvRow(["kpi", `net_accrual_${B}`, money(revenueMinor - expensesMinor)]));

  // Sales in month — ALL rows (complete section)
  lines.push("");
  lines.push(
    csvRow([
      "sale",
      "number",
      "date",
      "customer",
      `total_${B}`,
      `paid_${B}`,
      `balance_${B}`,
      "status",
    ]),
  );
  for (const s of rows.sales) {
    lines.push(
      csvRow([
        "sale",
        s.number,
        s.issueDate.slice(0, 10),
        s.customerName ?? "",
        money(s.totalMinor),
        money(s.paidMinor),
        money(s.balanceMinor),
        s.status,
      ]),
    );
  }

  // Expenses in month — ALL rows (complete section)
  lines.push("");
  lines.push(
    csvRow([
      "expense",
      "date",
      "category",
      "supplier",
      `amount_${B}`,
      `paid_${B}`,
      `balance_${B}`,
      "status",
    ]),
  );
  for (const e of rows.expenses) {
    lines.push(
      csvRow([
        "expense",
        e.spentAt.slice(0, 10),
        e.category,
        e.supplierName ?? "",
        money(e.amountMinor),
        money(e.paidMinor),
        money(e.balanceMinor),
        e.status,
      ]),
    );
  }

  const csv = `\uFEFF${lines.join("\r\n")}\r\n`; // BOM so Excel opens UTF-8 cleanly
  const filename = `report-${business.slug || "business"}-${rows.month}.csv`;

  void audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "data.export",
    entityType: "ReportMonthCSV",
    entityId: rows.month,
    after: { format: "csv", month: rows.month, salesRows: rows.sales.length, expenseRows: rows.expenses.length },
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
