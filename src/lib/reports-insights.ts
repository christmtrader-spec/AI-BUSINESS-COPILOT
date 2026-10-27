/**
 * R76 — honest derivations shared by the dashboard insights strip and the
 * reports header. Pure integer-math functions over ALREADY-FETCHED summary
 * numbers (A08) — no fetching, no new endpoints, no invented facts (Rule 05).
 *
 * Collection rate semantics (fixed in R75, shared here since R76):
 *   - Gated to revenue > 0 AND collected > 0 (a rate over nothing, or
 *     nothing collected, is not an insight — it is silence).
 *   - Capped at 100%: over-collection (payments for earlier invoices) must
 *     never read as ">100% of invoiced" — the pill states a ratio of THIS
 *     window's invoiced amount, so the honest ceiling is 100.
 *   - Rounded to the nearest whole percent (display math, not accounting).
 *
 * R77 — the SAME law now covers the attention aggregates: receivables aging
 * (aged over 60 days) and payables past-due sums live here so the
 * /api/v1/receivables route, the /api/v1/payables route and the copilot
 * grounding snapshot all cite figures from ONE arithmetic authority — the
 * copilot can never disagree with the dashboard tiles by construction.
 */
import { localDayIndex } from "@/lib/aging";
export function collectionPercentOf(
  revenueMinor: number,
  collectedMinor: number,
): number | null {
  if (!(revenueMinor > 0) || !(collectedMinor > 0)) return null;
  return Math.min(100, Math.round((collectedMinor / revenueMinor) * 100));
}

/**
 * Receivables aging gate shared with the /api/v1/receivables aggregates:
 * "aged over 60 days" means age in whole days STRICTLY greater than 60 —
 * exactly the union of the aging report's own D61_90 and D90_PLUS buckets
 * (src/lib/aging.ts agingBucketForAge). Keeping one arithmetic authority
 * means the dashboard pill can never disagree with the aging report.
 */
export function isAgedOver60(ageDays: number): boolean {
  return Math.max(0, Math.floor(ageDays)) > 60;
}

/**
 * R77 — past-due gate shared with the /api/v1/payables aggregates: a STATED
 * due day strictly before today's business-timezone day is past due. Bills
 * without a due date are never past due (honest: no terms were stated).
 *
 * R81 — the SAME gate now serves the RECEIVABLES overdue lane: Sale gained
 * an optional stated dueDate (§84 date-only law, same as the payables
 * side). Callers pair it with an open-balance check (`balanceMinor > 0`)
 * so a paid invoice is never flagged. One authority for both sides of the
 * book — the sales list, the invoice detail, the receivables rows and the
 * payables rows can never disagree on what "overdue" means.
 */
export function isPastDueDay(
  dueDate: Date | string | null,
  todayIdx: number,
  timeZone: string,
): boolean {
  if (!dueDate) return false;
  return todayIdx > localDayIndex(new Date(dueDate), timeZone);
}

/** Open-sale row shape the aging sum needs (subset of Prisma Sale). */
export type AgedSaleRow = {
  issueDate: Date | string;
  totalMinor: number;
  paidMinor: number;
};

/**
 * R77 — aggregate "aged over 60 days" balance + count over already-fetched
 * open-sale rows. Balance = totalMinor − paidMinor per invoice (integer
 * minor units, A08); age = todayIdx − localDayIndex(issueDate, tz) in whole
 * business-timezone days, gated by the shared isAgedOver60 above. This is
 * the exact computation the receivables route and the copilot snapshot use,
 * so a copilot answer and the dashboard tile cannot drift apart.
 */
export function sumAgedOver60Sales(
  rows: AgedSaleRow[],
  todayIdx: number,
  timeZone: string,
): { minor: number; count: number } {
  let minor = 0;
  let count = 0;
  for (const row of rows) {
    if (isAgedOver60(todayIdx - localDayIndex(new Date(row.issueDate), timeZone))) {
      minor += row.totalMinor - row.paidMinor;
      count += 1;
    }
  }
  return { minor, count };
}

