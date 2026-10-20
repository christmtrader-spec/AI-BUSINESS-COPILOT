/**
 * Advanced report insights — Prompt 20 (§35), Prompt 50 hardened (§6/§8).
 *
 * The gated "advanced" block of the reports summary: deterministic
 * comparisons the basic MVP reports do not include (growth vs the previous
 * equivalent window, customer revenue concentration). EVERY figure is
 * computed by THIS server from recorded transactions with integer math
 * (A08/A11-A13) — the AI and the UI only narrate.
 *
 * Prompt 50 corrections (all previously REPRODUCED defects, now fixed):
 *  - D50-B: windows were anchored at `Date(localToday+"T00:00:00Z")` and
 *    stepped in fixed 86_400_000 ms — wrong for every non-UTC timezone and
 *    across DST. Now BOTH windows come from lib/report-periods.ts: exactly
 *    N business-local calendar dates each, no overlap, no gap, exclusive
 *    UTC database bounds (Gate D).
 *  - D50-C: the customer lookup queried `id IN (...)` WITHOUT the tenant
 *    scope. Every Customer row is now resolved with the authenticated
 *    businessId (Gate P) — ids alone never prove ownership.
 *  - Concentration rows carry the stable customerId (additive) so
 *    drill-downs key on identity, never on a display name (Gate F), and
 *    the unassigned-revenue share is exposed instead of redistributed.
 *
 * Entitlement: ADVANCED_REPORTS (enforced in GET /api/v1/reports/summary —
 * the server OMITS this block entirely when not entitled, so hiding the
 * UI card without server enforcement can never happen the other way
 * around, §26).
 */
import { db } from "@/lib/db";
import { pctChange, resolveCustomRange, resolvePreviousWindow, resolveRollingWindow, safeAdd, type ReportDays } from "@/lib/report-periods";
import { normalizeReportDays } from "@/lib/reports";

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
    topCustomers: Array<{
      // Prompt 50 additive — stable party identity for safe drill-down.
      customerId: string;
      name: string;
      revenueMinor: number;
      sharePct: number;
    }>;
    top5SharePct: number;
    customerCount: number;
    // Prompt 50 additive (§8) — issued revenue in the window with NO linked
    // customer. Exposed so named customers' shares visibly do NOT have to
    // add up to 100%; never redistributed across named customers.
    unassignedRevenueMinor: number;
    /** Denominator law: full window issued revenue (assigned + unassigned). */
    totalRevenueMinor: number;
  };
};

/**
 * Deterministic advanced insights for the last `days` compared with the
 * preceding `days` window. Timezone-safe: both windows are exact
 * business-local calendar-date ranges resolved by lib/report-periods.ts
 * (same law as lib/reports.ts — one date authority for all reports).
 */
export async function buildAdvancedInsights(
  businessId: string,
  daysInput: unknown,
  custom?: { from: string; to: string },
): Promise<AdvancedInsights> {
  const days = normalizeReportDays(daysInput);
  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { timezone: true },
  });
  const tz = business?.timezone || "UTC";

  // Prompt 52 §F4 — the advanced block accepts the same custom local-day
  // window as the summary (Jalali presets arrive as Gregorian from/to).
  // Previous window: the same NUMBER of local dates immediately before —
  // no overlap, no gap (Gate D law unchanged).
  const current = custom
    ? resolveCustomRange(tz, custom.from, custom.to, new Date())
    : resolveRollingWindow(tz, days, new Date());
  const previous = resolvePreviousWindow(tz, current.dayKeys.length, current.fromKey);

  const [sales, expenses, salesPrev, expensesPrev] = await Promise.all([
    db.sale.findMany({
      where: {
        businessId,
        deletedAt: null,
        issueDate: { gte: current.fetchFrom, lt: current.fetchUntil },
      },
      select: { totalMinor: true, customerId: true },
    }),
    db.expense.findMany({
      where: {
        businessId,
        deletedAt: null,
        spentAt: { gte: current.fetchFrom, lt: current.fetchUntil },
      },
      select: { amountMinor: true },
    }),
    db.sale.findMany({
      where: {
        businessId,
        deletedAt: null,
        issueDate: { gte: previous.fetchFrom, lt: previous.fetchUntil },
      },
      select: { totalMinor: true },
    }),
    db.expense.findMany({
      where: {
        businessId,
        deletedAt: null,
        spentAt: { gte: previous.fetchFrom, lt: previous.fetchUntil },
      },
      select: { amountMinor: true },
    }),
  ]);

  let revenueMinor = 0;
  for (const s of sales) revenueMinor = safeAdd(revenueMinor, s.totalMinor, "advanced revenue");
  let revenuePrevMinor = 0;
  for (const s of salesPrev) revenuePrevMinor = safeAdd(revenuePrevMinor, s.totalMinor, "advanced prev revenue");
  let expensesMinor = 0;
  for (const e of expenses) expensesMinor = safeAdd(expensesMinor, e.amountMinor, "advanced expenses");
  let expensesPrevMinor = 0;
  for (const e of expensesPrev) expensesPrevMinor = safeAdd(expensesPrevMinor, e.amountMinor, "advanced prev expenses");

  // ---- Customer concentration (current window) -----------------------------
  // Group by the ACTUAL Customer id (§8) — display names are never identity.
  const byCustomer = new Map<string, number>();
  let unassignedRevenueMinor = 0;
  for (const s of sales) {
    if (!s.customerId) {
      unassignedRevenueMinor = safeAdd(unassignedRevenueMinor, s.totalMinor, "unassigned revenue");
      continue;
    }
    byCustomer.set(s.customerId, safeAdd(byCustomer.get(s.customerId) ?? 0, s.totalMinor, "customer revenue"));
  }
  const customerIds = [...byCustomer.keys()];
  // TENANT LAW (D50-C fix): ids alone never prove ownership — every lookup
  // carries the authenticated businessId (Gate P).
  const customers =
    customerIds.length > 0
      ? await db.customer.findMany({
          where: { id: { in: customerIds }, businessId },
          select: { id: true, name: true },
        })
      : [];
  const nameOf = new Map(customers.map((c) => [c.id, c.name]));
  const topCustomers = [...byCustomer.entries()]
    .map(([customerId, minor]) => ({
      customerId,
      // Unreachable-by-construction fallback: the ids came from this
      // business's own sales, so the scoped lookup must resolve them.
      name: nameOf.get(customerId) ?? "—",
      revenueMinor: minor,
      sharePct: revenueMinor > 0 ? Math.round((minor / revenueMinor) * 100) : 0,
    }))
    // Deterministic order: revenue desc, then the stable party id (§8).
    .sort((a, b) => b.revenueMinor - a.revenueMinor || a.customerId.localeCompare(b.customerId))
    .slice(0, 5);
  const top5SharePct =
    revenueMinor > 0
      ? Math.round(
          (topCustomers.reduce((sum, c) => sum + c.revenueMinor, 0) / revenueMinor) * 100,
        )
      : 0;

  return {
    previousRange: {
      from: previous.fromKey,
      to: previous.toKey,
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
      unassignedRevenueMinor,
      totalRevenueMinor: revenueMinor,
    },
  };
}
