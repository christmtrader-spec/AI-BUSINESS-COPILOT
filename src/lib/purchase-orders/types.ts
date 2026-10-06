/**
 * Prompt 41 — Purchase Order domain types + pure laws (client-safe).
 *
 * SCOPE LAW (§2/§4/§255): a purchase order is a PROCUREMENT COMMITMENT
 * DOCUMENT — "the business intends to buy these products from this supplier
 * under these commercial terms". It is NOT an expense, NOT a payment, NOT an
 * inventory receipt, NOT an accounting entry. No lifecycle transition ever
 * writes Expense/Payment/Sale/InventoryAdjustment/stockQty/statement rows.
 *
 * This module is pure: no Prisma, no db, no server-only imports. Safe for
 * client bundles (§118 — server-only boundaries).
 */

/* ------------------------------ §14 lifecycle ----------------------------- */

export const PURCHASE_ORDER_STATUSES = [
  "DRAFT",
  "SENT",
  "CONFIRMED",
  "CLOSED",
  "CANCELLED",
] as const;

export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export function isPurchaseOrderStatus(value: string): value is PurchaseOrderStatus {
  return (PURCHASE_ORDER_STATUSES as readonly string[]).includes(value);
}

/* --------------------------- §15 state machine ---------------------------- */

/**
 * Allowed transitions (§15) — server-authoritative. There is NO generic
 * status PATCH (§42): every transition runs through its dedicated endpoint.
 * CLOSED and CANCELLED are terminal (§19): nothing leaves them.
 */
export const PURCHASE_ORDER_TRANSITIONS: Readonly<
  Record<PurchaseOrderStatus, readonly PurchaseOrderStatus[]>
> = {
  DRAFT: ["SENT", "CANCELLED"],
  SENT: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["CLOSED", "CANCELLED"],
  CLOSED: [],
  CANCELLED: [],
};

export function canTransitionPurchaseOrder(
  from: PurchaseOrderStatus,
  to: PurchaseOrderStatus,
): boolean {
  return PURCHASE_ORDER_TRANSITIONS[from].includes(to);
}

/** The transition each dedicated lifecycle endpoint performs (§42/§215). */
export const PURCHASE_ORDER_TRANSITION_TARGET: Readonly<
  Record<"send" | "confirm" | "close" | "cancel", PurchaseOrderStatus>
> = {
  send: "SENT",
  confirm: "CONFIRMED",
  close: "CLOSED",
  cancel: "CANCELLED",
};

/* ----------------------------- §28 quantities ----------------------------- */

/** §28 — orderedQty: integer 1..1_000_000 whole units. No floats/NaN. */
export const ORDERED_QTY_MIN = 1;
export const ORDERED_QTY_MAX = 1_000_000;

export function isValidOrderedQty(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= ORDERED_QTY_MIN &&
    value <= ORDERED_QTY_MAX
  );
}

/* ------------------------------- §29 money -------------------------------- */

/**
 * §29 — unitPriceMinor: integer 0..9_000_000_000 minor units. The upper
 * bound follows the EXISTING money-validation convention (z.amountMinor /
 * z.unitPriceMinor max 9_000_000_000 in src/lib/schemas.ts). Zero is ALLOWED
 * (free/promotional line items §29/§195). Negative values are always
 * rejected (§196 — a negative line must never act as a discount).
 */
export const UNIT_PRICE_MINOR_MIN = 0;
export const UNIT_PRICE_MINOR_MAX = 9_000_000_000;

export function isValidUnitPriceMinor(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= UNIT_PRICE_MINOR_MIN &&
    value <= UNIT_PRICE_MINOR_MAX
  );
}

/* --------------------------- §30/§32 total math ---------------------------- */

export type PurchaseOrderTotal = {
  lineCount: number;
  totalQty: number;
  totalMinor: number;
};

/**
 * §30/§32 — exact, server-authoritative totals. Multiplication is done in
 * BigInt so intermediate products can never lose precision; the final value
 * must still fit a safe JS integer (project money DTO convention) or the
 * caller receives a 422 — never a silently rounded total.
 */
export function computePurchaseOrderTotal(
  lines: ReadonlyArray<{ orderedQty: number; unitPriceMinor: number }>,
): PurchaseOrderTotal {
  let totalQty = 0;
  let total = 0n;
  for (const line of lines) {
    totalQty += line.orderedQty;
    total += BigInt(line.orderedQty) * BigInt(line.unitPriceMinor);
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    // §32 — reject rather than silently lose precision.
    throw new Error("PURCHASE_ORDER_TOTAL_OVERFLOW");
  }
  return { lineCount: lines.length, totalQty, totalMinor: Number(total) };
}

