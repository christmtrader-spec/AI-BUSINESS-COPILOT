/**
 * Prompt 45 — Sales Order domain types + pure laws (client-safe).
 *
 * SCOPE LAW (§4): a SalesOrder is a COMMERCIAL document — "the customer
 * committed to buying these quantities at these prices". It is NOT
 * revenue, NOT an invoice, NOT a payment, NOT a receivable, NOT an
 * inventory adjustment and NOT a stock reservation. Confirming an order
 * mutates NOTHING but the order itself (§30). There is NO stock
 * reservation model in this domain (§101).
 *
 * ORDER-TO-CASH AUTHORITY LAW (§5/§58):
 *  - PATH A (legacy direct sale, unchanged §6/§120): Sale creation owns
 *    the stock decrement.
 *  - PATH B (order-based, §7): the linked GoodsDispatch POST owns the
 *    ONLY inventory decrement; the ONE linked Sale invoice owns the
 *    financial/receivable authority and must NEVER decrement stock a
 *    second time (§58) — the authoritative distinction is the Sale
 *    relation (salesOrderId), never a notes/reference heuristic.
 *
 * LIFECYCLE LAW (§15/§16): DRAFT → CONFIRMED → COMPLETED, with
 * DRAFT/CONFIRMED → CANCELLED. COMPLETED means "fully dispatched AND
 * invoiced" — it says NOTHING about payment (§17/§64): Sale.status stays
 * the separate payment authority.
 *
 * FULFILLMENT LAW (§36/§37/§38): dispatchedQty per order line is the
 * SUM of POSTED linked GoodsDispatchLine quantities (draft/cancelled
 * never count). dispatchedQty <= orderedQty is a HARD invariant — no
 * over-dispatch, no tolerance, no clamp. A negative remaining quantity
 * is corruption and surfaces, never silently zeroes.
 *
 * HARDENING LAWS (inherited verbatim from the audited P41–P44 chain):
 *  - safe-integer arithmetic everywhere; qty × price overflow → the
 *    stable SALES_ORDER_TOTAL_OVERFLOW rejection (never a rounded total);
 *  - every PERSISTED line quantity is safe-integer >= 1 — a stored zero
 *    is corruption and is rejected at every row-materializing path;
 *  - the list/detail line-set completeness invariant is three explicit
 *    checks (fetched <= cap, counted <= cap, counted === fetched);
 *  - write-time cap rejection (lineCount === cap) is a 422 user error;
 *    an ALREADY-corrupted over-cap document is a 500 integrity failure;
 *  - date filters interpret from/to in the AUTHENTICATED business
 *    timezone via the ESTABLISHED helpers (no second date utility);
 *  - unknown persisted statuses are NEVER silently mapped to DRAFT.
 *
 * This module is pure: no Prisma, no db, no server-only imports. Safe
 * for client bundles. Cross-domain imports are the ESTABLISHED strict
 * calendar-date helpers only (re-exported — no third copy anywhere).
 */
import { zonedWallClockToUtc } from "@/lib/crm/normalization";
import { nextCalendarDay } from "@/lib/statements/schema";
import { isValidCalendarDate } from "@/lib/inventory/goods-return/types";

/** §dates — the ONE canonical strict calendar-date law (re-exported). */
export { isValidCalendarDate };

/* ------------------------------ lifecycle ------------------------------ */

export const SALES_ORDER_STATUSES = ["DRAFT", "CONFIRMED", "COMPLETED", "CANCELLED"] as const;

export type SalesOrderStatus = (typeof SALES_ORDER_STATUSES)[number];

export function isSalesOrderStatus(value: string): value is SalesOrderStatus {
  return (SALES_ORDER_STATUSES as readonly string[]).includes(value);
}

/* --------------------- persisted-status integrity ---------------------- */

export const SALES_ORDER_INVALID_PERSISTED_STATUS = "SALES_ORDER_INVALID_PERSISTED_STATUS";

