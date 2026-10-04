/**
 * Prompt 39 — Party Statements domain types.
 *
 * WHAT A STATEMENT IS (§1/§264/§265/§278):
 *   A DERIVED TRANSACTION VIEW over the existing Sale / Expense / Payment
 *   records of ONE party (a customer or a supplier) — never a general
 *   ledger, never double-entry accounting, never a P&L. Terminology is
 *   deliberately "Customer Statement" / "Supplier Statement" with
 *   opening/closing balance and balance movements.
 *
 * CORE SEMANTICS (§2):
 *   Customer: SALE increases the balance, PAYMENT_RECEIVED decreases it.
 *     statement balance = sales − customer payments
 *   Supplier: BILL increases the balance, PAYMENT_MADE decreases it.
 *     statement balance = supplier bills − supplier payments
 *
 * NO NEW SOURCE OF TRUTH (§4/§5/§190/§191): every figure here is derived
 * at read time. Nothing in this module persists a StatementEvent, a
 * balance column, or a snapshot.
 */

/** Closed statement kinds (§7) — no arbitrary statement kind from the client. */
export const STATEMENT_KINDS = ["CUSTOMER", "SUPPLIER"] as const;
export type StatementKind = (typeof STATEMENT_KINDS)[number];

export function isStatementKind(value: string): value is StatementKind {
  return (STATEMENT_KINDS as readonly string[]).includes(value);
}

/** Client-facing statement type tokens for routes/keys (§56/§139). */
export const STATEMENT_TYPE_TOKENS = ["customer", "supplier"] as const;
export type StatementTypeToken = (typeof STATEMENT_TYPE_TOKENS)[number];

export function isStatementTypeToken(value: string): value is StatementTypeToken {
  return (STATEMENT_TYPE_TOKENS as readonly string[]).includes(value);
}

export function statementTypeTokenOf(kind: StatementKind): StatementTypeToken {
  return kind === "CUSTOMER" ? "customer" : "supplier";
}

/** Closed statement event vocabulary (§8) — never client-supplied. */
export const STATEMENT_EVENT_TYPES = [
  "SALE",
  "PAYMENT_RECEIVED",
  "BILL",
  "PAYMENT_MADE",
] as const;
export type StatementEventType = (typeof STATEMENT_EVENT_TYPES)[number];

export function isStatementEventType(value: string): value is StatementEventType {
  return (STATEMENT_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Internal source identity (§187/§188/§189) — the SOURCE TABLE always rides
 * with the source id. Sale and Payment ids are independent sequences, so a
 * bare id is never assumed globally meaningful:
 *   Customer: SALE:<id> / PAYMENT_IN:<id>
 *   Supplier: BILL:<id> / PAYMENT_OUT:<id>
 */
export const STATEMENT_SOURCE_TYPES = [
  "SALE",
  "PAYMENT_IN",
  "BILL",
  "PAYMENT_OUT",
] as const;
export type StatementSourceType = (typeof STATEMENT_SOURCE_TYPES)[number];

/**
 * Pure internal derived event (§9). Constructed in memory from DB rows —
 * NEVER persisted (§190), never returned as a raw Prisma object (§32).
 */
export type StatementEvent = {
  /** Deterministic internal identity "SALE:<id>" / "PAYMENT_IN:<id>" / "BILL:<id>" / "PAYMENT_OUT:<id>". */
  id: string;
  kind: StatementKind;
  eventType: StatementEventType;
  sourceType: StatementSourceType;
  sourceId: string;
  occurredAt: Date;
  reference: string | null;
  description: string | null;
  /** Integer minor units (§135) — increase side of the movement (0 allowed). */
  increaseMinor: number;
  /** Integer minor units (§135) — decrease side of the movement (0 allowed). */
  decreaseMinor: number;
  /** increaseMinor − decreaseMinor, exact integer (§135/§268). */
  movementMinor: number;
};

/** A statement event after the server-computed running balance (§24). */
export type StatementEventRow = StatementEvent & {
  /** previous balance + movementMinor, exact integer (§24/§135). */
  balanceAfterMinor: number;
};

/** Statement summary — all integer minor units, DB-aggregate derived (§30/§31). */
export type StatementSummary = {
  openingBalanceMinor: number;
  periodIncreaseMinor: number;
  periodDecreaseMinor: number;
  closingBalanceMinor: number;
  /** Actual events in the selected period — NOT page rows (§179). */
  eventCount: number;
};

/**
 * Canonical merged ordering key (§25/§26 + §187):
 *   occurredAt ASC → sourceId ASC → sourceType ASC (deterministic tie-break;
 *   the final sourceType comparison only matters for the theoretical
 *   cross-table id collision at the same instant).
 */
export type StatementSortKey = {
  ts: Date;
  id: string;
  st: StatementSourceType;
};

export function eventSortKey(event: StatementEvent): StatementSortKey {
  return { ts: event.occurredAt, id: event.sourceId, st: event.sourceType };
}

/** Total order over statement events (pure, deterministic — §25/§26). */
export function compareSortKeys(a: StatementSortKey, b: StatementSortKey): number {
  const at = a.ts.getTime();
  const bt = b.ts.getTime();
  if (at !== bt) return at < bt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  if (a.st !== b.st) return a.st < b.st ? -1 : 1;
  return 0;
}

/** Strictly-before test used for page boundaries and balance math. */
export function isBeforeKey(key: StatementSortKey, cursorKey: StatementSortKey): boolean {
  return compareSortKeys(key, cursorKey) < 0;
}

/** Guard: statement money values are always integers (§135/§268/§269). */
export function assertMinorInteger(value: number, label: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`Statement money invariant violated (${label}): non-integer minor units`);
  }
  return value;
}

/** Pagination bounds (§35) — default 50, minimum 10, maximum 100. */
export const STATEMENT_DEFAULT_LIMIT = 50;
export const STATEMENT_MIN_LIMIT = 10;
export const STATEMENT_MAX_LIMIT = 100;

/**
 * Page fetch strategy (§40): each source is fetched with limit+1 rows so a
 * full source window proves more rows exist beyond the fetched page while
 * memory stays O(limit) (§41).
 */
export function statementSourceTake(limit: number): number {
  return limit + 1;
}
