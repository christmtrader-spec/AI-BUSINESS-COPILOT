/**
 * Prompt 40 — Inventory Stocktake domain types + pure laws (client-safe).
 *
 * SCOPE LAW (§3/§248): a stocktake is a CONTROLLED PHYSICAL COUNT session.
 * It is NOT accounting: no ledger, no journal, no valuation layers, no P&L.
 * Finalization reconciles ONLY Product.stockQty through the EXISTING
 * InventoryAdjustment semantics — never Sale/Expense/Payment/Statement/CRM.
 *
 * This module is pure: no Prisma, no db, no server-only imports. Safe for
 * client bundles (§118 — server-only boundaries).
 */

/* ------------------------------ §8 lifecycle ------------------------------ */

export const STOCKTAKE_STATUSES = [
  "DRAFT",
  "COUNTING",
  "REVIEW",
  "FINALIZED",
  "CANCELLED",
] as const;

export type StocktakeStatus = (typeof STOCKTAKE_STATUSES)[number];

export function isStocktakeStatus(value: string): value is StocktakeStatus {
  return (STOCKTAKE_STATUSES as readonly string[]).includes(value);
}

/** §7 — closed count-type vocabulary; Prompt 40 implements SELECTED only. */
export const STOCKTAKE_COUNT_TYPES = ["SELECTED"] as const;

export type StocktakeCountType = (typeof STOCKTAKE_COUNT_TYPES)[number];

export function isStocktakeCountType(value: string): value is StocktakeCountType {
  return (STOCKTAKE_COUNT_TYPES as readonly string[]).includes(value);
}

/* --------------------------- §8/§9 state machine --------------------------- */

/** Allowed transitions, server-authoritative (§9). Everything else → 422. */
export const STOCKTAKE_TRANSITIONS: Readonly<
  Record<StocktakeStatus, readonly StocktakeStatus[]>
> = {
  DRAFT: ["COUNTING", "CANCELLED"],
  COUNTING: ["REVIEW", "CANCELLED"],
  REVIEW: ["COUNTING", "FINALIZED", "CANCELLED"],
  FINALIZED: [],
  CANCELLED: [],
};

export function canTransitionStocktake(
  from: StocktakeStatus,
  to: StocktakeStatus,
): boolean {
  return STOCKTAKE_TRANSITIONS[from].includes(to);
}

/* ----------------------------- §17 quantities ----------------------------- */

/** §17 — countedQty is an integer, 0..1_000_000_000. No float/NaN/Infinity. */
export const COUNTED_QTY_MAX = 1_000_000_000;

export function isValidCountedQty(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= COUNTED_QTY_MAX
  );
}

/** §16/§18 — variance = counted − system. Sign is meaningful; never abs(). */
export function computeVarianceQty(countedQty: number, systemQtyAtCount: number): number {
  return countedQty - systemQtyAtCount;
}

/* ------------------------------ §61 line cap ------------------------------ */

export const STOCKTAKE_LINE_CAP_DEFAULT = 1000;
export const STOCKTAKE_LINE_CAP_MIN = 100;
export const STOCKTAKE_LINE_CAP_MAX = 5000;

export function stocktakeLineCap(env: string | undefined | null): number {
  const parsed = Number.parseInt(String(env ?? "").trim(), 10);
  if (!Number.isInteger(parsed)) return STOCKTAKE_LINE_CAP_DEFAULT;
  if (parsed < STOCKTAKE_LINE_CAP_MIN) return STOCKTAKE_LINE_CAP_MIN;
  if (parsed > STOCKTAKE_LINE_CAP_MAX) return STOCKTAKE_LINE_CAP_MAX;
  return parsed;
}

/* ------------------------------ §22 reference ----------------------------- */

export const STOCKTAKE_REFERENCE_MIN = 2;
export const STOCKTAKE_REFERENCE_MAX = 80;
export const STOCKTAKE_NOTES_MAX = 2000;

/* ----------------------------- §36/§37 summary ---------------------------- */

export type StocktakeSummary = {
  lineCount: number;
  countedLineCount: number;
  pendingLineCount: number;
  positiveVarianceLineCount: number;
  negativeVarianceLineCount: number;
  zeroVarianceLineCount: number;
  increaseVarianceUnits: number;
  decreaseVarianceUnits: number;
  netVarianceUnits: number;
};

export type StocktakeSummaryLine = {
  countedAt: Date | string | null;
  varianceQty: number | null;
};

/**
 * Counted-line sentinel law: uncounted lines are stored (non-nullable
 * columns) as countedAt = epoch-0 (1970-01-01T00:00:00Z) with placeholder
 * quantities. A line counts as COUNTED only when countedAt is non-null AND
 * not the epoch sentinel. This is the SINGLE source of the rule — used by
 * the summary, the list DTO and the line DTO alike (p40-unit discovery:
 * the summary originally missed the epoch sentinel, always reporting
 * pending = 0).
 */
export function isCountedLine(countedAt: Date | string | null | undefined): boolean {
  if (countedAt == null) return false;
  return new Date(countedAt).getTime() !== 0;
}

/** §36/§37 — server-derived review summary from plain line shapes. */
export function computeStocktakeSummary(lines: readonly StocktakeSummaryLine[]): StocktakeSummary {
  const lineCount = lines.length;
  let counted = 0;
  let positive = 0;
  let negative = 0;
  let zero = 0;
  let increase = 0;
  let decrease = 0;
  for (const line of lines) {
    if (!isCountedLine(line.countedAt)) continue; // pending (null or epoch-0 sentinel)
    counted += 1;
    const v = line.varianceQty;
    if (v == null) continue;
    if (v > 0) {
      positive += 1;
      increase += v;
    } else if (v < 0) {
      negative += 1;
      decrease += -v; // §36 — decrease units reported as a positive magnitude
    } else {
      zero += 1;
    }
  }
  return {
    lineCount,
    countedLineCount: counted,
    pendingLineCount: lineCount - counted,
    positiveVarianceLineCount: positive,
    negativeVarianceLineCount: negative,
    zeroVarianceLineCount: zero,
    increaseVarianceUnits: increase,
    decreaseVarianceUnits: decrease,
    netVarianceUnits: increase - decrease,
  };
}

/* ------------------------------ §138 errors ------------------------------- */

export const STOCKTAKE_ERROR_CODES = {
  INVALID_TRANSITION: "INVALID_STOCKTAKE_TRANSITION",
  DUPLICATE_PRODUCT: "DUPLICATE_STOCKTAKE_PRODUCT",
  STALE_COUNT: "STOCKTAKE_STALE_COUNT",
  PRODUCT_INACTIVE: "STOCKTAKE_PRODUCT_INACTIVE",
  LINE_LIMIT: "STOCKTAKE_LINE_LIMIT_REACHED",
} as const;
