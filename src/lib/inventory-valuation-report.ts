/**
 * Prompt 51 — DETAILED INVENTORY VALUATION report service.
 *
 * ONE calculation backs BOTH the JSON API and the CSV export (the same
 * single-calculation law as every other report service): the detailed,
 * searchable breakdown of the operational inventory estimate the summary
 * has always shown (`summary.inventory.valueMinor`).
 *
 * VALUATION BASIS (ADR 0051 §3.1 — the ONLY basis this report may claim):
 *   operationalEstimatedValueMinor = stockQty × costPriceMinor
 * computed with the shared safe-integer helpers. It is a CURRENT
 * OPERATIONAL ESTIMATE built from two current, mutable fields:
 *   - NOT a historical valuation (cost history does not exist — no "as of"
 *     selector is offered and past unit costs are never reconstructed),
 *   - NOT a balance-sheet asset value, FIFO/LIFO/weighted-average,
 *     COGS, gross/net profit, or any ledger posting.
 *
 * COST-QUALITY LAW (ADR 0051 §3.3):
 *   - Zero current cost is NOT an error: free samples, promotional goods
 *     and intentional zeros are valid. The report counts
 *     "positive stock with zero current cost" and asks for review — it
 *     never rewrites costs, never infers reasons, never invents prices.
 *   - A negative cost price is financial corruption → controlled
 *     integrity error (never silently clamped).
 *   - Negative stock is a truthful operational state → NEGATIVE_STOCK
 *     rows with a (possibly negative) honest value and a data-quality
 *     count — never silently clamped to zero.
 *
 * IDENTITY LAW (Gate E twin of Prompt 50): rows key on the STABLE
 * `Product.id`; identical display names never merge and renames never
 * split. Navigation in the UI uses the id, never the name.
 *
 * INCLUSION LAW (ADR 0051 §6 — the reconciliation contract): the product
 * population is `businessId` + `deletedAt: null`, INCLUDING inactive
 * products (an inactive product can still hold stock). With default
 * filters the report total reconciles EXACTLY with
 * `summary.inventory.valueMinor` (Gate D).
 *
 * BOUNDED LAW (ADR 0051 §8): the complete matching set is scanned in
 * id-ordered chunks (no unbounded findMany) up to INVENTORY_SCAN_CAP;
 * over-cap businesses get a controlled 413 — never a partial total
 * posing as complete. Sorting/aggregates happen server-side over the
 * complete scanned set with the stable `id` tie-break; JSON pages are
 * slices of that deterministic order. Exports are complete-or-reject
 * against INVENTORY_EXPORT_MAX_ROWS.
 *
 * UNITS LAW (ADR 0051 §9): quantities in mixed units (pieces/kg/hours…)
 * are never summed into one grand total — money is summed, quantities
 * are per-row.
 *
 * NO MUTATIONS: this service only reads Product rows (§10/§11 — a report
 * request must never touch stock, costs, or any financial record).
 */
import { db } from "@/lib/db";
import {
  ReportIntegrityError,
  ReportRangeError,
  envCap,
  safeAdd,
  safeMul,
} from "@/lib/report-periods";

// ---------------------------------------------------------------------------
// Closed vocabularies (ADR 0051 §7 — validated server-side, documented)
// ---------------------------------------------------------------------------

export const INVENTORY_COST_STATES = ["ALL", "POSITIVE_COST", "ZERO_COST"] as const;
export type InventoryCostStateFilter = (typeof INVENTORY_COST_STATES)[number];

export const INVENTORY_STOCK_STATES = ["ALL", "POSITIVE_STOCK", "ZERO_STOCK", "LOW_STOCK"] as const;
export type InventoryStockStateFilter = (typeof INVENTORY_STOCK_STATES)[number];

export const INVENTORY_ACTIVITIES = ["ALL", "ACTIVE", "INACTIVE"] as const;
export type InventoryActivityFilter = (typeof INVENTORY_ACTIVITIES)[number];

export const INVENTORY_SORTS = [
  "VALUE_DESC",
  "VALUE_ASC",
  "NAME_ASC",
  "NAME_DESC",
  "QUANTITY_DESC",
  "QUANTITY_ASC",
  "COST_DESC",
] as const;
export type InventorySort = (typeof INVENTORY_SORTS)[number];

export const INVENTORY_DEFAULT_SORT: InventorySort = "VALUE_DESC";
export const INVENTORY_PAGE_SIZE_DEFAULT = 25;
export const INVENTORY_PAGE_SIZE_MIN = 1;
export const INVENTORY_PAGE_SIZE_MAX = 100;
export const INVENTORY_Q_MAX_LENGTH = 80;

