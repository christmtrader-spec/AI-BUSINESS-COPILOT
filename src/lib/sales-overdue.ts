/**
 * R87 — the SALES list joins the stated-terms breach lane with the SAME
 * authority the row badges (R81), the receivables aggregates (R82) and the
 * copilot attention figures use.
 *
 * ONE law, TWO directions of the same truth — the receivables twin of the
 * supplier-bill pastdue.ts module (R85):
 *  - saleRowOverdueState is the per-row READ law — the exact mirror of the
 *    R81 list badge computation: an invoice whose stated due DAY has passed
 *    in the BUSINESS timezone while a balance is still open. No stated
 *    terms is honest silence (the AGING framing applies instead); a settled
 *    balance is never overdue — a paid invoice cannot breach terms.
 *  - planOverdueSaleFilter is the SQL plan direction — it forces the due
 *    window cap at "strictly before today's business day" and reports the
 *    status contradiction (status=PAID can NEVER be overdue: its balance is
 *    zero by definition), so a filtered list and the row badges can never
 *    disagree. The balance-open side of the plan is composed at the caller
 *    as a per-row SQL FIELD REFERENCE (`totalMinor gt paidMinor` — the
 *    literal translation of `balance > 0`, evaluated row-by-row in SQL;
 *    the same law R85 established on the payables side).
 *
 * Pure module (no db import, no server-only) so the r87 unit harness can
 * exhaustively prove both directions; the row mapper NEVER re-derives day
 * math — it receives the precomputed state.
 */
import { localDayIndex } from "@/lib/aging";
import { isPastDueDay } from "@/lib/reports-insights";

/** Minimal sale-row shape the state law needs (subset of Prisma row). */
export type OverdueSaleStateRow = {
  /** R90 — a DRAFT is pre-issuance: no terms, never overdue. Optional so
   *  legacy callers stay honest (absence reads as "not a draft"). */
  status?: string | null;
  dueDate: Date | string | null;
  totalMinor: number;
  paidMinor: number;
};

/**
 * Per-row overdue state — the R81 badge law applied to a list row.
 * `overdueDays` counts whole business-timezone days past the due day with
 * a floor of 1 (due-today is NOT overdue — §9), and is non-null ONLY when
 * overdue (the honest-absence law: no stated terms → both stay null).
 */
export function saleRowOverdueState(
  row: OverdueSaleStateRow,
  todayIdx: number,
  timeZone: string,
): { overdue: boolean; overdueDays: number | null } {
  const none = { overdue: false, overdueDays: null } as const;
  // R90 — a DRAFT is not issued money: it carries no terms and can never
  // breach them (belt-and-braces — its dueDate is null by the create law,
  // but the state never trusts the column, it trusts the lifecycle).
  if (row.status === "DRAFT") return none;
  if (row.totalMinor - row.paidMinor <= 0) return none; // settled
  if (!isPastDueDay(row.dueDate, todayIdx, timeZone)) return none; // no terms / due today / future
  return {
    overdue: true,
    overdueDays: Math.max(1, todayIdx - localDayIndex(new Date(row.dueDate!), timeZone)),
  };
}

/**
 * SQL plan for the `overdue=1` list filter. Returns null when the filter
 * is off (no contribution). The plan caps the due window at "strictly
 * before today's business day" — the same midnoon-to-midnoon day
 * arithmetic the §84 storage law makes exact (every stored dueDate is the
 * UTC-midnoon instant of its calendar day, so a `lt todayMidnoon` bound IS
 * "due day < today's business day"). An explicitly requested status=PAID
 * is a CONTRADICTION → the caller must 422 (the R82 aging-details conflict
 * law; UNPAID/PARTIAL compose — their balance-open side is enforced by the
 * caller's field reference, never a client-computed bound). R90 — DRAFT is
 * the second contradiction: a draft has no terms to breach and is not yet
 * a receivable at all.
 */
export type OverdueSaleFilterPlan = {
  statusConflict: boolean;
  dueDate: { lt: Date };
};

export function planOverdueSaleFilter(input: {
  overdue: boolean;
  status?: string;
  /** UTC-midnoon instant of TODAY's business-timezone calendar day. */
  todayMidnoon: Date;
}): OverdueSaleFilterPlan | null {
  if (!input.overdue) return null;
  return {
    statusConflict: input.status === "PAID" || input.status === "DRAFT",
    dueDate: { lt: input.todayMidnoon },
  };
}
