/**
 * Prompt 48 — Supplier Bill domain types + pure laws (client-safe).
 *
 * SCOPE LAW (P48 §4): a supplier bill is a PROCUREMENT INVOICE DOCUMENT —
 * "the supplier invoiced these product quantities at these unit prices".
 * It is NOT a GoodsReceipt (physical receipt authority), NOT a PurchaseOrder
 * (procurement commitment), NOT a GoodsReturn (physical return authority),
 * NOT a Payment (settlement authority), and NOT an Expense category in
 * disguise. The bill is the DOCUMENT/detail authority; the linked Expense
 * is the SOLE financial payable authority (P48 §2 — no duplicate payable).
 *
 * THREE-WAY QUANTITY MATCHING (P48 §7) is encoded here as ONE pure law:
 *   available = received(POSTED receipts) − returned(POSTED returns)
 *               − previouslyBilled(POSTED bills)
 * Nothing is ever clamped; inconsistent aggregates are corruption.
 *
 * This module is pure: no Prisma, no db, no server-only imports. Safe for
 * client bundles (server-only boundaries law).
 */

/* ------------------------------ §10 lifecycle ----------------------------- */

export const SUPPLIER_BILL_STATUSES = ["DRAFT", "POSTED", "CANCELLED"] as const;

export type SupplierBillStatus = (typeof SUPPLIER_BILL_STATUSES)[number];

export function isSupplierBillStatus(value: string): value is SupplierBillStatus {
  return (SUPPLIER_BILL_STATUSES as readonly string[]).includes(value);
}

/* -------------------- persisted-status integrity law ---------------------- */

export const SUPPLIER_BILL_INVALID_PERSISTED_STATUS = "SUPPLIER_BILL_INVALID_PERSISTED_STATUS";

/**
 * A corrupted persisted status (e.g. "OPEN", "PAID", "") is an internal
 * data-integrity error, NOT a draft. A fabricated DRAFT would expose
 * edit/post/cancel behavior on an unknown document state, so this pure
 * error class is thrown instead and mapped to a controlled 500 by the
 * server layer. INVALID PERSISTED STATUS ≠ DRAFT (P47 §97 law carried over).
 */
export class SupplierBillStatusIntegrityError extends Error {
  readonly code = SUPPLIER_BILL_INVALID_PERSISTED_STATUS;
  readonly value: string;
  constructor(value: unknown) {
    super(`${SUPPLIER_BILL_INVALID_PERSISTED_STATUS}: ${String(value ?? "")}`);
    this.name = "SupplierBillStatusIntegrityError";
    this.value = typeof value === "string" ? value : String(value ?? "");
  }
}

/**
 * Parse a PERSISTED status value. Known → the exact valid status; unknown →
 * throws. There is deliberately NO `→ DRAFT` fallback anywhere in the domain.
 */
export function parseSupplierBillStatus(value: string): SupplierBillStatus {
  if (isSupplierBillStatus(value)) return value;
  throw new SupplierBillStatusIntegrityError(value);
}

/* --------------------------- §10 transition matrix ------------------------ */

/**
 * Allowed transitions (P48 §10) — server-authoritative through the dedicated
 * post/cancel endpoints only; there is NO generic status PATCH.
 *  - DRAFT → POSTED (the posting transaction; creates exactly one Expense)
 *  - DRAFT → CANCELLED (pure document transition; no payable, no movement)
 *  - POSTED is immutable in this phase (P48 §10: cannot be edited or
 *    cancelled — reversal workflow intentionally out of scope)
 *  - CANCELLED is terminal
 */
export const SUPPLIER_BILL_TRANSITIONS: Readonly<
  Record<SupplierBillStatus, readonly SupplierBillStatus[]>
> = {
  DRAFT: ["POSTED", "CANCELLED"],
  POSTED: [],
  CANCELLED: [],
};

export function canTransitionSupplierBill(
  from: SupplierBillStatus,
  to: SupplierBillStatus,
): boolean {
  return SUPPLIER_BILL_TRANSITIONS[from].includes(to);
}