/** Row-level states (a superset of the filters, for truthful labeling). */
export type InventoryRowStockState = "POSITIVE_STOCK" | "LOW_STOCK" | "ZERO_STOCK" | "NEGATIVE_STOCK";
export type InventoryRowCostState = "POSITIVE_COST" | "ZERO_COST";

// ---------------------------------------------------------------------------
// Caps (envCap law — clamped, harness-exercisable, defaults stand)
// ---------------------------------------------------------------------------

/** Hard bound on products scanned for the complete aggregates. */
export const INVENTORY_SCAN_CAP = envCap("INVENTORY_SCAN_CAP", 50_000, 100, 1_000_000);
/** Hard bound on rows a single CSV export may contain (complete-or-reject). */
export const INVENTORY_EXPORT_MAX_ROWS = envCap("INVENTORY_EXPORT_MAX_ROWS", 10_000, 10, 1_000_000);
/** Chunked keyset read size (never one unbounded findMany). */
export const INVENTORY_SCAN_CHUNK = 500;

/** The scan budget tripped — the route maps this to a controlled 413. */
export class InventoryReportTooLargeError extends Error {
  constructor(
    public scanned: number,
    public cap: number,
  ) {
    super(`inventory report scan exceeded the ${cap} product budget (scanned ${scanned})`);
    this.name = "InventoryReportTooLargeError";
  }
}

// ---------------------------------------------------------------------------
// Pure row semantics (unit-tested without a database)
// ---------------------------------------------------------------------------

export type InventoryProductInput = {
  id: string;
  name: string;
  sku: string | null;
  unit: string | null;
  stockQty: number;
  costPriceMinor: number;
  isActive: boolean;
  lowStockAt: number;
};

export type InventoryValuationRow = InventoryProductInput & {
  estimatedValueMinor: number;
  stockState: InventoryRowStockState;
  costState: InventoryRowCostState;
};

export type InventoryFilters = {
  q: string | null;
  costState: InventoryCostStateFilter;
  stockState: InventoryStockStateFilter;
  activity: InventoryActivityFilter;
  sort: InventorySort;
};

export type InventoryTotals = {
  estimatedValueMinor: number;
  productCount: number;
  positiveStockCount: number;
  zeroStockCount: number;
  negativeStockCount: number;
  zeroCostPositiveStockCount: number;
  inactiveCount: number;
  lowStockCount: number;
};

/** Truthful row state for the recorded quantity (negative is never hidden). */
export function rowStockState(stockQty: number, lowStockAt: number): InventoryRowStockState {
  if (!Number.isSafeInteger(stockQty) || !Number.isSafeInteger(lowStockAt)) {
    throw new ReportIntegrityError("product stock quantities are not safe integers");
  }
  if (stockQty < 0) return "NEGATIVE_STOCK";
  if (stockQty === 0) return "ZERO_STOCK";
  if (stockQty <= lowStockAt) return "LOW_STOCK";
  return "POSITIVE_STOCK";
}

/** Zero cost is a valid measured state (POSITIVE_COST is strictly > 0). */
export function rowCostState(costPriceMinor: number): InventoryRowCostState {
  if (!Number.isSafeInteger(costPriceMinor)) {
    throw new ReportIntegrityError("product cost prices are not safe integers");
  }
  return costPriceMinor > 0 ? "POSITIVE_COST" : "ZERO_COST";
}

/** The ONE place filter semantics live (JSON, CSV and tests share it). */
export function filterInventoryRows(
  rows: InventoryValuationRow[],
  filters: Pick<InventoryFilters, "q" | "costState" | "stockState" | "activity">,
): InventoryValuationRow[] {
  const q = filters.q;
  return rows.filter((r) => {
    if (q) {
      const name = r.name.toLowerCase();
      const sku = (r.sku ?? "").toLowerCase();
      if (!name.includes(q) && !sku.includes(q)) return false;
    }
    if (filters.costState === "POSITIVE_COST" && r.costState !== "POSITIVE_COST") return false;
    if (filters.costState === "ZERO_COST" && r.costState !== "ZERO_COST") return false;
    if (filters.stockState === "POSITIVE_STOCK" && r.stockState !== "POSITIVE_STOCK") return false;
    if (filters.stockState === "ZERO_STOCK" && r.stockState !== "ZERO_STOCK") return false;
    if (filters.stockState === "LOW_STOCK" && r.stockState !== "LOW_STOCK") return false;
    if (filters.activity === "ACTIVE" && !r.isActive) return false;
    if (filters.activity === "INACTIVE" && r.isActive) return false;
    return true;
  });
}

