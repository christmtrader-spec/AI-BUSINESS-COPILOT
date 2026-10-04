/**
 * Prompt 39 — statement EVENTS layer (pure mapping + merging + where-builders).
 *
 * LAWS ENCODED HERE:
 *   §10 — a customer SALE event moves +Sale.totalMinor at Sale.issueDate
 *         (NEVER paidMinor — the Payment row creates its own movement).
 *   §11 — a customer PAYMENT_RECEIVED event moves −Payment.amountMinor at
 *         Payment.paidAt; identity flows Payment → Sale → Customer. Expense
 *         payments never appear here and payment.actorId is NEVER treated
 *         as party identity (§102).
 *   §12 — a supplier BILL event moves +Expense.amountMinor at Expense.spentAt.
 *   §13 — a supplier PAYMENT_MADE event moves −Payment.amountMinor where the
 *         target Expense belongs to the supplier; sale payments never appear.
 *   §14/§15/§100/§101 — soft-deleted Sales/Expenses are excluded, and a
 *         payment whose target transaction is deleted is excluded with it.
 *   §105/§106/§107 — no double counting: Sale uses totalMinor, Expense uses
 *         amountMinor, Payment contributes exactly one event via its target.
 *   §29 — private notes (Sale.note / Expense.note / Payment.note) are NEVER
 *         part of statement rows.
 */
import { formatInvoiceNumber } from "@/lib/finance";
import { messagesFor } from "@/i18n/messages";
import { formatTemplate } from "./formatting";
import type { StatementWindow } from "./schema";
import {
  assertMinorInteger,
  compareSortKeys,
  eventSortKey,
  type StatementEvent,
  type StatementEventRow,
  type StatementSourceType,
} from "./types";

// ---------------------------------------------------------------------------
// Pure query-shape builders (single source used by the engine AND unit tests —
// they make the tenant/delete/window/after-clause laws inspectable without a DB).
// ---------------------------------------------------------------------------

/** Ordering boundary: strictly AFTER this key in the merged order (§46). */
export type AfterKey = { ts: Date; id: string } | null;

function afterClause(dateField: "issueDate" | "paidAt" | "spentAt", after: AfterKey) {
  if (!after) return {};
  // (date > ts) OR (date = ts AND id >= afterId) — the "=" twin is filtered
  // in memory with the strict full-key compare (covers the cross-table
  // sourceType tie-break of §187 without SQL gymnastics).
  return {
    OR: [{ [dateField]: { gt: after.ts } }, { [dateField]: after.ts, id: { gte: after.id } }],
  };
}

/** Customer SALE source (§10/§124): business + party + not deleted + window. */
export function customerSaleWhere(
  businessId: string,
  customerId: string,
  window: StatementWindow,
  after: AfterKey,
) {
  return {
    businessId,
    customerId,
    deletedAt: null, // §14/§100
    issueDate: { gte: window.from, lt: window.until },
    ...afterClause("issueDate", after),
  };
}

/** Customer PAYMENT source (§11/§124): party via the SALE TARGET relation. */
export function customerPaymentWhere(
  businessId: string,
  customerId: string,
  window: StatementWindow,
  after: AfterKey,
) {
  return {
    businessId,
    sale: { customerId, deletedAt: null }, // target + target party + target not deleted (§101)
    paidAt: { gte: window.from, lt: window.until },
    ...afterClause("paidAt", after),
  };
}

/** Supplier BILL source (§12/§124). */
export function supplierExpenseWhere(
  businessId: string,
  supplierId: string,
  window: StatementWindow,
  after: AfterKey,
) {
  return {
    businessId,
    supplierId,
    deletedAt: null, // §14/§100
    spentAt: { gte: window.from, lt: window.until },
    ...afterClause("spentAt", after),
  };
}

/** Supplier PAYMENT source (§13/§124): party via the EXPENSE TARGET relation. */
export function supplierPaymentWhere(
  businessId: string,
  supplierId: string,
  window: StatementWindow,
  after: AfterKey,
) {
  return {
    businessId,
    expense: { supplierId, deletedAt: null }, // target + target party + target not deleted (§101)
    paidAt: { gte: window.from, lt: window.until },
    ...afterClause("paidAt", after),
  };
}

// ---------------------------------------------------------------------------
// Explicit selects (§125) — no full relation objects, no notes (§29).
// ---------------------------------------------------------------------------

export const customerSaleSelect = {
  id: true,
  number: true,
  issueDate: true,
  totalMinor: true,
} as const;

export const customerPaymentSelect = {
  id: true,
  paidAt: true,
  amountMinor: true,
  sale: { select: { number: true } },
} as const;

export const supplierExpenseSelect = {
  id: true,
  spentAt: true,
  amountMinor: true,
  category: true,
  reference: true,
} as const;

export const supplierPaymentSelect = {
  id: true,
  paidAt: true,
  amountMinor: true,
  expense: { select: { reference: true, category: true } },
} as const;

// ---------------------------------------------------------------------------
// Row → event mapping (pure, localized descriptions via shared catalogs).
// ---------------------------------------------------------------------------

export type CustomerSaleRow = {
  id: string;
  number: number;
  issueDate: Date;
  totalMinor: number;
};

export type CustomerPaymentRow = {
  id: string;
  paidAt: Date;
  amountMinor: number;
  sale: { number: number } | null;
};

export type SupplierExpenseRow = {
  id: string;
  spentAt: Date;
  amountMinor: number;
  category: string;
  reference: string | null;
};

export type SupplierPaymentRow = {
  id: string;
  paidAt: Date;
  amountMinor: number;
  expense: { reference: string | null; category: string } | null;
};