/**
 * A corrupted persisted status (e.g. "BROKEN", "INVALID", "") is an
 * internal-data-integrity error, NOT a draft (§108). A fabricated DRAFT
 * would expose line editing / confirmation on an unknown document state,
 * so this pure error class is thrown instead and mapped to a controlled
 * 500 by the server layer. INVALID PERSISTED STATUS ≠ DRAFT.
 */
export class SalesOrderStatusIntegrityError extends Error {
  readonly code = SALES_ORDER_INVALID_PERSISTED_STATUS;
  readonly value: string;
  constructor(value: unknown) {
    // Server-side diagnostic detail only — the HTTP body carries the stable
    // code and a fixed, value-free message (no internals leaked).
    super(`${SALES_ORDER_INVALID_PERSISTED_STATUS}: ${String(value ?? "")}`);
    this.name = "SalesOrderStatusIntegrityError";
    this.value = typeof value === "string" ? value : String(value ?? "");
  }
}

/**
 * Parse a PERSISTED status value. Known → the exact valid status; unknown →
 * throws (§108). There is deliberately NO `→ DRAFT` fallback anywhere.
 */
export function parseSalesOrderStatus(value: string): SalesOrderStatus {
  if (isSalesOrderStatus(value)) return value;
  throw new SalesOrderStatusIntegrityError(value);
}

/* --------------------------- transition matrix -------------------------- */

/**
 * Allowed transitions (§16) — server-authoritative:
 *  - DRAFT → CONFIRMED | CANCELLED;
 *  - CONFIRMED → COMPLETED | CANCELLED (cancel additionally requires the
 *    no-fulfillment guard §49 — enforced in the service, inside the tx);
 *  - COMPLETED and CANCELLED are terminal.
 */
export const SALES_ORDER_TRANSITIONS: Readonly<
  Record<SalesOrderStatus, readonly SalesOrderStatus[]>
> = {
  DRAFT: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransitionSalesOrder(
  from: SalesOrderStatus,
  to: SalesOrderStatus,
): boolean {
  return SALES_ORDER_TRANSITIONS[from].includes(to);
}

/* ---------------------------- quantity laws ----------------------------- */

/** orderedQty: integer 1..1_000_000 whole units (§18). */
export const ORDER_QTY_MIN = 1;
export const SALES_ORDER_QTY_MAX = 1_000_000;

/**
 * A valid order quantity is a SAFE integer 1..1_000_000 (§18).
 * Number.isSafeInteger (not Number.isInteger alone): an unsafe integer has
 * already lost precision before any comparison runs, so it can never be
 * trusted as an authoritative quantity.
 */
export function isValidOrderQty(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= ORDER_QTY_MIN &&
    value <= SALES_ORDER_QTY_MAX
  );
}

/**
 * A PERSISTED order-line quantity (loaded from the database) must be a
 * safe integer in the valid domain. Shared by every path that loads
 * actual rows (detail, list, confirm, fulfillment, export, invoice,
 * history widgets) — a stored zero is INVALID persisted state and is
 * rejected everywhere.
 */
export function isValidPersistedOrderQty(value: unknown): boolean {
  return isValidOrderQty(value);
}

/** unitPriceMinor: integer 0..9_000_000_000 (§21/§22 — mirrors P41). */
export const SALES_ORDER_PRICE_MAX = 9_000_000_000;

export function isValidOrderPrice(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= SALES_ORDER_PRICE_MAX
  );
}

/* ------------------------------ line cap ------------------------------- */

export const SALES_ORDER_LINE_CAP_DEFAULT = 200;
export const SALES_ORDER_LINE_CAP_MIN = 20;
export const SALES_ORDER_LINE_CAP_MAX = 500;

/**
 * SALES_ORDER_MAX_LINES parsing (§31): default safely, fall back to the
 * default on malformed input, clamp below MIN and above MAX. Never
 * unbounded. (Same defensive parser style as P41–P44.)
 */
export function salesOrderLineCap(env: string | undefined | null): number {
  const parsed = Number.parseInt(String(env ?? "").trim(), 10);
  if (!Number.isInteger(parsed)) return SALES_ORDER_LINE_CAP_DEFAULT;
  if (parsed < SALES_ORDER_LINE_CAP_MIN) return SALES_ORDER_LINE_CAP_MIN;
  if (parsed > SALES_ORDER_LINE_CAP_MAX) return SALES_ORDER_LINE_CAP_MAX;
  return parsed;
}

