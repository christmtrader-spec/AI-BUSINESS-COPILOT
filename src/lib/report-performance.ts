/**
 * Prompt 50 (§11) — advanced PERFORMANCE report service.
 *
 * ONE aggregation service backs BOTH the JSON API and the CSV export
 * (§11.5/§12 — the export can never drift from the UI numbers).
 *
 * ENTITLEMENT: every consumer enforces ADVANCED_REPORTS server-side
 * (§11) — the UI teaser is never the gate.
 *
 * FINANCIAL AUTHORITIES (§2/§11.2/§11.3/§11.4 — Gate K/L/M):
 *  - Sales performance scans non-deleted SALE invoices (issued revenue on
 *    issueDate). SalesOrder/SalesQuotation/GoodsDispatch rows are NOT in
 *    the Sale table and can never appear.
 *  - Expense performance scans EXPENSE records on spentAt (recorded
 *    expense basis). A posted SupplierBill's linked Expense appears ONCE —
 *    the Expense is the financial authority; the bill adds no second row.
 *  - Cash-flow detail scans PAYMENT rows on paidAt (actual cash basis).
 *    One Payment row = one cash movement; Sale.paidMinor/Expense.paidMinor
 *    are denormalized summaries and are NEVER added on top.
 *
 * BOUNDED LAW (§10/§13): source scans take PERFORMANCE_ROW_CAP rows (+1 to
 * detect truncation). When the cap trips, the JSON response carries
 * `truncated: true` and totals are labeled a partial scan; the CSV export
 * REJECTS instead of shipping a partial file (complete-or-reject, §12).
 *
 * IDENTITY LAW (Gate E/F): product groups key on SaleItem.productId
 * (catalog) — identical display names never merge distinct products and a
 * rename never splits one product. Customer groups key on customerId.
 * Unlinked lines (productId null) are a separate `unlinked` aggregate.
 *
 * DISCOUNT ALLOCATION (§7): the NET product report allocates each Sale's
 * document-level discount proportionally across its lines with an exact
 * BigInt largest-remainder method — allocated nets sum EXACTLY to
 * Sale.totalMinor per invoice, ties resolved by stable SaleItem.id order.
 * Corrupt invoices (negative lines/total, zero lines with non-zero total)
 * raise a controlled integrity error instead of inventing a difference.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import {
  MAX_REPORT_RANGE_DAYS,
  ReportIntegrityError,
  ReportRangeError,
  envCap,
  localDateKeyOf,
  localMonthKeyOf,
  parseLocalDateKey,
  resolveCustomRange,
  safeAdd,
  type ReportWindow,
} from "@/lib/report-periods";

export { ReportRangeError };

// ---------------------------------------------------------------------------
// Closed vocabularies + caps (§11.2/§11.3 — no client-selected DB fields)
// ---------------------------------------------------------------------------

export const SALES_GROUP_BYS = ["product", "customer", "day", "month"] as const;
export type SalesGroupBy = (typeof SALES_GROUP_BYS)[number];

export const EXPENSE_GROUP_BYS = ["category", "supplier", "day", "month"] as const;
export type ExpenseGroupBy = (typeof EXPENSE_GROUP_BYS)[number];

export const CASHFLOW_KIND = "cashflow" as const;

// Bounded-read caps (§10/§13) — env-tunable via the P49 envCap convention so
// harnesses can exercise the truncation/rejection laws with small fixtures
// (production defaults unchanged).
export const PERFORMANCE_ROW_CAP = envCap("PERFORMANCE_ROW_CAP", 20_000, 10, 1_000_000);
export const PERFORMANCE_GROUP_CAP = envCap("PERFORMANCE_GROUP_CAP", 500, 2, 10_000);
export const PERFORMANCE_DEFAULT_LIMIT = 25;
export const PERFORMANCE_MIN_LIMIT = 10;
export const PERFORMANCE_MAX_LIMIT = 100;
export const PERFORMANCE_EXPORT_MAX_ROWS = envCap("PERFORMANCE_EXPORT_MAX_ROWS", 5000, 10, 1_000_000);
export { MAX_REPORT_RANGE_DAYS as PERFORMANCE_MAX_RANGE_DAYS };

export function isSalesGroupBy(v: string): v is SalesGroupBy {
  return (SALES_GROUP_BYS as readonly string[]).includes(v);
}
export function isExpenseGroupBy(v: string): v is ExpenseGroupBy {
  return (EXPENSE_GROUP_BYS as readonly string[]).includes(v);
}

/** Parse `limit` with the closed clamp; throws ReportRangeError on junk. */
export function parsePerformanceLimit(raw: string | null): number {
  if (raw === null || raw === "") return PERFORMANCE_DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw.trim())) {
    throw new ReportRangeError("limit", "limit must be a positive integer.");
  }
  const n = Number(raw.trim());
  if (n < PERFORMANCE_MIN_LIMIT || n > PERFORMANCE_MAX_LIMIT) {
    throw new ReportRangeError(
      "limit",
      `limit must be between ${PERFORMANCE_MIN_LIMIT} and ${PERFORMANCE_MAX_LIMIT}.`,
    );
  }
  return n;
}