/** Open-expense row shape the past-due sum needs (subset of Prisma Expense). */
export type PastDueExpenseRow = {
  dueDate: Date | string | null;
  amountMinor: number;
  paidMinor: number;
};

/**
 * R77 — aggregate past-due balance + count over already-fetched open-expense
 * rows. Balance = amountMinor − paidMinor per bill (A08); gate is the shared
 * isPastDueDay above (stated due day strictly before today's business day).
 * Same authority the payables route and the copilot snapshot use.
 */
export function sumPastDueBills(
  rows: PastDueExpenseRow[],
  todayIdx: number,
  timeZone: string,
): { minor: number; count: number } {
  let minor = 0;
  let count = 0;
  for (const row of rows) {
    if (isPastDueDay(row.dueDate, todayIdx, timeZone)) {
      minor += row.amountMinor - row.paidMinor;
      count += 1;
    }
  }
  return { minor, count };
}

/**
 * Open-sale row shape the overdue sum needs (subset of Prisma Sale) — the
 * R81 stated-terms fields (Sale.dueDate) ride alongside the aging fields.
 */
export type OverdueSaleRow = {
  dueDate: Date | string | null;
  totalMinor: number;
  paidMinor: number;
};

/**
 * R82 — aggregate OVERDUE balance + count over already-fetched open-sale
 * rows: stated-terms invoices whose due day is strictly before today's
 * business-timezone day. The SAME shared isPastDueDay gate every other
 * surface uses (sales list rows, invoice detail, receivables rows, the
 * payables side) — one arithmetic authority, so the aging card's overdue
 * slice, the receivables header pill and the copilot chip can never
 * disagree by construction. Callers pass OPEN rows only (status != PAID —
 * the paid are never overdue; the same contract sumPastDueBills follows).
 */
export function sumOverdueSales(
  rows: OverdueSaleRow[],
  todayIdx: number,
  timeZone: string,
): { minor: number; count: number } {
  let minor = 0;
  let count = 0;
  for (const row of rows) {
    if (isPastDueDay(row.dueDate, todayIdx, timeZone)) {
      minor += row.totalMinor - row.paidMinor;
      count += 1;
    }
  }
  return { minor, count };
}

/**
 * R91 — the ATTRIBUTION engine: WHO owns the breach. The same open-sale
 * rows the sums above walk, plus the party identity an attribution needs;
 * rows without a customer (walk-in invoices) are honest NON-attributable —
 * an anonymous balance cannot be deep-linked, so the attribution narrows
 * only the attributable subset and the chip that cites it can never claim
 * more than its customer truly owns.
 *
 * ONE walk, TWO readings (the receivables twins of the R89 aging roll-up):
 *  - topOverdueParty gates on the SAME isPastDueDay the overdue sum uses;
 *  - topAgedOver60Party gates on the SAME isAgedOver60(localDayIndex age)
 *    the aging sum uses (issued rows only — R90's issuedIssueDate witness
 *    guarantees a non-null issueDate in the issued population; an absent
 *    one here is silent non-membership, never a fabricated age).
 * Both return the LARGEST party by outstanding money (the R89 board's
 * vocabulary), ties broken deterministically: count DESC, then name asc,
 * then id asc — same input, same winner, always. The caller pairs the
 * result with the matching total count (sumOverdueSales/sumAgedOver60Sales
 * over the SAME rows) so the chip count ≤ total count holds by construction.
 */
export type AttributableSaleRow = {
  issueDate?: Date | string;
  dueDate: Date | string | null;
  totalMinor: number;
  paidMinor: number;
  customerId?: string | null;
  customerName?: string | null;
};

export type AttributedParty = {
  /** The customer id the deep link carries (a safe server-side id). */
  id: string;
  /** Display name captured from the same row (empty only if rows lie). */
  name: string;
  /** This party's count within the cited population (≤ the total count). */
  count: number;
  /** This party's outstanding within the cited population (integer minor). */
  minor: number;
};