/* ------------------------------ §6 quantities ----------------------------- */

/** billedQty: integer 1..1_000_000 whole units (mirrors P41 orderedQty law). */
export const BILLED_QTY_MIN = 1;
export const BILLED_QTY_MAX = 1_000_000;

export function isValidBilledQty(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= BILLED_QTY_MIN &&
    value <= BILLED_QTY_MAX
  );
}

/* ------------------------------- §8 money --------------------------------- */

/**
 * unitPriceMinor: integer 0..1_000_000_000 minor units (mirrors P41 §29 —
 * zero ALLOWED for free/promotional invoice lines; a zero TOTAL bill is
 * rejected at posting with SUPPLIER_BILL_ZERO_TOTAL because the existing
 * Expense.amountMinor contract requires a positive payable).
 * Negative values are always rejected (a negative line must never act as a
 * discount — P41 §196 law carried over). The bound is the maximum
 * representable by this project's Int money columns.
 */
export const BILL_UNIT_PRICE_MINOR_MIN = 0;
export const BILL_UNIT_PRICE_MINOR_MAX = 1_000_000_000;

export function isValidBillUnitPriceMinor(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= BILL_UNIT_PRICE_MINOR_MIN &&
    value <= BILL_UNIT_PRICE_MINOR_MAX
  );
}

/* ------------------------------ line cap ---------------------------------- */

export const SUPPLIER_BILL_LINE_CAP_DEFAULT = 200;
export const SUPPLIER_BILL_LINE_CAP_MIN = 20;
export const SUPPLIER_BILL_LINE_CAP_MAX = 500;

/**
 * SUPPLIER_BILL_MAX_LINES parsing: default safely, fall back to the default
 * on malformed input, clamp below MIN and above MAX. Never unbounded. (Same
 * defensive parser style as PURCHASE_ORDER_MAX_LINES / GOODS_RECEIPT_MAX_LINES.)
 */
export function supplierBillLineCap(env: string | undefined | null): number {
  const parsed = Number.parseInt(String(env ?? "").trim(), 10);
  if (!Number.isInteger(parsed)) return SUPPLIER_BILL_LINE_CAP_DEFAULT;
  if (parsed < SUPPLIER_BILL_LINE_CAP_MIN) return SUPPLIER_BILL_LINE_CAP_MIN;
  if (parsed > SUPPLIER_BILL_LINE_CAP_MAX) return SUPPLIER_BILL_LINE_CAP_MAX;
  return parsed;
}

/* --------------------------- §8/§9 exact money math ----------------------- */

export type SupplierBillTotals = {
  lineCount: number;
  totalQty: number;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
};

/**
 * §8 — line total for ONE line: billedQty × unitPriceMinor in BigInt so the
 * intermediate product can never lose precision; the final value must fit a
 * safe JS integer (project money DTO convention) or SUPPLIER_BILL_PRICE_OVERFLOW
 * is thrown — never a silently rounded/losing total.
 */
export function computeBillLineTotalMinor(billedQty: number, unitPriceMinor: number): number {
  const total = BigInt(billedQty) * BigInt(unitPriceMinor);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("SUPPLIER_BILL_PRICE_OVERFLOW");
  }
  return Number(total);
}

/**
 * §9 — canonical bill totals: subtotal = Σ lineTotalMinor (BigInt sum);
 * total = subtotal − discount. Every input is re-validated here:
 *  - each line total must be a non-negative safe integer
 *  - discount must be an integer 0..subtotal (negative discounts and
 *    discounts exceeding the subtotal are both rejected)
 *  - the final total must remain a safe integer
 * A zero/negative TOTAL is NOT silently accepted — callers apply the
 * SUPPLIER_BILL_ZERO_TOTAL policy (the payable store requires amount ≥ 1).
 */
