/**
 * Prompt 43 — Goods Return domain types + pure laws (client-safe, §136/§138).
 *
 * SCOPE LAW (§4/§7): a goods return is a PHYSICAL INVENTORY OUTFLOW —
 * "the business has physically returned these quantities of products to the
 * supplier, sourced from one previously POSTED goods receipt". It is NOT a
 * credit note, NOT an expense, NOT a payment, NOT a refund, NOT a supplier
 * balance adjustment, NOT an accounting entry. A return document contains
 * NO MONEY at all.
 *
 * HIERARCHY LAW (§5): PURCHASE ORDER → GOODS RECEIPT → GOODS RETURN →
 * PRODUCT STOCK → INVENTORY ADJUSTMENT HISTORY. The source receipt stays
 * the immutable gross-quantity authority (§8/§34); returned quantities live
 * ONLY in GoodsReturnLine (§126/§130 — no receipt rewrite, no new receipt
 * or PO status).
 *
 * NET RECEIVING LAW (§77-§82): for every PO line
 *   grossReceivedQty = SUM(POSTED GoodsReceiptLine.receivedQty)
 *   returnedQty      = SUM(POSTED GoodsReturnLine.returnedQty)
 *   netReceivedQty   = grossReceivedQty − returnedQty
 *   remainingQty     = orderedQty − netReceivedQty
 * and the over-receipt law becomes netReceivedQty + newReceivedQty ≤
 * orderedQty. The ONE canonical implementation of each quantity lives here
 * — API, UI and export never re-implement them differently (§138).
 *
 * This module is pure: no Prisma, no db, no server-only imports. Safe for
 * client bundles (same server-only boundary law as P40/P41/P42). The only
 * cross-domain import is the ESTABLISHED business-timezone instant helper
 * (§23 — no second date utility is created anywhere in P43).
 */
import { zonedWallClockToUtc } from "@/lib/crm/normalization";
import { nextCalendarDay } from "@/lib/statements/schema";

/* ------------------------------ §9 lifecycle ------------------------------ */

export const GOODS_RETURN_STATUSES = ["DRAFT", "POSTED", "CANCELLED"] as const;

export type GoodsReturnStatus = (typeof GOODS_RETURN_STATUSES)[number];

export function isGoodsReturnStatus(value: string): value is GoodsReturnStatus {
  return (GOODS_RETURN_STATUSES as readonly string[]).includes(value);
}

/* -------------------- §65 persisted-status integrity ---------------------- */

export const GOODS_RETURN_INVALID_PERSISTED_STATUS = "GOODS_RETURN_INVALID_PERSISTED_STATUS";

/**
 * §65 — a corrupted persisted status (e.g. "BROKEN", "INVALID", "") is an
 * internal-data-integrity error, NOT a draft. A fabricated DRAFT would
 * expose add-line/post/cancel behavior on an unknown document state, so
 * this pure error class is thrown instead and mapped to a controlled 500
 * by the server layer. INVALID PERSISTED STATUS ≠ DRAFT.
 */
export class GoodsReturnStatusIntegrityError extends Error {
  readonly code = GOODS_RETURN_INVALID_PERSISTED_STATUS;
  readonly value: string;
  constructor(value: unknown) {
    // Server-side diagnostic detail only — the HTTP body carries the stable
    // code and a fixed, value-free message (§143 — no internals leaked).
    super(`${GOODS_RETURN_INVALID_PERSISTED_STATUS}: ${String(value ?? "")}`);
    this.name = "GoodsReturnStatusIntegrityError";
    this.value = typeof value === "string" ? value : String(value ?? "");
  }
}

/**
 * §65 — parse a PERSISTED status value. Known → the exact valid status;
 * unknown → throws. There is deliberately NO `→ DRAFT` fallback anywhere
 * in the domain.
 */
export function parseGoodsReturnStatus(value: string): GoodsReturnStatus {
  if (isGoodsReturnStatus(value)) return value;
  throw new GoodsReturnStatusIntegrityError(value);
}