/* ------------------- read-cap invariant (integrity) -------------------- */

/**
 * Read-cap invariant (§106): a persisted order that contains MORE lines
 * than its own configured cap is database corruption. Read paths fetch
 * cap+1 rows to PROVE completeness; the +1 row (or a `_count` mismatch)
 * must fail the read with this stable code — never a silently
 * truncated/partial DTO or a partial total. Distinct from
 * SALES_ORDER_LINE_LIMIT_REACHED (422 write-time rejection): the
 * invariant is a 500 data-integrity failure.
 */
export const SALES_ORDER_LINE_CAP_INVARIANT = "SALES_ORDER_LINE_CAP_INVARIANT";

/* ------------------------- canonical order math ------------------------- */

export const SALES_ORDER_CORRUPT_HISTORY = "SALES_ORDER_CORRUPT_HISTORY";
export const SALES_ORDER_TOTAL_OVERFLOW = "SALES_ORDER_TOTAL_OVERFLOW";

/**
 * Domain integrity error for corrupted persisted state (over-dispatch,
 * corrupt quantities, missing snapshots). Server layers map this to the
 * controlled 500 with the stable code carried in the message.
 */
export class SalesOrderIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesOrderIntegrityError";
  }
}

/**
 * Input-time total overflow: the CLIENT-visible rejection for a
 * request whose canonical math leaves the safe integer range (§22/§24/§107
 * — never silently rounded). Persisted-data overflow is corruption and
 * uses the integrity error instead.
 */
export class SalesOrderTotalOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesOrderTotalOverflowError";
  }
}

/**
 * ONE canonical order-line total: orderedQty × unitPriceMinor in exact
 * integer math (§24/§55). Every operand is validated (safe integer, valid
 * domain); an unsafe product or sum throws — a computed total can never
 * silently lose precision (§107). Input-time callers map
 * SalesOrderTotalOverflowError to 422 SALES_ORDER_TOTAL_OVERFLOW;
 * persisted-data callers map it to the integrity 500.
 */
export function computeOrderLineTotalMinor(
  orderedQty: number,
  unitPriceMinor: number,
): number {
  if (!isValidPersistedOrderQty(orderedQty)) {
    throw new SalesOrderIntegrityError(
      `${SALES_ORDER_CORRUPT_HISTORY}: orderedQty ${String(orderedQty)}`,
    );
  }
  if (!isValidOrderPrice(unitPriceMinor)) {
    throw new SalesOrderIntegrityError(
      `${SALES_ORDER_CORRUPT_HISTORY}: unitPriceMinor ${String(unitPriceMinor)}`,
    );
  }
  const total = orderedQty * unitPriceMinor;
  if (!Number.isSafeInteger(total)) {
    throw new SalesOrderTotalOverflowError(
      `${SALES_ORDER_TOTAL_OVERFLOW}: line total ${orderedQty}×${unitPriceMinor}`,
    );
  }
  return total;
}

export type OrderLineTotalsInput = ReadonlyArray<{
  orderedQty: number;
  unitPriceMinor: number;
}>;

export type OrderTotals = {
  lineTotalsMinor: number[];
  subtotalMinor: number;
};

/**
 * ONE canonical subtotal computation over a PROVEN-COMPLETE line set
 * (§24): every line total is exact; the accumulation re-checks the safe
 * integer range after EVERY addition (200 lines × maxima can exceed
 * Number.MAX_SAFE_INTEGER — silent overflow can never fabricate a total).
 */
export function computeOrderSubtotalMinor(lines: OrderLineTotalsInput): OrderTotals {
  const lineTotalsMinor: number[] = [];
  let subtotalMinor = 0;
  for (const line of lines) {
    const lineTotal = computeOrderLineTotalMinor(line.orderedQty, line.unitPriceMinor);
    lineTotalsMinor.push(lineTotal);
    subtotalMinor += lineTotal;
    if (!Number.isSafeInteger(subtotalMinor)) {
      throw new SalesOrderTotalOverflowError(
        `${SALES_ORDER_TOTAL_OVERFLOW}: subtotal exceeded the safe integer range`,
      );
    }
  }
  return { lineTotalsMinor, subtotalMinor };
}