/** Strict custom range → exact ReportWindow (§4 law; rejects junk ranges). */
export function parsePerformanceRange(
  timeZone: string,
  from: string | null,
  to: string | null,
  now: Date,
): ReportWindow {
  if (!from || !parseLocalDateKey(from)) {
    throw new ReportRangeError("from", "from must be a valid YYYY-MM-DD date.");
  }
  if (!to || !parseLocalDateKey(to)) {
    throw new ReportRangeError("to", "to must be a valid YYYY-MM-DD date.");
  }
  return resolveCustomRange(timeZone, from, to, now, MAX_REPORT_RANGE_DAYS);
}

// ---------------------------------------------------------------------------
// Exact invoice-level discount allocation (§7.2 — largest remainder, BigInt)
// ---------------------------------------------------------------------------

export type AllocationLine = { id: string; lineTotalMinor: number };

/**
 * Allocate `totalMinor` across the invoice lines proportionally to their
 * line totals, distributing the integer remainder to the largest fractional
 * parts (ties → smaller SaleItem.id first). Guarantees, for VALID input:
 *   every allocated value ≥ 0, integer, and SUM(allocated) === totalMinor.
 */
export function allocateInvoiceDiscount(
  lines: AllocationLine[],
  totalMinor: number,
): number[] {
  if (lines.length === 0) {
    if (totalMinor === 0) return [];
    throw new ReportIntegrityError("invoice has no lines but a non-zero total");
  }
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0) {
    throw new ReportIntegrityError("invoice total is not a safe non-negative integer");
  }
  const bigTotal = BigInt(totalMinor);
  const weights = lines.map((l) => {
    if (!Number.isSafeInteger(l.lineTotalMinor) || l.lineTotalMinor < 0) {
      throw new ReportIntegrityError("invoice line total is not a safe non-negative integer");
    }
    return BigInt(l.lineTotalMinor);
  });
  const subtotal = weights.reduce((acc, w) => acc + w, 0n);
  if (subtotal === 0n) {
    if (bigTotal === 0n) return lines.map(() => 0);
    throw new ReportIntegrityError("invoice lines sum to zero but the total is non-zero");
  }
  // Exact proportional floors + remainders in BigInt — no float anywhere.
  const nets: number[] = [];
  const remainders: Array<{ idx: number; rem: bigint; id: string }> = [];
  let distributed = 0n;
  for (let i = 0; i < lines.length; i++) {
    const exact = (weights[i] * bigTotal) / subtotal; // floor ( BigInt / )
    const rem = (weights[i] * bigTotal) % subtotal;
    nets.push(Number(exact)); // exact < 2^53 by the safe-integer guards above
    distributed += exact;
    remainders.push({ idx: i, rem, id: lines[i].id });
  }
  let left = bigTotal - distributed; // 0 <= left < number of lines
  // Stable remainder order: largest fractional remainder first, ties by the
  // line's stable id (ascending) — deterministic across runs (§7.2).
  remainders.sort((a, b) => (a.rem > b.rem ? -1 : a.rem < b.rem ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let i = 0;
  while (left > 0n) {
    nets[remainders[i % remainders.length].idx] += 1;
    left -= 1n;
    i += 1;
  }
  return nets;
}

// ---------------------------------------------------------------------------
// Signed keyset cursor for the cash-flow page (same convention as P39/P49)
// ---------------------------------------------------------------------------

const CURSOR_VERSION = "v1";
const CURSOR_MAX_LENGTH = 1024;

function cursorSecret(): string {
  return (
    process.env.STATEMENT_CURSOR_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "statement-cursor-local-dev-secret"
  );
}

function b64urlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
function b64urlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}
function signPayload(payload: string): string {
  return createHmac("sha256", cursorSecret()).update(payload).digest("base64url");
}

