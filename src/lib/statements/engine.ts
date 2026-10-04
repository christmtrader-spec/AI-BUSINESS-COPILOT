/**
 * Prompt 39 — statement ENGINE (§40–§46/§124–§126/§133/§179–§182).
 *
 * buildStatement() is the SINGLE SOURCE OF CALCULATION (§133): the API, the
 * UI DTO and the CSV export all go through it. Financial formulas are never
 * duplicated.
 *
 * PAGE STRATEGY (§40/§41):
 *   Each source (Sales and Payments for customers, Expenses and Payments for
 *   suppliers) is fetched with `take = limit + 1` rows strictly after the
 *   cursor key, the two bounded candidate lists are merged in memory, and
 *   the first `limit` events form the page. At most O(limit) event objects
 *   are retained — the full history is NEVER loaded (§41/§123).
 *
 * BALANCE STRATEGY (§21/§42/§43/§44/§45):
 *   - opening balance = DB SUM aggregates strictly before the period start;
 *   - period increase/decrease = DB SUM aggregates inside the window;
 *   - balanceBeforePage (page ≥ 2) = the absolute balance AFTER the cursor
 *     event, from bounded DB SUM aggregates at-or-before the cursor key —
 *     never a replay of previous pages;
 *   - per-row balanceAfterMinor = exact integer running balance server-side.
 *
 * SUMMARY vs PAGINATION (§179/§180/§181/§182):
 *   opening / periodIncrease / periodDecrease / closing / eventCount come
 *   from COMPLETE DB aggregates (count + sum) and are therefore completely
 *   independent of cursor/limit — changing the cursor never changes a total.
 *   `truncated` is always false for the paginated API: there is no hard
 *   event cap, the cursor walks the whole range.
 *
 * NO MUTATIONS (§22/§23): this module only ever reads. There is no clamp,
 * no rounding, no float math — exact integers only (§135/§268/§269).
 */
import { ApiError } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { decodeStatementCursor, encodeStatementCursor } from "./cursor";
import {
  applyRunningBalance,
  customerPaymentEvent,
  customerPaymentSelect,
  customerPaymentWhere,
  customerSaleEvent,
  customerSaleSelect,
  customerSaleWhere,
  mergeSortedEvents,
  sortEvents,
  summarizeStatement,
  supplierBillEvent,
  supplierExpenseSelect,
  supplierExpenseWhere,
  supplierPaymentEvent,
  supplierPaymentSelect,
  supplierPaymentWhere,
  type AfterKey,
} from "./events";
import { resolveStatementWindow } from "./schema";
import {
  assertMinorInteger,
  compareSortKeys,
  eventSortKey,
  statementSourceTake,
  statementTypeTokenOf,
  type StatementEvent,
  type StatementEventType,
  type StatementKind,
  type StatementSortKey,
  type StatementSourceType,
} from "./types";

export type StatementRequest = {
  kind: StatementKind;
  /** Server-derived tenant scope (§33/§34/§126) — never client-supplied. */
  businessId: string;
  partyId: string;
  /** Resolved business-calendar dates "YYYY-MM-DD" (cursor-bound, §48). */
  from: string;
  to: string;
  /** Business timezone (§17/§93). */
  timeZone: string;
  limit: number;
  cursor: string | null;
  locale: "en" | "fa";
};

export type StatementResult = {
  statementType: "customer" | "supplier";
  party: { id: string; name: string };
  summary: {
    openingBalanceMinor: number;
    periodIncreaseMinor: number;
    periodDecreaseMinor: number;
    closingBalanceMinor: number;
    eventCount: number;
    truncated: boolean;
    from: string;
    to: string;
    timezone: string;
  };
  rows: Array<{
    id: string;
    eventType: StatementEventType;
    occurredAt: string;
    reference: string | null;
    description: string | null;
    increaseMinor: number;
    decreaseMinor: number;
    movementMinor: number;
    balanceAfterMinor: number;
  }>;
  nextCursor: string | null;
  /** Absolute balance immediately before the first visible row (§45) — integer. */
  balanceBeforePageMinor: number;
};