function byId(a: { id: string }, b: { id: string }): number {
  // Deterministic code-point order — locale-independent across runtimes.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Server-side sort over the COMPLETE set; `id` is always the final tie-break. */
export function sortInventoryRows(
  rows: InventoryValuationRow[],
  sort: InventorySort,
): InventoryValuationRow[] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    switch (sort) {
      case "VALUE_DESC":
        return b.estimatedValueMinor - a.estimatedValueMinor || byId(a, b);
      case "VALUE_ASC":
        return a.estimatedValueMinor - b.estimatedValueMinor || byId(a, b);
      case "NAME_ASC":
        return (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || byId(a, b);
      case "NAME_DESC":
        return (a.name > b.name ? -1 : a.name < b.name ? 1 : 0) || byId(a, b);
      case "QUANTITY_DESC":
        return b.stockQty - a.stockQty || byId(a, b);
      case "QUANTITY_ASC":
        return a.stockQty - b.stockQty || byId(a, b);
      case "COST_DESC":
        return b.costPriceMinor - a.costPriceMinor || byId(a, b);
    }
  });
  return sorted;
}

/** Aggregates over EXACTLY the rows passed in (the filtered set — §4.2). */
export function computeInventoryTotals(rows: InventoryValuationRow[]): InventoryTotals {
  let estimatedValueMinor = 0;
  let positiveStockCount = 0;
  let zeroStockCount = 0;
  let negativeStockCount = 0;
  let zeroCostPositiveStockCount = 0;
  let inactiveCount = 0;
  let lowStockCount = 0;
  for (const r of rows) {
    estimatedValueMinor = safeAdd(estimatedValueMinor, r.estimatedValueMinor, "inventory total");
    if (r.stockQty > 0) {
      positiveStockCount = safeAdd(positiveStockCount, 1, "positiveStockCount");
      if (r.costPriceMinor === 0) {
        zeroCostPositiveStockCount = safeAdd(zeroCostPositiveStockCount, 1, "zeroCostPositiveStockCount");
      }
    } else if (r.stockQty === 0) {
      zeroStockCount = safeAdd(zeroStockCount, 1, "zeroStockCount");
    } else {
      negativeStockCount = safeAdd(negativeStockCount, 1, "negativeStockCount");
    }
    if (!r.isActive) inactiveCount = safeAdd(inactiveCount, 1, "inactiveCount");
    if (r.stockState === "LOW_STOCK") lowStockCount = safeAdd(lowStockCount, 1, "lowStockCount");
  }
  return {
    estimatedValueMinor,
    productCount: rows.length,
    positiveStockCount,
    zeroStockCount,
    negativeStockCount,
    zeroCostPositiveStockCount,
    inactiveCount,
    lowStockCount,
  };
}

// ---------------------------------------------------------------------------
// Query parsing — closed vocab, strict numbers, bounded search (§5.2)
// ---------------------------------------------------------------------------

type SearchParamsLike = { get(name: string): string | null | undefined };

function enumOf<T extends string>(
  values: readonly T[],
  raw: string | null | undefined,
  fallback: T,
  field: string,
): T {
  const v = (raw ?? "").trim();
  if (v === "") return fallback;
  if (!(values as readonly string[]).includes(v)) {
    throw new ReportRangeError(field, `${field} must be one of ${values.join(", ")}.`);
  }
  return v as T;
}

export function parseInventoryFilters(params: SearchParamsLike): InventoryFilters {
  const qRaw = (params.get("q") ?? "").trim();
  if (qRaw.length > INVENTORY_Q_MAX_LENGTH) {
    throw new ReportRangeError("q", `q must be at most ${INVENTORY_Q_MAX_LENGTH} characters.`);
  }
  return {
    q: qRaw === "" ? null : qRaw.toLowerCase(),
    costState: enumOf(INVENTORY_COST_STATES, params.get("costState"), "ALL", "costState"),
    stockState: enumOf(INVENTORY_STOCK_STATES, params.get("stockState"), "ALL", "stockState"),
    activity: enumOf(INVENTORY_ACTIVITIES, params.get("activity"), "ALL", "activity"),
    sort: enumOf(INVENTORY_SORTS, params.get("sort"), INVENTORY_DEFAULT_SORT, "sort"),
  };
}

export function parseInventoryPage(params: SearchParamsLike): { page: number; pageSize: number } {
  const pageRaw = (params.get("page") ?? "").trim();
  const sizeRaw = (params.get("pageSize") ?? "").trim();
  const page = pageRaw === "" ? 1 : Number(pageRaw);
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new ReportRangeError("page", "page must be a positive integer.");
  }
  const pageSize = sizeRaw === "" ? INVENTORY_PAGE_SIZE_DEFAULT : Number(sizeRaw);
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < INVENTORY_PAGE_SIZE_MIN ||
    pageSize > INVENTORY_PAGE_SIZE_MAX
  ) {
    throw new ReportRangeError(
      "pageSize",
      `pageSize must be an integer between ${INVENTORY_PAGE_SIZE_MIN} and ${INVENTORY_PAGE_SIZE_MAX}.`,
    );
  }
  return { page, pageSize };
}

