/**
 * Prompt 42 — Goods Receipt domain types + pure laws (client-safe, §170).
 *
 * SCOPE LAW (§3/§4/§5): a goods receipt is a PHYSICAL INVENTORY EVENT —
 * "the business has physically received these quantities of products
 * against a confirmed purchase order". It is NOT an expense, NOT a
 * payment, NOT a supplier statement movement, NOT an accounting entry.
 * A receipt document contains NO MONEY at all (§37/§38).
 *
 * HIERARCHY LAW (§2): PURCHASE ORDER → GOODS RECEIPT → PRODUCT STOCK →
 * INVENTORY ADJUSTMENT HISTORY. The PO stays the commercial quantity
 * authority; received/remaining are DERIVED from POSTED receipt lines
 * (§99/§100) — never client-trusted.
 *
 * This module is pure: no Prisma, no db, no server-only imports. Safe for
 * client bundles (§169 — server-only boundaries).
 */

/* ------------------------------ §7 lifecycle ------------------------------ */

export const GOODS_RECEIPT_STATUSES = ["DRAFT", "POSTED", "CANCELLED"] as const;

export type GoodsReceiptStatus = (typeof GOODS_RECEIPT_STATUSES)[number];

export function isGoodsReceiptStatus(value: string): value is GoodsReceiptStatus {
  return (GOODS_RECEIPT_STATUSES as readonly string[]).includes(value);
}

/* -------------------- §96 persisted-status integrity ---------------------- */

export const GOODS_RECEIPT_INVALID_PERSISTED_STATUS = "GOODS_RECEIPT_INVALID_PERSISTED_STATUS";

/**
 * §96 — a corrupted persisted status (e.g. "BROKEN", "INVALID", "") is an
 * internal-data-integrity error, NOT a draft. A fabricated DRAFT would
 * expose add-line/post/cancel behavior on an unknown document state, so
 * this pure error class is thrown instead and mapped to a controlled 500
 * by the server layer. INVALID PERSISTED STATUS ≠ DRAFT (§97).
 */
export class GoodsReceiptStatusIntegrityError extends Error {
  readonly code = GOODS_RECEIPT_INVALID_PERSISTED_STATUS;
  readonly value: string;
  constructor(value: unknown) {
    // Server-side diagnostic detail only — the HTTP body carries the stable
    // code and a fixed, value-free message (§96).
    super(`${GOODS_RECEIPT_INVALID_PERSISTED_STATUS}: ${String(value ?? "")}`);
    this.name = "GoodsReceiptStatusIntegrityError";
    this.value = typeof value === "string" ? value : String(value ?? "");
  }
}

/**
 * §173 — parse a PERSISTED status value. Known → the exact valid status;
 * unknown → throws. There is deliberately NO `→ DRAFT` fallback anywhere
 * in the domain (§97 — never Draft, never postable, never cancellable).
 */
export function parseGoodsReceiptStatus(value: string): GoodsReceiptStatus {
  if (isGoodsReceiptStatus(value)) return value;
  throw new GoodsReceiptStatusIntegrityError(value);
}

/* --------------------------- §7 transition matrix -------------------------- */

/**
 * Allowed transitions (§7) — server-authoritative. DRAFT may post or
 * cancel; POSTED is immutable (§8 — reversal workflow intentionally out of
 * scope); CANCELLED is terminal (§10).
 */
export const GOODS_RECEIPT_TRANSITIONS: Readonly<
  Record<GoodsReceiptStatus, readonly GoodsReceiptStatus[]>
> = {
  DRAFT: ["POSTED", "CANCELLED"],
  POSTED: [],
  CANCELLED: [],
};

export function canTransitionGoodsReceipt(
  from: GoodsReceiptStatus,
  to: GoodsReceiptStatus,
): boolean {
  return GOODS_RECEIPT_TRANSITIONS[from].includes(to);
}

/* ------------------------- §17-§19 quantity laws --------------------------- */

/** §17/§18/§19 — receivedQty: integer 1..1_000_000 whole units. */
export const RECEIVED_QTY_MIN = 1;
export const GOODS_RECEIPT_QTY_MAX = 1_000_000;

export function isValidReceivedQty(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= RECEIVED_QTY_MIN &&
    value <= GOODS_RECEIPT_QTY_MAX
  );
}

/* ------------------------------- §20 line cap ------------------------------ */

export const GOODS_RECEIPT_LINE_CAP_DEFAULT = 200;
export const GOODS_RECEIPT_LINE_CAP_MIN = 20;
export const GOODS_RECEIPT_LINE_CAP_MAX = 500;

