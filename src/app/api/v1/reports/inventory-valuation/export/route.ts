/**
 * GET /api/v1/reports/inventory-valuation/export — Prompt 51 (§7) CSV.
 *
 * Generated from the SAME calculation service as the JSON endpoint
 * (single-calculation law — the export can never drift from the UI).
 *
 * ENTITLEMENT: the existing CSV_EXPORT entitlement, enforced SERVER-SIDE
 * (§7.1 — UI hiding is never the enforcement). No new export entitlement.
 * Rate limited like every export (10 / 5 min / user); audited "data.export".
 *
 * COMPLETE OR REJECT (§7.2): the export contains EVERY matching product
 * or is rejected — an over-cap result is a stable 413, never a partial
 * file with HTTP 200.
 *
 * CSV conventions preserved from the established export routes: UTF-8 BOM,
 * CRLF, formula-injection protection (csvCell), stable headers/order,
 * safe attachment filename, no-store, and a summary section that
 * reconciles with the exported rows (§7.5) labeled as the current
 * operational estimate.
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
  INVENTORY_EXPORT_MAX_ROWS,
  InventoryReportTooLargeError,
  buildInventoryValuationExport,
  parseInventoryFilters,
} from "@/lib/inventory-valuation-report";
import { ReportRangeError } from "@/lib/report-periods";

export const dynamic = "force-dynamic";

function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // §7.1 — server-side CSV_EXPORT gate, fresh read (§111).
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
  let filters;
  try {
    filters = parseInventoryFilters(params);
  } catch (error) {
    if (error instanceof ReportRangeError) {
      throw new ApiError(422, "VALIDATION_ERROR", error.message, { field: error.field });
    }
    throw error;
  }

  let data;
  try {
    data = await buildInventoryValuationExport(ctx.businessId, filters);
  } catch (error) {
    if (error instanceof InventoryReportTooLargeError) {
      throw new ApiError(
        413,
        "REPORT_TOO_LARGE",
        "This business has more products than the valuation report can process completely.",
      );
    }
    throw error;
  }
  // §7.2 — complete or reject: over-cap exports are REJECTED, never trimmed.
  if (data.rows.length > INVENTORY_EXPORT_MAX_ROWS) {
    throw new ApiError(
      413,
      "EXPORT_TOO_LARGE",
      "Too many matching products to export. Narrow the filters and try again.",
    );
  }

  const business = ctx.business;
  const precision = business.decimalPrecision ?? 2;
  // Integer-minor → decimal-string presentation (A08: conversion happens
  // once, deterministically, at output — never float arithmetic).
  const money = (minor: number) => fromMinor(minor, precision).toFixed(precision);
  const B = business.currencyCode;

  const lines: string[] = [];
  lines.push(csvRow(["section", "field", "value"]));
  lines.push(csvRow(["meta", "business", business.name]));
  lines.push(csvRow(["meta", "currency", B]));
  lines.push(csvRow(["meta", "report", "inventory-valuation"]));
  lines.push(csvRow(["meta", "basis", "current_operational_estimate (stockQty × current costPriceMinor)"]));
  lines.push(csvRow(["meta", "limitation", "current costs only — not a historical or accounting valuation"]));
  lines.push(csvRow(["meta", "search", filters.q ?? ""]));
  lines.push(csvRow(["meta", "cost_state", filters.costState]));
  lines.push(csvRow(["meta", "stock_state", filters.stockState]));
  lines.push(csvRow(["meta", "activity", filters.activity]));
  lines.push(csvRow(["meta", "sort", filters.sort]));
  lines.push(csvRow(["meta", "generated_at", new Date().toISOString()]));

  // Summary (§7.5) — reconciles with the rows below, nothing else mixed in.
  lines.push("");
  lines.push(csvRow(["summary", `total_operational_value_${B}`, money(data.totals.estimatedValueMinor)]));
  lines.push(csvRow(["summary", "products_exported", data.rows.length]));
  lines.push(csvRow(["summary", "positive_stock_products", data.totals.positiveStockCount]));
  lines.push(csvRow(["summary", "zero_stock_products", data.totals.zeroStockCount]));
  lines.push(csvRow(["summary", "negative_stock_products", data.totals.negativeStockCount]));
  lines.push(csvRow(["summary", "positive_stock_zero_current_cost", data.totals.zeroCostPositiveStockCount]));
  lines.push(csvRow(["summary", "inactive_products", data.totals.inactiveCount]));
  lines.push(csvRow(["summary", "low_stock_products", data.totals.lowStockCount]));

  lines.push("");
  lines.push(
    csvRow([
      "product",
      "product_id",
      "name",
      "sku",
      "unit",
      "stock_qty",
      `unit_cost_${B}`,
      `estimated_value_${B}`,
      "status",
      "cost_state",
      "stock_state",
    ]),
  );
  for (const r of data.rows) {
    lines.push(
      csvRow([
        "product",
        r.id,
        r.name,
        r.sku ?? "",
        r.unit ?? "",
        r.stockQty,
        money(r.costPriceMinor),
        money(r.estimatedValueMinor),
        r.isActive ? "active" : "inactive",
        r.costState === "POSITIVE_COST" ? "positive_cost" : "zero_current_cost",
        r.stockState === "POSITIVE_STOCK"
          ? "positive_stock"
          : r.stockState === "LOW_STOCK"
            ? "low_stock"
            : r.stockState === "ZERO_STOCK"
              ? "zero_stock"
              : "negative_stock",
      ]),
    );
  }

  const csv = `\uFEFF${lines.join("\r\n")}\r\n`; // BOM so Excel opens UTF-8 cleanly
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const filename = `inventory-valuation-${business.slug || "business"}-${stamp}.csv`;

  void audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "data.export",
    entityType: "InventoryValuationCSV",
    entityId: null,
    after: {
      format: "csv",
      rows: data.rows.length,
      search: filters.q,
      costState: filters.costState,
      stockState: filters.stockState,
      activity: filters.activity,
      sort: filters.sort,
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