/* --------------------------- §9 transition matrix -------------------------- */

/**
 * Allowed transitions (§9) — server-authoritative. DRAFT may post or
 * cancel; POSTED is immutable (§11 — no POSTED → CANCELLED, no reversal);
 * CANCELLED is terminal (§12).
 */
export const GOODS_RETURN_TRANSITIONS: Readonly<
  Record<GoodsReturnStatus, readonly GoodsReturnStatus[]>
> = {
  DRAFT: ["POSTED", "CANCELLED"],
  POSTED: [],
  CANCELLED: [],
};

export function canTransitionGoodsReturn(
  from: GoodsReturnStatus,
  to: GoodsReturnStatus,
): boolean {
  return GOODS_RETURN_TRANSITIONS[from].includes(to);
}

/* ------------------------- §32 quantity laws ------------------------------- */

/** §32 — returnedQty: integer 1..1_000_000 whole units. */
export const RETURNED_QTY_MIN = 1;
export const GOODS_RETURN_QTY_MAX = 1_000_000;

/**
 * §6 — a valid returned quantity is a SAFE integer 1..1_000_000.
 * Number.isSafeInteger (not Number.isInteger alone): an unsafe integer has
 * already lost precision before any comparison runs, so it can never be
 * trusted as an authoritative quantity.
 */
export function isValidReturnedQty(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= RETURNED_QTY_MIN &&
    value <= GOODS_RETURN_QTY_MAX
  );
}

/**
 * §6/§8 — a PERSISTED returned quantity (loaded from the database) must be
 * a safe integer in the valid domain. Shared by every path that loads
 * actual rows (post, detail DTO, list DTO, export, history widgets).
 */
export function isValidPersistedReturnedQty(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= RETURNED_QTY_MIN &&
    value <= GOODS_RETURN_QTY_MAX
  );
}

/** §6 — safe non-negative integer guard for derived/persisted quantities. */
function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/* ------------------------------- §33 line cap ------------------------------ */

export const GOODS_RETURN_LINE_CAP_DEFAULT = 200;
export const GOODS_RETURN_LINE_CAP_MIN = 20;
export const GOODS_RETURN_LINE_CAP_MAX = 500;

/**
 * §33 — GOODS_RETURN_MAX_LINES parsing: default safely, fall back to the
 * default on malformed input, clamp below MIN and above MAX. Never
 * unbounded. (Same defensive parser style as GOODS_RECEIPT_MAX_LINES.)
 */
export function goodsReturnLineCap(env: string | undefined | null): number {
  const parsed = Number.parseInt(String(env ?? "").trim(), 10);
  if (!Number.isInteger(parsed)) return GOODS_RETURN_LINE_CAP_DEFAULT;
  if (parsed < GOODS_RETURN_LINE_CAP_MIN) return GOODS_RETURN_LINE_CAP_MIN;
  if (parsed > GOODS_RETURN_LINE_CAP_MAX) return GOODS_RETURN_LINE_CAP_MAX;
  return parsed;
}

/* ---------------------------- §23 reason codes ----------------------------- */

/** §23 — closed return-reason vocabulary. Localized in the UI layer. */
export const GOODS_RETURN_REASON_CODES = [
  "DAMAGED",
  "WRONG_ITEM",
  "QUALITY_ISSUE",
  "EXCESS",
  "OTHER",
] as const;

export type GoodsReturnReasonCode = (typeof GOODS_RETURN_REASON_CODES)[number];

export function isGoodsReturnReasonCode(value: string): value is GoodsReturnReasonCode {
  return (GOODS_RETURN_REASON_CODES as readonly string[]).includes(value);
}

/* ------------------- §76/§140 read-cap invariant (integrity) ---------------- */

