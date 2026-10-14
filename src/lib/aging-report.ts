/**
 * Shared aging REPORT builder — the SINGLE source of the aging aggregation
 * (A11: one calculation, never a second one).
 *
 * Both /api/v1/reports/aging (UI JSON) and /api/v1/reports/aging/export
 * (CSV) render from THIS function, exactly like the statement engine backs
 * both its API and its CSV (§132/§133). Deterministic: business-timezone day
 * math (A07), integer minor units (A08), fixed buckets, AGING_SCAN_CAP per
 * side with an honest `truncated` flag.
 */
import { db } from "@/lib/db";
import { AGING_SCAN_CAP, buildAgingSide, localDayKey, type AgingItem } from "@/lib/aging";

export type AgingReport = {
  generatedAt: string;
  timezone: string;
  asOf: string;
  truncated: boolean;
  receivables: ReturnType<typeof buildAgingSide>;
  payables: ReturnType<typeof buildAgingSide>;
};

export async function buildAgingReport(businessId: string, now: Date = new Date()): Promise<AgingReport> {
  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { timezone: true },
  });
  const tz = business?.timezone || "UTC";

  const [sales, expenses] = await Promise.all([
    db.sale.findMany({
      where: { businessId, deletedAt: null, status: { not: "PAID" } },
      orderBy: { issueDate: "asc" },
      take: AGING_SCAN_CAP,
      select: {
        totalMinor: true,
        paidMinor: true,
        issueDate: true,
        // Prompt 49 (§6) — the AUTHORITATIVE party id travels with the name:
        // per-party drill-down keys on id, never on the display string.
        customer: { select: { id: true, name: true } },
      },
    }),
    db.expense.findMany({
      where: { businessId, deletedAt: null, status: { not: "PAID" } },
      orderBy: { spentAt: "asc" },
      take: AGING_SCAN_CAP,
      select: {
        amountMinor: true,
        paidMinor: true,
        spentAt: true,
        dueDate: true,
        supplier: { select: { id: true, name: true } },
      },
    }),
  ]);

  const receivableItems: AgingItem[] = sales.map((s) => ({
    anchor: s.issueDate,
    balanceMinor: s.totalMinor - s.paidMinor,
    party: s.customer?.name ?? null,
    partyId: s.customer?.id ?? null,
  }));

  const payableItems: AgingItem[] = expenses.map((e) => ({
    anchor: e.dueDate ?? e.spentAt,
    balanceMinor: e.amountMinor - e.paidMinor,
    party: e.supplier?.name ?? null,
    partyId: e.supplier?.id ?? null,
    dueDate: e.dueDate,
  }));

  return {
    generatedAt: now.toISOString(),
    timezone: tz,
    asOf: localDayKey(now, tz),
    truncated: sales.length >= AGING_SCAN_CAP || expenses.length >= AGING_SCAN_CAP,
    receivables: buildAgingSide(receivableItems, { timeZone: tz, now }),
    payables: buildAgingSide(payableItems, { timeZone: tz, now, withPastDue: true }),
  };
}
