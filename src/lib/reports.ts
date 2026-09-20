/**
 * Deterministic report computation — single source of truth.
 *
 * Used by BOTH /api/v1/reports/summary (charts UI) and the AI copilot
 * grounding pipeline (A11-A13): every figure the AI can speak is computed
 * HERE by the server from recorded transactions. The AI only narrates.
 *
 * Day boundaries honor the business timezone (A04) via Intl bucketing;
 * all money is integer minor units (A08).
 */
import { db } from "@/lib/db";

export const ALLOWED_REPORT_DAYS = [7, 30, 90] as const;
export type ReportDays = (typeof ALLOWED_REPORT_DAYS)[number];

export function normalizeReportDays(input: unknown): ReportDays {
  const n = Number(input ?? 30);
  return (ALLOWED_REPORT_DAYS as readonly number[]).includes(n) ? (n as ReportDays) : 30;
}

/** YYYY-MM-DD key in a given IANA timezone (falls back to UTC). */
function localDateKey(d: Date, timeZone: string): string {
  try {
    // en-CA gives ISO-like YYYY-MM-DD output.
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export type ReportSummary = Awaited<ReturnType<typeof buildReportSummary>>;

export async function buildReportSummary(businessId: string, days: ReportDays) {
  // Business timezone for day boundaries (A04).
  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { timezone: true },
  });
  const tz = business?.timezone || "UTC";

  // Range: the last `days` calendar days ending today (local to business).
  const now = new Date();
  const todayKey = localDateKey(now, tz);
  const dayKeys: string[] = [];
  {
    // Walk back from today, local-key based (robust across DST).
    const cursor = new Date(now);
    for (let i = 0; i < days; i++) {
      dayKeys.unshift(localDateKey(cursor, tz));
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
  }
  // Fetch window: widen by 1 day so timezone shifts are covered.
  const fetchFrom = new Date(now);
  fetchFrom.setUTCDate(fetchFrom.getUTCDate() - days);
  fetchFrom.setUTCHours(0, 0, 0, 0);

  const dateGte = fetchFrom;

  const [sales, payments, expenses, saleItems, products, openSales, openExpenses] =
    await Promise.all([
      db.sale.findMany({
        where: {
          businessId,
          deletedAt: null,
          issueDate: { gte: dateGte },
        },
        select: { issueDate: true, totalMinor: true, discountMinor: true },
      }),
      db.payment.findMany({
        where: { businessId, paidAt: { gte: dateGte } },
        select: { paidAt: true, direction: true, amountMinor: true },
      }),
      db.expense.findMany({
        where: {
          businessId,
          deletedAt: null,
          spentAt: { gte: dateGte },
        },
        select: { spentAt: true, category: true, amountMinor: true },
      }),
      db.saleItem.findMany({
        where: {
          sale: {
            businessId,
            deletedAt: null,
            issueDate: { gte: dateGte },
          },
        },
        select: { name: true, qty: true, lineTotalMinor: true },
      }),
      db.product.findMany({
        where: { businessId, deletedAt: null },
        select: {
          id: true,
          name: true,
          unit: true,
          stockQty: true,
          lowStockAt: true,
          costPriceMinor: true,
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
    if (b) b[field] += amount;
  };
  for (const s of sales) add(s.issueDate, "revenueMinor", s.totalMinor);
  for (const e of expenses) add(e.spentAt, "expenseMinor", e.amountMinor);
  for (const p of payments) {
    add(p.paidAt, p.direction === "IN" ? "collectedMinor" : "paidOutMinor", p.amountMinor);
  }
  const timeline = dayKeys.map((date) => ({ date, ...bucket.get(date)! }));

  // ---- KPIs over the selected window ---------------------------------------
  const firstKey = dayKeys[0];
  const inWindow = (iso: Date) => localDateKey(iso, tz) >= firstKey;
  let revenueMinor = 0;
  let salesCount = 0;
  for (const s of sales) {
    if (inWindow(s.issueDate)) {
      revenueMinor += s.totalMinor;
      salesCount += 1;
    }
  }
  let expensesMinor = 0;
  let expensesCount = 0;
  for (const e of expenses) {
    if (inWindow(e.spentAt)) {
      expensesMinor += e.amountMinor;
      expensesCount += 1;
    }
  }
  let collectedMinor = 0;
  let paidOutMinor = 0;
  for (const p of payments) {
    if (!inWindow(p.paidAt)) continue;
    if (p.direction === "IN") collectedMinor += p.amountMinor;
    else paidOutMinor += p.amountMinor;
  }

  // ---- Top products (by revenue in window) ----------------------------------
  const byProduct = new Map<string, { qty: number; revenueMinor: number }>();
  for (const item of saleItems) {
    const agg = byProduct.get(item.name) ?? { qty: 0, revenueMinor: 0 };
    agg.qty += item.qty;
    agg.revenueMinor += item.lineTotalMinor;
    byProduct.set(item.name, agg);
  }
  const topProducts = [...byProduct.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.revenueMinor - a.revenueMinor)
    .slice(0, 5);

  // ---- Expenses by category (window) ----------------------------------------
  const byCategory = new Map<string, number>();
  for (const e of expenses) {
    if (!inWindow(e.spentAt)) continue;
    byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + e.amountMinor);
  }
  const expensesByCategory = [...byCategory.entries()]
    .map(([category, totalMinor]) => ({ category, totalMinor }))
    .sort((a, b) => b.totalMinor - a.totalMinor)
    .slice(0, 6);

  // ---- Inventory health ------------------------------------------------------
  let inventoryValueMinor = 0;
  const lowStockItems: Array<{
    id: string;
    name: string;
    unit: string | null;
    stockQty: number;
    lowStockAt: number;
  }> = [];
  for (const p of products) {
    inventoryValueMinor += p.stockQty * p.costPriceMinor;
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

  return {
    range: { days, from: firstKey, to: todayKey, timezone: tz },
    kpis: {
      revenueMinor,
      salesCount,
      avgSaleMinor: salesCount > 0 ? Math.round(revenueMinor / salesCount) : 0,
      collectedMinor,
      expensesMinor,
      expensesCount,
      paidOutMinor,
      netCashMinor: collectedMinor - paidOutMinor,
      netAccrualMinor: revenueMinor - expensesMinor,
    },
    timeline,
    topProducts,
    expensesByCategory,
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
    },
  };
}

// ---- Month-over-month breakdown ---------------------------------------------

export const ALLOWED_REPORT_MONTHS = [3, 6, 12] as const;
export type ReportMonths = (typeof ALLOWED_REPORT_MONTHS)[number];

export function normalizeReportMonths(input: unknown): ReportMonths {
  const n = Number(input ?? 6);
  return (ALLOWED_REPORT_MONTHS as readonly number[]).includes(n) ? (n as ReportMonths) : 6;
}

/** YYYY-MM key in a given IANA timezone (falls back to UTC). Exported so the
 *  sales/expenses list APIs can filter by the EXACT same month bucket the
 *  MoM table and drill-down use — figures can never drift between views. */
export function localMonthKey(d: Date, timeZone: string): string {
  try {
    // "en-CA" year + month, e.g. 2026-09 for September 2026.
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
    }).formatToParts(d);
    const year = parts.find((p) => p.type === "year")?.value;
    const month = parts.find((p) => p.type === "month")?.value;
    return year && month ? `${year}-${month}` : d.toISOString().slice(0, 7);
  } catch {
    return d.toISOString().slice(0, 7);
  }
}

export type MonthlyBreakdown = Awaited<ReturnType<typeof buildMonthlyBreakdown>>;

/**
 * Month-over-month KPI series for the last `months` calendar months
 * (including the current, partially-elapsed month). Deterministic: every
 * figure is bucketed from recorded transactions in the business timezone.
 * Ordered oldest → newest.
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
      monthKeys.unshift(localMonthKey(cursor, tz));
      cursor.setUTCMonth(cursor.getUTCMonth() - 1);
    }
  }

  // Fetch a widened window (start of the oldest month minus 2 days for tz).
  const [y, m] = monthKeys[0].split("-").map(Number);
  const fetchFrom = new Date(Date.UTC(y, m - 1, 1));
  fetchFrom.setUTCDate(fetchFrom.getUTCDate() - 2);

  const [sales, payments, expenses] = await Promise.all([
    db.sale.findMany({
      where: { businessId, deletedAt: null, issueDate: { gte: fetchFrom } },
      select: { issueDate: true, totalMinor: true },
    }),
    db.payment.findMany({
      where: { businessId, paidAt: { gte: fetchFrom } },
      select: { paidAt: true, direction: true, amountMinor: true },
    }),
    db.expense.findMany({
      where: { businessId, deletedAt: null, spentAt: { gte: fetchFrom } },
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
    const mk = localMonthKey(iso, tz);
    const b = bucket.get(mk);
    if (b) (b[field] as number) += amount;
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
 * shifts at month boundaries are covered). Rows are then filtered with the
 * authoritative localMonthKey — the SAME pattern buildMonthDetail uses.
 * Shared by the month drill-down AND the sales/expenses list ?month= filter.
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
 */
export async function buildMonthDetail(businessId: string, monthKey: string) {
  const month = normalizeMonthKey(monthKey);
  if (!month) return null;

  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { timezone: true },
  });
  const tz = business?.timezone || "UTC";

  // Widened UTC fetch window (±2 days) so tz shifts are covered — rows are
  // then filtered by the authoritative local month key.
  const [y, m] = month.split("-").map(Number);
  const fetchFrom = new Date(Date.UTC(y, m - 1, 1));
  fetchFrom.setUTCDate(fetchFrom.getUTCDate() - 2);
  const fetchUntil = new Date(Date.UTC(y, m, 1));
  fetchUntil.setUTCDate(fetchUntil.getUTCDate() + 2);

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
      orderBy: { issueDate: "desc" },
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
      orderBy: { spentAt: "desc" },
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
    if (localMonthKey(s.issueDate, tz) !== month) return false;
    revenueMinor += s.totalMinor;
    return true;
  });
  const inMonthExpenses = expenses.filter((e) => {
    if (localMonthKey(e.spentAt, tz) !== month) return false;
    return true;
  });
  for (const p of payments) {
    if (localMonthKey(p.paidAt, tz) !== month) continue;
    if (p.direction === "IN") collectedMinor += p.amountMinor;
    else paidOutMinor += p.amountMinor;
  }
  const expensesMinor = inMonthExpenses.reduce((sum, e) => sum + e.amountMinor, 0);

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
      netCashMinor: collectedMinor - paidOutMinor,
      netAccrualMinor: revenueMinor - expensesMinor,
    },
    sales: inMonthSales.slice(0, 25).map((s) => ({
      number: s.number,
      issueDate: s.issueDate.toISOString(),
      customerName: s.customer?.name ?? null,
      totalMinor: s.totalMinor,
      paidMinor: s.paidMinor,
      balanceMinor: s.totalMinor - s.paidMinor,
      status: s.status,
    })),
    expenses: inMonthExpenses.slice(0, 25).map((e) => ({
      category: e.category,
      spentAt: e.spentAt.toISOString(),
      supplierName: e.supplier?.name ?? null,
      amountMinor: e.amountMinor,
      paidMinor: e.paidMinor,
      balanceMinor: e.amountMinor - e.paidMinor,
      status: e.status,
    })),
  };
}