/**
 * §76/§140 — read-cap invariant: a persisted document that contains MORE
 * lines than its own configured cap is database corruption. Read paths
 * fetch cap+1 rows to PROVE completeness; the +1 row (or a `_count`
 * mismatch) must fail the read with this stable code — never a silently
 * truncated/partial DTO. Distinct from GOODS_RETURN_LINE_LIMIT_REACHED
 * (422 write-time rejection): the invariant is a 500 data-integrity failure.
 */
export const GOODS_RETURN_LINE_CAP_INVARIANT = "GOODS_RETURN_LINE_CAP_INVARIANT";

/* ------------------- §36/§37/§38 canonical return math --------------------- */

export const GOODS_RETURN_CORRUPT_HISTORY = "GOODS_RETURN_CORRUPT_HISTORY";

export class GoodsReturnIntegrityError extends Error {
  readonly code = GOODS_RETURN_CORRUPT_HISTORY;
  constructor(message: string) {
    super(message);
    this.name = "GoodsReturnIntegrityError";
  }
}

/**
 * §37/§38 — ONE canonical returned-quantity sum. Exact integer arithmetic
 * only (no floats, no Math.round, no clamping). EVERY input is a PERSISTED
 * GoodsReturnLine quantity, and every valid persisted line has
 * returnedQty >= 1 — a stored zero is INVALID persisted state and is
 * rejected here (§7): an empty collection still totals exactly 0 where the
 * call contract permits emptiness, but a zero SUMMAND is never legitimate.
 * Each addition (and the total) must remain a safe integer — silent
 * precision loss can never fabricate a total (§7).
 */
export function computeReturnedQty(postedQuantities: ReadonlyArray<number>): number {
  let total = 0;
  for (const qty of postedQuantities) {
    if (!isValidPersistedReturnedQty(qty)) {
      throw new GoodsReturnIntegrityError(
        `${GOODS_RETURN_CORRUPT_HISTORY}: invalid returned quantity ${String(qty)}`,
      );
    }
    total += qty;
    if (!Number.isSafeInteger(total)) {
      throw new GoodsReturnIntegrityError(
        `${GOODS_RETURN_CORRUPT_HISTORY}: returned total exceeded the safe integer range`,
      );
    }
  }
  return total;
}

/**
 * §15/§16 — the ONE canonical list/detail line-set completeness validator.
 * Three explicit invariants, ALL enforced:
 *   1. fetched rows > cap           → corruption (over-cap document);
 *   2. counted rows (_count) > cap  → corruption (over-cap document);
 *   3. counted ≠ fetched            → corruption EVEN WHEN both are below
 *      the cap — a subset total must never masquerade as complete.
 * The mismatch arm exists because the old `max(fetched, counted) > cap`
 * gate silently accepted e.g. fetched=1 / counted=2 below the cap.
 */
export function assertGoodsReturnLineSetComplete(
  fetchedLines: number,
  countedLines: number,
  cap: number,
): void {
  if (fetchedLines > cap || countedLines > cap) {
    throw new GoodsReturnIntegrityError(
      `${GOODS_RETURN_LINE_CAP_INVARIANT}: fetched ${fetchedLines} / counted ${countedLines} exceed cap ${cap}`,
    );
  }
  if (countedLines !== fetchedLines) {
    throw new GoodsReturnIntegrityError(
      `${GOODS_RETURN_LINE_CAP_INVARIANT}: line count ${countedLines} != fetched rows ${fetchedLines}`,
    );
  }
}

/**
 * §36 — returnable = received − returned; an exact non-negative integer.
 * returned > received is data-integrity corruption (§36/§38) — NEVER
 * clamped to zero. Negative/fractional inputs are corruption too.
 */
