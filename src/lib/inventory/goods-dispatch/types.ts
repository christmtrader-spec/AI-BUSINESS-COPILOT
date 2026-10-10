/**
 * Prompt 44 — Goods Dispatch domain types + pure laws (client-safe).
 *
 * SCOPE LAW: a goods dispatch is a PHYSICAL INVENTORY OUTFLOW — "the
 * business has physically sent these quantities of products out of stock"
 * (to a customer, a branch, a sample recipient…). It is NOT an invoice,
 * NOT a sale record, NOT a payment, NOT a receivable, NOT an accounting
 * entry. A dispatch document contains NO MONEY at all. Posting DECREASES
 * Product.stockQty and writes ONE negative InventoryAdjustment per line;
 * drafts and cancellations mutate NOTHING but the dispatch document.
 *
 * HIERARCHY LAW: PRODUCT STOCK → GOODS DISPATCH → INVENTORY ADJUSTMENT
 * HISTORY. Unlike P43 returns (anchored to a POSTED receipt), an outbound
 * dispatch is NOT chained to a purchase-order document — the PRODUCT and
 * its CURRENT aggregate stock are the quantity authority at POST time
 * (no lot/batch provenance exists in this application — the same
 * documented aggregate-stock trade-off as P40/P42/P43).
 *
 * HARDENING LAWS (inherited verbatim from the audited P43 finalization):
 *  - safe-integer arithmetic everywhere (unsafe integers can never be
 *    authoritative quantities);
 *  - every PERSISTED line quantity is safe-integer ≥ 1 — a stored zero is
 *    corruption and is rejected at every row-materializing path;
 *  - the list/detail line-set completeness invariant is three explicit
 *    checks (fetched ≤ cap, counted ≤ cap, counted === fetched) — a
 *    count mismatch below the cap NEVER passes;
 *  - write-time cap rejection (lineCount === cap) is a 422 user error;
 *    an ALREADY-corrupted over-cap document is a 500 integrity failure;
 *  - date filters interpret from/to in the AUTHENTICATED business
 *    timezone via the ESTABLISHED helpers (no second date utility);
 *  - unknown persisted statuses / reason codes are NEVER silently mapped.
 *
 * This module is pure: no Prisma, no db, no server-only imports. Safe for
 * client bundles. The only cross-domain import is the ESTABLISHED strict
 * calendar-date validator (re-exported — no third copy anywhere).
 */
import { zonedWallClockToUtc } from "@/lib/crm/normalization";
import { nextCalendarDay } from "@/lib/statements/schema";
import { isValidCalendarDate } from "@/lib/inventory/goods-return/types";

/** §dates — the ONE canonical strict calendar-date law (re-exported). */
export { isValidCalendarDate };

/* ------------------------------ lifecycle ------------------------------ */

export const GOODS_DISPATCH_STATUSES = ["DRAFT", "POSTED", "CANCELLED"] as const;

export type GoodsDispatchStatus = (typeof GOODS_DISPATCH_STATUSES)[number];

export function isGoodsDispatchStatus(value: string): value is GoodsDispatchStatus {
  return (GOODS_DISPATCH_STATUSES as readonly string[]).includes(value);
}

/* --------------------- persisted-status integrity ---------------------- */

export const GOODS_DISPATCH_INVALID_PERSISTED_STATUS = "GOODS_DISPATCH_INVALID_PERSISTED_STATUS";

/**
 * A corrupted persisted status (e.g. "BROKEN", "INVALID", "") is an
 * internal-data-integrity error, NOT a draft. A fabricated DRAFT would
 * expose add-line/post/cancel behavior on an unknown document state, so
 * this pure error class is thrown instead and mapped to a controlled 500
 * by the server layer. INVALID PERSISTED STATUS ≠ DRAFT.
 */