/** True when any dataset-changing filter is active (drives the UI label). */
export function inventoryFiltersActive(filters: InventoryFilters): boolean {
  return (
    filters.q !== null ||
    filters.costState !== "ALL" ||
    filters.stockState !== "ALL" ||
    filters.activity !== "ALL"
  );
}

// ---------------------------------------------------------------------------
// Database scan — bounded keyset chunks over the tenant-scoped population
// ---------------------------------------------------------------------------

const PRODUCT_SELECT = {
  id: true,
  name: true,
  sku: true,
  unit: true,
  stockQty: true,
  costPriceMinor: true,
  isActive: true,
  lowStockAt: true,
} as const;

/**
 * Scan the COMPLETE included product population (businessId + not deleted,
 * INCLUDING inactive — the reconciliation contract with the summary) in
 * id-ordered bounded chunks. Computes each row's operational estimate with
 * guarded arithmetic and fails loudly on corrupt costs.
 */
export async function scanInventoryValuationRows(businessId: string): Promise<InventoryValuationRow[]> {
  const rows: InventoryValuationRow[] = [];
  let lastId = "";
  let scanned = 0;
  for (;;) {
    const batch = await db.product.findMany({
      where: { businessId, deletedAt: null, ...(lastId ? { id: { gt: lastId } } : {}) },
      orderBy: { id: "asc" },
      take: INVENTORY_SCAN_CHUNK,
      select: PRODUCT_SELECT,
    });
    if (batch.length === 0) break;
    for (const p of batch) {
      if (p.costPriceMinor < 0) {
        throw new ReportIntegrityError(`product ${p.id} has a negative cost price`);
      }
      const value = safeMul(p.stockQty, p.costPriceMinor, "inventory value");
      rows.push({
        ...p,
        estimatedValueMinor: value,
        stockState: rowStockState(p.stockQty, p.lowStockAt),
        costState: rowCostState(p.costPriceMinor),
      });
    }
    scanned += batch.length;
    if (scanned > INVENTORY_SCAN_CAP) {
      throw new InventoryReportTooLargeError(scanned, INVENTORY_SCAN_CAP);
    }
    lastId = batch[batch.length - 1].id;
    if (batch.length < INVENTORY_SCAN_CHUNK) break;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Public builders — ONE calculation for JSON and CSV (single-calculation law)
// ---------------------------------------------------------------------------

export type InventoryValuationReport = {
  basis: "current_operational_estimate";
  formula: "stockQty × costPriceMinor";
  currencyCode: string;
  decimalPrecision: number;
  filters: InventoryFilters & { page: number; pageSize: number };
  filtersActive: boolean;
  totals: InventoryTotals;
  scan: { complete: true; cap: number };
  pagination: { page: number; pageSize: number; totalCount: number; totalPages: number; hasMore: boolean };
  rows: InventoryValuationRow[];
};

/** JSON report — complete aggregates + one deterministic page of rows. */
export async function buildInventoryValuationReport(
  businessId: string,
  filters: InventoryFilters,
  page: number,
  pageSize: number,
  meta: { currencyCode: string; decimalPrecision: number },
): Promise<InventoryValuationReport> {
  const all = await scanInventoryValuationRows(businessId);
  const matching = sortInventoryRows(filterInventoryRows(all, filters), filters.sort);
  const totals = computeInventoryTotals(matching);
  const totalCount = matching.length;
  const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / pageSize);
  const start = (page - 1) * pageSize;
  return {
    basis: "current_operational_estimate",
    formula: "stockQty × costPriceMinor",
    currencyCode: meta.currencyCode,
    decimalPrecision: meta.decimalPrecision,
    filters: { ...filters, page, pageSize },
    filtersActive: inventoryFiltersActive(filters),
    totals,
    scan: { complete: true, cap: INVENTORY_SCAN_CAP },
    pagination: {
      page,
      pageSize,
      totalCount,
      totalPages,
      hasMore: page * pageSize < totalCount,
    },
    rows: matching.slice(start, start + pageSize),
  };
}

/**
 * Export payload — the COMPLETE filtered set (the caller enforces the
 * row cap and renders the CSV; complete-or-reject, never a prefix).
 */
export async function buildInventoryValuationExport(
  businessId: string,
  filters: InventoryFilters,
): Promise<{ totals: InventoryTotals; rows: InventoryValuationRow[] }> {
  const all = await scanInventoryValuationRows(businessId);
  const matching = sortInventoryRows(filterInventoryRows(all, filters), filters.sort);
  return { totals: computeInventoryTotals(matching), rows: matching };
}