/** §10 — customer SALE event: +totalMinor (never paidMinor, §105/§106). */
export function customerSaleEvent(row: CustomerSaleRow, locale: "en" | "fa"): StatementEvent {
  assertMinorInteger(row.totalMinor, "sale.totalMinor");
  const reference = formatInvoiceNumber(row.number);
  return {
    id: `SALE:${row.id}`,
    kind: "CUSTOMER",
    eventType: "SALE",
    sourceType: "SALE",
    sourceId: row.id,
    occurredAt: row.issueDate,
    reference,
    description: formatTemplate(messagesFor(locale).statements.invoiceDesc, { number: reference }),
    increaseMinor: row.totalMinor,
    decreaseMinor: 0,
    movementMinor: row.totalMinor,
  };
}

/** §11 — customer PAYMENT_RECEIVED: −amountMinor, party from the sale target. */
export function customerPaymentEvent(row: CustomerPaymentRow, locale: "en" | "fa"): StatementEvent {
  assertMinorInteger(row.amountMinor, "payment.amountMinor");
  const reference = row.sale?.number != null ? formatInvoiceNumber(row.sale.number) : null;
  return {
    id: `PAYMENT_IN:${row.id}`,
    kind: "CUSTOMER",
    eventType: "PAYMENT_RECEIVED",
    sourceType: "PAYMENT_IN",
    sourceId: row.id,
    occurredAt: row.paidAt,
    reference,
    description: messagesFor(locale).statements.paymentDesc,
    increaseMinor: 0,
    decreaseMinor: row.amountMinor,
    movementMinor: -row.amountMinor,
  };
}

/** §12 — supplier BILL: +amountMinor (never paidMinor, §105/§107). */
export function supplierBillEvent(row: SupplierExpenseRow, locale: "en" | "fa"): StatementEvent {
  assertMinorInteger(row.amountMinor, "expense.amountMinor");
  // §27 — reference is the stated supplier bill reference, falling back to
  // the business-facing category (never an internal database id, §121).
  const reference = row.reference ?? row.category ?? null;
  return {
    id: `BILL:${row.id}`,
    kind: "SUPPLIER",
    eventType: "BILL",
    sourceType: "BILL",
    sourceId: row.id,
    occurredAt: row.spentAt,
    reference,
    description: row.category ?? null,
    increaseMinor: row.amountMinor,
    decreaseMinor: 0,
    movementMinor: row.amountMinor,
  };
}

/** §13 — supplier PAYMENT_MADE: −amountMinor, party from the expense target. */
export function supplierPaymentEvent(row: SupplierPaymentRow, locale: "en" | "fa"): StatementEvent {
  assertMinorInteger(row.amountMinor, "payment.amountMinor");
  const reference = row.expense?.reference ?? row.expense?.category ?? null;
  return {
    id: `PAYMENT_OUT:${row.id}`,
    kind: "SUPPLIER",
    eventType: "PAYMENT_MADE",
    sourceType: "PAYMENT_OUT",
    sourceId: row.id,
    occurredAt: row.paidAt,
    reference,
    description: messagesFor(locale).statements.paymentDesc,
    increaseMinor: 0,
    decreaseMinor: row.amountMinor,
    movementMinor: -row.amountMinor,
  };
}

// ---------------------------------------------------------------------------
// Deterministic ordering + merging (§25/§26/§40/§46).
// ---------------------------------------------------------------------------

/** Defensive ascending sort by the canonical key (DB results arrive sorted). */
export function sortEvents(events: StatementEvent[]): StatementEvent[] {
  return [...events].sort((a, b) => compareSortKeys(eventSortKey(a), eventSortKey(b)));
}

/**
 * Merge two individually-sorted source lists into one ascending list (§40).
 * Inputs must each be sorted by the canonical key; output is globally sorted
 * with NO duplicated and NO skipped event (§186).
 */
export function mergeSortedEvents(a: StatementEvent[], b: StatementEvent[]): StatementEvent[] {
  const out: StatementEvent[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const cmp = compareSortKeys(eventSortKey(a[i]), eventSortKey(b[j]));
    if (cmp <= 0) out.push(a[i++]);
    else out.push(b[j++]);
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

// ---------------------------------------------------------------------------
// Server-computed running balance (§24/§44/§45) — the client NEVER computes it.
// ---------------------------------------------------------------------------

/** Apply the exact integer running balance over an ordered page. */
export function applyRunningBalance(
  events: StatementEvent[],
  balanceBeforeMinor: number,
): StatementEventRow[] {
  assertMinorInteger(balanceBeforeMinor, "balanceBeforeMinor");
  let balance = balanceBeforeMinor;
  return events.map((event) => {
    assertMinorInteger(event.movementMinor, "movementMinor");
    balance += event.movementMinor;
    return { ...event, balanceAfterMinor: balance };
  });
}

/** Pure summary arithmetic (§22/§30/§31) — closing = opening + in − out. */
export function summarizeStatement(
  openingBalanceMinor: number,
  periodIncreaseMinor: number,
  periodDecreaseMinor: number,
  eventCount: number,
): {
  openingBalanceMinor: number;
  periodIncreaseMinor: number;
  periodDecreaseMinor: number;
  closingBalanceMinor: number;
  eventCount: number;
} {
  assertMinorInteger(openingBalanceMinor, "openingBalanceMinor");
  assertMinorInteger(periodIncreaseMinor, "periodIncreaseMinor");
  assertMinorInteger(periodDecreaseMinor, "periodDecreaseMinor");
  return {
    openingBalanceMinor,
    periodIncreaseMinor,
    periodDecreaseMinor,
    closingBalanceMinor: openingBalanceMinor + periodIncreaseMinor - periodDecreaseMinor,
    eventCount,
  };
}

export type StatementSourceTypeToken = StatementSourceType;