export function computeReturnableQty(receivedQty: number, returnedQty: number): number {
  // §6/§8 — every operand must be a SAFE integer; unsafe integers have
  // already lost precision and can never be authoritative quantities.
  if (!Number.isSafeInteger(receivedQty) || receivedQty < 0) {
    throw new GoodsReturnIntegrityError(
      `${GOODS_RETURN_CORRUPT_HISTORY}: receivedQty ${String(receivedQty)}`,
    );
  }
  if (!Number.isSafeInteger(returnedQty) || returnedQty < 0) {
    throw new GoodsReturnIntegrityError(
      `${GOODS_RETURN_CORRUPT_HISTORY}: returnedQty ${String(returnedQty)}`,
    );
  }
  if (returnedQty > receivedQty) {
    throw new GoodsReturnIntegrityError(
      `${GOODS_RETURN_CORRUPT_HISTORY}: returned ${returnedQty} > received ${receivedQty}`,
    );
  }
  return receivedQty - returnedQty;
}

/**
 * §35/§12 — cumulative return cap for ONE receipt line: SUM(POSTED
 * returned) + new return quantity ≤ receivedQty. Pure, total, and the
 * SINGLE authority the line-add check (advisory, §62) and the post-time
 * final check (§43 step 11) both call — there is no second tolerance
 * implementation. Preconditions are ENFORCED, not assumed (§12): every
 * operand is a safe integer, received/alreadyReturned are ≥ 0, and newQty
 * is a valid return quantity (≥ 1) — a violation throws the canonical
 * integrity error instead of silently comparing garbage.
 */
export function exceedsReturnable(
  receivedQty: number,
  alreadyReturnedQty: number,
  newQty: number,
): boolean {
  if (!isSafeNonNegativeInteger(receivedQty)) {
    throw new GoodsReturnIntegrityError(
      `${GOODS_RETURN_CORRUPT_HISTORY}: receivedQty ${String(receivedQty)}`,
    );
  }
  if (!isSafeNonNegativeInteger(alreadyReturnedQty)) {
    throw new GoodsReturnIntegrityError(
      `${GOODS_RETURN_CORRUPT_HISTORY}: alreadyReturnedQty ${String(alreadyReturnedQty)}`,
    );
  }
  if (!isValidPersistedReturnedQty(newQty)) {
    throw new GoodsReturnIntegrityError(
      `${GOODS_RETURN_CORRUPT_HISTORY}: newQty ${String(newQty)}`,
    );
  }
  const cumulative = alreadyReturnedQty + newQty;
  if (!Number.isSafeInteger(cumulative)) {
    throw new GoodsReturnIntegrityError(
      `${GOODS_RETURN_CORRUPT_HISTORY}: cumulative returned total exceeded the safe integer range`,
    );
  }
  return cumulative > receivedQty;
}

/**
 * §77-§79 — NET RECEIVED math (the P43 extension of the receiving law).
 * net = gross − returned; returned > gross or a negative result is
 * database corruption and MUST be surfaced, never silently clamped (§79).
 * netReceivedQty > orderedQty is likewise corruption (§79) — the caller
 * validates that against the PO line's orderedQty via computeNetRemainingQty.
 */
export function computeNetReceivedQty(grossReceivedQty: number, returnedQty: number): number {
  // §10 — every operand and the result must be a SAFE integer (unsafe
  // integers silently lose precision and can never be authoritative).
  if (!isSafeNonNegativeInteger(grossReceivedQty)) {
    throw new GoodsReturnIntegrityError(
      `${GOODS_RETURN_CORRUPT_HISTORY}: grossReceivedQty ${String(grossReceivedQty)}`,
    );
  }
  if (!isSafeNonNegativeInteger(returnedQty)) {
    throw new GoodsReturnIntegrityError(
      `${GOODS_RETURN_CORRUPT_HISTORY}: returnedQty ${String(returnedQty)}`,
    );
  }
  if (returnedQty > grossReceivedQty) {
    // §79 — returning more than was ever received is corruption.
    throw new GoodsReturnIntegrityError(
      `${GOODS_RETURN_CORRUPT_HISTORY}: returned ${returnedQty} > gross received ${grossReceivedQty}`,
    );
  }
  return grossReceivedQty - returnedQty;
}

/**
 * §79 — remaining = ordered − net; net > ordered is receiving-history
 * corruption (must fail with the P42 stable code — the mapping lives in
 * the server layer, §80). Pure and shared by API, UI and export.
 */
