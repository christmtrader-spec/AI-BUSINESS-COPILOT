/**
 * Prompt 47 — Sales Quotation domain types + pure laws (client-safe).
 *
 * SCOPE LAW (§1): a SalesQuotation is a formal COMMERCIAL OFFER made to a
 * prospective or existing customer. It is NOT a SalesOrder, NOT a Sale
 * invoice, NOT revenue, NOT a payment, NOT a receivable, NOT an expense,
 * NOT a purchase commitment, NOT an inventory movement, NOT a stock
 * reservation and NOT an accounting entry. Creating, editing, marking
 * sent, accepting, rejecting, cancelling, expiring or converting a
 * quotation NEVER directly alters product inventory and NEVER creates a
 * financial transaction. The ONLY permitted downstream effect of
 * conversion is one legitimate linked SalesOrder through the existing
 * order workflow (§13) — inventory/decrement, invoicing, payments and
 * receivables stay owned by GoodsDispatch/Sale/Payment (§14).
 *
 * LIFECYCLE LAW (§8) — closed persisted vocabulary, server-authoritative:
 *   DRAFT     → SENT | CANCELLED            (editable header + lines)
 *   SENT      → ACCEPTED | REJECTED | CANCELLED | EXPIRED
 *                                          (terms immutable after send)
 *   ACCEPTED  → CONVERTED | CANCELLED       (immutable; converts exactly
 *                                            once; cancel-before-conversion
 *                                            is the documented policy)
 *   REJECTED | EXPIRED | CANCELLED | CONVERTED → terminal.
 * ACCEPT/REJECT require the offer to still be WITHIN its validity period
 * (§8/§9). An explicit EXPIRED transition exists for a SENT offer that is
 * already past its validity date — it is atomic and audited (§9).
 *
 * VALIDITY LAW (§9): the offer is valid THROUGH validUntilDate INCLUSIVE
 * in the AUTHENTICATED business timezone. It is expired when the current
 * business-local calendar date is AFTER validUntilDate. The SERVER is the
 * time authority — never the browser clock. A SENT quotation whose
 * validity date has passed is displayed with effectiveStatus EXPIRED while
 * its PERSISTED status remains SENT (the database is never silently
 * pretended to be mutated, §9); accept/reject on such a quotation are
 * rejected with the controlled SALES_QUOTATION_EXPIRED error. An ACCEPTED
 * quotation NEVER becomes expired merely because the validity date later
 * passes — acceptance is already recorded (§9).
 *
 * MANUAL DECLARATION SEMANTICS (§2.7): SENT records an internal user's
 * declaration that the offer was sent OUTSIDE the application — it is NOT
 * proof of email delivery. ACCEPTED records an authorized internal user's
 * declaration that the customer accepted — NOT a verified portal
 * signature. There is no public quotation endpoint, no customer portal,
 * no acceptance token and no email delivery in this phase.
 *
 * MONEY LAW (§2.3): integer minor units only; safe-integer arithmetic
 * everywhere; lineTotal = qty × unitPriceMinor; subtotal = Σ lineTotals;
 * total = subtotal − discount. Overflow is REJECTED, never rounded or
 * truncated. Client-submitted totals are never trusted.
 *
 * SNAPSHOT LAW (§12): customer/product identity is frozen at write time
 * from verified tenant-scoped rows; later renames never rewrite history;
 * corrupted/missing persisted snapshots surface as controlled integrity
 * errors, never silently substituted with live values.
 *
 * This module is pure: no Prisma, no db, no server-only imports. Safe for
 * client bundles. Cross-domain imports are the ESTABLISHED strict
 * calendar-date helpers only (re-exported — no second date utility).
 */
import { zonedWallClockToUtc } from "@/lib/crm/normalization";
import { nextCalendarDay } from "@/lib/statements/schema";
import { isValidCalendarDate } from "@/lib/inventory/goods-return/types";

/** §dates — the ONE canonical strict calendar-date law (re-exported). */
export { isValidCalendarDate };

/* ------------------------------ lifecycle ------------------------------ */

export const SALES_QUOTATION_STATUSES = [
  "DRAFT",
  "SENT",
  "ACCEPTED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
  "CONVERTED",
] as const;