/**
 * Discount law (§23): integer 0..subtotalMinor. No tax engine, no
 * shipping, no payment fields. Returns the value or throws the input-time
 * rejection (the caller maps it to 422 INVALID_DISCOUNT).
 */
export function validateOrderDiscount(
  discountMinor: number,
  subtotalMinor: number,
): number {
  if (!Number.isSafeInteger(discountMinor) || discountMinor < 0) {
    throw new SalesOrderTotalOverflowError(
      `${SALES_ORDER_TOTAL_OVERFLOW}: discount ${String(discountMinor)}`,
    );
  }
  if (discountMinor > subtotalMinor) {
    throw new SalesOrderTotalOverflowError(
      `${SALES_ORDER_TOTAL_OVERFLOW}: discount ${discountMinor} exceeds subtotal ${subtotalMinor}`,
    );
  }
  return discountMinor;
}

/**
 * ONE canonical order total (§24): totalMinor = subtotalMinor −
 * discountMinor, exact integers only. Inputs must already be validated.
 */
export function computeOrderTotalMinor(subtotalMinor: number, discountMinor: number): number {
  if (!Number.isSafeInteger(subtotalMinor) || subtotalMinor < 0) {
    throw new SalesOrderIntegrityError(
      `${SALES_ORDER_CORRUPT_HISTORY}: subtotalMinor ${String(subtotalMinor)}`,
    );
  }
  if (!Number.isSafeInteger(discountMinor) || discountMinor < 0) {
    throw new SalesOrderIntegrityError(
      `${SALES_ORDER_CORRUPT_HISTORY}: discountMinor ${String(discountMinor)}`,
    );
  }
  const total = subtotalMinor - discountMinor;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new SalesOrderTotalOverflowError(
      `${SALES_ORDER_TOTAL_OVERFLOW}: total ${String(total)}`,
    );
  }
  return total;
}

/* ------------------------- fulfillment arithmetic ----------------------- */

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The ONE canonical per-line fulfillment computation (§36/§38):
 *   dispatchedQty  = Σ POSTED linked dispatch-line qty (aggregate result)
 *   remainingToDispatchQty = orderedQty − dispatchedQty
 * Corruption classification is precise: an invalid ORDERED quantity or an
 * invalid (negative/unsafe) DISPATCHED aggregate is persisted-data
 * corruption; dispatched > ordered is the over-dispatch integrity
 * failure (§37 — no tolerance, no clamp). The remaining quantity is never
 * clamped to zero (§38).
 */
export function computeRemainingToDispatchQty(
  orderedQty: number,
  dispatchedQty: number,
): { dispatchedQty: number; remainingToDispatchQty: number } {
  if (!isValidPersistedOrderQty(orderedQty)) {
    throw new SalesOrderIntegrityError(
      `${SALES_ORDER_CORRUPT_HISTORY}: orderedQty ${String(orderedQty)}`,
    );
  }
  if (!isSafeNonNegativeInteger(dispatchedQty)) {
    throw new SalesOrderIntegrityError(
      `${SALES_ORDER_CORRUPT_HISTORY}: dispatchedQty ${String(dispatchedQty)}`,
    );
  }
  if (dispatchedQty > orderedQty) {
    throw new SalesOrderIntegrityError(
      `${SALES_ORDER_ERROR_CODES.OVER_DISPATCH}: dispatched ${dispatchedQty} > ordered ${orderedQty}`,
    );
  }
  const remainingToDispatchQty = orderedQty - dispatchedQty;
  if (!Number.isSafeInteger(remainingToDispatchQty) || remainingToDispatchQty < 0) {
    throw new SalesOrderIntegrityError(
      `${SALES_ORDER_CORRUPT_HISTORY}: remaining ${String(remainingToDispatchQty)}`,
    );
  }
  return { dispatchedQty, remainingToDispatchQty };
}