/**
 * §20 — GOODS_RECEIPT_MAX_LINES parsing: default safely, fall back to the
 * default on malformed input, clamp below MIN and above MAX. Never
 * unbounded. (Same defensive parser style as PURCHASE_ORDER_MAX_LINES
 * and INVENTORY_STOCKTAKE_MAX_LINES.)
 */
export function goodsReceiptLineCap(env: string | undefined | null): number {
  const parsed = Number.parseInt(String(env ?? "").trim(), 10);
  if (!Number.isInteger(parsed)) return GOODS_RECEIPT_LINE_CAP_DEFAULT;
  if (parsed < GOODS_RECEIPT_LINE_CAP_MIN) return GOODS_RECEIPT_LINE_CAP_MIN;
  if (parsed > GOODS_RECEIPT_LINE_CAP_MAX) return GOODS_RECEIPT_LINE_CAP_MAX;
  return parsed;
}

/* ---------------------- §49 stock overflow (Int32) ------------------------- */

/**
 * §49 — Product.stockQty is a SQLite/Prisma Int (4-byte signed). The
 * post-mutation stock must stay within the storage maximum or the posting
 * is rejected with 422 GOODS_RECEIPT_STOCK_OVERFLOW — never a wrapped /
 * corrupted value.
 */
export const PRODUCT_STOCK_INT32_MAX = 2_147_483_647;

export function stockOverflowsInt32(currentStock: number, receivedQty: number): boolean {
  return currentStock + receivedQty > PRODUCT_STOCK_INT32_MAX;
}

/* ------------------- §171/§172 canonical receiving math -------------------- */

/**
 * §171 — ONE canonical received-quantity sum. Exact integer arithmetic
 * only (no floats, no Math.round). Inputs are POSTED receipt quantities
 * (draft/cancelled receipts are NEVER summed, §99).
 */
export function computeReceivedQty(postedQuantities: ReadonlyArray<number>): number {
  let total = 0;
  for (const qty of postedQuantities) {
    if (!Number.isInteger(qty) || qty < 0) {
      // A negative/ fractional quantity in persisted history is corruption,
      // not a summand — the caller must surface it, never clamp it.
      throw new Error("GOODS_RECEIPT_CORRUPT_RECEIVED_HISTORY");
    }
    total += qty;
  }
  return total;
}

/**
 * §100/§172 — remaining = ordered − received; received > ordered is
 * database corruption and MUST be surfaced, never silently clamped to 0
 * (no Math.max hiding, §100/§283). Violations throw the stable integrity
 * error which the server maps to a controlled 500.
 */
export const GOODS_RECEIPT_CORRUPT_RECEIVED = "GOODS_RECEIPT_CORRUPT_RECEIVED";

/**
 * P42-F §10-§14 — read-cap invariant: a persisted document that contains
 * MORE lines than its own configured cap is database corruption. Read
 * paths fetch cap+1 rows to PROVE completeness; the +1 row (or a
 * `_count` mismatch) must fail the read with this stable code — never a
 * silently truncated/partial DTO. Distinct from GOODS_RECEIPT_LINE_LIMIT_REACHED
 * (422 input/lifecycle rejection at write time): the invariant is a 500
 * data-integrity failure.
 */
export const GOODS_RECEIPT_LINE_CAP_INVARIANT = "GOODS_RECEIPT_LINE_CAP_INVARIANT";

export class GoodsReceiptIntegrityError extends Error {
  readonly code = GOODS_RECEIPT_CORRUPT_RECEIVED;
  constructor(message: string) {
    super(message);
    this.name = "GoodsReceiptIntegrityError";
  }
}

export function computeRemainingQty(orderedQty: number, receivedQty: number): number {
  if (!Number.isInteger(orderedQty) || orderedQty < 0) {
    throw new GoodsReceiptIntegrityError(
      `${GOODS_RECEIPT_CORRUPT_RECEIVED}: orderedQty ${String(orderedQty)}`,
    );
  }
  if (!Number.isInteger(receivedQty) || receivedQty < 0) {
    throw new GoodsReceiptIntegrityError(
      `${GOODS_RECEIPT_CORRUPT_RECEIVED}: receivedQty ${String(receivedQty)}`,
    );
  }
  if (receivedQty > orderedQty) {
    // §100/§283 — never clamp: over-received history is integrity failure.
    throw new GoodsReceiptIntegrityError(
      `${GOODS_RECEIPT_CORRUPT_RECEIVED}: received ${receivedQty} > ordered ${orderedQty}`,
    );
  }
  return orderedQty - receivedQty;
}

