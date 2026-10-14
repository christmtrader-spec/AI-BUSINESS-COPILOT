/**
 * GET /api/v1/reports/performance/export — Prompt 50 (§11.5/§12) CSV.
 *
 * Generated from the SAME aggregation service as the JSON endpoint
 * (§11.5 — one calculation, never a second one for export).
 *
 * ENTITLEMENTS (§14/§15): ADVANCED_REPORTS (the report itself is advanced)
 * AND CSV_EXPORT (it is a CSV export) — both enforced server-side, fresh
 * read. Rate limited like every export (10 / 5 min / user); audited
 * "data.export".
 *
 * COMPLETE OR REJECT (§12/§15): a truncated source scan (PERFORMANCE_ROW_CAP)
 * or an over-cap row set is REJECTED with a stable controlled error — the
 * endpoint NEVER returns a partial file with HTTP 200.
 *
 * CSV conventions preserved from the established export routes: UTF-8 BOM,
 * CRLF, formula-injection protection (csvCell), stable headers/order,
 * safe attachment filename, no-store.
 */
import { NextRequest, NextResponse } from "next/server";
import { ApiError, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { assertFeatureAccess } from "@/lib/billing";
import { fromMinor } from "@/lib/money";
import { csvCell } from "@/lib/csv";
import {
  buildCashFlowPage,
  buildExpensePerformance,
  buildSalesPerformance,
  isExpenseGroupBy,
  isSalesGroupBy,
  parsePerformanceLimit,
  parsePerformanceRange,
  PERFORMANCE_EXPORT_MAX_ROWS,
  ReportRangeError,
} from "@/lib/report-performance";

export const dynamic = "force-dynamic";

function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // §14 — BOTH entitlements, server-side, fresh reads.
  await assertFeatureAccess(ctx.businessId, "ADVANCED_REPORTS");
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

  const params = req.nextUrl.searchParams;
  const kind = (params.get("kind") ?? "").trim();
  if (kind !== "sales" && kind !== "expenses" && kind !== "cashflow") {
    throw new ApiError(422, "VALIDATION_ERROR", "kind must be sales, expenses or cashflow.", {
      field: "kind",
    });
  }

  let window;
  try {
    window = parsePerformanceRange(
      ctx.business.timezone || "UTC",
      params.get("from"),
      params.get("to"),
      new Date(),
    );
  } catch (error) {
    if (error instanceof ReportRangeError) {
      throw new ApiError(422, "INVALID_REPORT_RANGE", error.message, { field: error.field });
    }
    throw error;
  }

  const groupByRaw = (params.get("groupBy") ?? "").trim();
  const business = ctx.business;
  const precision = business.decimalPrecision ?? 2;
  const money = (minor: number) => fromMinor(minor, precision).toFixed(precision);
  const B = business.currencyCode;

  const lines: string[] = [];
  const finish = (section: string) => {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const filename = `report-performance-${business.slug || "business"}-${section}-${stamp}.csv`;
    const csv = `\uFEFF${lines.join("\r\n")}\r\n`; // BOM so Excel opens UTF-8 cleanly

    void audit({
      businessId: ctx.businessId,
      actorId: ctx.userId,
      action: "data.export",
      entityType: "ReportPerformanceCSV",
      entityId: null,
      after: { format: "csv", kind, section, from: window.fromKey, to: window.toKey },
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
  };

  const metaHeader = (section: string, extra: Array<[string, string | number]>) => {
    lines.push(csvRow(["section", "field", "value"]));
    lines.push(csvRow(["meta", "business", business.name]));
    lines.push(csvRow(["meta", "currency", B]));
    lines.push(csvRow(["meta", "report", section]));
    lines.push(csvRow(["meta", "from", window.fromKey]));
    lines.push(csvRow(["meta", "to", window.toKey]));
    lines.push(csvRow(["meta", "timezone", window.timeZone]));
    for (const [k, v] of extra) lines.push(csvRow(["meta", k, v]));
    lines.push(csvRow(["meta", "generated_at", new Date().toISOString()]));
  };

  if (kind === "sales") {
    if (!isSalesGroupBy(groupByRaw)) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "groupBy must be one of product, customer, day, month.",
        { field: "groupBy" },
      );
    }
    const report = await buildSalesPerformance(ctx.businessId, window, groupByRaw);
    // §12 — complete or reject: a capped scan can never become a "complete" CSV.
    if (report.truncated) {
      throw new ApiError(
        413,
        "EXPORT_INCOMPLETE",
        "The selected range has too much activity to export. Narrow the date range and try again.",
      );
    }
    if (report.groups.length > PERFORMANCE_EXPORT_MAX_ROWS) {
      throw new ApiError(
        413,
        "EXPORT_TOO_LARGE",
        "The report has too many rows to export. Narrow the date range or grouping.",
      );
    }
    metaHeader(`sales-${report.groupBy}`, [
      ["discount_basis", "net_allocated_proportional_largest_remainder"],
    ]);
    lines.push("");
    lines.push(
      csvRow([
        "kpi",
        `revenue_issued_${B}`,
        money(report.totals.revenueMinor),
      ]),
    );
    lines.push(csvRow(["kpi", "invoice_count", report.totals.invoiceCount]));
    lines.push(csvRow(["kpi", `line_value_before_invoice_discount_${B}`, money(report.totals.lineValueMinor)]));
    lines.push(csvRow(["kpi", `invoice_discount_${B}`, money(report.totals.discountMinor)]));
    lines.push(csvRow(["kpi", `net_allocated_line_value_${B}`, money(report.totals.netLineValueMinor)]));
    lines.push("");
    if (report.groupBy === "product") {
      lines.push(
        csvRow([
          "group",
          "product_id",
          "kind",
          "name",
          "sku",
          "unit",
          "qty_sold",
          "invoice_count",
          `line_value_${B}`,
          `net_value_${B}`,
        ]),
      );
      for (const g of report.groups) {
        if (g.dimension !== "product") continue;
        lines.push(
          csvRow([
            "group",
            g.productId ?? "",
            g.kind,
            g.name,
            g.sku ?? "",
            g.unit ?? "",
            g.qtySold,
            g.invoiceCount,
            money(g.lineValueMinor),
            money(g.netValueMinor),
          ]),
        );
      }
    } else if (report.groupBy === "customer") {
      lines.push(csvRow(["group", "customer_id", "name", "invoice_count", `revenue_${B}`]));
      for (const g of report.groups) {
        if (g.dimension !== "customer") continue;
        lines.push(
          csvRow(["group", g.customerId ?? "", g.name ?? "", g.invoiceCount, money(g.revenueMinor)]),
        );
      }
    } else {
      const key = report.groupBy === "day" ? "date" : "month";
      lines.push(csvRow(["group", key, "invoice_count", `revenue_${B}`]));
      for (const g of report.groups) {
        if (g.dimension === "day" || g.dimension === "month") {
          const bucketKey = g.dimension === "day" ? g.date : g.month;
          lines.push(csvRow(["group", bucketKey, g.invoiceCount, money(g.revenueMinor)]));
        }
      }
    }
    return finish(`sales-${report.groupBy}`);
  }

  if (kind === "expenses") {
    if (!isExpenseGroupBy(groupByRaw)) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "groupBy must be one of category, supplier, day, month.",
        { field: "groupBy" },
      );
    }
    const report = await buildExpensePerformance(ctx.businessId, window, groupByRaw);
    if (report.truncated) {
      throw new ApiError(
        413,
        "EXPORT_INCOMPLETE",
        "The selected range has too much activity to export. Narrow the date range and try again.",
      );
    }
    if (report.groups.length > PERFORMANCE_EXPORT_MAX_ROWS) {
      throw new ApiError(
        413,
        "EXPORT_TOO_LARGE",
        "The report has too many rows to export. Narrow the date range or grouping.",
      );
    }
    metaHeader(`expenses-${report.groupBy}`, [["basis", "recorded_expense_on_spentAt"]]);
    lines.push("");
    lines.push(csvRow(["kpi", `expenses_recorded_${B}`, money(report.totals.amountMinor)]));
    lines.push(csvRow(["kpi", "expense_count", report.totals.expenseCount]));
    lines.push("");
    if (report.groupBy === "category") {
      lines.push(csvRow(["group", "category", "expense_count", `amount_${B}`]));
      for (const g of report.groups) {
        if (g.dimension !== "category") continue;
        lines.push(csvRow(["group", g.category, g.expenseCount, money(g.amountMinor)]));
      }
    } else if (report.groupBy === "supplier") {
      lines.push(csvRow(["group", "supplier_id", "name", "expense_count", `amount_${B}`]));
      for (const g of report.groups) {
        if (g.dimension !== "supplier") continue;
        lines.push(
          csvRow(["group", g.supplierId ?? "", g.name ?? "", g.expenseCount, money(g.amountMinor)]),
        );
      }
    } else {
      const key = report.groupBy === "day" ? "date" : "month";
      lines.push(csvRow(["group", key, "expense_count", `amount_${B}`]));
      for (const g of report.groups) {
        if (g.dimension === "day" || g.dimension === "month") {
          const bucketKey = g.dimension === "day" ? g.date : g.month;
          lines.push(csvRow(["group", bucketKey, g.expenseCount, money(g.amountMinor)]));
        }
      }
    }
    return finish(`expenses-${report.groupBy}`);
  }

  // cashflow export — complete row extraction within the documented cap:
  // page through the keyset until exhausted; reject when the cap is hit
  // (never a partial file, §12).
  {
    const allRows: Awaited<ReturnType<typeof buildCashFlowPage>>["rows"] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await buildCashFlowPage(ctx.businessId, window, null, 500, cursor);
      allRows.push(...page.rows);
      if (allRows.length > PERFORMANCE_EXPORT_MAX_ROWS) {
        throw new ApiError(
          413,
          "EXPORT_TOO_LARGE",
          "The cash-flow detail has too many rows to export. Narrow the date range.",
        );
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    metaHeader("cashflow", [["basis", "actual_payments_on_paidAt"]]);
    lines.push("");
    lines.push(csvRow(["kpi", `cash_collected_${B}`, money(sumDir(allRows, "IN"))]));
    lines.push(csvRow(["kpi", `cash_paid_out_${B}`, money(sumDir(allRows, "OUT"))]));
    lines.push(csvRow(["kpi", "payment_count", allRows.length]));
    lines.push("");
    lines.push(
      csvRow(["payment", "date", "direction", `amount_${B}`, "method", "sale_id", "sale_number", "expense_id", "expense_reference"]),
    );
    for (const r of allRows) {
      lines.push(
        csvRow([
          "payment",
          r.date,
          r.direction,
          money(r.amountMinor),
          r.method,
          r.sale?.id ?? "",
          r.sale?.number ?? "",
          r.expense?.id ?? "",
          r.expense?.reference ?? "",
        ]),
      );
    }
    return finish("cashflow");
  }
});

function sumDir(
  rows: Array<{ direction: "IN" | "OUT"; amountMinor: number }>,
  dir: "IN" | "OUT",
): number {
  return rows.filter((r) => r.direction === dir).reduce((s, r) => s + r.amountMinor, 0);
}