export class GoodsDispatchStatusIntegrityError extends Error {
  readonly code = GOODS_DISPATCH_INVALID_PERSISTED_STATUS;
  readonly value: string;
  constructor(value: unknown) {
    // Server-side diagnostic detail only — the HTTP body carries the stable
    // code and a fixed, value-free message (no internals leaked).
    super(`${GOODS_DISPATCH_INVALID_PERSISTED_STATUS}: ${String(value ?? "")}`);
    this.name = "GoodsDispatchStatusIntegrityError";
    this.value = typeof value === "string" ? value : String(value ?? "");
  }
}

/**
 * Parse a PERSISTED status value. Known → the exact valid status; unknown →
 * throws. There is deliberately NO `→ DRAFT` fallback anywhere in the domain.
 */
export function parseGoodsDispatchStatus(value: string): GoodsDispatchStatus {
  if (isGoodsDispatchStatus(value)) return value;
  throw new GoodsDispatchStatusIntegrityError(value);
}

/* --------------------------- transition matrix -------------------------- */

/**
 * Allowed transitions — server-authoritative. DRAFT may post or cancel;
 * POSTED is immutable (no POSTED → CANCELLED, no reversal — corrections
 * happen through new documents / authorized adjustments); CANCELLED is
 * terminal.
 */
export const GOODS_DISPATCH_TRANSITIONS: Readonly<
  Record<GoodsDispatchStatus, readonly GoodsDispatchStatus[]>
> = {
  DRAFT: ["POSTED", "CANCELLED"],
  POSTED: [],
  CANCELLED: [],
};

export function canTransitionGoodsDispatch(
  from: GoodsDispatchStatus,
  to: GoodsDispatchStatus,
): boolean {
  return GOODS_DISPATCH_TRANSITIONS[from].includes(to);
}

/* ---------------------------- quantity laws ----------------------------- */

/** qty: integer 1..1_000_000 whole units. */
export const DISPATCH_QTY_MIN = 1;
export const GOODS_DISPATCH_QTY_MAX = 1_000_000;

/**
 * A valid dispatch quantity is a SAFE integer 1..1_000_000.
 * Number.isSafeInteger (not Number.isInteger alone): an unsafe integer has
 * already lost precision before any comparison runs, so it can never be
 * trusted as an authoritative quantity.
 */
export function isValidDispatchQty(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= DISPATCH_QTY_MIN &&
    value <= GOODS_DISPATCH_QTY_MAX
  );
}

/**
 * A PERSISTED dispatch quantity (loaded from the database) must be a safe
 * integer in the valid domain. Shared by every path that loads actual rows
 * (post, detail DTO, list DTO, export, history widgets) — a stored zero is
 * INVALID persisted state and is rejected everywhere.
 */
export function isValidPersistedDispatchQty(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= DISPATCH_QTY_MIN &&
    value <= GOODS_DISPATCH_QTY_MAX
  );
}

/** Safe non-negative integer guard for derived/persisted quantities. */
function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/* ------------------------------ line cap ------------------------------- */

export const GOODS_DISPATCH_LINE_CAP_DEFAULT = 200;
export const GOODS_DISPATCH_LINE_CAP_MIN = 20;
export const GOODS_DISPATCH_LINE_CAP_MAX = 500;

/**
 * GOODS_DISPATCH_MAX_LINES parsing: default safely, fall back to the
 * default on malformed input, clamp below MIN and above MAX. Never
 * unbounded. (Same defensive parser style as GOODS_RETURN_MAX_LINES.)
 */
export function goodsDispatchLineCap(env: string | undefined | null): number {
  const parsed = Number.parseInt(String(env ?? "").trim(), 10);
  if (!Number.isInteger(parsed)) return GOODS_DISPATCH_LINE_CAP_DEFAULT;
  if (parsed < GOODS_DISPATCH_LINE_CAP_MIN) return GOODS_DISPATCH_LINE_CAP_MIN;
  if (parsed > GOODS_DISPATCH_LINE_CAP_MAX) return GOODS_DISPATCH_LINE_CAP_MAX;
  return parsed;
}

