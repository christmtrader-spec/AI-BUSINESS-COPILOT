/**
 * R85 — the supplier-bill LIST joins the past-due lane with the SAME
 * authority the detail strip (R83) and the payables aggregates (R77) use.
 *
 * ONE law, TWO directions of the same truth:
 *  - billRowPastDueState is the per-row READ law — the exact mirror of the
 *    R83 detail computation: a POSTED bill whose live linked payable is
 *    still outstanding (> 0) and whose stated due DAY has passed in the
 *    BUSINESS timezone. DRAFT/CANCELLED documents are never past due
 *    (nothing is owed through them yet); a settled payable is never past
 *    due; no stated terms is honest silence.
 *  - planPastDueBillFilter is the WRITE-side SQL plan — it selects exactly
 *    the rows the read law would flag, so a filtered list and the row
 *    badges can never disagree. `amountMinor > paidMinor` is expressed as
 *    a Prisma FIELD REFERENCE (not a client-computed bound) — the literal
 *    translation of `outstanding > 0`, evaluated row-by-row in SQL.
 *
 * Pure module (no db import, no server-only) so the r85 unit harness can
 * exhaustively prove both directions; the mapper NEVER re-derives day
 * math — it receives the precomputed state (the R83 DTO law travels).
 */
import { localDayIndex } from "@/lib/aging";
import { isPastDueDay } from "@/lib/reports-insights";
import { calendarDateToUtcMidnoon } from "./types";

/** Minimal bill-row shape the list state law needs (subset of Prisma row). */
export type PastDueBillRow = {
  status: string;
  dueDate: Date | string | null;
  expense: { amountMinor: number; paidMinor: number } | null | undefined;
};

/**
 * Per-row past-due state — the R83 detail law applied to a LIST row.
 * `pastDueDays` counts whole business-timezone days past the due day with
 * a floor of 1 (due-today is NOT past due — §9), and is non-null ONLY
 * when pastDue (the honest-absence law: no terms → both stay null).
 */
export function billRowPastDueState(
  row: PastDueBillRow,
  todayIdx: number,
  timeZone: string,
): { pastDue: boolean; pastDueDays: number | null } {
  const none = { pastDue: false, pastDueDays: null } as const;
  if (row.status !== "POSTED") return none; // DRAFT/CANCELLED — not payables
  if (!row.expense) return none; // no live payable to breach
  if (row.expense.amountMinor - row.expense.paidMinor <= 0) return none; // settled
  if (!isPastDueDay(row.dueDate, todayIdx, timeZone)) return none;
  return {
    pastDue: true,
    pastDueDays: Math.max(1, todayIdx - localDayIndex(new Date(row.dueDate!), timeZone)),
  };
}

/**
 * SQL plan for the `pastDue=1` list filter. Returns null when the filter
 * is off (no contribution). The plan FORCES status=POSTED and caps the
 * due window at "strictly before today's business day" — the same
 * midnoon-to-midnoon day arithmetic the §84 storage law makes exact
 * (every stored dueDate is the UTC-midnoon instant of its calendar day,
 * so a `lt todayMidnoon` bound IS "due day < today's business day").
 * An explicitly requested non-POSTED status is a CONTRADICTION → the
 * caller must 422 (the R82 aging-details overdue conflict law).
 */
export type PastDueBillFilterPlan = {
  statusConflict: boolean;
  status: "POSTED" | undefined;
  dueDate: { gte?: Date; lte?: Date; lt: Date };
};

export function planPastDueBillFilter(input: {
  pastDue: boolean;
  status?: string;
  dueDateFrom?: string;
  dueDateTo?: string;
  /** UTC-midnoon instant of TODAY's business-timezone calendar day. */
  todayMidnoon: Date;
}): PastDueBillFilterPlan | null {
  if (!input.pastDue) return null;
  const statusConflict = input.status !== undefined && input.status !== "POSTED";
  const dueDate: PastDueBillFilterPlan["dueDate"] = { lt: input.todayMidnoon };
  // The user's own due-date window composes (AND) with the breach cap —
  // midnoon-to-midnoon bounds match calendar days exactly (§84).
  if (input.dueDateFrom) dueDate.gte = calendarDateToUtcMidnoon(input.dueDateFrom);
  if (input.dueDateTo) dueDate.lte = calendarDateToUtcMidnoon(input.dueDateTo);
  return {
    statusConflict,
    status: "POSTED" as const,
    dueDate,
  };
}
