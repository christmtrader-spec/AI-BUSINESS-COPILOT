/**
 * Deterministic report computation — single source of truth.
 *
 * Used by BOTH /api/v1/reports/summary (charts UI) and the AI copilot
 * grounding pipeline (A11-A13): every figure the AI can speak is computed
 * HERE by the server from recorded transactions. The AI only narrates.
 *
 * Prompt 50 hardening (§2/§4/§5/§6/§7/§10):
 *  - Every window comes from lib/report-periods.ts: EXACT business-local
 *    day boundaries converted to UTC instants via Intl offset math (never
 *    fixed-millisecond steps) — DST-safe for every IANA zone.
 *  - Both database bounds are bounded (`gte` AND exclusive `lt`): a
 *    future-dated record can NEVER enter a completed reporting window
 *    (Gate B). For the current month the same law clamps the month view.
 *  - Top products aggregate by STABLE product identity (productId) — two
 *    distinct catalog products with identical display names never merge,
 *    and a renamed product never splits (Gate E). Unlinked (no productId)
 *    historical lines are reported separately with truthful labels.
 *  - Expense categories: the top-N slice is accompanied by a server-computed
 *    `Other` bucket so SUM(top slice + Other) == kpis.expensesMinor exactly
 *    (Gate G — an honest denominator).
 *  - All money arithmetic guards the safe-integer range and fails with a
 *    controlled integrity error instead of silently overflowing (Gate O).
 *
 * Day boundaries honor the business timezone (A04); all money is integer
 * minor units (A08).
 */
import { db } from "@/lib/db";
import {
  computeInventoryTopValueProducts,
  rowCostState,
  rowStockState,
  type InventoryValuationRow,
} from "@/lib/inventory-valuation-report";
import {
  ALLOWED_REPORT_DAYS,
  localMonthKeyOf,
  normalizeReportDaysInput,
  pctChange,
  resolveCustomRange,
  resolveMonthWindow,
  resolvePreviousWindow,
  resolveRollingWindow,
  safeAdd,
  safeMul,
  safeSub,
  todayKey,
  zonedDayEndExclusiveUtc,
  zonedDayStartUtc,
  type ReportDays,
} from "@/lib/report-periods";

export { ALLOWED_REPORT_DAYS };
export type { ReportDays };

export function normalizeReportDays(input: unknown): ReportDays {
  return normalizeReportDaysInput(input);
}