/**
 * ONE canonical dispatch-request gate (§42 advisory + §44 authoritative):
 * requested qty against the CURRENT remaining quantity. Returns true when
 * the request exceeds what remains. Both operands are validated — an
 * invalid operand is corruption, never "over".
 */
export function exceedsRemainingToDispatch(remainingToDispatchQty: number, requestedQty: number): boolean {
  if (!isSafeNonNegativeInteger(remainingToDispatchQty)) {
    throw new SalesOrderIntegrityError(
      `${SALES_ORDER_CORRUPT_HISTORY}: remainingToDispatchQty ${String(remainingToDispatchQty)}`,
    );
  }
  if (!isValidOrderQty(requestedQty)) {
    throw new SalesOrderIntegrityError(
      `${SALES_ORDER_CORRUPT_HISTORY}: requestedQty ${String(requestedQty)}`,
    );
  }
  return requestedQty > remainingToDispatchQty;
}

/* ------------------- read-cap invariant (shared law) -------------------- */

/**
 * The ONE canonical list/detail line-set completeness validator (§106).
 * Three explicit invariants, ALL enforced:
 *   1. fetched rows > cap           → corruption (over-cap document);
 *   2. counted rows (_count) > cap  → corruption (over-cap document);
 *   3. counted ≠ fetched            → corruption EVEN WHEN both are below
 *      the cap — a subset total must never masquerade as complete.
 * (Same three-check law as the audited P44 dispatch module.)
 */
export function assertSalesOrderLineSetComplete(
  fetchedLines: number,
  countedLines: number,
  cap: number,
): void {
  if (fetchedLines > cap || countedLines > cap) {
    throw new SalesOrderIntegrityError(
      `${SALES_ORDER_LINE_CAP_INVARIANT}: fetched ${fetchedLines} / counted ${countedLines} exceed cap ${cap}`,
    );
  }
  if (countedLines !== fetchedLines) {
    throw new SalesOrderIntegrityError(
      `${SALES_ORDER_LINE_CAP_INVARIANT}: line count ${countedLines} != fetched rows ${fetchedLines}`,
    );
  }
}

/* ---------------------------- reference law ---------------------------- */

export const SALES_ORDER_REFERENCE_MIN = 2;
export const SALES_ORDER_REFERENCE_MAX = 80;
export const SALES_ORDER_NOTES_MAX = 2000;

/**
 * Reference normalization (§13): trim, reject control characters (NUL,
 * newlines, path-hostile control bytes), collapse pathological whitespace
 * runs to a single space, preserve Unicode. Returns null when nothing
 * usable remains (blank → caller generates).
 */
export function normalizeSalesOrderReference(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null; // control chars rejected
  const collapsed = trimmed.replace(/\s+/g, " ");
  if (collapsed.length < SALES_ORDER_REFERENCE_MIN) return null;
  if (collapsed.length > SALES_ORDER_REFERENCE_MAX) return null;
  return collapsed;
}

/**
 * Server-generated reference when the user leaves it blank (§14):
 * SO-<YYYYMMDD>-<6 unambiguous base32 chars>, secure random. Database
 * uniqueness stays authoritative; NEVER a MAX(reference)+1 algorithm;
 * client-generated uniqueness is never trusted.
 */
const GENERATION_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I/L/O/0/1

export function generateSalesOrderReference(
  now: Date,
  random: (max: number) => number,
): string {
  const date =
    `${now.getUTCFullYear()}`.padStart(4, "0") +
    `${now.getUTCMonth() + 1}`.padStart(2, "0") +
    `${now.getUTCDate()}`.padStart(2, "0");
  let token = "";
  for (let i = 0; i < 6; i += 1) {
    token += GENERATION_ALPHABET[random(GENERATION_ALPHABET.length)];
  }
  return `SO-${date}-${token}`;
}

/* --------------------------- date-window law --------------------------- */