export type SalesQuotationStatus = (typeof SALES_QUOTATION_STATUSES)[number];

export function isSalesQuotationStatus(value: string): value is SalesQuotationStatus {
  return (SALES_QUOTATION_STATUSES as readonly string[]).includes(value);
}

/* --------------------- persisted-status integrity ---------------------- */

export const SALES_QUOTATION_INVALID_PERSISTED_STATUS = "SALES_QUOTATION_INVALID_PERSISTED_STATUS";

/**
 * A corrupted persisted status (e.g. "BROKEN", "", "PAYED") is an
 * internal-data-integrity error, NOT a draft (§8/§22). A fabricated DRAFT
 * would expose line editing / lifecycle actions on an unknown document
 * state, so this pure error class is thrown instead and mapped to a
 * controlled 500 by the server layer. INVALID PERSISTED STATUS ≠ DRAFT.
 */
export class SalesQuotationStatusIntegrityError extends Error {
  readonly code = SALES_QUOTATION_INVALID_PERSISTED_STATUS;
  readonly value: string;
  constructor(value: unknown) {
    // Server-side diagnostic detail only — the HTTP body carries the stable
    // code and a fixed, value-free message (no internals leaked).
    super(`${SALES_QUOTATION_INVALID_PERSISTED_STATUS}: ${String(value ?? "")}`);
    this.name = "SalesQuotationStatusIntegrityError";
    this.value = typeof value === "string" ? value : String(value ?? "");
  }
}

/**
 * Parse a PERSISTED status value. Known → the exact valid status; unknown →
 * throws. There is deliberately NO `→ DRAFT` fallback anywhere (§8).
 */
export function parseSalesQuotationStatus(value: string): SalesQuotationStatus {
  if (isSalesQuotationStatus(value)) return value;
  throw new SalesQuotationStatusIntegrityError(value);
}

/* --------------------------- transition matrix -------------------------- */

/**
 * Allowed transitions (§8) — server-authoritative, EXHAUSTIVE. Every API
 * endpoint uses THIS canonical matrix; no route or UI duplicates it.
 *  - DRAFT → SENT (requires ≥1 line — service gate §10) | CANCELLED;
 *  - SENT → ACCEPTED | REJECTED (both require the validity window §9 —
 *    service gate) | CANCELLED | EXPIRED (EXPIRED additionally requires
 *    the offer to ACTUALLY be past validity — service gate §9);
 *  - ACCEPTED → CONVERTED (exactly once — DB unique constraint §7) |
 *    CANCELLED (documented cancel-before-conversion policy §8);
 *  - REJECTED/EXPIRED/CANCELLED/CONVERTED are terminal.
 */
export const SALES_QUOTATION_TRANSITIONS: Readonly<
  Record<SalesQuotationStatus, readonly SalesQuotationStatus[]>
> = {
  DRAFT: ["SENT", "CANCELLED"],
  SENT: ["ACCEPTED", "REJECTED", "CANCELLED", "EXPIRED"],
  ACCEPTED: ["CONVERTED", "CANCELLED"],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
  CONVERTED: [],
};

export function canTransitionSalesQuotation(
  from: SalesQuotationStatus,
  to: SalesQuotationStatus,
): boolean {
  return SALES_QUOTATION_TRANSITIONS[from].includes(to);
}

/** Header/lines may change only while DRAFT (§10/§11). */
export function salesQuotationEditable(status: SalesQuotationStatus): boolean {
  return status === "DRAFT";
}

/** SENT and every later state is a read-only document (§8). */
export function salesQuotationIsReadOnly(status: SalesQuotationStatus): boolean {
  return status !== "DRAFT";
}

/* --------------------------- quantity laws ----------------------------- */

/** qty: integer 1..1_000_000 whole units (§6 — mirrors the order law). */
export const QUOTATION_QTY_MIN = 1;
export const SALES_QUOTATION_QTY_MAX = 1_000_000;

/**
 * A valid quotation quantity is a SAFE integer 1..1_000_000 (§6/§11).
 * Number.isSafeInteger (not Number.isInteger alone): an unsafe integer has
 * already lost precision before any comparison runs.
 */