export function computeNetRemainingQty(orderedQty: number, netReceivedQty: number): number {
  // §11 — every operand and the result must be a SAFE integer; a negative
  // result is NEVER clamped to zero (that would hide receiving corruption).
  if (!isSafeNonNegativeInteger(orderedQty)) {
    throw new GoodsReturnIntegrityError(
      `${GOODS_RETURN_CORRUPT_HISTORY}: orderedQty ${String(orderedQty)}`,
    );
  }
  if (!isSafeNonNegativeInteger(netReceivedQty)) {
    throw new GoodsReturnIntegrityError(
      `${GOODS_RETURN_CORRUPT_HISTORY}: netReceivedQty ${String(netReceivedQty)}`,
    );
  }
  if (netReceivedQty > orderedQty) {
    throw new GoodsReturnIntegrityError(
      `${GOODS_RETURN_CORRUPT_HISTORY}: net received ${netReceivedQty} > ordered ${orderedQty}`,
    );
  }
  return orderedQty - netReceivedQty;
}

/* --------------------- §41/§42 stock arithmetic laws ----------------------- */

/**
 * §42 — exact integer stock decrement. Verifies every input BEFORE the
 * mutation: current stock integer ≥ 0, returnedQty integer ≥ 1,
 * newStock ≥ 0 (§39/§41 — no negative stock, no override, no silent
 * zero-clamp). Returns the new stock or throws the stable code.
 */
export const GOODS_RETURN_INVALID_PERSISTED_STOCK = "GOODS_RETURN_INVALID_PERSISTED_STOCK";

export function stockAfterReturn(currentStock: number, returnedQty: number): number {
  if (!Number.isSafeInteger(currentStock) || currentStock < 0) {
    // §41/§14 — already-negative or unsafe persisted STOCK is stock
    // corruption: controlled integrity failure, NEVER silently set to zero.
    throw new GoodsReturnIntegrityError(
      `${GOODS_RETURN_INVALID_PERSISTED_STOCK}: currentStock ${String(currentStock)}`,
    );
  }
  if (!isValidPersistedReturnedQty(returnedQty)) {
    // §14 — an invalid RETURNED quantity is RETURN-DOCUMENT corruption
    // (CORRUPT_HISTORY), not stock corruption: the most accurate stable
    // classification, even though both errors share this helper.
    throw new GoodsReturnIntegrityError(
      `${GOODS_RETURN_CORRUPT_HISTORY}: returnedQty ${String(returnedQty)}`,
    );
  }
  const newStock = currentStock - returnedQty; // §42 — exact integer math
  if (!Number.isSafeInteger(newStock) || newStock < 0) {
    throw new GoodsReturnIntegrityError(
      `${GOODS_RETURN_INVALID_PERSISTED_STOCK}: newStock ${newStock} < 0`,
    );
  }
  return newStock;
}

/**
 * §22-§24 — the business-timezone createdAt day window for list filters.
 * COMPOSES the established repository helpers (zonedWallClockToUtc +
 * nextCalendarDay — the same statement/aging law, §23: no second date
 * utility): `from` is the INCLUSIVE local start of day, `to` is the
 * EXCLUSIVE local start of the NEXT day (never 23:59:59.999). Invalid
 * calendar dates (2026-02-31, 2026-13-01) are rejected — never rolled over
 * (§24); null maps to a controlled 422 at the call site. A record at 00:15
 * local time belongs to its LOCAL calendar date even when its UTC date is
 * the previous day (§25).
 */