export function computeSupplierBillTotals(
  lines: ReadonlyArray<{ lineTotalMinor: number }>,
  discountMinor: number,
): Omit<SupplierBillTotals, "totalQty"> {
  let subtotal = 0n;
  for (const line of lines) {
    if (!Number.isSafeInteger(line.lineTotalMinor) || line.lineTotalMinor < 0) {
      throw new Error("SUPPLIER_BILL_PRICE_OVERFLOW");
    }
    subtotal += BigInt(line.lineTotalMinor);
  }
  if (subtotal > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("SUPPLIER_BILL_TOTAL_OVERFLOW");
  }
  if (!Number.isSafeInteger(discountMinor) || discountMinor < 0) {
    throw new Error("SUPPLIER_BILL_INVALID_DISCOUNT");
  }
  if (BigInt(discountMinor) > subtotal) {
    throw new Error("SUPPLIER_BILL_INVALID_DISCOUNT");
  }
  const total = subtotal - BigInt(discountMinor);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("SUPPLIER_BILL_TOTAL_OVERFLOW");
  }
  return {
    lineCount: lines.length,
    subtotalMinor: Number(subtotal),
    discountMinor,
    totalMinor: Number(total),
  };
}

/* --------------------- §7 three-way quantity matching --------------------- */

export type BillableQuantityInput = {
  orderedQty: number;
  receivedQty: number; // SUM(POSTED GoodsReceiptLine.receivedQty)
  returnedQty: number; // SUM(POSTED GoodsReturnLine.returnedQty)
  previouslyBilledQty: number; // SUM(POSTED SupplierBillLine.billedQty)
};

/**
 * §7 — THE ONE canonical available-billable-quantity computation.
 *   available = received − returned − previouslyBilled
 * Corruption policy (§7/§13): inconsistent aggregates are integrity
 * failures, never clamped:
 *  - received > ordered                     → SUPPLIER_BILL_CORRUPT_HISTORY
 *  - returned > received                    → SUPPLIER_BILL_CORRUPT_HISTORY
 *  - previouslyBilled > received − returned → SUPPLIER_BILL_CORRUPT_HISTORY
 * A negative available result can then only be produced by a caller asking
 * for more than remains — the ordinary over-bill rejection, not corruption.
 */
export const SUPPLIER_BILL_CORRUPT_HISTORY = "SUPPLIER_BILL_CORRUPT_HISTORY";

export class SupplierBillMatchingIntegrityError extends Error {
  readonly code = SUPPLIER_BILL_CORRUPT_HISTORY;
  constructor(detail: string) {
    super(`${SUPPLIER_BILL_CORRUPT_HISTORY}: ${detail}`);
    this.name = "SupplierBillMatchingIntegrityError";
  }
}

export function computeAvailableBillableQty(input: BillableQuantityInput): number {
  const { orderedQty, receivedQty, returnedQty, previouslyBilledQty } = input;
  if (!Number.isInteger(orderedQty) || orderedQty < 0) {
    throw new SupplierBillMatchingIntegrityError(`orderedQty ${String(orderedQty)}`);
  }
  if (!Number.isInteger(receivedQty) || receivedQty < 0) {
    throw new SupplierBillMatchingIntegrityError(`receivedQty ${String(receivedQty)}`);
  }
  if (!Number.isInteger(returnedQty) || returnedQty < 0) {
    throw new SupplierBillMatchingIntegrityError(`returnedQty ${String(returnedQty)}`);
  }
  if (!Number.isInteger(previouslyBilledQty) || previouslyBilledQty < 0) {
    throw new SupplierBillMatchingIntegrityError(
      `previouslyBilledQty ${String(previouslyBilledQty)}`,
    );
  }
  if (receivedQty > orderedQty) {
    throw new SupplierBillMatchingIntegrityError(
      `received ${receivedQty} > ordered ${orderedQty}`,
    );
  }
  if (returnedQty > receivedQty) {
    throw new SupplierBillMatchingIntegrityError(
      `returned ${returnedQty} > received ${receivedQty}`,
    );
  }
  const netReceived = receivedQty - returnedQty;
  if (previouslyBilledQty > netReceived) {
    throw new SupplierBillMatchingIntegrityError(
      `billed ${previouslyBilledQty} > net received ${netReceived}`,
    );
  }
  return netReceived - previouslyBilledQty;
}