/** Line total for ONE line — same BigInt law (§30). */
export function computeLineTotalMinor(orderedQty: number, unitPriceMinor: number): number {
  const total = BigInt(orderedQty) * BigInt(unitPriceMinor);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("PURCHASE_ORDER_TOTAL_OVERFLOW");
  }
  return Number(total);
}

/* ------------------------------ §33 line cap ------------------------------ */

export const PURCHASE_ORDER_LINE_CAP_DEFAULT = 200;
export const PURCHASE_ORDER_LINE_CAP_MIN = 20;
export const PURCHASE_ORDER_LINE_CAP_MAX = 500;

/**
 * §33 — PURCHASE_ORDER_MAX_LINES parsing: default safely, fall back to the
 * default on malformed input, clamp below MIN and above MAX. Never unbounded.
 * (Same clamp law as the P40 stocktake line cap.)
 */
export function purchaseOrderLineCap(env: string | undefined | null): number {
  const parsed = Number.parseInt(String(env ?? "").trim(), 10);
  if (!Number.isInteger(parsed)) return PURCHASE_ORDER_LINE_CAP_DEFAULT;
  if (parsed < PURCHASE_ORDER_LINE_CAP_MIN) return PURCHASE_ORDER_LINE_CAP_MIN;
  if (parsed > PURCHASE_ORDER_LINE_CAP_MAX) return PURCHASE_ORDER_LINE_CAP_MAX;
  return parsed;
}

/* ----------------------------- §12/§13 reference --------------------------- */

export const PURCHASE_ORDER_REFERENCE_MIN = 2;
export const PURCHASE_ORDER_REFERENCE_MAX = 80;
export const PURCHASE_ORDER_NOTES_MAX = 2000;

/**
 * §12 — reference normalization: trim, reject control characters, collapse
 * pathological whitespace runs to a single space, preserve Unicode.
 * Returns null when nothing usable remains (blank).
 */
export function normalizePurchaseOrderReference(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null; // §12 — control chars rejected
  const collapsed = trimmed.replace(/\s+/g, " ");
  if (collapsed.length < PURCHASE_ORDER_REFERENCE_MIN) return null;
  if (collapsed.length > PURCHASE_ORDER_REFERENCE_MAX) return null;
  return collapsed;
}

/**
 * §13 — server-generated reference when the user leaves it blank:
 * PO-<YYYYMMDD>-<6 unambiguous base32 chars>. Database uniqueness stays
 * authoritative; the service retries a bounded number of times on the
 * (astronomically unlikely) collision. NEVER a MAX(reference)+1 algorithm.
 */
const GENERATION_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I/L/O/0/1

export function generatePurchaseOrderReference(now: Date, random: (max: number) => number): string {
  const date = `${now.getUTCFullYear()}`.padStart(4, "0") +
    `${now.getUTCMonth() + 1}`.padStart(2, "0") +
    `${now.getUTCDate()}`.padStart(2, "0");
  let token = "";
  for (let i = 0; i < 6; i += 1) {
    token += GENERATION_ALPHABET[random(GENERATION_ALPHABET.length)];
  }
  return `PO-${date}-${token}`;
}

/* ------------------------------- §138 errors ------------------------------- */

export const PURCHASE_ORDER_ERROR_CODES = {
  INVALID_TRANSITION: "INVALID_PURCHASE_ORDER_TRANSITION",
  IMMUTABLE: "PURCHASE_ORDER_IMMUTABLE",
  DUPLICATE_REFERENCE: "DUPLICATE_PURCHASE_ORDER_REFERENCE",
  DUPLICATE_PRODUCT: "DUPLICATE_PURCHASE_ORDER_PRODUCT",
  LINE_LIMIT: "PURCHASE_ORDER_LINE_LIMIT_REACHED",
  INVALID_SUPPLIER: "INVALID_SUPPLIER",
  INVALID_PRODUCT: "INVALID_PRODUCT",
  PRODUCT_INACTIVE: "PURCHASE_ORDER_PRODUCT_INACTIVE",
  TOTAL_OVERFLOW: "PURCHASE_ORDER_TOTAL_OVERFLOW",
  EMPTY_ORDER: "PURCHASE_ORDER_EMPTY",
} as const;

/* ---------------------------- §46 lifecycle gates --------------------------- */

/** Lines may be added/edited/removed only while DRAFT (§34/§35/§36). */
export function purchaseOrderLinesEditable(status: PurchaseOrderStatus): boolean {
  return status === "DRAFT";
}

/** CLOSED/CANCELLED are immutable documents (§19/§90). */
export function purchaseOrderIsTerminal(status: PurchaseOrderStatus): boolean {
  return status === "CLOSED" || status === "CANCELLED";
}
