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

// ---------------------------------------------------------------------------
// R94/R95 — the 360 RANK CITATION + the book LEADERS (both readers of the
// ONE shared fold: rollupAccumulate + rollupRank from lib/aging-details).
// The identity law: the rank order IS the board's order — same fold, same
// tie-breaks (outstanding desc → name asc → id asc), same population.
// Noise guard: rows with non-finite or non-positive outstanding NEVER enter
// the population (settled/negative balances are not leader material).
// ---------------------------------------------------------------------------

import {
  rollupAccumulate,
  rollupRank,
  type AgingRollupAccumulator,
} from "@/lib/aging-details";

/** The minimal row the citation/leader readers fold (caller-supplied book). */
export type PartyRankBookRow = {
  partyId: string | null;
  partyName: string | null;
  outstandingMinor: number;
};

/** Shared fold for both readers — the ONE board authority. */
function foldBook(rows: PartyRankBookRow[]): AgingRollupAccumulator {
  const acc: AgingRollupAccumulator = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.outstandingMinor) || r.outstandingMinor <= 0) continue;
    rollupAccumulate(
      acc,
      { partyId: r.partyId, partyName: r.partyName, outstandingMinor: r.outstandingMinor, ageDays: 0 },
      true,
    );
  }
  return acc;
}

/**
 * The rank of ONE party within the folded board (the 360 citation).
 * Returns null when the party holds no open money (honest absence — a
 * party held up only by settled rows is NOT in the population). The
 * unassigned mass counts in partyCount (it is a real group on the board)
 * but can never be CITED (a focus id is always a real party id).
 */
export function partyRankFromBookRows(
  rows: PartyRankBookRow[],
  partyId: string,
): { rank: number; partyCount: number } | null {
  const board = rollupRank(foldBook(rows), Number.MAX_SAFE_INTEGER);
  const idx = board.groups.findIndex((g) => g.partyId === partyId);
  if (idx === -1) return null;
  return { rank: idx + 1, partyCount: board.groupCount };
}

/**
 * The book's LEADER board slice (the dashboard/book-leaders panel): the
 * first `take` groups of the SAME ranked board, rank by rank. take ≤ 0 →
 * an empty slice with the HONEST population still reported (silence, never
 * an error, never a fabricated zero population).
 */
export function bookLeadersFromBookRows(
  rows: PartyRankBookRow[],
  take: number,
): {
  leaders: Array<{
    rank: number;
    partyId: string | null;
    partyName: string | null;
    outstandingMinor: number;
    count: number;
  }>;
  partyCount: number;
} {
  const board = rollupRank(foldBook(rows), Number.MAX_SAFE_INTEGER);
  const n = Number.isFinite(take) ? Math.max(0, Math.floor(take)) : 0;
  return {
    leaders: board.groups.slice(0, n).map((g, i) => ({
      rank: i + 1,
      partyId: g.partyId,
      partyName: g.partyName,
      outstandingMinor: g.outstandingMinor,
      count: g.count,
    })),
    partyCount: board.groupCount,
  };
}