export type PerformanceCursorPayload = {
  v: "v1";
  /** businessId binding — a cursor never crosses tenants. */
  b: string;
  /** kind + groupBy + range + direction binding — never crosses filters. */
  k: string;
  /** last SCANNED paidAt instant (ISO). */
  ts: string;
  /** last SCANNED payment id. */
  id: string;
};

export function encodePerformanceCursor(state: PerformanceCursorPayload): string {
  const payload = b64urlEncode(JSON.stringify(state));
  return `${payload}.${signPayload(payload)}`;
}

export function decodePerformanceCursor(
  token: string,
  expect: { businessId: string; binding: string },
): PerformanceCursorPayload {
  if (!token || token.length > CURSOR_MAX_LENGTH || !token.includes(".")) {
    throw new ReportRangeError("cursor", "cursor is invalid.");
  }
  const [payload, sig] = token.split(".");
  const expectedSig = signPayload(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ReportRangeError("cursor", "cursor is invalid.");
  }
  let state: PerformanceCursorPayload;
  try {
    state = JSON.parse(b64urlDecode(payload)) as PerformanceCursorPayload;
  } catch {
    throw new ReportRangeError("cursor", "cursor is invalid.");
  }
  if (
    state?.v !== CURSOR_VERSION ||
    state.b !== expect.businessId ||
    state.k !== expect.binding ||
    typeof state.ts !== "string" ||
    typeof state.id !== "string"
  ) {
    throw new ReportRangeError("cursor", "cursor does not match the current query.");
  }
  const ts = new Date(state.ts);
  if (Number.isNaN(ts.getTime())) {
    throw new ReportRangeError("cursor", "cursor is invalid.");
  }
  return state;
}

// ---------------------------------------------------------------------------
// Sales performance (§11.2)
// ---------------------------------------------------------------------------

export type SalesPerformanceRow =
  | {
      dimension: "product";
      /** Stable catalog identity; null only for unlinked legacy lines. */
      productId: string | null;
      kind: "catalog" | "unlinked";
      /** Catalog products: live tenant-scoped name. Unlinked: snapshot. */
      name: string;
      sku: string | null;
      unit: string | null;
      qtySold: number;
      invoiceCount: number;
      /** SaleItem line value BEFORE the invoice-level discount. */
      lineValueMinor: number;
      /** Net allocated value — sums exactly to the invoice totals (§7.2). */
      netValueMinor: number;
    }
  | {
      dimension: "customer";
      customerId: string | null;
      name: string | null;
      invoiceCount: number;
      revenueMinor: number;
    }
  | { dimension: "day"; date: string; invoiceCount: number; revenueMinor: number }
  | { dimension: "month"; month: string; invoiceCount: number; revenueMinor: number };