/**
 * §101 — fully received is EXACT equality (derived, never stored). A fully
 * received PO line cannot receive additional quantity (§15/§101).
 */
export function isFullyReceived(orderedQty: number, receivedQty: number): boolean {
  return computeRemainingQty(orderedQty, receivedQty) === 0;
}

/**
 * §15 — the over-receipt law itself: SUM(posted received) + new quantity
 * must never exceed orderedQty. Pure, total, and the SINGLE authority the
 * line-add check (advisory, §66) and the post-time final check (§39 step
 * 8) both call — there is no second tolerance implementation anywhere.
 */
export function exceedsRemaining(
  orderedQty: number,
  alreadyPostedQty: number,
  newQty: number,
): boolean {
  return alreadyPostedQty + newQty > orderedQty;
}

/* --------------------------- §60/§59 reference ----------------------------- */

export const GOODS_RECEIPT_REFERENCE_MIN = 2;
export const GOODS_RECEIPT_REFERENCE_MAX = 80;
export const GOODS_RECEIPT_NOTES_MAX = 2000;

/**
 * §60 — reference normalization: trim, reject control characters (NUL,
 * newlines, path-hostile control bytes), collapse pathological whitespace
 * runs to a single space, preserve Unicode. Returns null when nothing
 * usable remains (blank → caller generates, §59).
 */
export function normalizeGoodsReceiptReference(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null; // §60 — control chars rejected
  const collapsed = trimmed.replace(/\s+/g, " ");
  if (collapsed.length < GOODS_RECEIPT_REFERENCE_MIN) return null;
  if (collapsed.length > GOODS_RECEIPT_REFERENCE_MAX) return null;
  return collapsed;
}

/**
 * §59 — server-generated reference when the user leaves it blank:
 * GR-<YYYYMMDD>-<6 unambiguous base32 chars>, secure random. Database
 * uniqueness stays authoritative; NEVER a MAX(reference)+1 algorithm.
 */
const GENERATION_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I/L/O/0/1

export function generateGoodsReceiptReference(
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
  return `GR-${date}-${token}`;
}

/* ------------------------------ §95 errors --------------------------------- */

export const GOODS_RECEIPT_ERROR_CODES = {
  DUPLICATE_REFERENCE: "GOODS_RECEIPT_DUPLICATE_REFERENCE",
  INVALID_TRANSITION: "GOODS_RECEIPT_INVALID_TRANSITION",
  EMPTY: "GOODS_RECEIPT_EMPTY",
  LINE_LIMIT: "GOODS_RECEIPT_LINE_LIMIT_REACHED",
  EXCEEDS_REMAINING: "GOODS_RECEIPT_EXCEEDS_REMAINING",
  PO_NOT_RECEIVABLE: "GOODS_RECEIPT_PURCHASE_ORDER_NOT_RECEIVABLE",
  PRODUCT_NOT_FOUND: "GOODS_RECEIPT_PRODUCT_NOT_FOUND",
  STOCK_OVERFLOW: "GOODS_RECEIPT_STOCK_OVERFLOW",
  INVALID_PERSISTED_STATUS: GOODS_RECEIPT_INVALID_PERSISTED_STATUS,
  INVALID_PERSISTED_STOCK: "GOODS_RECEIPT_INVALID_PERSISTED_STOCK",
  IMMUTABLE: "GOODS_RECEIPT_IMMUTABLE",
  CORRUPT_RECEIVED: GOODS_RECEIPT_CORRUPT_RECEIVED,
  LINE_CAP_INVARIANT: GOODS_RECEIPT_LINE_CAP_INVARIANT,
} as const;

/* ---------------------------- lifecycle gates ------------------------------ */

/** Lines may be added/edited/removed only while DRAFT (§64/§68/§69). */
export function goodsReceiptLinesEditable(status: GoodsReceiptStatus): boolean {
  return status === "DRAFT";
}

/** §8/§78 — POSTED is immutable; §10/§78 — CANCELLED is read-only too. */
export function goodsReceiptIsReadOnly(status: GoodsReceiptStatus): boolean {
  return status !== "DRAFT";
}

/** §11 — only CONFIRMED purchase orders may receive goods. */
export function purchaseOrderIsReceivable(status: string): boolean {
  return status === "CONFIRMED";
}
