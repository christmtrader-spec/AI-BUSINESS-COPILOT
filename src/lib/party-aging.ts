/**
 * Prompt 49 (§10/§17) — PER-PARTY AGING summary helper.
 *
 * The bounded, read-only aging overview behind the Customer 360 and
 * Supplier 360 panels. ONE calculation authority (§3.2): items are mapped
 * to the canonical AgingItem shape and bucketed by buildAgingSide() —
 * there is NO second bucket algorithm, no second past-due law.
 *
 * LAWS PRESERVED:
 *   - receivables anchor on Sale.issueDate; NO customer due date is
 *     invented and NO overdue count is produced (§9);
 *   - payables anchor on dueDate ?? spentAt; past-due requires a stated
 *     dueDate strictly before today's business-local day (§9);
 *   - integer minor units only (A08);
 *   - business timezone from the authenticated business (never the client);
 *   - the scan is bounded by AGING_SCAN_CAP with an honest truncated flag.
 */
import { db } from "@/lib/db";
import {
  AGING_SCAN_CAP,
  buildAgingSide,
  localDayKey,
  type AgingBucketKey,
} from "./aging";

import type { PartyAgingSummary } from "@/lib/entities/types";

export type { PartyAgingSummary };

/**
 * Customer receivables aging for ONE tenant-scoped customer.
 * Open Sales only (status ≠ PAID, not deleted) — SalesOrders and Sales
 * Quotations are SEPARATE tables and can never appear here (§8).
 */
export async function buildCustomerAgingSummary(
  businessId: string,
  customerId: string,
  timeZone: string,
  now: Date = new Date(),
): Promise<PartyAgingSummary> {
  const sales = await db.sale.findMany({
    where: { businessId, customerId, deletedAt: null, status: { not: "PAID" } },
    orderBy: { issueDate: "asc" },
    take: AGING_SCAN_CAP,
    select: { totalMinor: true, paidMinor: true, issueDate: true },
  });

  const side = buildAgingSide(
    sales.map((s) => ({
      anchor: s.issueDate,
      balanceMinor: s.totalMinor - s.paidMinor,
      party: null,
      partyId: customerId,
    })),
    { timeZone, now },
  );

  return {
    asOf: localDayKey(now, timeZone),
    timezone: timeZone,
    totalOutstandingMinor: side.totalMinor,
    openItemCount: side.openCount,
    buckets: side.buckets,
    oldestDays: side.topParties[0]?.oldestDays ?? 0,
    // Receivables: NO past-due slice at all (§9 — invoice age is not a
    // contractual overdue claim; the keys are ABSENT, never null money).
    truncated: sales.length >= AGING_SCAN_CAP,
  };
}

/**
 * Supplier payables aging for ONE tenant-scoped supplier.
 * The Expense is the SOLE payable authority — a posted SupplierBill is never
 * a second item (its reference is not even needed for this summary; the
 * detailed view may attach it as supplemental metadata §8).
 */
export async function buildSupplierAgingSummary(
  businessId: string,
  supplierId: string,
  timeZone: string,
  now: Date = new Date(),
): Promise<PartyAgingSummary> {
  const expenses = await db.expense.findMany({
    where: { businessId, supplierId, deletedAt: null, status: { not: "PAID" } },
    orderBy: { spentAt: "asc" },
    take: AGING_SCAN_CAP,
    select: { amountMinor: true, paidMinor: true, spentAt: true, dueDate: true },
  });

  const side = buildAgingSide(
    expenses.map((e) => ({
      anchor: e.dueDate ?? e.spentAt,
      balanceMinor: e.amountMinor - e.paidMinor,
      party: null,
      partyId: supplierId,
      dueDate: e.dueDate,
    })),
    { timeZone, now, withPastDue: true },
  );

  return {
    asOf: localDayKey(now, timeZone),
    timezone: timeZone,
    totalOutstandingMinor: side.totalMinor,
    openItemCount: side.openCount,
    buckets: side.buckets,
    oldestDays: side.topParties[0]?.oldestDays ?? 0,
    pastDueMinor: side.pastDueMinor ?? 0,
    pastDueCount: side.pastDueCount ?? 0,
    truncated: expenses.length >= AGING_SCAN_CAP,
  };
}
