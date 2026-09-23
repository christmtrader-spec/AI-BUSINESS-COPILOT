/**
 * Advanced report insights — Prompt 20 (§35).
 *
 * The gated "advanced" block of the reports summary: deterministic
 * comparisons the basic MVP reports do not include (growth vs the previous
 * equivalent window, customer revenue concentration). EVERY figure is
 * computed by THIS server from recorded transactions with integer math
 * (A08/A11-A13) — the AI and the UI only narrate.
 *
 * Entitlement: ADVANCED_REPORTS (enforced in GET /api/v1/reports/summary —
 * the server OMITS this block entirely when not entitled, so hiding the
 * UI card without server enforcement can never happen the other way
 * around, §26).
 */
import { db } from "@/lib/db";
import { normalizeReportDays, type ReportDays } from "@/lib/reports";

export type AdvancedInsights = {
  previousRange: { from: string; to: string };
  growth: {
    revenueMinor: number;
    revenuePrevMinor: number;
    revenueChangePct: number | null; // null when previous window revenue = 0
    salesCount: number;
    salesCountPrev: number;
    salesChangePct: number | null;
    expensesMinor: number;
    expensesPrevMinor: number;
    expensesChangePct: number | null;
  };
  concentration: {
    topCustomers: Array<{ name: string; revenueMinor: number; sharePct: number }>;
    top5SharePct: number;
    customerCount: number;
  };
};

function pctChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

/**
 * Deterministic advanced insights for the last `days` compared with the
 * preceding `days` window. Timezone-safe: windows use the business
 * timezone's local date keys, mirroring lib/reports.ts.
 */
export async function buildAdvancedInsights(
  businessId: string,
  daysInput: unknown,
): Promise<AdvancedInsights> {
  const days = normalizeReportDays(daysInput);
  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { timezone: true },
  });
  const tz = business?.timezone || "UTC";

  // Window boundaries in UTC instants matching local-day semantics used by
  // lib/reports.ts (localDateKey). We compute the same "today" anchor.
  const now = new Date();
  const localToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // YYYY-MM-DD
  const todayStart = new Date(`${localToday}T00:00:00Z`);
  const windowFrom = new Date(todayStart.getTime() - (days - 1) * 86_400_000);
  const prevFrom = new Date(windowFrom.getTime() - days * 86_400_000);
  const prevUntil = new Date(windowFrom.getTime() - 1);

  const [sales, expenses, salesPrev, expensesPrev] = await Promise.all([
    db.sale.findMany({
      where: { businessId, deletedAt: null, issueDate: { gte: windowFrom, lte: now } },
      select: { totalMinor: true, customerId: true },
    }),
    db.expense.findMany({
      where: { businessId, deletedAt: null, spentAt: { gte: windowFrom, lte: now } },
      select: { amountMinor: true },
    }),
    db.sale.findMany({
      where: { businessId, deletedAt: null, issueDate: { gte: prevFrom, lte: prevUntil } },
      select: { totalMinor: true },
    }),
    db.expense.findMany({
      where: { businessId, deletedAt: null, spentAt: { gte: prevFrom, lte: prevUntil } },
      select: { amountMinor: true },
    }),
  ]);

  const revenueMinor = sales.reduce((sum, s) => sum + s.totalMinor, 0);
  const revenuePrevMinor = salesPrev.reduce((sum, s) => sum + s.totalMinor, 0);
  const expensesMinor = expenses.reduce((sum, e) => sum + e.amountMinor, 0);
  const expensesPrevMinor = expensesPrev.reduce((sum, e) => sum + e.amountMinor, 0);

  // ---- Customer concentration (current window) -----------------------------
  const byCustomer = new Map<string, number>();
  for (const s of sales) {
    if (!s.customerId) continue;
    byCustomer.set(s.customerId, (byCustomer.get(s.customerId) ?? 0) + s.totalMinor);
  }
  const customerIds = [...byCustomer.keys()];
  const customers =
    customerIds.length > 0
      ? await db.customer.findMany({
          where: { id: { in: customerIds } },
          select: { id: true, name: true },
        })
      : [];
  const nameOf = new Map(customers.map((c) => [c.id, c.name]));
  const topCustomers = [...byCustomer.entries()]
    .map(([id, minor]) => ({
      name: nameOf.get(id) ?? "—",
      revenueMinor: minor,
      sharePct: revenueMinor > 0 ? Math.round((minor / revenueMinor) * 100) : 0,
    }))
    .sort((a, b) => b.revenueMinor - a.revenueMinor)
    .slice(0, 5);
  const top5SharePct =
    revenueMinor > 0
      ? Math.round(
          (topCustomers.reduce((sum, c) => sum + c.revenueMinor, 0) / revenueMinor) * 100,
        )
      : 0;

  return {
    previousRange: {
      from: prevFrom.toISOString().slice(0, 10),
      to: prevUntil.toISOString().slice(0, 10),
    },
    growth: {
      revenueMinor,
      revenuePrevMinor,
      revenueChangePct: pctChange(revenueMinor, revenuePrevMinor),
      salesCount: sales.length,
      salesCountPrev: salesPrev.length,
      salesChangePct: pctChange(sales.length, salesPrev.length),
      expensesMinor,
      expensesPrevMinor,
      expensesChangePct: pctChange(expensesMinor, expensesPrevMinor),
    },
    concentration: {
      topCustomers,
      top5SharePct,
      customerCount: customerIds.length,
    },
  };
}