/** YYYY-MM-DD key in a given IANA timezone (falls back to UTC). */
export function localDateKey(d: Date, timeZone: string): string {
  try {
    // en-CA gives ISO-like YYYY-MM-DD output.
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export type ReportSummary = Awaited<ReturnType<typeof buildReportSummary>>;

export async function buildReportSummary(
  businessId: string,
  days: ReportDays,
  // Prompt 52 §F4 — optional explicit local-day window (Jalali presets send
  // Gregorian YYYY-MM-DD from/to). Same laws as the rolling window: local-day
  // boundaries, future-only ranges rejected, `to` clamped to today (366d cap).
  custom?: { from: string; to: string },
) {
  // Business timezone for day boundaries (A04) — server authority only.
  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { timezone: true },
  });
  const tz = business?.timezone || "UTC";

  // Prompt 50 (§5): exact local-day window ending TODAY. fetchUntil is the
  // exclusive start of tomorrow's local day — future-dated rows never load.
  const now = new Date();
  const window = custom
    ? resolveCustomRange(tz, custom.from, custom.to, now)
    : resolveRollingWindow(tz, days, now);
  const { fromKey, toKey, dayKeys, fetchFrom, fetchUntil } = window;

  const dateGte = fetchFrom;

  // R115 — the previous comparison window (report-periods §6 law: the
  // same-LENGTH business-local window IMMEDIATELY before the current one —
  // no overlap, no gap, DST-safe exact instants). The three windowed
  // transaction fetches below widen their lower bound to cover BOTH
  // windows; the local-date predicates keep every current-window aggregate
  // exact (the documented widened-fetch revalidation law, §5).
  const trendWindow = resolvePreviousWindow(tz, dayKeys.length, fromKey);
  const trendGte = trendWindow.fetchFrom;

  const [sales, payments, expenses, saleItems, products, openSales, openExpenses] =
    await Promise.all([
      db.sale.findMany({
        where: {
          businessId,
          deletedAt: null,
          issueDate: { gte: trendGte, lt: fetchUntil },
        },
        select: { issueDate: true, totalMinor: true, discountMinor: true },
      }),
      db.payment.findMany({
        where: { businessId, paidAt: { gte: trendGte, lt: fetchUntil } },
        select: { paidAt: true, direction: true, amountMinor: true },
      }),
      db.expense.findMany({
        where: {
          businessId,
          deletedAt: null,
          spentAt: { gte: trendGte, lt: fetchUntil },
        },
        select: { spentAt: true, category: true, amountMinor: true },
      }),
      db.saleItem.findMany({
        where: {
          sale: {
            businessId,
            deletedAt: null,
            issueDate: { gte: dateGte, lt: fetchUntil },
          },
        },
        // Prompt 50 (§7): stable identity + snapshot for drill-down.
        select: {
          id: true,
          saleId: true,
          productId: true,
          name: true,
          unit: true,
          qty: true,
          lineTotalMinor: true,
        },
      }),
      db.product.findMany({
        where: { businessId, deletedAt: null },
        select: {
          id: true,
          name: true,
          sku: true,
          unit: true,
          stockQty: true,
          lowStockAt: true,
          costPriceMinor: true,
          // R102/W3 — the FULL InventoryProductInput shape: the throne row
          // builder consumes the same population as the Prompt 51 report
          // (inactive products can still hold stock — never filtered here).
          isActive: true,
        },
      }),
      db.sale.aggregate({
        where: { businessId, deletedAt: null, status: { not: "PAID" } },
        _sum: { totalMinor: true, paidMinor: true },
        _count: true,
      }),
      db.expense.aggregate({
        where: { businessId, deletedAt: null, status: { not: "PAID" } },
        _sum: { amountMinor: true, paidMinor: true },
        _count: true,
      }),
    ]);

  // ---- Daily buckets (deterministic, timezone-aware) -----------------------
  type Bucket = {
    revenueMinor: number;
    expenseMinor: number;
    collectedMinor: number;
    paidOutMinor: number;
  };
  const bucket = new Map<string, Bucket>();
  for (const key of dayKeys) {
    bucket.set(key, { revenueMinor: 0, expenseMinor: 0, collectedMinor: 0, paidOutMinor: 0 });
  }
  const add = (iso: Date, field: keyof Bucket, amount: number) => {
    const key = localDateKey(iso, tz);
    const b = bucket.get(key);
    if (b) b[field] = safeAdd(b[field], amount, field);
  };
  for (const s of sales) add(s.issueDate, "revenueMinor", s.totalMinor);
  for (const e of expenses) add(e.spentAt, "expenseMinor", e.amountMinor);
  for (const p of payments) {
    add(p.paidAt, p.direction === "IN" ? "collectedMinor" : "paidOutMinor", p.amountMinor);
  }
  const timeline = dayKeys.map((date) => ({ date, ...bucket.get(date)! }));

  // ---- KPIs over the selected window ---------------------------------------
  // The database bounds are exact local-day instants, so every fetched row is
  // in-window by construction; the local-date predicate is a belt-and-braces
  // revalidation (§5 "local-date revalidation when widened fetches are used")
  // that also keeps KPIs correct even if a future zone offset changed under
  // us mid-request. Future keys have no bucket → timeline always reconciles.
  const inWindow = (iso: Date) => {
    const key = localDateKey(iso, tz);
    return key >= fromKey && key <= toKey;
  };
  let revenueMinor = 0;
  let salesCount = 0;
  for (const s of sales) {
    if (inWindow(s.issueDate)) {
      revenueMinor = safeAdd(revenueMinor, s.totalMinor, "revenueMinor");
      salesCount = safeAdd(salesCount, 1, "salesCount");
    }
  }
  let expensesMinor = 0;
  let expensesCount = 0;
  for (const e of expenses) {
    if (inWindow(e.spentAt)) {
      expensesMinor = safeAdd(expensesMinor, e.amountMinor, "expensesMinor");
      expensesCount = safeAdd(expensesCount, 1, "expensesCount");
    }
  }
  let collectedMinor = 0;
  let paidOutMinor = 0;
  for (const p of payments) {
    if (!inWindow(p.paidAt)) continue;
    if (p.direction === "IN") collectedMinor = safeAdd(collectedMinor, p.amountMinor, "collectedMinor");
    else paidOutMinor = safeAdd(paidOutMinor, p.amountMinor, "paidOutMinor");
  }

  // ---- R115 — previous-window comparison (the additive `trend` block) -----
  // SAME rows already fetched (the widened lower bound), bucketed by the
  // EXACT local-date predicate — the previous window can never overlap the
  // current one (L5), and the L8 pct law rides the ONE pctChange authority
  // (null on a ≤0 baseline — never a fabricated or sign-flipped %).
  const inPrevWindow = (iso: Date) => {
    const key = localDateKey(iso, tz);
    return key >= trendWindow.fromKey && key <= trendWindow.toKey;
  };
  let revenuePrevMinor = 0;
  let salesCountPrev = 0;
  for (const s of sales) {
    if (inPrevWindow(s.issueDate)) {
      revenuePrevMinor = safeAdd(revenuePrevMinor, s.totalMinor, "revenuePrevMinor");
      salesCountPrev = safeAdd(salesCountPrev, 1, "salesCountPrev");
    }
  }
  let expensesPrevMinor = 0;
  let expensesCountPrev = 0;
  for (const e of expenses) {
    if (inPrevWindow(e.spentAt)) {
      expensesPrevMinor = safeAdd(expensesPrevMinor, e.amountMinor, "expensesPrevMinor");
      expensesCountPrev = safeAdd(expensesCountPrev, 1, "expensesCountPrev");
    }
  }
  let collectedPrevMinor = 0;
  let paidOutPrevMinor = 0;
  for (const p of payments) {
    if (!inPrevWindow(p.paidAt)) continue;
    if (p.direction === "IN") collectedPrevMinor = safeAdd(collectedPrevMinor, p.amountMinor, "collectedPrevMinor");
    else paidOutPrevMinor = safeAdd(paidOutPrevMinor, p.amountMinor, "paidOutPrevMinor");
  }
  const netCashPrevMinor = safeSub(collectedPrevMinor, paidOutPrevMinor, "netCashPrevMinor");

  // ---- Top products — STABLE IDENTITY (Prompt 50 §7 / Gate E) ---------------
  // Catalog lines group by SaleItem.productId; unlinked (null productId)
  // lines are a SEPARATE aggregate labeled `kind: "unlinked"` keyed by the
  // historical name snapshot — never merged into catalog identities.
  type ProductAgg = {
    productId: string | null;
    kind: "catalog" | "unlinked";
    name: string;
    unit: string | null;
    qty: number;
    revenueMinor: number;
    invoiceCount: number;
  };
  const byProduct = new Map<string, ProductAgg>();
  const invoiceIdsPerProduct = new Map<string, Set<string>>();
  for (const item of saleItems) {
    // Group key: catalog identity wins; unlinked lines fall back to the
    // snapshot name under a dedicated namespace that can never collide
    // with a productId.
    const groupKey = item.productId ? `p:${item.productId}` : `u:${item.name}`;
    const agg = byProduct.get(groupKey) ?? {
      productId: item.productId,
      kind: item.productId ? ("catalog" as const) : ("unlinked" as const),
      name: item.name,
      unit: item.unit,
      qty: 0,
      revenueMinor: 0,
      invoiceCount: 0,
    };
    agg.qty = safeAdd(agg.qty, item.qty, "product qty");
    agg.revenueMinor = safeAdd(agg.revenueMinor, item.lineTotalMinor, "product revenue");
    byProduct.set(groupKey, agg);
    let set = invoiceIdsPerProduct.get(groupKey);
    if (!set) {
      set = new Set<string>();
      invoiceIdsPerProduct.set(groupKey, set);
    }
    set.add(item.saleId);
  }
  const topProducts = [...byProduct.entries()]
    .sort(
      (a, b) =>
        b[1].revenueMinor - a[1].revenueMinor ||
        (a[1].productId ?? a[1].name).localeCompare(b[1].productId ?? b[1].name),
    )
    .slice(0, 5)
    .map(([groupKey, p]) => ({
      // Additive Prompt 50 fields — `name`/`qty`/`revenueMinor` preserved
      // verbatim for the AI snapshot and existing UI (backward compatible).
      // Revenue basis: SaleItem.lineTotalMinor — the LINE VALUE BEFORE the
      // invoice-level discount (labeled as such in UI/CSV; the invoice
      // net-allocation basis lives in the advanced performance report).
      name: p.name,
      qty: p.qty,
      revenueMinor: p.revenueMinor,
      productId: p.productId,
      kind: p.kind,
      unit: p.unit,
      sku: null as string | null,
      invoiceCount: invoiceIdsPerProduct.get(groupKey)?.size ?? 0,
    }));
  // Resolve the LIVE catalog identity (tenant-scoped) — a renamed product
  // reports under its current name as ONE aggregate; unlinked rows keep
  // their historical snapshot names. SKU/unit come from the live row.
  const productById = new Map(products.map((p) => [p.id, p]));
  for (const row of topProducts) {
    if (row.productId) {
      const live = productById.get(row.productId);
      if (live) {
        row.name = live.name;
        row.sku = live.sku ?? null;
        row.unit = row.unit ?? live.unit ?? null;
      }
    }
  }

  // ---- Expenses by category — honest denominator (§9 / Gate G) --------------
  const byCategory = new Map<string, number>();
  for (const e of expenses) {
    if (!inWindow(e.spentAt)) continue;
    byCategory.set(e.category, safeAdd(byCategory.get(e.category) ?? 0, e.amountMinor, "category total"));
  }
  const allCategories = [...byCategory.entries()]
    .map(([category, totalMinor]) => ({ category, totalMinor }))
    .sort((a, b) => b.totalMinor - a.totalMinor || a.category.localeCompare(b.category));
  const CATEGORY_TOP = 6;
  const topCategories = allCategories.slice(0, CATEGORY_TOP);
  let otherMinor = 0;
  for (const c of allCategories.slice(CATEGORY_TOP)) {
    otherMinor = safeAdd(otherMinor, c.totalMinor, "other category total");
  }
  // Law (Gate G): SUM(topCategories + otherMinor) === expensesMinor.
  const expensesByCategory = topCategories;
  const expensesByCategoryOther = { category: "__other__", totalMinor: otherMinor };

  // ---- Inventory health ------------------------------------------------------
  // R102 — the valuation ROWS are built ONCE here (the same population law
  // as Prompt 51: businessId + deletedAt: null INCLUDING inactive), every
  // row through the SAME state classifiers the detailed report uses, so the
  // summary's inventory total and its throne can never disagree with the
  // valuation report (Gate D reconciliation — one authority, no drift).
  const inventoryRows: InventoryValuationRow[] = products.map((p) => ({
    id: p.id,
    name: p.name,
    sku: p.sku,
    unit: p.unit,
    stockQty: p.stockQty,
    lowStockAt: p.lowStockAt,
    costPriceMinor: p.costPriceMinor,
    isActive: p.isActive,
    estimatedValueMinor: safeMul(p.stockQty, p.costPriceMinor, "inventory value"),
    stockState: rowStockState(p.stockQty, p.lowStockAt),
    costState: rowCostState(p.costPriceMinor),
  }));
  let inventoryValueMinor = 0;
  const lowStockItems: Array<{
    id: string;
    name: string;
    unit: string | null;
    stockQty: number;
    lowStockAt: number;
  }> = [];
  for (const p of inventoryRows) {
    // Operational current-cost estimate — quantity × current cost price
    // (NOT an accounting valuation; Gate N wording preserved).
    inventoryValueMinor = safeAdd(inventoryValueMinor, p.estimatedValueMinor, "inventory total");
    if (p.stockQty <= p.lowStockAt) {
      lowStockItems.push({
        id: p.id,
        name: p.name,
        unit: p.unit,
        stockQty: p.stockQty,
        lowStockAt: p.lowStockAt,
      });
    }
  }
  lowStockItems.sort((a, b) => a.stockQty - b.stockQty);
  // R99/R102 — the value podium: EXACTLY the VALUE_DESC order's head via the
  // ONE extractor (re-sorts through sortInventoryRows internally — the throne
  // can never disagree with the detailed report's own ranking).
  const inventoryTopValueProducts = computeInventoryTopValueProducts(inventoryRows, 2);

  return {
    // `days` stays the ROLLING preset (7/30/90) for backward compatibility;
    // custom windows expose their honest inclusive length via rangeDays and
    // echo the requested bounds via custom.
    range: {
      days: custom ? dayKeys.length : days,
      from: fromKey,
      to: toKey,
      timezone: tz,
      ...(custom ? { custom: { from: fromKey, to: toKey } } : {}),
    },
    kpis: {
      revenueMinor,
      salesCount,
      avgSaleMinor: salesCount > 0 ? Math.round(revenueMinor / salesCount) : 0,
      collectedMinor,
      expensesMinor,
      expensesCount,
      paidOutMinor,
      netCashMinor: safeSub(collectedMinor, paidOutMinor, "netCashMinor"),
      netAccrualMinor: safeSub(revenueMinor, expensesMinor, "netAccrualMinor"),
    },
    // R115 — the additive comparison block: the same-LENGTH window
    // immediately before `range` (§6 law). pcts ride the ONE L8 authority
    // (pctChange: null on a ≤0 baseline — the chip and the copilot narrate
    // from these RAW inputs, never computing their own %). Older cached
    // clients honestly omit what they don't know (additive law).
    trend: {
      revenuePrevMinor,
      expensesPrevMinor,
      collectedPrevMinor,
      paidOutPrevMinor,
      netCashPrevMinor,
      revenueChangePct: pctChange(revenueMinor, revenuePrevMinor),
      expensesChangePct: pctChange(expensesMinor, expensesPrevMinor),
      collectedChangePct: pctChange(collectedMinor, collectedPrevMinor),
      netCashChangePct: pctChange(
        safeSub(collectedMinor, paidOutMinor, "netCashMinor"),
        netCashPrevMinor,
      ),
      salesCountPrev,
      expensesCountPrev,
      previousRange: { from: trendWindow.fromKey, to: trendWindow.toKey },
    },
    timeline,
    topProducts,
    expensesByCategory,
    // Prompt 50 additive — truthful "Other" bucket + reconciling total:
    //   SUM(expensesByCategory[*].totalMinor) + expensesByCategoryOther.totalMinor
    //   === kpis.expensesMinor   (same window, same filters)
    expensesByCategoryOther,
    expensesByCategoryTotalMinor: expensesMinor,
    expensesCategoryCount: allCategories.length,
    outstanding: {
      receivableMinor: (openSales._sum.totalMinor ?? 0) - (openSales._sum.paidMinor ?? 0),
      receivableCount: openSales._count,
      payableMinor: (openExpenses._sum.amountMinor ?? 0) - (openExpenses._sum.paidMinor ?? 0),
      payableCount: openExpenses._count,
    },
    inventory: {
      valueMinor: inventoryValueMinor,
      productCount: products.length,
      lowStockCount: lowStockItems.length,
      lowStockItems: lowStockItems.slice(0, 6),
      // R99/R102 — the additive throne field (older cached clients stay
      // honest — the view type carries it OPTIONAL).
      topValueProducts: inventoryTopValueProducts,
    },
  };
}