function topAttributedParty(
  rows: AttributableSaleRow[],
  gate: (row: AttributableSaleRow) => boolean,
): AttributedParty | null {
  const groups = new Map<string, AttributedParty>();
  for (const row of rows) {
    if (!row.customerId) continue; // walk-in — honest non-attributable
    if (!gate(row)) continue;
    const g = groups.get(row.customerId) ?? {
      id: row.customerId,
      name: "",
      count: 0,
      minor: 0,
    };
    g.count += 1;
    g.minor += row.totalMinor - row.paidMinor;
    if (!g.name && row.customerName) g.name = row.customerName;
    groups.set(row.customerId, g);
  }
  return pickTopAttributed(groups);
}

/**
 * R92 — the SELECTION LAW in exactly one place: largest outstanding first
 * (the R89 board's vocabulary), ties broken count DESC, then name asc, then
 * id asc — same input, same winner, always. The per-shape walks accumulate
 * their groups and hand them here; no walk re-implements the tie chain.
 */
function pickTopAttributed(groups: Map<string, AttributedParty>): AttributedParty | null {
  let top: AttributedParty | null = null;
  for (const g of groups.values()) {
    if (top === null) {
      top = g;
      continue;
    }
    if (g.minor !== top.minor) {
      if (g.minor > top.minor) top = g;
      continue;
    }
    if (g.count !== top.count) {
      if (g.count > top.count) top = g;
      continue;
    }
    if (g.name !== top.name) {
      if (g.name < top.name) top = g;
      continue;
    }
    if (g.id < top.id) top = g;
  }
  return top;
}

/** R91 — the largest OVERDUE debtor among attributable open rows (or null). */
export function topOverdueParty(
  rows: AttributableSaleRow[],
  todayIdx: number,
  timeZone: string,
): AttributedParty | null {
  return topAttributedParty(rows, (row) =>
    isPastDueDay(row.dueDate, todayIdx, timeZone),
  );
}

/** R91 — the largest AGED (60+ day) debtor among attributable open rows. */
export function topAgedOver60Party(
  rows: AttributableSaleRow[],
  todayIdx: number,
  timeZone: string,
): AttributedParty | null {
  return topAttributedParty(rows, (row) => {
    if (!row.issueDate) return false;
    return isAgedOver60(
      todayIdx - localDayIndex(new Date(row.issueDate), timeZone),
    );
  });
}

/**
 * R92 — an attributable open-bill row (the payables twin of
 * AttributableSaleRow): the past-due sum's row plus the supplier identity
 * the attribution needs. Bills without a supplier are honest
 * NON-attributable — an anonymous payable cannot be deep-linked.
 */
export type AttributableBillRow = {
  dueDate: Date | string | null;
  amountMinor: number;
  paidMinor: number;
  supplierId?: string | null;
  supplierName?: string | null;
};

/**
 * R92 — the largest PAST-DUE creditor among attributable open-bill rows
 * (the payables twin of topOverdueParty). Gates on the SAME isPastDueDay
 * the payablesPastDue sum uses; money is amountMinor − paidMinor (A08).
 * ONE selection law via pickTopAttributed — the winner, the tie chain and
 * the honest null are IDENTICAL on both sides of the book, so a chip can
 * never behave differently because of which side it cites.
 */
export function topPastDueSupplier(
  rows: AttributableBillRow[],
  todayIdx: number,
  timeZone: string,
): AttributedParty | null {
  const groups = new Map<string, AttributedParty>();
  for (const row of rows) {
    if (!row.supplierId) continue; // anonymous payable — honest non-attributable
    if (!isPastDueDay(row.dueDate, todayIdx, timeZone)) continue;
    const g = groups.get(row.supplierId) ?? {
      id: row.supplierId,
      name: "",
      count: 0,
      minor: 0,
    };
    g.count += 1;
    g.minor += row.amountMinor - row.paidMinor;
    if (!g.name && row.supplierName) g.name = row.supplierName;
    groups.set(row.supplierId, g);
  }
  return pickTopAttributed(groups);
}