export type SalesPerformanceReport = {
  kind: "sales";
  groupBy: SalesGroupBy;
  range: { from: string; to: string; timezone: string };
  totals: {
    /** Issued revenue = SUM(Sale.totalMinor) in the window. */
    revenueMinor: number;
    invoiceCount: number;
    /** SUM(SaleItem.lineTotalMinor) — before invoice-level discounts. */
    lineValueMinor: number;
    /** SUM(Sale.discountMinor). */
    discountMinor: number;
    /** lineValueMinor - discountMinor (reconciles with allocated nets). */
    netLineValueMinor: number;
  };
  groups: SalesPerformanceRow[];
  /** More DISTINCT groups exist than PERFORMANCE_GROUP_CAP. */
  groupTruncated: boolean;
  /** Source scan hit PERFORMANCE_ROW_CAP — totals cover the scanned subset. */
  truncated: boolean;
  /**
   * Discount basis law (§7): "net_allocated" — document-level discounts are
   * allocated proportionally (largest remainder) so nets reconcile exactly.
   */
  discountBasis: "net_allocated";
};

export async function buildSalesPerformance(
  businessId: string,
  window: ReportWindow,
  groupBy: SalesGroupBy,
): Promise<SalesPerformanceReport> {
  const sales = await db.sale.findMany({
    where: {
      businessId,
      deletedAt: null,
      issueDate: { gte: window.fetchFrom, lt: window.fetchUntil },
    },
    select: {
      id: true,
      totalMinor: true,
      discountMinor: true,
      issueDate: true,
      customerId: true,
      customer: { select: { id: true, name: true } },
      items: {
        select: { id: true, productId: true, name: true, unit: true, qty: true, lineTotalMinor: true },
        orderBy: { id: "asc" },
      },
    },
    orderBy: [{ issueDate: "asc" }, { id: "asc" }],
    take: PERFORMANCE_ROW_CAP + 1,
  });
  const truncated = sales.length > PERFORMANCE_ROW_CAP;
  const scanned = truncated ? sales.slice(0, PERFORMANCE_ROW_CAP) : sales;

  let revenueMinor = 0;
  let invoiceCount = 0;
  let discountMinor = 0;
  let lineValueMinor = 0;

  type ProductAgg = {
    productId: string | null;
    kind: "catalog" | "unlinked";
    name: string;
    sku: string | null;
    unit: string | null;
    qtySold: number;
    invoiceCount: number;
    lineValueMinor: number;
    netValueMinor: number;
  };
  const productAgg = new Map<string, ProductAgg>();
  const customerAgg = new Map<string, { customerId: string | null; name: string | null; invoiceCount: number; revenueMinor: number }>();
  const dayAgg = new Map<string, { invoiceCount: number; revenueMinor: number }>();
  const monthAgg = new Map<string, { invoiceCount: number; revenueMinor: number }>();

  for (const s of scanned) {
    revenueMinor = safeAdd(revenueMinor, s.totalMinor, "sales revenue");
    invoiceCount = safeAdd(invoiceCount, 1, "invoice count");
    discountMinor = safeAdd(discountMinor, s.discountMinor, "invoice discount");

    const dayKey = localDateKeyOf(s.issueDate, window.timeZone);
    const monthKey = localMonthKeyOf(s.issueDate, window.timeZone);

    const bump = (
      m: Map<string, { invoiceCount: number; revenueMinor: number }>,
      key: string,
      amount: number,
    ) => {
      const row = m.get(key) ?? { invoiceCount: 0, revenueMinor: 0 };
      row.invoiceCount = safeAdd(row.invoiceCount, 1, "bucket invoice count");
      row.revenueMinor = safeAdd(row.revenueMinor, amount, "bucket revenue");
      m.set(key, row);
    };

    if (groupBy === "day") bump(dayAgg, dayKey, s.totalMinor);
    if (groupBy === "month") bump(monthAgg, monthKey, s.totalMinor);
    if (groupBy === "customer") {
      const key = s.customerId ?? "__unassigned__";
      const row = customerAgg.get(key) ?? {
        customerId: s.customerId,
        name: s.customer?.name ?? null,
        invoiceCount: 0,
        revenueMinor: 0,
      };
      row.invoiceCount = safeAdd(row.invoiceCount, 1, "customer invoice count");
      row.revenueMinor = safeAdd(row.revenueMinor, s.totalMinor, "customer revenue");
      customerAgg.set(key, row);
    }

    // Lines: gross line value always; net via the exact allocation (§7.2).
    const nets = allocateInvoiceDiscount(
      s.items.map((i) => ({ id: i.id, lineTotalMinor: i.lineTotalMinor })),
      s.totalMinor,
    );
    for (let i = 0; i < s.items.length; i++) {
      const item = s.items[i];
      lineValueMinor = safeAdd(lineValueMinor, item.lineTotalMinor, "line value");
      const key = item.productId ? `p:${item.productId}` : `u:${item.name}`;
      const agg = productAgg.get(key) ?? {
        productId: item.productId,
        kind: item.productId ? ("catalog" as const) : ("unlinked" as const),
        name: item.name,
        sku: null,
        unit: item.unit,
        qtySold: 0,
        invoiceCount: 0,
        lineValueMinor: 0,
        netValueMinor: 0,
      };
      agg.qtySold = safeAdd(agg.qtySold, item.qty, "product qty");
      agg.lineValueMinor = safeAdd(agg.lineValueMinor, item.lineTotalMinor, "product line value");
      agg.netValueMinor = safeAdd(agg.netValueMinor, nets[i], "product net value");
      agg.invoiceCount = safeAdd(agg.invoiceCount, 1, "product line count");
      productAgg.set(key, agg);
    }
  }

  // Resolve catalog product names/SKUs tenant-scoped (Gate P) — a renamed
  // product reports under its CURRENT live identity; the historical line
  // snapshot name is preserved for unlinked rows only.
  const catalogIds = [...productAgg.values()]
    .filter((p) => p.productId)
    .map((p) => p.productId as string);
  const catalogProducts =
    catalogIds.length > 0
      ? await db.product.findMany({
          where: { id: { in: catalogIds }, businessId },
          select: { id: true, name: true, sku: true, unit: true },
        })
      : [];
  const live = new Map(catalogProducts.map((p) => [p.id, p]));
  for (const agg of productAgg.values()) {
    if (!agg.productId) continue;
    const p = live.get(agg.productId);
    if (p) {
      agg.name = p.name;
      agg.sku = p.sku ?? null;
      agg.unit = agg.unit ?? p.unit;
    }
  }

  const sortByValueDesc = <T>(
    rows: T[],
    value: (r: T) => number,
    tie: (r: T) => string,
  ): T[] =>
    [...rows].sort((a, b) => value(b) - value(a) || tie(a).localeCompare(tie(b)));

  let groups: SalesPerformanceRow[];
  let groupTruncated = false;
  if (groupBy === "product") {
    const all = sortByValueDesc(
      [...productAgg.values()],
      (r) => r.netValueMinor,
      (r) => r.productId ?? `u:${r.name}`,
    );
    groupTruncated = all.length > PERFORMANCE_GROUP_CAP;
    groups = all.slice(0, PERFORMANCE_GROUP_CAP).map((p) => ({
      dimension: "product" as const,
      productId: p.productId,
      kind: p.kind,
      name: p.name,
      sku: p.sku,
      unit: p.unit,
      qtySold: p.qtySold,
      invoiceCount: p.invoiceCount,
      lineValueMinor: p.lineValueMinor,
      netValueMinor: p.netValueMinor,
    }));
  } else if (groupBy === "customer") {
    const all = sortByValueDesc(
      [...customerAgg.values()],
      (r) => r.revenueMinor,
      (r) => r.customerId ?? "__unassigned__",
    );
    groupTruncated = all.length > PERFORMANCE_GROUP_CAP;
    groups = all.slice(0, PERFORMANCE_GROUP_CAP).map((c) => ({
      dimension: "customer" as const,
      customerId: c.customerId,
      name: c.name,
      invoiceCount: c.invoiceCount,
      revenueMinor: c.revenueMinor,
    }));
  } else if (groupBy === "day") {
    const all = [...dayAgg.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    groupTruncated = all.length > PERFORMANCE_GROUP_CAP;
    groups = all.slice(0, PERFORMANCE_GROUP_CAP).map(([date, v]) => ({
      dimension: "day" as const,
      date,
      invoiceCount: v.invoiceCount,
      revenueMinor: v.revenueMinor,
    }));
  } else {
    const all = [...monthAgg.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    groupTruncated = all.length > PERFORMANCE_GROUP_CAP;
    groups = all.slice(0, PERFORMANCE_GROUP_CAP).map(([month, v]) => ({
      dimension: "month" as const,
      month,
      invoiceCount: v.invoiceCount,
      revenueMinor: v.revenueMinor,
    }));
  }

  return {
    kind: "sales",
    groupBy,
    range: { from: window.fromKey, to: window.toKey, timezone: window.timeZone },
    totals: {
      revenueMinor,
      invoiceCount,
      lineValueMinor,
      discountMinor,
      netLineValueMinor: safeSubLocal(lineValueMinor, discountMinor),
    },
    groups,
    groupTruncated,
    truncated,
    discountBasis: "net_allocated",
  };
}

function safeSubLocal(a: number, b: number): number {
  const r = a - b;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(r)) {
    throw new ReportIntegrityError("sales totals overflowed the safe integer range");
  }
  return r;
}

// ---------------------------------------------------------------------------
// Expense performance (§11.3)
// ---------------------------------------------------------------------------

export type ExpensePerformanceRow =
  | { dimension: "category"; category: string; expenseCount: number; amountMinor: number }
  | { dimension: "supplier"; supplierId: string | null; name: string | null; expenseCount: number; amountMinor: number }
  | { dimension: "day"; date: string; expenseCount: number; amountMinor: number }
  | { dimension: "month"; month: string; expenseCount: number; amountMinor: number };

export type ExpensePerformanceReport = {
  kind: "expenses";
  groupBy: ExpenseGroupBy;
  range: { from: string; to: string; timezone: string };
  /** Basis: EXPENSE.amountMinor on spentAt — NOT Payment cash-out (§11.3). */
  basis: "recorded_expense_on_spentAt";
  totals: { amountMinor: number; expenseCount: number };
  groups: ExpensePerformanceRow[];
  groupTruncated: boolean;
  truncated: boolean;
};

export async function buildExpensePerformance(
  businessId: string,
  window: ReportWindow,
  groupBy: ExpenseGroupBy,
): Promise<ExpensePerformanceReport> {
  const expenses = await db.expense.findMany({
    where: {
      businessId,
      deletedAt: null,
      spentAt: { gte: window.fetchFrom, lt: window.fetchUntil },
    },
    select: {
      category: true,
      amountMinor: true,
      spentAt: true,
      supplierId: true,
      supplier: { select: { id: true, name: true } },
    },
    orderBy: [{ spentAt: "asc" }, { id: "asc" }],
    take: PERFORMANCE_ROW_CAP + 1,
  });
  const truncated = expenses.length > PERFORMANCE_ROW_CAP;
  const scanned = truncated ? expenses.slice(0, PERFORMANCE_ROW_CAP) : expenses;

  let amountMinor = 0;
  let expenseCount = 0;
  const categoryAgg = new Map<string, { expenseCount: number; amountMinor: number }>();
  const supplierAgg = new Map<string, { supplierId: string | null; name: string | null; expenseCount: number; amountMinor: number }>();
  const dayAgg = new Map<string, { expenseCount: number; amountMinor: number }>();
  const monthAgg = new Map<string, { expenseCount: number; amountMinor: number }>();

  for (const e of scanned) {
    amountMinor = safeAdd(amountMinor, e.amountMinor, "expense amount");
    expenseCount = safeAdd(expenseCount, 1, "expense count");
    const dayKey = localDateKeyOf(e.spentAt, window.timeZone);
    const monthKey = localMonthKeyOf(e.spentAt, window.timeZone);
    const bump = (
      m: Map<string, { expenseCount: number; amountMinor: number }>,
      key: string,
    ) => {
      const row = m.get(key) ?? { expenseCount: 0, amountMinor: 0 };
      row.expenseCount = safeAdd(row.expenseCount, 1, "bucket expense count");
      row.amountMinor = safeAdd(row.amountMinor, e.amountMinor, "bucket expense amount");
      m.set(key, row);
    };
    if (groupBy === "category") {
      const row = categoryAgg.get(e.category) ?? { expenseCount: 0, amountMinor: 0 };
      row.expenseCount = safeAdd(row.expenseCount, 1, "category expense count");
      row.amountMinor = safeAdd(row.amountMinor, e.amountMinor, "category amount");
      categoryAgg.set(e.category, row);
    }
    if (groupBy === "supplier") {
      const key = e.supplierId ?? "__unassigned__";
      const row = supplierAgg.get(key) ?? {
        supplierId: e.supplierId,
        name: e.supplier?.name ?? null,
        expenseCount: 0,
        amountMinor: 0,
      };
      row.expenseCount = safeAdd(row.expenseCount, 1, "supplier expense count");
      row.amountMinor = safeAdd(row.amountMinor, e.amountMinor, "supplier amount");
      supplierAgg.set(key, row);
    }
    if (groupBy === "day") bump(dayAgg, dayKey);
    if (groupBy === "month") bump(monthAgg, monthKey);
  }

  const sortByValueDesc = <T>(
    rows: T[],
    value: (r: T) => number,
    tie: (r: T) => string,
  ): T[] => [...rows].sort((a, b) => value(b) - value(a) || tie(a).localeCompare(tie(b)));

  let groups: ExpensePerformanceRow[];
  let groupTruncated = false;
  if (groupBy === "category") {
    const all = sortByValueDesc(
      [...categoryAgg.entries()],
      (r) => r[1].amountMinor,
      (r) => r[0],
    );
    groupTruncated = all.length > PERFORMANCE_GROUP_CAP;
    groups = all.slice(0, PERFORMANCE_GROUP_CAP).map(([category, v]) => ({
      dimension: "category" as const,
      category,
      expenseCount: v.expenseCount,
      amountMinor: v.amountMinor,
    }));
  } else if (groupBy === "supplier") {
    const all = sortByValueDesc(
      [...supplierAgg.values()],
      (r) => r.amountMinor,
      (r) => r.supplierId ?? "__unassigned__",
    );
    groupTruncated = all.length > PERFORMANCE_GROUP_CAP;
    groups = all.slice(0, PERFORMANCE_GROUP_CAP).map((s) => ({
      dimension: "supplier" as const,
      supplierId: s.supplierId,
      name: s.name,
      expenseCount: s.expenseCount,
      amountMinor: s.amountMinor,
    }));
  } else if (groupBy === "day") {
    const all = [...dayAgg.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    groupTruncated = all.length > PERFORMANCE_GROUP_CAP;
    groups = all.slice(0, PERFORMANCE_GROUP_CAP).map(([date, v]) => ({
      dimension: "day" as const,
      date,
      expenseCount: v.expenseCount,
      amountMinor: v.amountMinor,
    }));
  } else {
    const all = [...monthAgg.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    groupTruncated = all.length > PERFORMANCE_GROUP_CAP;
    groups = all.slice(0, PERFORMANCE_GROUP_CAP).map(([month, v]) => ({
      dimension: "month" as const,
      month,
      expenseCount: v.expenseCount,
      amountMinor: v.amountMinor,
    }));
  }

  return {
    kind: "expenses",
    groupBy,
    range: { from: window.fromKey, to: window.toKey, timezone: window.timeZone },
    basis: "recorded_expense_on_spentAt",
    totals: { amountMinor, expenseCount },
    groups,
    groupTruncated,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Cash-flow detail (§11.4) — actual Payment rows, keyset-paginated
// ---------------------------------------------------------------------------

export type CashFlowRow = {
  id: string;
  /** Business-local calendar date of paidAt. */
  date: string;
  direction: "IN" | "OUT";
  amountMinor: number;
  /** CASH | BANK_TRANSFER | CARD | OTHER (approved field, §11.4). */
  method: string;
  /** Related source reference for safe navigation (never a second movement). */
  sale: { id: string; number: number } | null;
  expense: { id: string; reference: string | null; category: string } | null;
};

export type CashFlowPage = {
  kind: "cashflow";
  range: { from: string; to: string; timezone: string };
  direction: "IN" | "OUT" | null;
  /** Complete totals for the WHOLE filtered window (DB aggregate — the page
   *  is a bounded preview and never the source of the totals, §13). */
  totals: { collectedMinor: number; paidOutMinor: number; netCashMinor: number; paymentCount: number };
  rows: CashFlowRow[];
  nextCursor: string | null;
  truncated: false;
};

export async function buildCashFlowPage(
  businessId: string,
  window: ReportWindow,
  direction: "IN" | "OUT" | null,
  limit: number,
  cursorToken: string | null,
): Promise<CashFlowPage> {
  const binding = `cashflow:${window.fromKey}:${window.toKey}:${direction ?? "*"}`;
  let cursor: PerformanceCursorPayload | null = null;
  if (cursorToken) {
    cursor = decodePerformanceCursor(cursorToken, { businessId, binding });
  }

  const where = {
    businessId,
    paidAt: { gte: window.fetchFrom, lt: window.fetchUntil },
    ...(direction ? { direction } : {}),
    ...(cursor
      ? {
          // DESC keyset continuation (paidAt desc, id desc): everything
          // strictly AFTER the last scanned row in this order —
          //   paidAt < ts  OR  (paidAt == ts AND id < id)
          // `eq` (NOT gte) in the tie branch: rows with paidAt > ts sort
          // BEFORE the cursor and were already displayed (Gate K).
          OR: [
            { paidAt: { lt: new Date(cursor.ts) } },
            { AND: [{ paidAt: new Date(cursor.ts) }, { id: { lt: cursor.id } }] },
          ],
        }
      : {}),
  };

  // Page rows ordered paidAt DESC, id DESC (newest first), keyset-continuous.
  const [pageRows, totalsAgg] = await Promise.all([
    db.payment.findMany({
      where,
      select: {
        id: true,
        paidAt: true,
        direction: true,
        amountMinor: true,
        method: true,
        sale: { select: { id: true, number: true } },
        expense: { select: { id: true, reference: true, category: true } },
      },
      orderBy: [{ paidAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    }),
    db.payment.aggregate({
      where: {
        businessId,
        paidAt: { gte: window.fetchFrom, lt: window.fetchUntil },
      },
      _sum: { amountMinor: true },
      _count: true,
    }),
  ]);

  // Complete cash totals per direction for the whole window (two small
  // grouped aggregates — the page NEVER computes the totals, §13).
  const byDirection = await db.payment.groupBy({
    by: ["direction"],
    where: {
      businessId,
      paidAt: { gte: window.fetchFrom, lt: window.fetchUntil },
    },
    _sum: { amountMinor: true },
  });
  const collected = byDirection.find((d) => d.direction === "IN")?._sum.amountMinor ?? 0;
  const paidOut = byDirection.find((d) => d.direction === "OUT")?._sum.amountMinor ?? 0;

  const hasMore = pageRows.length > limit;
  const rows = pageRows.slice(0, limit).map((p) => ({
    id: p.id,
    date: localDateKeyOf(p.paidAt, window.timeZone),
    direction: p.direction === "IN" ? ("IN" as const) : ("OUT" as const),
    amountMinor: p.amountMinor,
    method: p.method,
    sale: p.sale ? { id: p.sale.id, number: p.sale.number } : null,
    expense: p.expense
      ? { id: p.expense.id, reference: p.expense.reference, category: p.expense.category }
      : null,
  }));

  const nextCursor = hasMore
    ? encodePerformanceCursor({
        v: CURSOR_VERSION,
        b: businessId,
        k: binding,
        ts: pageRows[limit - 1].paidAt.toISOString(),
        id: pageRows[limit - 1].id,
      })
    : null;

  return {
    kind: "cashflow",
    range: { from: window.fromKey, to: window.toKey, timezone: window.timeZone },
    direction,
    totals: {
      collectedMinor: collected,
      paidOutMinor: paidOut,
      netCashMinor: collected - paidOut,
      paymentCount: totalsAgg._count,
    },
    rows,
    nextCursor,
    truncated: false,
  };
}