/* ---------------------------- reason codes ----------------------------- */

/** Closed dispatch-reason vocabulary. Localized in the UI layer. */
export const GOODS_DISPATCH_REASON_CODES = [
  "SALE",
  "GIFT_SAMPLE",
  "TRANSFER_OUT",
  "OTHER",
] as const;

export type GoodsDispatchReasonCode = (typeof GOODS_DISPATCH_REASON_CODES)[number];

export function isGoodsDispatchReasonCode(value: string): value is GoodsDispatchReasonCode {
  return (GOODS_DISPATCH_REASON_CODES as readonly string[]).includes(value);
}

/* ------------------- read-cap invariant (integrity) -------------------- */

/**
 * Read-cap invariant: a persisted document that contains MORE lines than
 * its own configured cap is database corruption. Read paths fetch cap+1
 * rows to PROVE completeness; the +1 row (or a `_count` mismatch) must
 * fail the read with this stable code — never a silently truncated/partial
 * DTO. Distinct from GOODS_DISPATCH_LINE_LIMIT_REACHED (422 write-time
 * rejection): the invariant is a 500 data-integrity failure.
 */
export const GOODS_DISPATCH_LINE_CAP_INVARIANT = "GOODS_DISPATCH_LINE_CAP_INVARIANT";

/* ------------------------ canonical dispatch math ---------------------- */

export const GOODS_DISPATCH_CORRUPT_HISTORY = "GOODS_DISPATCH_CORRUPT_HISTORY";

export class GoodsDispatchIntegrityError extends Error {
  readonly code = GOODS_DISPATCH_CORRUPT_HISTORY;
  constructor(message: string) {
    super(message);
    this.name = "GoodsDispatchIntegrityError";
  }
}

/**
 * ONE canonical dispatched-quantity sum. Exact integer arithmetic only
 * (no floats, no Math.round, no clamping). EVERY input is a PERSISTED
 * GoodsDispatchLine quantity, and every valid persisted line has qty >= 1
 * — a stored zero is INVALID persisted state and is rejected here: an
 * empty collection still totals exactly 0 where the call contract permits
 * emptiness, but a zero SUMMAND is never legitimate. Each addition (and
 * the total) must remain a safe integer — silent precision loss can never
 * fabricate a total.
 */
export function computeDispatchedQty(persistedQuantities: ReadonlyArray<number>): number {
  let total = 0;
  for (const qty of persistedQuantities) {
    if (!isValidPersistedDispatchQty(qty)) {
      throw new GoodsDispatchIntegrityError(
        `${GOODS_DISPATCH_CORRUPT_HISTORY}: invalid persisted quantity ${String(qty)}`,
      );
    }
    total += qty;
    if (!Number.isSafeInteger(total)) {
      throw new GoodsDispatchIntegrityError(
        `${GOODS_DISPATCH_CORRUPT_HISTORY}: dispatched total exceeded the safe integer range`,
      );
    }
  }
  return total;
}

/**
 * The ONE canonical list/detail line-set completeness validator. Three
 * explicit invariants, ALL enforced:
 *   1. fetched rows > cap           → corruption (over-cap document);
 *   2. counted rows (_count) > cap  → corruption (over-cap document);
 *   3. counted ≠ fetched            → corruption EVEN WHEN both are below
 *      the cap — a subset total must never masquerade as complete.
 * (The mismatch arm exists because a `max(fetched, counted) > cap` gate
 * silently accepts e.g. fetched=1 / counted=2 below the cap.)
 */
export function assertGoodsDispatchLineSetComplete(
  fetchedLines: number,
  countedLines: number,
  cap: number,
): void {
  if (fetchedLines > cap || countedLines > cap) {
    throw new GoodsDispatchIntegrityError(
      `${GOODS_DISPATCH_LINE_CAP_INVARIANT}: fetched ${fetchedLines} / counted ${countedLines} exceed cap ${cap}`,
    );
  }
  if (countedLines !== fetchedLines) {
    throw new GoodsDispatchIntegrityError(
      `${GOODS_DISPATCH_LINE_CAP_INVARIANT}: line count ${countedLines} != fetched rows ${fetchedLines}`,
    );
  }
}

