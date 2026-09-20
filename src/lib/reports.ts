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