export function isValidQuotationQty(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= QUOTATION_QTY_MIN &&
    value <= SALES_QUOTATION_QTY_MAX
  );
}

/**
 * A PERSISTED quotation-line quantity (loaded from the database) must be a
 * safe integer in the valid domain — a stored 0/negative/fractional value
 * is corruption and is rejected at every row-materializing path (§11).
 */
export function isValidPersistedQuotationQty(value: unknown): boolean {
  return isValidQuotationQty(value);
}

/** unitPriceMinor: integer 0..9_000_000_000 (§6 — mirrors the order law). */
export const SALES_QUOTATION_PRICE_MAX = 9_000_000_000;

export function isValidQuotationPrice(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= SALES_QUOTATION_PRICE_MAX
  );
}

/* ------------------------------ line cap ------------------------------- */

export const SALES_QUOTATION_LINE_CAP_DEFAULT = 200;
export const SALES_QUOTATION_LINE_CAP_MIN = 20;
export const SALES_QUOTATION_LINE_CAP_MAX = 500;

/**
 * SALES_QUOTATION_MAX_LINES parsing (§11): default safely, fall back to
 * the default on malformed input, clamp below MIN and above MAX. Never
 * unbounded. (Same defensive parser style as P41–P45.)
 */
export function salesQuotationLineCap(env: string | undefined | null): number {
  const parsed = Number.parseInt(String(env ?? "").trim(), 10);
  if (!Number.isInteger(parsed)) return SALES_QUOTATION_LINE_CAP_DEFAULT;
  if (parsed < SALES_QUOTATION_LINE_CAP_MIN) return SALES_QUOTATION_LINE_CAP_MIN;
  if (parsed > SALES_QUOTATION_LINE_CAP_MAX) return SALES_QUOTATION_LINE_CAP_MAX;
  return parsed;
}

/* ------------------- read-cap invariant (integrity) -------------------- */

/**
 * Read-cap invariant (§11): a persisted quotation that contains MORE lines
 * than its own configured cap is database corruption. Read paths fetch
 * cap+1 rows to PROVE completeness; the +1 row (or a `_count` mismatch)
 * must fail the read with this stable code — never a silently
 * truncated/partial DTO or a partial total. Distinct from
 * SALES_QUOTATION_LINE_LIMIT_REACHED (422 write-time rejection): the
 * invariant is a 500 data-integrity failure.
 */
export const SALES_QUOTATION_LINE_CAP_INVARIANT = "SALES_QUOTATION_LINE_CAP_INVARIANT";

/* ------------------------- canonical quotation math --------------------- */

export const SALES_QUOTATION_CORRUPT_HISTORY = "SALES_QUOTATION_CORRUPT_HISTORY";
export const SALES_QUOTATION_TOTAL_OVERFLOW = "SALES_QUOTATION_TOTAL_OVERFLOW";

/**
 * Domain integrity error for corrupted persisted state (corrupt quantities,
 * missing snapshots, over-cap history). Server layers map this to the
 * controlled 500 with the stable code carried in the name.
 */
export class SalesQuotationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesQuotationIntegrityError";
  }
}

/**
 * Input-time total overflow: the CLIENT-visible rejection for a request
 * whose canonical math leaves the safe integer range (§11 — never
 * silently rounded). Persisted-data overflow is corruption and uses the
 * integrity error instead.
 */
export class SalesQuotationTotalOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SalesQuotationTotalOverflowError";
  }
}

/**
 * ONE canonical quotation-line total: qty × unitPriceMinor in exact
 * integer math (§11). Every operand is validated (safe integer, valid
 * domain); an unsafe product or sum throws — a computed total can never
 * silently lose precision. Input-time callers map
 * SalesQuotationTotalOverflowError to 422 SALES_QUOTATION_TOTAL_OVERFLOW;
 * persisted-data callers map it to the integrity 500.
 */