// ---- Month-over-month breakdown ---------------------------------------------

import {
  ALLOWED_REPORT_MONTHS,
  normalizeReportMonthsInput,
  type ReportMonths,
} from "@/lib/report-periods";

export { ALLOWED_REPORT_MONTHS };
export type { ReportMonths };

export function normalizeReportMonths(input: unknown): ReportMonths {
  return normalizeReportMonthsInput(input);
}

/** YYYY-MM key in a given IANA timezone (falls back to UTC). Exported so the
 *  sales/expenses list APIs can filter by the EXACT same month bucket the
 *  MoM table and drill-down use — figures can never drift between views. */
export function localMonthKey(d: Date, timeZone: string): string {
  return localMonthKeyOf(d, timeZone);
}

export type MonthlyBreakdown = Awaited<ReturnType<typeof buildMonthlyBreakdown>>;

/**
 * Month-over-month KPI series for the last `months` calendar months
 * (including the current, partially-elapsed month). Deterministic: every
 * figure is bucketed from recorded transactions in the business timezone.
 * Ordered oldest → newest.
 *
 * Prompt 50: the fetch window is bounded on BOTH sides — and the current
 * month ends at the end of TODAY (business-local), so a future-dated row
 * can never inflate the in-progress month (Gate B).
 */
export async function buildMonthlyBreakdown(businessId: string, months: ReportMonths) {
  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { timezone: true },
  });
  const tz = business?.timezone || "UTC";

  // Month keys oldest → newest, ending with the current month.
  const monthKeys: string[] = [];
  {
    const cursor = new Date();
    cursor.setUTCDate(1); // anchor: shifting month on the 1st is DST-safe
    for (let i = 0; i < months; i++) {
      monthKeys.unshift(localMonthKeyOf(cursor, tz));
      cursor.setUTCMonth(cursor.getUTCMonth() - 1);
    }
  }

  // EXACT bounds: start of the oldest month → end of the CURRENT local day
  // (the newest month bucket is the current, partially-elapsed one).
  const now = new Date();
  const oldest = monthKeys[0];
  const fetchFrom = zonedDayStartUtc(`${oldest}-01`, tz);
  const fetchUntil = zonedDayEndExclusiveUtc(todayKey(now, tz), tz);

  const [sales, payments, expenses] = await Promise.all([
    db.sale.findMany({
      where: { businessId, deletedAt: null, issueDate: { gte: fetchFrom, lt: fetchUntil } },
      select: { issueDate: true, totalMinor: true },
    }),
    db.payment.findMany({
      where: { businessId, paidAt: { gte: fetchFrom, lt: fetchUntil } },
      select: { paidAt: true, direction: true, amountMinor: true },
    }),
    db.expense.findMany({
      where: { businessId, deletedAt: null, spentAt: { gte: fetchFrom, lt: fetchUntil } },
      select: { spentAt: true, amountMinor: true },
    }),
  ]);

  type MonthBucket = {
    revenueMinor: number;
    salesCount: number;
    expensesMinor: number;
    expensesCount: number;
    collectedMinor: number;
    paidOutMinor: number;
  };
  const bucket = new Map<string, MonthBucket>();
  for (const key of monthKeys) {
    bucket.set(key, {
      revenueMinor: 0,
      salesCount: 0,
      expensesMinor: 0,
      expensesCount: 0,
      collectedMinor: 0,
      paidOutMinor: 0,
    });
  }
  const add = (iso: Date, field: keyof MonthBucket, amount: number) => {
    const mk = localMonthKeyOf(iso, tz);
    const b = bucket.get(mk);
    if (b) (b[field] as number) = safeAdd(b[field], amount, field);
  };
  for (const s of sales) add(s.issueDate, "revenueMinor", s.totalMinor);
  for (const s of sales) add(s.issueDate, "salesCount", 1);
  for (const e of expenses) add(e.spentAt, "expensesMinor", e.amountMinor);
  for (const e of expenses) add(e.spentAt, "expensesCount", 1);
  for (const p of payments) {
    add(
      p.paidAt,
      p.direction === "IN" ? "collectedMinor" : "paidOutMinor",
      p.amountMinor,
    );
  }

  return {
    months: monthKeys.length,
    series: monthKeys.map((month) => {
      const b = bucket.get(month)!;
      return {
        month, // YYYY-MM (display label is a client/UI concern)
        revenueMinor: b.revenueMinor,
        salesCount: b.salesCount,
        expensesMinor: b.expensesMinor,
        expensesCount: b.expensesCount,
        collectedMinor: b.collectedMinor,
        paidOutMinor: b.paidOutMinor,
        netCashMinor: b.collectedMinor - b.paidOutMinor,
        netAccrualMinor: b.revenueMinor - b.expensesMinor,
      };
    }),
  };
}