/** §7 — a quantity fits when it is ≤ the available billable remainder. */
export function quantityFitsAvailable(billedQty: number, availableQty: number): boolean {
  return billedQty <= availableQty;
}

/* --------------------------- §8 price variance ---------------------------- */

/**
 * §8 — price variance is RECORDED AND DISPLAYED, never silently normalized
 * away and never blocked (no invented tolerance rule). Pure signed delta:
 *   variance = invoiced unit price − purchase-order unit price
 */
export function priceVarianceMinor(
  unitPriceMinor: number,
  purchaseOrderUnitPriceMinor: number,
): number {
  return unitPriceMinor - purchaseOrderUnitPriceMinor;
}

/* --------------------------- §12 payable category ------------------------- */

/**
 * §11 step 23 — the ONE documented canonical Expense category for payables
 * created by supplier-bill posting. Free-text category (≤60) under the
 * existing Expense contract; this constant keeps statement/aging filtering
 * and UI grouping stable.
 */
export const SUPPLIER_BILL_EXPENSE_CATEGORY = "Supplier bill";

/* ------------------------------ §12/§13 references ------------------------ */

export const SUPPLIER_BILL_REFERENCE_MIN = 2;
export const SUPPLIER_BILL_REFERENCE_MAX = 80;
export const SUPPLIER_BILL_INVOICE_REFERENCE_MAX = 80;
export const SUPPLIER_BILL_NOTES_MAX = 2000;

/**
 * Reference normalization (P42 §60 law carried over): trim, reject control
 * characters (NUL, newlines, path-hostile control bytes), collapse
 * pathological whitespace runs to a single space, preserve Unicode. Returns
 * null when nothing usable remains (blank → caller generates for the
 * internal reference; caller stores null for the optional invoice reference).
 */
export function normalizeSupplierBillReference(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null; // control chars rejected
  const collapsed = trimmed.replace(/\s+/g, " ");
  if (collapsed.length < SUPPLIER_BILL_REFERENCE_MIN) return null;
  if (collapsed.length > SUPPLIER_BILL_REFERENCE_MAX) return null;
  return collapsed;
}

/**
 * Supplier invoice reference normalization: same hygiene law, separate
 * length contract (1..80 — an invoice number may legitimately be a single
 * token; uniqueness is per (business, supplier), DB-enforced, NULLs distinct).
 */
export function normalizeSupplierInvoiceReference(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null;
  const collapsed = trimmed.replace(/\s+/g, " ");
  if (collapsed.length > SUPPLIER_BILL_INVOICE_REFERENCE_MAX) return null;
  return collapsed;
}

/**
 * Server-generated internal reference when the user leaves it blank:
 * SB-<YYYYMMDD>-<6 unambiguous base32 chars>, secure random. Database
 * uniqueness stays authoritative; NEVER a MAX(reference)+1 algorithm.
 */
const GENERATION_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I/L/O/0/1

export function generateSupplierBillReference(
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
  return `SB-${date}-${token}`;
}

/* --------------------------- date-only calendar law ----------------------- */

/**
 * Strict calendar-date validation (Prompt-35 §84 law carried over):
 * "YYYY-MM-DD" with NO rollover — 2026-02-31 and 2026-13-01 are rejected.
 * Normalization to the canonical UTC-midnoon instant happens in the zod
 * schema boundary (billDate/dueDate are DATE-ONLY business semantics).
 */
export function isValidCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

/**
 * The canonical date-only normalization: a calendar day is stored as its
 * UTC-midnoon instant (T12:00:00.000Z) so the calendar day is stable across
 * display timezones (Prompt-35 §84 / Expense.dueDate contract).
 */
export function calendarDateToUtcMidnoon(value: string): Date {
  return new Date(`${value}T12:00:00.000Z`);
}

/** Inverse display helper: the stored instant → its YYYY-MM-DD calendar day. */
export function utcMidnoonToCalendarDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/* ------------------------------- §17 PO gates ----------------------------- */

