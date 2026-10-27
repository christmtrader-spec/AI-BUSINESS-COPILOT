/**
 * Workspace activity feed — the server-side union of the three money-flow
 * ledgers (sales, expenses, payments) into one recency-sorted feed.
 *
 * Design law:
 * - Every query is business-scoped after session+membership verification
 *   (A01/A02) — the merge happens ONLY over rows already proven to belong
 *   to the caller's business.
 * - Figures are copied verbatim from the ledger rows (integer minor units,
 *   A08) — never recomputed, never invented (Rule 05).
 * - "Recent" mirrors each module's own default list ordering (sales by
 *   createdAt, expenses by createdAt, payments by paidAt) so the feed can
 *   never disagree with what the modules themselves show as "latest".
 * - The pure merge is exported for unit testing (same pattern as
 *   evaluateSameOrigin / report helpers): query rows in, items out.
 */

import { db } from "@/lib/db";

export type ActivityKind = "SALE" | "PAYMENT_IN" | "PAYMENT_OUT" | "EXPENSE";

export type ActivityItem = {
  /** Namespaced id — feed rows are presentational projections, not rows. */
  id: string;
  kind: ActivityKind;
  /** ISO instant the entry is dated by (see ordering note above). */
  at: string;
  /** Always positive; direction is carried by `kind` (A08: no floats). */
  amountMinor: number;
  /** Sale invoice number (SALE / PAYMENT_IN when it settles a sale). */
  number: number | null;
  /** Customer (SALE / PAYMENT_IN) or supplier (EXPENSE / PAYMENT_OUT). */
  partyName: string | null;
  /** Expense category (EXPENSE / PAYMENT_OUT against an expense). */
  category: string | null;
  /** Payment method (PAYMENT_IN / PAYMENT_OUT). */
  method: string | null;
};

/** Upper bound — keeps any abusive `limit` from turning into a full scan. */
export const ACTIVITY_LIMIT_MAX = 20;

export function normalizeActivityLimit(raw: string | null): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return 8;
  return Math.min(n, ACTIVITY_LIMIT_MAX);
}

type SaleRow = {
  id: string;
  number: number;
  createdAt: Date;
  totalMinor: number;
  customer: { name: string } | null;
};

type ExpenseRow = {
  id: string;
  category: string;
  createdAt: Date;
  amountMinor: number;
  supplier: { name: string } | null;
};

type PaymentRow = {
  id: string;
  direction: string;
  paidAt: Date;
  amountMinor: number;
  method: string;
  sale: { number: number; customer: { name: string } | null } | null;
  expense: { category: string; supplier: { name: string } | null } | null;
};

/** Pure merge: newest-first, ties broken by kind for deterministic order. */
export function mergeActivity(
  input: { sales: SaleRow[]; expenses: ExpenseRow[]; payments: PaymentRow[] },
  limit: number,
): ActivityItem[] {
  const items: ActivityItem[] = [];

  for (const s of input.sales) {
    items.push({
      id: `sale:${s.id}`,
      kind: "SALE",
      at: s.createdAt.toISOString(),
      amountMinor: s.totalMinor,
      number: s.number,
      partyName: s.customer?.name ?? null,
      category: null,
      method: null,
    });
  }
  for (const e of input.expenses) {
    items.push({
      id: `expense:${e.id}`,
      kind: "EXPENSE",
      at: e.createdAt.toISOString(),
      amountMinor: e.amountMinor,
      number: null,
      partyName: e.supplier?.name ?? null,
      category: e.category,
      method: null,
    });
  }
  for (const p of input.payments) {
    items.push({
      id: `payment:${p.id}`,
      kind: p.direction === "IN" ? "PAYMENT_IN" : "PAYMENT_OUT",
      at: p.paidAt.toISOString(),
      amountMinor: p.amountMinor,
      number: p.sale?.number ?? null,
      partyName:
        p.sale?.customer?.name ?? p.expense?.supplier?.name ?? null,
      category: p.expense?.category ?? null,
      method: p.method,
    });
  }

  const kindOrder: Record<ActivityKind, number> = {
    PAYMENT_IN: 0,
    PAYMENT_OUT: 1,
    SALE: 2,
    EXPENSE: 3,
  };
  items.sort((a, b) => {
    const t = Date.parse(b.at) - Date.parse(a.at);
    if (t !== 0) return t;
    return kindOrder[a.kind] - kindOrder[b.kind];
  });
  return items.slice(0, limit);
}

/** Tenant-scoped fetch + merge (the route calls exactly this). */
export async function buildActivityFeed(
  businessId: string,
  limit: number,
): Promise<ActivityItem[]> {
  const take = Math.min(Math.max(limit, 1), ACTIVITY_LIMIT_MAX);
  const [sales, expenses, payments] = await Promise.all([
    db.sale.findMany({
      where: { businessId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true,
        number: true,
        createdAt: true,
        totalMinor: true,
        customer: { select: { name: true } },
      },
    }),
    db.expense.findMany({
      where: { businessId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true,
        category: true,
        createdAt: true,
        amountMinor: true,
        supplier: { select: { name: true } },
      },
    }),
    db.payment.findMany({
      where: { businessId },
      orderBy: { paidAt: "desc" },
      take,
      select: {
        id: true,
        direction: true,
        paidAt: true,
        amountMinor: true,
        method: true,
        sale: { select: { number: true, customer: { select: { name: true } } } },
        expense: { select: { category: true, supplier: { select: { name: true } } } },
      },
    }),
  ]);
  return mergeActivity({ sales, expenses, payments }, take);
}