// ---- Single-month drill-down --------------------------------------------------

import { envCap as periodEnvCap } from "@/lib/report-periods";

/** Monthly preview cap (§10 — the UI shows a bounded, DISCLOSED preview). */
export const MONTH_PREVIEW_LIMIT = 25;
/** §10 — per-section cap for the COMPLETE monthly CSV extraction (env-tunable
 *  per the P49 envCap convention so harnesses can exercise the reject law). */
export const MONTH_EXPORT_MAX_ROWS = periodEnvCap("MONTH_EXPORT_MAX_ROWS", 5000, 10, 200_000);
const MONTH_EXPORT_CHUNK = Math.min(400, MONTH_EXPORT_MAX_ROWS + 1);

/**
 * Validate a YYYY-MM drill-down key. Returns null for anything outside
 * 2000-01 .. 2100-12 — the client value is never trusted.
 */
export function normalizeMonthKey(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const m = /^(\d{4})-(\d{2})$/.exec(input);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return null;
  return `${m[1]}-${m[2]}`;
}

export type MonthDetail = Awaited<ReturnType<typeof buildMonthDetail>>;

/**
 * Widened UTC fetch window for a YYYY-MM month bucket (±2 days so timezone
 * shifts at month boundaries are covered) — the SUPERSET the sales/expenses
 * list APIs fetch before re-filtering rows with the authoritative
 * localMonthKey (identical bucketing to buildMonthDetail). The REPORT-side
 * exact window is resolveMonthWindow() in lib/report-periods.ts.
 */
