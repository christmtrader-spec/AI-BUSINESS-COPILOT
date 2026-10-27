import "server-only";

/**
 * R88 — the customer's TOTAL stated-terms breach facts: how many invoices
 * of this customer are overdue RIGHT NOW (open balance + stated due day
 * passed in the business tz) and the outstanding sum in business currency.
 *
 * This is a COMPLETE scan over the customer's OWN breach rows — deliberately
 * NOT bounded by the ≤10 recent-invoice window, so the 360 strip never
 * understates a breach hiding beyond the recent slice (the R86 law, other
 * side of the book). The WHERE is the SAME plan law the breach worklist
 * filter uses (planOverdueSaleFilter + the balance-open FIELD REFERENCE) —
 * the strip, the receivables aggregate and the filtered list can never
 * disagree about what a breach is.
 *
 * Unlike the payables side there is NO linked-Expense indirection here: the
 * Sale row IS the live receivable authority (§8 — totalMinor/paidMinor are
 * the canonical figures the aging engine, the statements and the payments
 * engine all read), so the outstanding sum reads the SAME live figures the
 * list rows show.
 */
import { db } from "@/lib/db";
import { localDayKey } from "@/lib/aging";
import { planOverdueSaleFilter } from "@/lib/sales-overdue";
import { calendarDateToUtcMidnoon } from "@/lib/supplier-bills/types";

export async function countOverdueSalesForCustomer(input: {
  businessId: string;
  customerId: string;
  timeZone: string;
}): Promise<{ count: number; outstandingMinor: number }> {
  const todayMidnoon = calendarDateToUtcMidnoon(localDayKey(new Date(), input.timeZone));
  const plan = planOverdueSaleFilter({ overdue: true, todayMidnoon });
  if (!plan) return { count: 0, outstandingMinor: 0 }; // unreachable — overdue is constant true

  const rows = await db.sale.findMany({
    where: {
      businessId: input.businessId,
      customerId: input.customerId,
      deletedAt: null,
      dueDate: plan.dueDate,
      // The literal `totalMinor − paidMinor > 0` as a per-row SQL field
      // reference — the exact fragment the breach worklist filter uses.
      totalMinor: { gt: db.sale.fields.paidMinor },
    },
    select: { totalMinor: true, paidMinor: true },
  });
  const outstandingMinor = rows.reduce(
    (sum, row) => sum + (row.totalMinor - row.paidMinor),
    0,
  );
  return { count: rows.length, outstandingMinor };
}
