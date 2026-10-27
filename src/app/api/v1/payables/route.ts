/**
 * GET /api/v1/payables — derived view of unpaid expenses
 * (status != PAID). Deterministic sums over integer minor units (A08).
 *
 * Payables-aging round: items now carry the supplier-bill terms
 * (dueDate/reference) plus a server-computed `pastDue` flag — day math in
 * the BUSINESS timezone (A07); the UI never derives overdue states itself.
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { db } from "@/lib/db";
import { localDayIndex } from "@/lib/aging";
// R96 — the book-leaders fact over the SAME open payables rows (one fold).
import { rollupAccumulate, rollupRank, type AgingRollupAccumulator } from "@/lib/aging-details";

export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest) => {
  const ctx = await getAuthContext(_req);
  requirePermission(ctx, "data:read");

  const [business, expenses] = await Promise.all([
    db.business.findUnique({
      where: { id: ctx.businessId },
      select: { timezone: true },
    }),
    db.expense.findMany({
      where: { businessId: ctx.businessId, deletedAt: null, status: { not: "PAID" } },
      orderBy: { spentAt: "asc" }, // oldest outstanding first
      take: 200,
      include: { supplier: { select: { name: true } } },
    }),
  ]);
  const tz = business?.timezone || "UTC";
  const todayIdx = localDayIndex(new Date(), tz);

  let totalOutstandingMinor = 0;
  const items = expenses.map((e) => {
    const balanceMinor = e.amountMinor - e.paidMinor;
    totalOutstandingMinor += balanceMinor;
    // Past due: a STATED due day strictly before today's business day.
    // Bills without a due date are never past due (honest: no terms stated).
    const pastDue = e.dueDate ? todayIdx > localDayIndex(e.dueDate, tz) : false;
    return {
      id: e.id,
      category: e.category,
      supplierName: e.supplier?.name ?? null,
      spentAt: e.spentAt.toISOString(),
      dueDate: e.dueDate ? e.dueDate.toISOString() : null,
      reference: e.reference,
      pastDue,
      amountMinor: e.amountMinor,
      paidMinor: e.paidMinor,
      balanceMinor,
      status: e.status,
    };
  });

  // Per-supplier aggregation (top 8 by outstanding amount).
  const bySupplierMap = new Map<string, number>();
  for (const e of expenses) {
    const name = e.supplier?.name ?? "—";
    bySupplierMap.set(name, (bySupplierMap.get(name) ?? 0) + (e.amountMinor - e.paidMinor));
  }
  const bySupplier = [...bySupplierMap.entries()]
    .map(([name, balanceMinor]) => ({ name, balanceMinor }))
    .sort((a, b) => b.balanceMinor - a.balanceMinor)
    .slice(0, 8);

  // R96 — the CREDITORS leaders fact: the shared fold over every open row.
  const creditorAcc: AgingRollupAccumulator = new Map();
  for (const e of expenses) {
    const balanceMinor = e.amountMinor - e.paidMinor;
    if (balanceMinor <= 0) continue;
    rollupAccumulate(
      creditorAcc,
      { partyId: e.supplierId, partyName: e.supplier?.name ?? null, outstandingMinor: balanceMinor, ageDays: 0 },
      true,
    );
  }
  const creditorBoard = rollupRank(creditorAcc, Number.MAX_SAFE_INTEGER);
  const leaders = {
    leaders: creditorBoard.groups.slice(0, 3).map((g, i) => ({
      rank: i + 1,
      partyId: g.partyId,
      partyName: g.partyName,
      outstandingMinor: g.outstandingMinor,
      count: g.count,
    })),
    partyCount: creditorBoard.groupCount,
  };

  return ok({
    totalOutstandingMinor,
    openCount: expenses.length,
    items,
    bySupplier,
    leaders,
  });
});