export function monthWindow(monthKey: string): { from: Date; until: Date } | null {
  const month = normalizeMonthKey(monthKey);
  if (!month) return null;
  const [y, m] = month.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1));
  from.setUTCDate(from.getUTCDate() - 2);
  const until = new Date(Date.UTC(y, m, 1));
  until.setUTCDate(until.getUTCDate() + 2);
  return { from, until };
}

/**
 * Drill-down for ONE month bucket of the MoM table. Uses the SAME
 * localMonthKey bucketing as buildMonthlyBreakdown — figures here always
 * match the table row (single source of truth, deterministic).
 *
 * Prompt 50 (§10): totals cover ALL month rows (DB-complete); the row
 * lists remain a bounded PREVIEW accompanied by truthful
 * totalCount/displayedCount/hasMore metadata — never a silent truncation.
 */
export async function buildMonthDetail(businessId: string, monthKey: string) {
  const month = normalizeMonthKey(monthKey);
  if (!month) return null;

  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { timezone: true },
  });
  const tz = business?.timezone || "UTC";

  const window = resolveMonthWindow(tz, month, new Date());
  if (!window) return null;
  const { fetchFrom, fetchUntil } = window;

  const [sales, expenses, payments] = await Promise.all([
    db.sale.findMany({
      where: {
        businessId,
        deletedAt: null,
        issueDate: { gte: fetchFrom, lt: fetchUntil },
      },
      select: {
        number: true,
        issueDate: true,
        totalMinor: true,
        paidMinor: true,
        status: true,
        customer: { select: { name: true } },
      },
      orderBy: [{ issueDate: "desc" }, { id: "desc" }],
    }),
    db.expense.findMany({
      where: {
        businessId,
        deletedAt: null,
        spentAt: { gte: fetchFrom, lt: fetchUntil },
      },
      select: {
        category: true,
        spentAt: true,
        amountMinor: true,
        paidMinor: true,
        status: true,
        supplier: { select: { name: true } },
      },
      orderBy: [{ spentAt: "desc" }, { id: "desc" }],
    }),
    db.payment.findMany({
      where: { businessId, paidAt: { gte: fetchFrom, lt: fetchUntil } },
      select: { paidAt: true, direction: true, amountMinor: true },
    }),
  ]);

  let revenueMinor = 0;
  let collectedMinor = 0;
  let paidOutMinor = 0;
  const inMonthSales = sales.filter((s) => {
    if (localMonthKeyOf(s.issueDate, tz) !== month) return false;
    revenueMinor = safeAdd(revenueMinor, s.totalMinor, "month revenue");
    return true;
  });
  const inMonthExpenses = expenses.filter((e) => {
    if (localMonthKeyOf(e.spentAt, tz) !== month) return false;
    return true;
  });
  for (const p of payments) {
    if (localMonthKeyOf(p.paidAt, tz) !== month) continue;
    if (p.direction === "IN") collectedMinor = safeAdd(collectedMinor, p.amountMinor, "month collected");
    else paidOutMinor = safeAdd(paidOutMinor, p.amountMinor, "month paidOut");
  }
  let expensesMinor = 0;
  for (const e of inMonthExpenses) {
    expensesMinor = safeAdd(expensesMinor, e.amountMinor, "month expenses");
  }

  return {
    month,
    timezone: tz,
    totals: {
      revenueMinor,
      salesCount: inMonthSales.length,
      expensesMinor,
      expensesCount: inMonthExpenses.length,
      collectedMinor,
      paidOutMinor,
      netCashMinor: safeSub(collectedMinor, paidOutMinor, "month netCash"),
      netAccrualMinor: safeSub(revenueMinor, expensesMinor, "month netAccrual"),
    },
    // Bounded preview (disclosed, §10) — the FULL month remains available
    // through "Open in Sales"/"Open in Expenses" and the complete CSV.
    sales: inMonthSales.slice(0, MONTH_PREVIEW_LIMIT).map((s) => ({
      number: s.number,
      issueDate: s.issueDate.toISOString(),
      customerName: s.customer?.name ?? null,
      totalMinor: s.totalMinor,
      paidMinor: s.paidMinor,
      balanceMinor: safeSub(s.totalMinor, s.paidMinor, "sale balance"),
      status: s.status,
    })),
    expenses: inMonthExpenses.slice(0, MONTH_PREVIEW_LIMIT).map((e) => ({
      category: e.category,
      spentAt: e.spentAt.toISOString(),
      supplierName: e.supplier?.name ?? null,
      amountMinor: e.amountMinor,
      paidMinor: e.paidMinor,
      balanceMinor: safeSub(e.amountMinor, e.paidMinor, "expense balance"),
      status: e.status,
    })),
    // Prompt 50 additive preview metadata (§10):
    preview: {
      sales: {
        totalCount: inMonthSales.length,
        displayedCount: Math.min(inMonthSales.length, MONTH_PREVIEW_LIMIT),
        hasMore: inMonthSales.length > MONTH_PREVIEW_LIMIT,
      },
      expenses: {
        totalCount: inMonthExpenses.length,
        displayedCount: Math.min(inMonthExpenses.length, MONTH_PREVIEW_LIMIT),
        hasMore: inMonthExpenses.length > MONTH_PREVIEW_LIMIT,
      },
    },
  };
}

