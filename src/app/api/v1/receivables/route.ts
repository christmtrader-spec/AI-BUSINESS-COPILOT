/**
 * GET /api/v1/receivables — derived view of outstanding invoices
 * (status != PAID). Deterministic sums over integer minor units (A08).
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { db } from "@/lib/db";
// R96 — the book-leaders fact: the ranked board over the SAME open rows
// this route returns (one fold, one authority — lib/aging-details).
import { rollupAccumulate, rollupRank, type AgingRollupAccumulator } from "@/lib/aging-details";

export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest) => {
  const ctx = await getAuthContext(_req);
  requirePermission(ctx, "data:read");

  const sales = await db.sale.findMany({
    where: { businessId: ctx.businessId, deletedAt: null, status: { not: "PAID" } },
    orderBy: { issueDate: "asc" }, // oldest outstanding first
    take: 200,
    include: { customer: { select: { name: true } } },
  });

  let totalOutstandingMinor = 0;
  const items = sales.map((s) => {
    const balanceMinor = s.totalMinor - s.paidMinor;
    totalOutstandingMinor += balanceMinor;
    return {
      id: s.id,
      number: s.number,
      customerName: s.customer?.name ?? null,
      issueDate: s.issueDate.toISOString(),
      totalMinor: s.totalMinor,
      paidMinor: s.paidMinor,
      balanceMinor,
      status: s.status,
    };
  });

  // Per-customer aggregation (top 8 by outstanding amount).
  const byCustomerMap = new Map<string, number>();
  for (const s of sales) {
    const name = s.customer?.name ?? "—";
    byCustomerMap.set(name, (byCustomerMap.get(name) ?? 0) + (s.totalMinor - s.paidMinor));
  }
  const byCustomer = [...byCustomerMap.entries()]
    .map(([name, balanceMinor]) => ({ name, balanceMinor }))
    .sort((a, b) => b.balanceMinor - a.balanceMinor)
    .slice(0, 8);

  // R96 — the DEBTORS leaders fact: fold every open row (settled rows are
  // never leader material) through the SHARED board fold; the ranked head
  // rides verbatim (the balances strip + AI snapshot read rank 1).
  const debtorAcc: AgingRollupAccumulator = new Map();
  for (const s of sales) {
    const balanceMinor = s.totalMinor - s.paidMinor;
    if (balanceMinor <= 0) continue;
    rollupAccumulate(
      debtorAcc,
      { partyId: s.customerId, partyName: s.customer?.name ?? null, outstandingMinor: balanceMinor, ageDays: 0 },
      true,
    );
  }
  const debtorBoard = rollupRank(debtorAcc, Number.MAX_SAFE_INTEGER);
  const leaders = {
    leaders: debtorBoard.groups.slice(0, 3).map((g, i) => ({
      rank: i + 1,
      partyId: g.partyId,
      partyName: g.partyName,
      outstandingMinor: g.outstandingMinor,
      count: g.count,
    })),
    partyCount: debtorBoard.groupCount,
  };

  return ok({
    totalOutstandingMinor,
    openCount: sales.length,
    items,
    byCustomer,
    leaders,
  });
});
