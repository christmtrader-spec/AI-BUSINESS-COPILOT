/**
 * GET /api/v1/payables — derived view of unpaid expenses
 * (status != PAID). Deterministic sums over integer minor units (A08).
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest) => {
  const ctx = await getAuthContext(_req);
  requirePermission(ctx, "data:read");

  const expenses = await db.expense.findMany({
    where: { businessId: ctx.businessId, deletedAt: null, status: { not: "PAID" } },
    orderBy: { spentAt: "asc" }, // oldest outstanding first
    take: 200,
    include: { supplier: { select: { name: true } } },
  });

  let totalOutstandingMinor = 0;
  const items = expenses.map((e) => {
    const balanceMinor = e.amountMinor - e.paidMinor;
    totalOutstandingMinor += balanceMinor;
    return {
      id: e.id,
      category: e.category,
      supplierName: e.supplier?.name ?? null,
      spentAt: e.spentAt.toISOString(),
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

  return ok({
    totalOutstandingMinor,
    openCount: expenses.length,
    items,
    bySupplier,
  });
});