// ---- Complete monthly CSV extraction (§10 — complete or reject) --------------

export type MonthDetailRows = {
  month: string;
  timezone: string;
  /** Month KPI totals for the payment-basis rows (§10 reconciliation). */
  collectedMinor: number;
  paidOutMinor: number;
  sales: Array<{
    number: number;
    issueDate: string;
    customerName: string | null;
    totalMinor: number;
    paidMinor: number;
    balanceMinor: number;
    status: string;
  }>;
  expenses: Array<{
    category: string;
    spentAt: string;
    supplierName: string | null;
    amountMinor: number;
    paidMinor: number;
    balanceMinor: number;
    status: string;
  }>;
};

/**
 * COMPLETE month rows for the CSV export — bounded CHUNKED keyset
 * extraction (never `findMany()` without take, never a silent prefix).
 * Returns null-with-reason when the month exceeds MONTH_EXPORT_MAX_ROWS
 * per section: the caller MUST reject the export instead of shipping a
 * partial file (§10 complete-or-reject law).
 */
export async function buildMonthDetailComplete(
  businessId: string,
  monthKey: string,
): Promise<
  | { status: "ok"; rows: MonthDetailRows }
  | { status: "too-large"; section: "sales" | "expenses"; max: number }
  | null
> {
  const month = normalizeMonthKey(monthKey);
  if (!month) return null;

  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { timezone: true },
  });
  const tz = business?.timezone || "UTC";
  const window = resolveMonthWindow(tz, month, new Date());
  if (!window) return null;
  const { fetchFrom, fetchUntil } = window;

  // ---- Sales: keyset chunks ordered (issueDate asc, id asc) ----
  const sales: Array<{
    number: number;
    issueDate: Date;
    totalMinor: number;
    paidMinor: number;
    status: string;
    customerName: string | null;
    id: string;
  }> = [];
  {
    let lastIssue: Date | null = null;
    let lastId: string | null = null;
    for (;;) {
      const chunk = await db.sale.findMany({
        where: {
          businessId,
          deletedAt: null,
          issueDate: { gte: fetchFrom, lt: fetchUntil },
          ...(lastIssue && lastId
            ? {
                OR: [
                  { issueDate: { gt: lastIssue } },
                  { AND: [{ issueDate: { gte: lastIssue } }, { id: { gt: lastId } }] },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          number: true,
          issueDate: true,
          totalMinor: true,
          paidMinor: true,
          status: true,
          customer: { select: { name: true } },
        },
        orderBy: [{ issueDate: "asc" }, { id: "asc" }],
        take: MONTH_EXPORT_CHUNK,
      });
      for (const s of chunk) {
        sales.push({
          id: s.id,
          number: s.number,
          issueDate: s.issueDate,
          totalMinor: s.totalMinor,
          paidMinor: s.paidMinor,
          status: s.status,
          customerName: s.customer?.name ?? null,
        });
      }
      // Cap check runs BEFORE the exhaustion break — a small final chunk can
      // never smuggle an over-cap month through as "complete" (§10).
      if (sales.length > MONTH_EXPORT_MAX_ROWS) {
        return { status: "too-large", section: "sales", max: MONTH_EXPORT_MAX_ROWS };
      }
      if (chunk.length < MONTH_EXPORT_CHUNK) break;
      const last = chunk[chunk.length - 1];
      lastIssue = last.issueDate;
      lastId = last.id;
    }
  }

  // ---- Expenses: keyset chunks ordered (spentAt asc, id asc) ----
  const expenses: Array<{
    category: string;
    spentAt: Date;
    amountMinor: number;
    paidMinor: number;
    status: string;
    supplierName: string | null;
  }> = [];
  {
    let lastSpent: Date | null = null;
    let lastId: string | null = null;
    for (;;) {
      const chunk = await db.expense.findMany({
        where: {
          businessId,
          deletedAt: null,
          spentAt: { gte: fetchFrom, lt: fetchUntil },
          ...(lastSpent && lastId
            ? {
                OR: [
                  { spentAt: { gt: lastSpent } },
                  { AND: [{ spentAt: { gte: lastSpent } }, { id: { gt: lastId } }] },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          category: true,
          spentAt: true,
          amountMinor: true,
          paidMinor: true,
          status: true,
          supplier: { select: { name: true } },
        },
        orderBy: [{ spentAt: "asc" }, { id: "asc" }],
        take: MONTH_EXPORT_CHUNK,
      });
      for (const e of chunk) {
        expenses.push({
          category: e.category,
          spentAt: e.spentAt,
          amountMinor: e.amountMinor,
          paidMinor: e.paidMinor,
          status: e.status,
          supplierName: e.supplier?.name ?? null,
        });
      }
      // Cap check BEFORE the exhaustion break (§10 — never a partial 200).
      if (expenses.length > MONTH_EXPORT_MAX_ROWS) {
        return { status: "too-large", section: "expenses", max: MONTH_EXPORT_MAX_ROWS };
      }
      if (chunk.length < MONTH_EXPORT_CHUNK) break;
      const last = chunk[chunk.length - 1];
      lastSpent = last.spentAt;
      lastId = last.id;
    }
  }

  // Payment-basis month totals (collected / paid out) — actual Payment rows
  // on the SAME exact window; never derived from invoice totals (§2.2).
  const paymentAgg = await db.payment.groupBy({
    by: ["direction"],
    where: { businessId, paidAt: { gte: fetchFrom, lt: fetchUntil } },
    _sum: { amountMinor: true },
  });
  const collectedMinor =
    paymentAgg.find((p) => p.direction === "IN")?._sum.amountMinor ?? 0;
  const paidOutMinor =
    paymentAgg.find((p) => p.direction === "OUT")?._sum.amountMinor ?? 0;

  return {
    status: "ok",
    rows: {
      month,
      timezone: tz,
      collectedMinor,
      paidOutMinor,
      sales: sales.map((s) => ({
        number: s.number,
        issueDate: s.issueDate.toISOString(),
        customerName: s.customerName,
        totalMinor: s.totalMinor,
        paidMinor: s.paidMinor,
        balanceMinor: safeSub(s.totalMinor, s.paidMinor, "export sale balance"),
        status: s.status,
      })),
      expenses: expenses.map((e) => ({
        category: e.category,
        spentAt: e.spentAt.toISOString(),
        supplierName: e.supplierName,
        amountMinor: e.amountMinor,
        paidMinor: e.paidMinor,
        balanceMinor: safeSub(e.amountMinor, e.paidMinor, "export expense balance"),
        status: e.status,
      })),
    },
  };
}
