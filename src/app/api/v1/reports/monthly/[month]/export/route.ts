/**
 * GET /api/v1/reports/monthly/[month]/export — single-month drill-down CSV.
 *
 * Companion to GET /api/v1/reports/monthly/[month]: the month dialog's
 * "Export CSV" button. Generated from buildMonthDetail — the SAME
 * deterministic function the dialog renders (single source of truth,
 * no number can drift between UI and export).
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
import { fromMinor } from "@/lib/money";
import { buildMonthDetail } from "@/lib/reports";
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

  const limit = rateLimit(`report-export:${ctx.userId}`, 10, 5 * 60_000);
  if (!limit.allowed) {
    throw new ApiError(
      429,
      "RATE_LIMITED",
      "Too many exports in a short time. Please wait a moment.",
      { retryAfterMs: limit.retryAfterMs },
    );
  }

  const detail = await buildMonthDetail(ctx.businessId, decodeURIComponent(month));
  if (!detail) {
    throw new ApiError(404, "NOT_FOUND", "Unknown month. Expected YYYY-MM.");
  }

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
  lines.push(csvRow(["meta", "month", detail.month]));
  lines.push(csvRow(["meta", "timezone", detail.timezone]));
  lines.push(csvRow(["meta", "generated_at", new Date().toISOString()]));

  // Totals (mirror the dialog's four KPI cells + counts)
  lines.push("");
  lines.push(csvRow(["kpi", `revenue_issued_${B}`, money(detail.totals.revenueMinor)]));
  lines.push(csvRow(["kpi", "sales_count", detail.totals.salesCount]));
  lines.push(csvRow(["kpi", `expenses_${B}`, money(detail.totals.expensesMinor)]));
  lines.push(csvRow(["kpi", "expenses_count", detail.totals.expensesCount]));
  lines.push(csvRow(["kpi", `collected_${B}`, money(detail.totals.collectedMinor)]));
  lines.push(csvRow(["kpi", `paid_out_${B}`, money(detail.totals.paidOutMinor)]));
  lines.push(csvRow(["kpi", `net_cash_${B}`, money(detail.totals.netCashMinor)]));
  lines.push(csvRow(["kpi", `net_accrual_${B}`, money(detail.totals.netAccrualMinor)]));

  // Sales in month
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
  for (const s of detail.sales) {
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

  // Expenses in month
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
  for (const e of detail.expenses) {
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
  const filename = `report-${business.slug || "business"}-${detail.month}.csv`;

  void audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "data.export",
    entityType: "ReportMonthCSV",
    entityId: detail.month,
    after: { format: "csv", month: detail.month },
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