export function computeQuotationLineTotalMinor(
  qty: number,
  unitPriceMinor: number,
): number {
  if (!isValidPersistedQuotationQty(qty)) {
    throw new SalesQuotationIntegrityError(
      `${SALES_QUOTATION_CORRUPT_HISTORY}: qty ${String(qty)}`,
    );
  }
  if (!isValidQuotationPrice(unitPriceMinor)) {
    throw new SalesQuotationIntegrityError(
      `${SALES_QUOTATION_CORRUPT_HISTORY}: unitPriceMinor ${String(unitPriceMinor)}`,
    );
  }
  const total = qty * unitPriceMinor;
  if (!Number.isSafeInteger(total)) {
    throw new SalesQuotationTotalOverflowError(
      `${SALES_QUOTATION_TOTAL_OVERFLOW}: line total ${qty}×${unitPriceMinor}`,
    );
  }
  return total;
}

export type QuotationLineTotalsInput = ReadonlyArray<{
  qty: number;
  unitPriceMinor: number;
}>;

export type QuotationTotals = {
  lineTotalsMinor: number[];
  subtotalMinor: number;
};

/**
 * ONE canonical subtotal computation over a PROVEN-COMPLETE line set
 * (§11): every line total is exact; the accumulation re-checks the safe
 * integer range after EVERY addition (200 lines × maxima can exceed
 * Number.MAX_SAFE_INTEGER — silent overflow can never fabricate a total).
 */
export function computeQuotationSubtotalMinor(lines: QuotationLineTotalsInput): QuotationTotals {
  const lineTotalsMinor: number[] = [];
  let subtotalMinor = 0;
  for (const line of lines) {
    const lineTotal = computeQuotationLineTotalMinor(line.qty, line.unitPriceMinor);
    lineTotalsMinor.push(lineTotal);
    subtotalMinor += lineTotal;
    if (!Number.isSafeInteger(subtotalMinor)) {
      throw new SalesQuotationTotalOverflowError(
        `${SALES_QUOTATION_TOTAL_OVERFLOW}: subtotal exceeded the safe integer range`,
      );
    }
  }
  return { lineTotalsMinor, subtotalMinor };
}

/**
 * Discount law (§11): integer 0..subtotalMinor. No tax engine, no
 * shipping, no payment fields. Returns the value or throws the input-time
 * rejection (the caller maps it to 422 INVALID_DISCOUNT).
 */
export function validateQuotationDiscount(
  discountMinor: number,
  subtotalMinor: number,
): number {
  if (!Number.isSafeInteger(discountMinor) || discountMinor < 0) {
    throw new SalesQuotationTotalOverflowError(
      `${SALES_QUOTATION_TOTAL_OVERFLOW}: discount ${String(discountMinor)}`,
    );
  }
  if (discountMinor > subtotalMinor) {
    throw new SalesQuotationTotalOverflowError(
      `${SALES_QUOTATION_TOTAL_OVERFLOW}: discount ${discountMinor} exceeds subtotal ${subtotalMinor}`,
    );
  }
  return discountMinor;
}

/**
 * ONE canonical quotation total (§11): totalMinor = subtotalMinor −
 * discountMinor, exact integers only. Inputs must already be validated.
 */
export function computeQuotationTotalMinor(subtotalMinor: number, discountMinor: number): number {
  if (!Number.isSafeInteger(subtotalMinor) || subtotalMinor < 0) {
    throw new SalesQuotationIntegrityError(
      `${SALES_QUOTATION_CORRUPT_HISTORY}: subtotalMinor ${String(subtotalMinor)}`,
    );
  }
  if (!Number.isSafeInteger(discountMinor) || discountMinor < 0) {
    throw new SalesQuotationIntegrityError(
      `${SALES_QUOTATION_CORRUPT_HISTORY}: discountMinor ${String(discountMinor)}`,
    );
  }
  const total = subtotalMinor - discountMinor;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new SalesQuotationTotalOverflowError(
      `${SALES_QUOTATION_TOTAL_OVERFLOW}: total ${String(total)}`,
    );
  }
  return total;
}

/* ------------------- read-cap invariant (shared law) -------------------- */

/**
 * The ONE canonical list/detail line-set completeness validator (§11).
 * Three explicit invariants, ALL enforced:
 *   1. fetched rows > cap           → corruption (over-cap document);
 *   2. counted rows (_count) > cap  → corruption (over-cap document);
 *   3. counted ≠ fetched            → corruption EVEN WHEN both are below
 *      the cap — a subset total must never masquerade as complete.
 * (Same three-check law as the audited P44/P45 document modules.)
 */