/**
 * Availability precondition helper for ONE dispatch line: currentStock is
 * a safe non-negative integer and newQty is a valid dispatch quantity.
 * Returns true when newQty exceeds the current stock. The authoritative
 * gate runs inside the post transaction; this pure helper is the ONE
 * comparison implementation shared by the advisory (draft-time) check and
 * the post-time final check.
 */
export function exceedsAvailableStock(currentStock: number, newQty: number): boolean {
  if (!isSafeNonNegativeInteger(currentStock)) {
    throw new GoodsDispatchIntegrityError(
      `${GOODS_DISPATCH_CORRUPT_HISTORY}: currentStock ${String(currentStock)}`,
    );
  }
  if (!isValidDispatchQty(newQty)) {
    throw new GoodsDispatchIntegrityError(
      `${GOODS_DISPATCH_CORRUPT_HISTORY}: newQty ${String(newQty)}`,
    );
  }
  return newQty > currentStock;
}

/* ----------------------- stock arithmetic laws ------------------------- */

/**
 * Exact integer stock decrement. Verifies every input BEFORE the mutation:
 * current stock integer ≥ 0, qty integer ≥ 1, newStock ≥ 0 (no negative
 * stock, no override, no silent zero-clamp). Returns the new stock or
 * throws the stable code. Classification is precise: an invalid CURRENT
 * STOCK reading is stock corruption; an invalid DISPATCH quantity is
 * dispatch-document corruption (CORRUPT_HISTORY).
 */
export const GOODS_DISPATCH_INVALID_PERSISTED_STOCK = "GOODS_DISPATCH_INVALID_PERSISTED_STOCK";

export function stockAfterDispatch(currentStock: number, dispatchedQty: number): number {
  if (!Number.isSafeInteger(currentStock) || currentStock < 0) {
    // Already-negative or unsafe persisted STOCK is stock corruption:
    // controlled integrity failure, NEVER silently set to zero.
    throw new GoodsDispatchIntegrityError(
      `${GOODS_DISPATCH_INVALID_PERSISTED_STOCK}: currentStock ${String(currentStock)}`,
    );
  }
  if (!isValidPersistedDispatchQty(dispatchedQty)) {
    // An invalid DISPATCH quantity is DISPATCH-DOCUMENT corruption
    // (CORRUPT_HISTORY), not stock corruption: the most accurate stable
    // classification, even though both errors share this helper.
    throw new GoodsDispatchIntegrityError(
      `${GOODS_DISPATCH_CORRUPT_HISTORY}: dispatchedQty ${String(dispatchedQty)}`,
    );
  }
  const newStock = currentStock - dispatchedQty; // exact integer math
  if (!Number.isSafeInteger(newStock) || newStock < 0) {
    throw new GoodsDispatchIntegrityError(
      `${GOODS_DISPATCH_INVALID_PERSISTED_STOCK}: newStock ${newStock} < 0`,
    );
  }
  return newStock;
}

/**
 * The business-timezone createdAt day window for list filters. COMPOSES
 * the established repository helpers (zonedWallClockToUtc +
 * nextCalendarDay — the same statement/aging/P43 law: no second date
 * utility): `from` is the INCLUSIVE local start of day, `to` is the
 * EXCLUSIVE local start of the NEXT day (never 23:59:59.999). Invalid
 * calendar dates (2026-02-31, 2026-13-01) are rejected — never rolled
 * over; null maps to a controlled 422 at the call site. A record at
 * 00:15 local time belongs to its LOCAL calendar date even when its UTC
 * date is the previous day.
 */