export function goodsReturnDayWindow(
  from: string | undefined,
  to: string | undefined,
  timezone: string | undefined | null,
): { gte?: Date; lt?: Date } | null {
  if (!from && !to) return {};
  // §24 — strict calendar validation here too (the zod boundary rejects
  // first; this is defense in depth — JS Date would silently roll an
  // invalid date over into the next month).
  if (from && !isValidCalendarDate(from)) return null;
  if (to && !isValidCalendarDate(to)) return null;
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

/* ------------------------- §52/§74 calendar dates -------------------------- */

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * §24/§52 — the ONE canonical strict calendar-date validator for the P43
 * list filters (the query schema re-exports this law — no second copy):
 * regex shape + real calendar day (leap-year aware). 2024-02-29 accepted;
 * 2026-02-31, 2026-13-01, 2026-00-10, 2026-01-00 and any JS rollover are
 * rejected.
 */
export function isValidCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

/* --------------------------- §19/§20 reference ----------------------------- */

export const GOODS_RETURN_REFERENCE_MIN = 2;
export const GOODS_RETURN_REFERENCE_MAX = 80;
export const GOODS_RETURN_NOTES_MAX = 2000;

/**
 * §19 — reference normalization: trim, reject control characters (NUL,
 * newlines, path-hostile control bytes), collapse pathological whitespace
 * runs to a single space, preserve Unicode. Returns null when nothing
 * usable remains (blank → caller generates, §20).
 */
export function normalizeGoodsReturnReference(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null; // §19 — control chars rejected
  const collapsed = trimmed.replace(/\s+/g, " ");
  if (collapsed.length < GOODS_RETURN_REFERENCE_MIN) return null;
  if (collapsed.length > GOODS_RETURN_REFERENCE_MAX) return null;
  return collapsed;
}

/**
 * §20 — server-generated reference when the user leaves it blank:
 * RET-<YYYYMMDD>-<6 unambiguous base32 chars>, secure random. Database
 * uniqueness stays authoritative; NEVER a MAX(reference)+1 algorithm;
 * client-generated uniqueness is never trusted.
 */
const GENERATION_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I/L/O/0/1

export function generateGoodsReturnReference(
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
  return `RET-${date}-${token}`;
}

/* ------------------------------ §142 errors -------------------------------- */

export const GOODS_RETURN_ERROR_CODES = {
  DUPLICATE_REFERENCE: "GOODS_RETURN_DUPLICATE_REFERENCE",
  DUPLICATE_LINE: "GOODS_RETURN_DUPLICATE_LINE",
  EMPTY: "GOODS_RETURN_EMPTY",
  LINE_LIMIT: "GOODS_RETURN_LINE_LIMIT_REACHED",
  EXCEEDS_RETURNABLE: "GOODS_RETURN_EXCEEDS_RETURNABLE",
  INSUFFICIENT_STOCK: "GOODS_RETURN_INSUFFICIENT_STOCK",
  INVALID_TRANSITION: "GOODS_RETURN_INVALID_TRANSITION",
  INVALID_PERSISTED_STATUS: GOODS_RETURN_INVALID_PERSISTED_STATUS,
  INVALID_PERSISTED_STOCK: GOODS_RETURN_INVALID_PERSISTED_STOCK,
  IMMUTABLE: "GOODS_RETURN_IMMUTABLE",
  SOURCE_NOT_POSTED: "GOODS_RETURN_SOURCE_NOT_POSTED",
  SOURCE_LINE_NOT_FOUND: "GOODS_RETURN_SOURCE_LINE_NOT_FOUND",
  CORRUPT_HISTORY: GOODS_RETURN_CORRUPT_HISTORY,
  LINE_CAP_INVARIANT: GOODS_RETURN_LINE_CAP_INVARIANT,
} as const;

/* ---------------------------- lifecycle gates ------------------------------ */

/** Lines may be added/edited/removed only while DRAFT (§10/§58/§60). */
export function goodsReturnLinesEditable(status: GoodsReturnStatus): boolean {
  return status === "DRAFT";
}

/** §11/§12 — POSTED and CANCELLED are read-only. */
export function goodsReturnIsReadOnly(status: GoodsReturnStatus): boolean {
  return status !== "DRAFT";
}

/** §13 — only POSTED receipts can be returned from. */
export function goodsReceiptIsReturnable(status: string): boolean {
  return status === "POSTED";
}