export function assertSalesQuotationLineSetComplete(
  fetchedLines: number,
  countedLines: number,
  cap: number,
): void {
  if (fetchedLines > cap || countedLines > cap) {
    throw new SalesQuotationIntegrityError(
      `${SALES_QUOTATION_LINE_CAP_INVARIANT}: fetched ${fetchedLines} / counted ${countedLines} exceed cap ${cap}`,
    );
  }
  if (countedLines !== fetchedLines) {
    throw new SalesQuotationIntegrityError(
      `${SALES_QUOTATION_LINE_CAP_INVARIANT}: line count ${countedLines} != fetched rows ${fetchedLines}`,
    );
  }
}

/* ---------------------------- reference law ---------------------------- */

export const SALES_QUOTATION_REFERENCE_MIN = 2;
export const SALES_QUOTATION_REFERENCE_MAX = 80;
export const SALES_QUOTATION_CUSTOMER_NOTES_MAX = 2000;
export const SALES_QUOTATION_INTERNAL_NOTES_MAX = 2000;

/**
 * Reference normalization (§10): trim, reject control characters (NUL,
 * newlines, path-hostile control bytes), collapse pathological whitespace
 * runs to a single space, preserve Unicode. Returns null when nothing
 * usable remains (blank → caller generates).
 */
export function normalizeSalesQuotationReference(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null; // control chars rejected
  const collapsed = trimmed.replace(/\s+/g, " ");
  if (collapsed.length < SALES_QUOTATION_REFERENCE_MIN) return null;
  if (collapsed.length > SALES_QUOTATION_REFERENCE_MAX) return null;
  return collapsed;
}

/**
 * Server-generated reference when the user leaves it blank (§10):
 * QT-<YYYYMMDD>-<6 unambiguous base32 chars>, secure random — the
 * established SalesOrder generation pattern with a DISTINCT quotation
 * prefix (quotation references share NO sequence with orders §10).
 * Database uniqueness stays authoritative; NEVER a MAX(reference)+1
 * algorithm; client-generated uniqueness is never trusted.
 */
const GENERATION_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I/L/O/0/1

export function generateSalesQuotationReference(
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
  return `QT-${date}-${token}`;
}

/* --------------------------- date-window law --------------------------- */

/**
 * The business-timezone quotationDate day window for list filters.
 * COMPOSES the established repository helpers (zonedWallClockToUtc +
 * nextCalendarDay — the same statement/aging/P43–P45 law: no second date
 * utility): `from` is the INCLUSIVE local start of day, `to` is the
 * EXCLUSIVE local start of the NEXT day (never 23:59:59.999). Invalid
 * calendar dates (2026-02-31, 2026-13-01) are rejected — never rolled
 * over; null maps to a controlled 422 at the call site.
 */