export function goodsDispatchDayWindow(
  from: string | undefined,
  to: string | undefined,
  timezone: string | undefined | null,
): { gte?: Date; lt?: Date } | null {
  if (!from && !to) return {};
  // Strict calendar validation here too (the zod boundary rejects first;
  // this is defense in depth — JS Date would silently roll an invalid
  // date over into the next month).
  if (from && !isValidCalendarDate(from)) return null;
  if (to && !isValidCalendarDate(to)) return null;
  // The ESTABLISHED helper falls back to UTC for an unknown IANA zone
  // (never throws, never invents an offset) — the same documented behavior
  // the statements/aging/P43 windows rely on.
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

/* ---------------------------- reference law ---------------------------- */

export const GOODS_DISPATCH_REFERENCE_MIN = 2;
export const GOODS_DISPATCH_REFERENCE_MAX = 80;
export const GOODS_DISPATCH_NOTES_MAX = 2000;

/**
 * Reference normalization: trim, reject control characters (NUL, newlines,
 * path-hostile control bytes), collapse pathological whitespace runs to a
 * single space, preserve Unicode. Returns null when nothing usable remains
 * (blank → caller generates).
 */
export function normalizeGoodsDispatchReference(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null; // control chars rejected
  const collapsed = trimmed.replace(/\s+/g, " ");
  if (collapsed.length < GOODS_DISPATCH_REFERENCE_MIN) return null;
  if (collapsed.length > GOODS_DISPATCH_REFERENCE_MAX) return null;
  return collapsed;
}

/**
 * Server-generated reference when the user leaves it blank:
 * DSP-<YYYYMMDD>-<6 unambiguous base32 chars>, secure random. Database
 * uniqueness stays authoritative; NEVER a MAX(reference)+1 algorithm;
 * client-generated uniqueness is never trusted.
 */
const GENERATION_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I/L/O/0/1

export function generateGoodsDispatchReference(
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
  return `DSP-${date}-${token}`;
}

/* -------------------------------- errors -------------------------------- */

export const GOODS_DISPATCH_ERROR_CODES = {
  DUPLICATE_REFERENCE: "GOODS_DISPATCH_DUPLICATE_REFERENCE",
  DUPLICATE_LINE: "GOODS_DISPATCH_DUPLICATE_LINE",
  EMPTY: "GOODS_DISPATCH_EMPTY",
  LINE_LIMIT: "GOODS_DISPATCH_LINE_LIMIT_REACHED",
  INSUFFICIENT_STOCK: "GOODS_DISPATCH_INSUFFICIENT_STOCK",
  INVALID_TRANSITION: "GOODS_DISPATCH_INVALID_TRANSITION",
  INVALID_PERSISTED_STATUS: GOODS_DISPATCH_INVALID_PERSISTED_STATUS,
  INVALID_PERSISTED_STOCK: GOODS_DISPATCH_INVALID_PERSISTED_STOCK,
  IMMUTABLE: "GOODS_DISPATCH_IMMUTABLE",
  PRODUCT_NOT_FOUND: "GOODS_DISPATCH_PRODUCT_NOT_FOUND",
  CUSTOMER_NOT_FOUND: "GOODS_DISPATCH_CUSTOMER_NOT_FOUND",
  LINE_NOT_FOUND: "GOODS_DISPATCH_LINE_NOT_FOUND",
  CORRUPT_HISTORY: GOODS_DISPATCH_CORRUPT_HISTORY,
  LINE_CAP_INVARIANT: GOODS_DISPATCH_LINE_CAP_INVARIANT,
} as const;

/* ---------------------------- lifecycle gates --------------------------- */

/** Lines may be added/edited/removed only while DRAFT. */
export function goodsDispatchLinesEditable(status: GoodsDispatchStatus): boolean {
  return status === "DRAFT";
}

/** POSTED and CANCELLED are read-only. */
export function goodsDispatchIsReadOnly(status: GoodsDispatchStatus): boolean {
  return status !== "DRAFT";
}