/** Tenant-scoped, not-deleted party load (§49/§98/§99) — 404, never 403. */
async function loadParty(kind: StatementKind, businessId: string, partyId: string) {
  if (kind === "CUSTOMER") {
    const customer = await db.customer.findFirst({
      where: { id: partyId, businessId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!customer) throw new ApiError(404, "NOT_FOUND", "Customer not found.");
    return customer;
  }
  const supplier = await db.supplier.findFirst({
    where: { id: partyId, businessId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!supplier) throw new ApiError(404, "NOT_FOUND", "Supplier not found.");
  return supplier;
}

/**
 * Absolute balance AT-OR-BEFORE the cursor key from bounded DB aggregates
 * (§44) = opening + every movement with full sort key ≤ cursorKey. The
 * source-type correction (§187) excludes a cross-table row that shares the
 * cursor instant+id but sorts strictly AFTER it.
 */
async function balanceAtOrBeforeKey(
  kind: StatementKind,
  businessId: string,
  partyId: string,
  cursorKey: StatementSortKey,
): Promise<number> {
  const ts = cursorKey.ts;
  const boundary = (dateField: "issueDate" | "paidAt" | "spentAt") => ({
    OR: [{ [dateField]: { lt: ts } }, { [dateField]: ts, id: { lte: cursorKey.id } }],
  });

  if (kind === "CUSTOMER") {
    const saleLe = await db.sale.aggregate({
      where: { businessId, customerId: partyId, deletedAt: null, ...boundary("issueDate") },
      _sum: { totalMinor: true },
    });
    const saleAt = await db.sale.findFirst({
      where: { businessId, customerId: partyId, deletedAt: null, issueDate: ts, id: cursorKey.id },
      select: { totalMinor: true },
    });
    const payLe = await db.payment.aggregate({
      where: { businessId, sale: { customerId: partyId, deletedAt: null }, ...boundary("paidAt") },
      _sum: { amountMinor: true },
    });
    const payAt = await db.payment.findFirst({
      where: { businessId, sale: { customerId: partyId, deletedAt: null }, paidAt: ts, id: cursorKey.id },
      select: { amountMinor: true },
    });
    const saleSum = assertMinorInteger(saleLe._sum.totalMinor ?? 0, "boundary sale sum");
    const saleCorrection = saleAt && ("SALE" as StatementSourceType) > cursorKey.st ? saleAt.totalMinor : 0;
    const paySum = assertMinorInteger(payLe._sum.amountMinor ?? 0, "boundary payment sum");
    const payCorrection = payAt && ("PAYMENT_IN" as StatementSourceType) > cursorKey.st ? payAt.amountMinor : 0;
    return saleSum - saleCorrection - (paySum - payCorrection);
  }

  const billLe = await db.expense.aggregate({
    where: { businessId, supplierId: partyId, deletedAt: null, ...boundary("spentAt") },
    _sum: { amountMinor: true },
  });
  const billAt = await db.expense.findFirst({
    where: { businessId, supplierId: partyId, deletedAt: null, spentAt: ts, id: cursorKey.id },
    select: { amountMinor: true },
  });
  const payLe = await db.payment.aggregate({
    where: { businessId, expense: { supplierId: partyId, deletedAt: null }, ...boundary("paidAt") },
    _sum: { amountMinor: true },
  });
  const payAt = await db.payment.findFirst({
    where: { businessId, expense: { supplierId: partyId, deletedAt: null }, paidAt: ts, id: cursorKey.id },
    select: { amountMinor: true },
  });
  const billSum = assertMinorInteger(billLe._sum.amountMinor ?? 0, "boundary bill sum");
  const billCorrection = billAt && ("BILL" as StatementSourceType) > cursorKey.st ? billAt.amountMinor : 0;
  const paySum = assertMinorInteger(payLe._sum.amountMinor ?? 0, "boundary payment sum");
  const payCorrection = payAt && ("PAYMENT_OUT" as StatementSourceType) > cursorKey.st ? payAt.amountMinor : 0;
  return billSum - billCorrection - (paySum - payCorrection);
}

/** Merge → strict-key filter → take limit → hasMore decision (pure logic). */
function assemblePage(
  sourceA: StatementEvent[],
  sourceB: StatementEvent[],
  afterKey: StatementSortKey | null,
  limit: number,
  perSourceTake: number,
): { events: StatementEvent[]; hasMore: boolean } {
  const merged = mergeSortedEvents(sortEvents(sourceA), sortEvents(sourceB));
  const filtered =
    afterKey === null
      ? merged
      : merged.filter((event) => compareSortKeys(eventSortKey(event), afterKey) > 0);
  const events = filtered.slice(0, limit);
  // More rows exist when the merged candidates overflow the page OR either
  // source filled its whole fetch window (meaning it may have more rows
  // beyond what this page consumed).
  const hasMore =
    filtered.length > limit ||
    sourceA.length >= perSourceTake ||
    sourceB.length >= perSourceTake;
  return { events, hasMore };
}

/** Build one statement page (§133 — the shared calculation for API/DTO/CSV). */
export async function buildStatement(req: StatementRequest): Promise<StatementResult> {
  const window = resolveStatementWindow(req.from, req.to, req.timeZone);
  const party = await loadParty(req.kind, req.businessId, req.partyId);

  // §48/§38 — authenticate + bind the cursor before any page query runs.
  const decoded = req.cursor
    ? decodeStatementCursor(req.cursor, {
        kind: req.kind,
        businessId: req.businessId,
        partyId: req.partyId,
        from: req.from,
        to: req.to,
      })
    : null;
  const afterKey: StatementSortKey | null = decoded
    ? { ts: new Date(decoded.ts), id: decoded.id, st: decoded.st }
    : null;
  const after: AfterKey = afterKey ? { ts: afterKey.ts, id: afterKey.id } : null;

  const take = statementSourceTake(req.limit);
  const periodPaymentWindow = { paidAt: { gte: window.from, lt: window.until } };

  // Opening + period aggregates (complete, page-independent — §42/§43/§181)
  // and the two bounded page windows run concurrently (§123 — no N+1, no
  // full-history load).
  let opening: number;
  let increase: number;
  let decrease: number;
  let eventCount: number;
  let page: { events: StatementEvent[]; hasMore: boolean };

  if (req.kind === "CUSTOMER") {
    const [
      openingSales,
      openingPayments,
      periodSales,
      periodPayments,
      saleCount,
      paymentCount,
      saleRows,
      payRows,
    ] = await Promise.all([
      db.sale.aggregate({
        where: { businessId: req.businessId, customerId: req.partyId, deletedAt: null, issueDate: { lt: window.from } },
        _sum: { totalMinor: true },
      }),
      db.payment.aggregate({
        where: { businessId: req.businessId, sale: { customerId: req.partyId, deletedAt: null }, paidAt: { lt: window.from } },
        _sum: { amountMinor: true },
      }),
      db.sale.aggregate({
        where: { businessId: req.businessId, customerId: req.partyId, deletedAt: null, issueDate: { gte: window.from, lt: window.until } },
        _sum: { totalMinor: true },
      }),
      db.payment.aggregate({
        where: { businessId: req.businessId, sale: { customerId: req.partyId, deletedAt: null }, ...periodPaymentWindow },
        _sum: { amountMinor: true },
      }),
      db.sale.count({
        where: { businessId: req.businessId, customerId: req.partyId, deletedAt: null, issueDate: { gte: window.from, lt: window.until } },
      }),
      db.payment.count({
        where: { businessId: req.businessId, sale: { customerId: req.partyId, deletedAt: null }, ...periodPaymentWindow },
      }),
      db.sale.findMany({
        where: customerSaleWhere(req.businessId, req.partyId, window, after),
        orderBy: [{ issueDate: "asc" }, { id: "asc" }],
        take,
        select: customerSaleSelect,
      }),
      db.payment.findMany({
        where: customerPaymentWhere(req.businessId, req.partyId, window, after),
        orderBy: [{ paidAt: "asc" }, { id: "asc" }],
        take,
        select: customerPaymentSelect,
      }),
    ]);

    opening = assertMinorInteger(
      (openingSales._sum.totalMinor ?? 0) - (openingPayments._sum.amountMinor ?? 0),
      "opening",
    );
    increase = assertMinorInteger(periodSales._sum.totalMinor ?? 0, "periodIncrease");
    decrease = assertMinorInteger(periodPayments._sum.amountMinor ?? 0, "periodDecrease");
    eventCount = saleCount + paymentCount;
    page = assemblePage(
      saleRows.map((row) => customerSaleEvent(row, req.locale)),
      payRows.map((row) => customerPaymentEvent(row, req.locale)),
      afterKey,
      req.limit,
      take,
    );
  } else {
    const [
      openingBills,
      openingPayments,
      periodBills,
      periodPayments,
      billCount,
      paymentCount,
      expenseRows,
      payRows,
    ] = await Promise.all([
      db.expense.aggregate({
        where: { businessId: req.businessId, supplierId: req.partyId, deletedAt: null, spentAt: { lt: window.from } },
        _sum: { amountMinor: true },
      }),
      db.payment.aggregate({
        where: { businessId: req.businessId, expense: { supplierId: req.partyId, deletedAt: null }, paidAt: { lt: window.from } },
        _sum: { amountMinor: true },
      }),
      db.expense.aggregate({
        where: { businessId: req.businessId, supplierId: req.partyId, deletedAt: null, spentAt: { gte: window.from, lt: window.until } },
        _sum: { amountMinor: true },
      }),
      db.payment.aggregate({
        where: { businessId: req.businessId, expense: { supplierId: req.partyId, deletedAt: null }, ...periodPaymentWindow },
        _sum: { amountMinor: true },
      }),
      db.expense.count({
        where: { businessId: req.businessId, supplierId: req.partyId, deletedAt: null, spentAt: { gte: window.from, lt: window.until } },
      }),
      db.payment.count({
        where: { businessId: req.businessId, expense: { supplierId: req.partyId, deletedAt: null }, ...periodPaymentWindow },
      }),
      db.expense.findMany({
        where: supplierExpenseWhere(req.businessId, req.partyId, window, after),
        orderBy: [{ spentAt: "asc" }, { id: "asc" }],
        take,
        select: supplierExpenseSelect,
      }),
      db.payment.findMany({
        where: supplierPaymentWhere(req.businessId, req.partyId, window, after),
        orderBy: [{ paidAt: "asc" }, { id: "asc" }],
        take,
        select: supplierPaymentSelect,
      }),
    ]);

    opening = assertMinorInteger(
      (openingBills._sum.amountMinor ?? 0) - (openingPayments._sum.amountMinor ?? 0),
      "opening",
    );
    increase = assertMinorInteger(periodBills._sum.amountMinor ?? 0, "periodIncrease");
    decrease = assertMinorInteger(periodPayments._sum.amountMinor ?? 0, "periodDecrease");
    eventCount = billCount + paymentCount;
    page = assemblePage(
      expenseRows.map((row) => supplierBillEvent(row, req.locale)),
      payRows.map((row) => supplierPaymentEvent(row, req.locale)),
      afterKey,
      req.limit,
      take,
    );
  }

  const summary = summarizeStatement(opening, increase, decrease, eventCount);

  // §44/§45 — absolute balance before the first visible row:
  //   page 1 (no cursor)        → the opening balance;
  //   later page                → the balance after the cursor event (bounded
  //                               aggregates at-or-before the cursor key);
  //   exhausted/empty last page → the closing balance (every movement consumed).
  const balanceBeforePageMinor =
    page.events.length === 0
      ? summary.closingBalanceMinor
      : afterKey
        ? await balanceAtOrBeforeKey(req.kind, req.businessId, req.partyId, afterKey)
        : opening;

  const rows = applyRunningBalance(page.events, balanceBeforePageMinor);

  const last = page.events.length ? page.events[page.events.length - 1] : null;
  const nextCursor =
    page.hasMore && last
      ? encodeStatementCursor({
          v: "v1",
          k: req.kind,
          b: req.businessId,
          p: req.partyId,
          f: req.from,
          t: req.to,
          ts: last.occurredAt.toISOString(),
          id: last.sourceId,
          st: last.sourceType,
        })
      : null;

  assertMinorInteger(summary.closingBalanceMinor, "closingBalanceMinor");

  return {
    statementType: statementTypeTokenOf(req.kind),
    party,
    summary: {
      openingBalanceMinor: summary.openingBalanceMinor,
      periodIncreaseMinor: summary.periodIncreaseMinor,
      periodDecreaseMinor: summary.periodDecreaseMinor,
      closingBalanceMinor: summary.closingBalanceMinor,
      eventCount: summary.eventCount,
      truncated: false, // §180 — cursor pagination covers the range; totals are complete
      from: req.from,
      to: req.to,
      timezone: req.timeZone,
    },
    rows: rows.map((row) => ({
      id: row.id,
      eventType: row.eventType,
      occurredAt: row.occurredAt.toISOString(),
      reference: row.reference,
      description: row.description,
      increaseMinor: row.increaseMinor,
      decreaseMinor: row.decreaseMinor,
      movementMinor: row.movementMinor,
      balanceAfterMinor: row.balanceAfterMinor,
    })),
    nextCursor,
    balanceBeforePageMinor,
  };
}