/**
 * §17 — PO statuses that PERMIT supplier billing. CONFIRMED is the active
 * procurement state; CLOSED permits billing of ALREADY-RECEIVED quantities
 * (P41 §17/§18: close is a pure document transition — posted receipts and
 * their invoiceable quantities survive it; invoices routinely arrive after
 * procurement closes). DRAFT/SENT/CANCELLED never permit billing.
 * This is the ONE gate shared by draft creation and the posting transaction.
 */
export function purchaseOrderIsBillable(status: string): boolean {
  return status === "CONFIRMED" || status === "CLOSED";
}

/* ----------------------------- lifecycle gates ---------------------------- */

/** Lines/header may change only while DRAFT (§10). */
export function supplierBillLinesEditable(status: SupplierBillStatus): boolean {
  return status === "DRAFT";
}

/** POSTED is immutable (§10); CANCELLED is read-only too (§10). */
export function supplierBillIsReadOnly(status: SupplierBillStatus): boolean {
  return status !== "DRAFT";
}

/* ------------------------------- §21 errors ------------------------------- */

export const SUPPLIER_BILL_ERROR_CODES = {
  NOT_FOUND: "SUPPLIER_BILL_NOT_FOUND",
  DUPLICATE_REFERENCE: "SUPPLIER_BILL_DUPLICATE_REFERENCE",
  DUPLICATE_INVOICE_REFERENCE: "SUPPLIER_BILL_DUPLICATE_INVOICE_REFERENCE",
  INVALID_STATUS: "SUPPLIER_BILL_INVALID_STATUS",
  INVALID_PERSISTED_STATUS: SUPPLIER_BILL_INVALID_PERSISTED_STATUS,
  INVALID_TRANSITION: "SUPPLIER_BILL_INVALID_TRANSITION",
  IMMUTABLE: "SUPPLIER_BILL_IMMUTABLE",
  EMPTY: "SUPPLIER_BILL_EMPTY",
  LINE_LIMIT: "SUPPLIER_BILL_LINE_LIMIT_REACHED",
  LINE_CAP_INVARIANT: "SUPPLIER_BILL_LINE_CAP_INVARIANT",
  DUPLICATE_PO_LINE: "SUPPLIER_BILL_DUPLICATE_PO_LINE",
  INVALID_QUANTITY: "SUPPLIER_BILL_INVALID_QUANTITY",
  QUANTITY_EXCEEDS_RECEIVED: "SUPPLIER_BILL_QUANTITY_EXCEEDS_RECEIVED",
  QUANTITY_EXCEEDS_AVAILABLE: "SUPPLIER_BILL_QUANTITY_EXCEEDS_AVAILABLE",
  RETURNED_QUANTITY: "SUPPLIER_BILL_RETURNED_QUANTITY",
  PRICE_OVERFLOW: "SUPPLIER_BILL_PRICE_OVERFLOW",
  TOTAL_OVERFLOW: "SUPPLIER_BILL_TOTAL_OVERFLOW",
  CURRENCY_MISMATCH: "SUPPLIER_BILL_CURRENCY_MISMATCH",
  ZERO_TOTAL: "SUPPLIER_BILL_ZERO_TOTAL",
  ALREADY_POSTED: "SUPPLIER_BILL_ALREADY_POSTED",
  ALREADY_LINKED: "SUPPLIER_BILL_ALREADY_LINKED",
  CORRUPT_HISTORY: SUPPLIER_BILL_CORRUPT_HISTORY,
  FOREIGN_ENTITY: "SUPPLIER_BILL_FOREIGN_ENTITY",
  LINKED_EXPENSE_IMMUTABLE: "SUPPLIER_BILL_LINKED_EXPENSE_IMMUTABLE",
  INVALID_DISCOUNT: "SUPPLIER_BILL_INVALID_DISCOUNT",
  PO_NOT_BILLABLE: "SUPPLIER_BILL_PURCHASE_ORDER_NOT_BILLABLE",
  PO_LINE_MISMATCH: "SUPPLIER_BILL_PO_LINE_MISMATCH",
  SUPPLIER_MISMATCH: "SUPPLIER_BILL_SUPPLIER_MISMATCH",
} as const;
