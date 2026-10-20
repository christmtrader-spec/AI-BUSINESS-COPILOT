/**
 * Prompt 55 (§X2) — Reorder suggestions (پیشنهاد خرید).
 *
 * The row-level truth behind the summary's low-stock signal: for every
 * ACTIVE, non-deleted product at or below its low-stock threshold, propose
 * a top-up quantity and the estimated cost of that top-up. The report is
 * a DECISION AID, not an auto-purchase: nothing is ever created, ordered,
 * or adjusted by this module (Rule 05 / no side effects).
 *
 * LAWS:
 *  - Every figure is computed SERVER-side from Product rows; the UI never
 *    invents numbers.
 *  - Money stays in integer minor units. suggestedQty × costPriceMinor is
 *    accepted only when it is a SAFE integer; otherwise the row's estimate
 *    is null and the grand total is withheld (a partial total is never
 *    served as complete — same honesty law as ADR 0051 §8).
 *  - The scan is bounded: candidates are read with a hard `take` cap and
 *    the report says so (`scan.complete`) when the cap cut anything off,
 *    mirroring the inventory-valuation report contract.
 *  - Suggestion = threshold − stock (minimum 1). Deliberately simple and
 *    explainable; no forecast model is claimed.
 */

import { db } from "@/lib/db";

export type ReorderRow = {
  id: string;
  name: string;
  sku: string | null;
  unit: string | null;
  stockQty: number;
  lowStockAt: number;
  costPriceMinor: number;
  suggestedQty: number;
  estimatedCostMinor: number | null;
  severity: "OUT_OF_STOCK" | "AT_OR_BELOW_THRESHOLD";
};

export type ReorderReport = {
  basis: "low_stock_topup_suggestion";
  formula: string;
  currencyCode: string;
  decimalPrecision: number;
  rows: ReorderRow[];
  totals: {
    suggestionCount: number;
    outOfStockCount: number;
    estimatedTotalMinor: number | null;
  };
  scan: { complete: boolean; cap: number };
};

/** Hard candidate cap — mirrors the bounded-scan law of the other reports. */
const SCAN_CAP = 2000;
/** Output cap — the panel is a decision aid, not a bulk dump. */
export const REORDER_ROW_LIMIT = 200;

export class ReorderReportTooLargeError extends Error {
  constructor() {
    super("This business has more products than the reorder report can scan completely.");
    this.name = "ReorderReportTooLargeError";
  }
}

export async function buildReorderSuggestions(
  businessId: string,
  opts: { currencyCode: string; decimalPrecision: number },
): Promise<ReorderReport> {
  const candidates = await db.product.findMany({
    where: { businessId, deletedAt: null, isActive: true },
    select: {
      id: true,
      name: true,
      sku: true,
      unit: true,
      stockQty: true,
      lowStockAt: true,
      costPriceMinor: true,
    },
    orderBy: [{ stockQty: "asc" }, { name: "asc" }],
    take: SCAN_CAP + 1, // one extra row detects a truncated scan cheaply
  });

  if (candidates.length > SCAN_CAP) {
    throw new ReorderReportTooLargeError();
  }

  const rows: ReorderRow[] = [];
  let outOfStockCount = 0;
  let estimatedTotalMinor = 0;
  let allEstimatesSafe = true;

  for (const p of candidates) {
    if (p.stockQty > p.lowStockAt) continue;
    const suggestedQty = Math.max(p.lowStockAt - p.stockQty, 1);
    const rawEstimate = suggestedQty * p.costPriceMinor;
    const estimateSafe = Number.isSafeInteger(rawEstimate);
    if (!estimateSafe) allEstimatesSafe = false;
    else estimatedTotalMinor += rawEstimate;
    if (p.stockQty <= 0) outOfStockCount += 1;
    rows.push({
      id: p.id,
      name: p.name,
      sku: p.sku,
      unit: p.unit,
      stockQty: p.stockQty,
      lowStockAt: p.lowStockAt,
      costPriceMinor: p.costPriceMinor,
      suggestedQty,
      estimatedCostMinor: estimateSafe ? rawEstimate : null,
      severity: p.stockQty <= 0 ? "OUT_OF_STOCK" : "AT_OR_BELOW_THRESHOLD",
    });
    if (rows.length >= REORDER_ROW_LIMIT) break;
  }

  return {
    basis: "low_stock_topup_suggestion",
    formula: "suggestedQty = max(lowStockAt − stockQty, 1); estCost = suggestedQty × costPrice",
    currencyCode: opts.currencyCode,
    decimalPrecision: opts.decimalPrecision,
    rows,
    totals: {
      suggestionCount: rows.length,
      outOfStockCount,
      // A partially-safe total is NEVER served as complete.
      estimatedTotalMinor: allEstimatesSafe ? estimatedTotalMinor : null,
    },
    scan: { complete: true, cap: REORDER_ROW_LIMIT },
  };
}