/**
 * The business-timezone createdAt day window for list filters. COMPOSES
 * the established repository helpers (zonedWallClockToUtc +
 * nextCalendarDay — the same statement/aging/P43/P44 law: no second date
 * utility): `from` is the INCLUSIVE local start of day, `to` is the
 * EXCLUSIVE local start of the NEXT day (never 23:59:59.999). Invalid
 * calendar dates (2026-02-31, 2026-13-01) are rejected — never rolled
 * over; null maps to a controlled 422 at the call site.
 */
export function salesOrderDayWindow(
  from: string | undefined,
  to: string | undefined,
  timezone: string | undefined | null,
): { gte?: Date; lt?: Date } | null {
  if (!from && !to) return {};
  if (from && !isValidCalendarDate(from)) return null;
  if (to && !isValidCalendarDate(to)) return null;
  // The ESTABLISHED helper falls back to UTC for an unknown IANA zone
  // (never throws, never invents an offset) — the same documented behavior
  // the statements/aging/P43/P44 windows rely on.
  const tz = timezone || "UTC";
  const window: { gte?: Date; lt?: Date } = {};
  if (from) {
    const gte = zonedWallClockToUtc(`${from}T00:00`, tz);
    if (!gte) return null;
    window.gte = gte;
  }
  if (to) {
    const lt = zonedWallClockToUtc(`${nextCalendarDay(to)}T00:00`, tz);
    if (!lt) return null;
    window.lt = lt;
  }
  return window;
}

/* -------------------------------- errors -------------------------------- */

/**
 * The centralized error vocabulary (§111). Routes never duplicate string
 * literals — every code is referenced from this table.
 */
export const SALES_ORDER_ERROR_CODES = {
  DUPLICATE_REFERENCE: "SALES_ORDER_DUPLICATE_REFERENCE",
  INVALID_STATUS: "SALES_ORDER_INVALID_STATUS",
  EMPTY: "SALES_ORDER_EMPTY",
  LINE_LIMIT: "SALES_ORDER_LINE_LIMIT_REACHED",
  LINE_CAP_INVARIANT: SALES_ORDER_LINE_CAP_INVARIANT,
  DUPLICATE_PRODUCT: "SALES_ORDER_DUPLICATE_PRODUCT",
  INVALID_TRANSITION: "SALES_ORDER_INVALID_TRANSITION",
  HAS_FULFILLMENT: "SALES_ORDER_HAS_FULFILLMENT",
  NOT_FULLY_DISPATCHED: "SALES_ORDER_NOT_FULLY_DISPATCHED",
  ALREADY_INVOICED: "SALES_ORDER_ALREADY_INVOICED",
  DISPATCH_EXCEEDS_REMAINING: "SALES_ORDER_DISPATCH_EXCEEDS_REMAINING",
  TOTAL_OVERFLOW: SALES_ORDER_TOTAL_OVERFLOW,
  INVALID_PERSISTED_STATUS: SALES_ORDER_INVALID_PERSISTED_STATUS,
  IMMUTABLE: "SALES_ORDER_IMMUTABLE",
  SALE_LINKED: "SALE_LINKED_TO_SALES_ORDER",
  FOREIGN_ENTITY: "SALES_ORDER_FOREIGN_ENTITY",
  OVER_DISPATCH: "SALES_ORDER_OVER_DISPATCH",
  CUSTOMER_NOT_FOUND: "SALES_ORDER_CUSTOMER_NOT_FOUND",
  PRODUCT_NOT_FOUND: "SALES_ORDER_PRODUCT_NOT_FOUND",
  LINE_NOT_FOUND: "SALES_ORDER_LINE_NOT_FOUND",
  INVALID_DISCOUNT: "INVALID_DISCOUNT",
  CORRUPT_HISTORY: SALES_ORDER_CORRUPT_HISTORY,
} as const;

/* ---------------------------- lifecycle gates --------------------------- */

/** Header/lines may change only while DRAFT (§26/§27). */
export function salesOrderEditable(status: SalesOrderStatus): boolean {
  return status === "DRAFT";
}

/** CONFIRMED/COMPLETED/CANCELLED orders are read-only documents (§27). */
export function salesOrderIsReadOnly(status: SalesOrderStatus): boolean {
  return status !== "DRAFT";
}