export function salesQuotationDayWindow(
  from: string | undefined,
  to: string | undefined,
  timezone: string | undefined | null,
): { gte?: Date; lt?: Date } | null {
  if (!from && !to) return {};
  if (from && !isValidCalendarDate(from)) return null;
  if (to && !isValidCalendarDate(to)) return null;
  // The ESTABLISHED helper falls back to UTC for an unknown IANA zone
  // (never throws, never invents an offset) — the same documented behavior
  // the statements/aging/P43–P45 windows rely on.
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

/* ------------------------- validity / expiration ------------------------ */

/**
 * The current business-local calendar date (YYYY-MM-DD) for an instant.
 * Uses the ESTABLISHED Intl en-CA formatting law (the same pattern the CRM
 * work queue and reports use) — no new timezone library, no browser clock
 * authority (the caller passes the server's `now`). Unknown IANA zones
 * degrade to UTC exactly like zonedWallClockToUtc (documented behavior).
 */
export function businessLocalCalendarDate(now: Date, timezone: string | undefined | null): string {
  let tz = timezone;
  if (tz) {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    } catch {
      tz = "UTC";
    }
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * The ONE canonical expiration predicate (§9): a quotation is expired when
 * the current business-local calendar date is AFTER validUntilDate
 * (inclusive-until law). Both instants are rendered in the AUTHENTICATED
 * business timezone (never the browser clock, never a client timezone).
 */
export function isQuotationExpiredInBusinessTz(
  validUntilDate: Date,
  now: Date,
  timezone: string | undefined | null,
): boolean {
  const today = businessLocalCalendarDate(now, timezone);
  const until = businessLocalCalendarDate(validUntilDate, timezone);
  return today > until;
}

/** Effective-status law (§9): persisted SENT + past validity → EXPIRED. */
export function effectiveQuotationStatus(
  persisted: SalesQuotationStatus,
  validUntilDate: Date,
  now: Date,
  timezone: string | undefined | null,
): SalesQuotationStatus {
  if (persisted === "SENT" && isQuotationExpiredInBusinessTz(validUntilDate, now, timezone)) {
    return "EXPIRED";
  }
  // ACCEPTED never becomes expired merely because the validity date later
  // passes — acceptance is already recorded (§9).
  return persisted;
}

/** The stored midnoon-UTC instant → its business-local calendar date. */
export function midnoonDateToCalendarDate(date: Date): string {
  // Calendar dates are stored at 12:00:00.000Z (the established UTC-midnoon
  // rule) — the ISO slice is that stored calendar date by construction.
  return date.toISOString().slice(0, 10);
}

/**
 * Validity ordering law (§9): validUntilDate must not be earlier than
 * quotationDate (strict calendar-date strings).
 */
export function isQuotationDateRangeValid(
  quotationDate: string,
  validUntilDate: string,
): boolean {
  if (!isValidCalendarDate(quotationDate) || !isValidCalendarDate(validUntilDate)) {
    return false;
  }
  return validUntilDate >= quotationDate;
}

/* -------------------------------- errors -------------------------------- */

/**
 * The centralized error vocabulary (§22). Routes never duplicate string
 * literals — every code is referenced from this table.
 */
export const SALES_QUOTATION_ERROR_CODES = {
  NOT_FOUND: "SALES_QUOTATION_NOT_FOUND",
  DUPLICATE_REFERENCE: "SALES_QUOTATION_DUPLICATE_REFERENCE",
  INVALID_STATUS: "SALES_QUOTATION_INVALID_STATUS",
  INVALID_PERSISTED_STATUS: SALES_QUOTATION_INVALID_PERSISTED_STATUS,
  INVALID_TRANSITION: "SALES_QUOTATION_INVALID_TRANSITION",
  EMPTY: "SALES_QUOTATION_EMPTY",
  LINE_LIMIT: "SALES_QUOTATION_LINE_LIMIT_REACHED",
  LINE_CAP_INVARIANT: SALES_QUOTATION_LINE_CAP_INVARIANT,
  DUPLICATE_PRODUCT: "SALES_QUOTATION_DUPLICATE_PRODUCT",
  EXPIRED: "SALES_QUOTATION_EXPIRED",
  NOT_EXPIRED: "SALES_QUOTATION_NOT_EXPIRED",
  INVALID_DATE_RANGE: "SALES_QUOTATION_INVALID_DATE_RANGE",
  TOTAL_OVERFLOW: SALES_QUOTATION_TOTAL_OVERFLOW,
  IMMUTABLE: "SALES_QUOTATION_IMMUTABLE",
  ALREADY_CONVERTED: "SALES_QUOTATION_ALREADY_CONVERTED",
  NOT_ACCEPTED: "SALES_QUOTATION_NOT_ACCEPTED",
  CORRUPT_HISTORY: SALES_QUOTATION_CORRUPT_HISTORY,
  FOREIGN_ENTITY: "SALES_QUOTATION_FOREIGN_ENTITY",
  CUSTOMER_NOT_FOUND: "SALES_QUOTATION_CUSTOMER_NOT_FOUND",
  PRODUCT_NOT_FOUND: "SALES_QUOTATION_PRODUCT_NOT_FOUND",
  LINE_NOT_FOUND: "SALES_QUOTATION_LINE_NOT_FOUND",
  INVALID_DISCOUNT: "INVALID_DISCOUNT",
} as const;
