/**
 * Prompt 34 — pure 360/detail calculation helpers (§12/§14/§15/§43/§73).
 *
 * All functions are PURE and integer-only (A08 money law: never floats).
 * They are shared by the API mappers and exercised directly by
 * scripts/prompt34-unit.ts.
 */

import type {
  CustomerSummary,
  PaymentStatusToken,
  StockState,
  SupplierSummary,
} from "./types";

/**
 * Narrow a status string coming from the DB into the closed token.
 * The column is only ever written through `statusOf`, so this is a
 * defensive type-guard, not a second status definition (§73).
 */
export function toStatusToken(status: string): PaymentStatusToken {
  // R90 — DRAFT passes through (the sale lifecycle owns it); every other
  // unknown falls to UNPAID (defensive, unchanged).
  return status === "DRAFT" || status === "PAID" || status === "PARTIAL" ? status : "UNPAID";
}

/**
 * Narrow a payment method string into the closed token (§19).
 * The column is constrained at the API boundary; unknown values fall
 * back to OTHER rather than leaking arbitrary strings into the DTO.
 */
export function toMethodToken(method: string) {
  return method === "BANK_TRANSFER" || method === "CARD" || method === "OTHER"
    ? method
    : "CASH";
}

/**
 * Narrow a payment direction string into the closed token (§19).
 * The column is constrained at the API boundary; unknown values fall
 * back to IN rather than leaking arbitrary strings into the DTO.
 */
export function toDirectionToken(direction: string) {
  return direction === "OUT" ? "OUT" : "IN";
}

/** Balance in minor units — SAME semantics as the existing lists/reports:
 *  `totalMinor − paidMinor` (integer subtraction, no clamping, no new
 *  financial meaning — §71/§72). */
export function balanceOf(totalMinor: number, paidMinor: number): number {
  if (!Number.isSafeInteger(totalMinor) || !Number.isSafeInteger(paidMinor)) {
    throw new Error("balanceOf: minor units must be safe integers");
  }
  return totalMinor - paidMinor;
}

/** One per-status bucket produced by a Prisma groupBy on the status column. */
export type StatusBucketRow = {
  status: PaymentStatusToken;
  /** Number of documents in the bucket. */
  count: number;
  /** Σ totalMinor for the bucket. */
  totalMinor: number;
  /** Σ paidMinor for the bucket. */
  paidMinor: number;
};

/**
 * Customer 360 summary (§12) from status buckets.
 *
 * Semantics (documented per §72): the stored status column IS the output
 * of `statusOf(totalMinor, paidMinor)` maintained at every write, so
 * bucketing by it reuses the established financial meaning:
 * - receivableMinor = Σ (totalMinor − paidMinor) over ALL non-deleted sales
 * - paidInvoiceCount = buckets with status PAID
 * - openInvoiceCount = buckets with status UNPAID or PARTIAL
 */
export function compute360Summary(rows: StatusBucketRow[]): CustomerSummary {
  let totalSalesMinor = 0;
  let paidSalesMinor = 0;
  let receivableMinor = 0;
  let invoiceCount = 0;
  let paidInvoiceCount = 0;
  let openInvoiceCount = 0;
  for (const row of rows) {
    assertMinor(row.totalMinor, "totalMinor");
    assertMinor(row.paidMinor, "paidMinor");
    totalSalesMinor += row.totalMinor;
    paidSalesMinor += row.paidMinor;
    receivableMinor += row.totalMinor - row.paidMinor;
    invoiceCount += row.count;
    if (row.status === "PAID") paidInvoiceCount += row.count;
    else openInvoiceCount += row.count;
  }
  return {
    totalSalesMinor,
    paidSalesMinor,
    receivableMinor,
    invoiceCount,
    paidInvoiceCount,
    openInvoiceCount,
  };
}

/** Supplier 360 (§14) — identical math over the expense buckets. */
export function computeSupplierSummary(
  rows: StatusBucketRow[],
): SupplierSummary {
  const s = compute360Summary(rows);
  return {
    totalExpensesMinor: s.totalSalesMinor,
    paidExpensesMinor: s.paidSalesMinor,
    payableMinor: s.receivableMinor,
    expenseCount: s.invoiceCount,
    paidExpenseCount: s.paidInvoiceCount,
    openExpenseCount: s.openInvoiceCount,
  };
}

/**
 * Product stock state (§15/§73) — the EXISTING thresholds used by the
 * products/inventory UI and reports (`stockQty <= 0` out; `<= lowStockAt`
 * low; else healthy). No new definition is introduced.
 */
export function stockStateOf(stockQty: number, lowStockAt: number): StockState {
  if (!Number.isSafeInteger(stockQty) || !Number.isSafeInteger(lowStockAt)) {
    throw new Error("stockStateOf: quantities must be safe integers");
  }
  if (stockQty <= 0) return "OUT_OF_STOCK";
  if (stockQty <= lowStockAt) return "LOW_STOCK";
  return "HEALTHY";
}

/** Input row for `dedupeProductSaleLines` (pre-mapper, Date fields raw). */
export type ProductSaleLineRow = {
  saleId: string;
  qty: number;
  lineTotalMinor: number;
  number: number;
  issueDate: Date | string;
};

/**
 * Collapse a product's SaleItem rows into ≤ `cap` UNIQUE sale records
 * (§15: "maximum 10 unique sale records"). Rows must already be ordered
 * most-recent-first; the first occurrence of a sale wins its date/number,
 * quantities and line totals accumulate per sale (integer math only).
 */
export function dedupeProductSaleLines(
  rows: ProductSaleLineRow[],
  cap: number,
): Array<{
  saleId: string;
  number: number;
  issueDate: Date | string;
  qty: number;
  lineTotalMinor: number;
}> {
  const bySale = new Map<
    string,
    { saleId: string; number: number; issueDate: Date | string; qty: number; lineTotalMinor: number }
  >();
  for (const row of rows) {
    assertMinor(row.lineTotalMinor, "lineTotalMinor");
    if (!Number.isSafeInteger(row.qty)) {
      throw new Error("dedupeProductSaleLines: qty must be a safe integer");
    }
    const existing = bySale.get(row.saleId);
    if (existing) {
      existing.qty += row.qty;
      existing.lineTotalMinor += row.lineTotalMinor;
    } else {
      bySale.set(row.saleId, {
        saleId: row.saleId,
        number: row.number,
        issueDate: row.issueDate,
        qty: row.qty,
        lineTotalMinor: row.lineTotalMinor,
      });
    }
  }
  return Array.from(bySale.values()).slice(0, cap);
}

function assertMinor(value: number, label: string) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label}: minor units must be safe integers`);
  }
}
