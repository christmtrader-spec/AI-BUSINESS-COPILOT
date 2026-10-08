/**
 * Prompt 42 — zod request schemas for the goods-receipt APIs (server-side).
 *
 * LAWS:
 *  - status is NEVER client input (§7) — post/cancel live on dedicated
 *    endpoints and the server derives them from the current row state.
 *  - businessId / supplier snapshot / PO reference snapshot / product
 *    identity / createdBy / postedAt are NEVER accepted from the client
 *    (§22/§25/§28/§36/§74). productId is REJECTED if submitted (§36 —
 *    the server derives it from the PurchaseOrderLine).
 *  - receivedQty is an integer 1..1_000_000 (§17/§18/§19) — zod rejects
 *    0, negatives, 1.5, NaN and Infinity at the boundary.
 *  - dates are strict calendar dates (same law as P41 §20 — no rollover).
 */
import { z } from "zod";
import {
  GOODS_RECEIPT_NOTES_MAX,
  GOODS_RECEIPT_QTY_MAX,
  GOODS_RECEIPT_REFERENCE_MAX,
  GOODS_RECEIPT_REFERENCE_MIN,
  RECEIVED_QTY_MIN,
  isGoodsReceiptStatus,
  normalizeGoodsReceiptReference,
} from "./types";

/** Strict calendar-date validation (no silent rollover) — P41 convention. */
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

const calendarDate = z
  .string()
  .refine(isValidCalendarDate, "Use a valid YYYY-MM-DD calendar date.");

/**
 * §59/§60 — reference schema: server-side normalization (trim/collapse/
 * control chars) then bounds. A blank/whitespace-only value becomes
 * undefined → the service generates GR-<date>-<token> (§59); a PROVIDED
 * but invalid reference (control chars, <2 or >80 visible chars) → 422.
 */
const referenceSchema = z
  .string()
  .max(GOODS_RECEIPT_REFERENCE_MAX + 16) // pre-normalization headroom
  .optional()
  .transform((v) => (v === undefined ? undefined : v.trim() || undefined))
  .refine((v) => v === undefined || normalizeGoodsReceiptReference(v) !== null, {
    message: `Reference must be ${GOODS_RECEIPT_REFERENCE_MIN}-${GOODS_RECEIPT_REFERENCE_MAX} visible characters.`,
  })
  .transform((v) => (v === undefined ? undefined : (normalizeGoodsReceiptReference(v) as string)));

/** §62 — notes: trimmed, blank → null, bounded; three-state in patches. */
const notesSchema = z
  .string()
  .max(GOODS_RECEIPT_NOTES_MAX + 16) // pre-trim headroom
  .nullish()
  .transform((v) => (v == null ? v : v.trim() || null))
  .refine((v) => v == null || v.length <= GOODS_RECEIPT_NOTES_MAX, {
    message: `Notes must be at most ${GOODS_RECEIPT_NOTES_MAX} characters.`,
  });

/**
 * §36 — receivedQty boundary: integer 1..1_000_000. NaN/Infinity fail
 * zod's int() refinement; 0/negatives fail min; 1.5 fails int.
 */
const receivedQtySchema = z
  .number()
  .int("receivedQty must be an integer.")
  .min(RECEIVED_QTY_MIN, "receivedQty must be at least 1.")
  .max(GOODS_RECEIPT_QTY_MAX);

/**
 * §58 — create request. Only purchaseOrderId + optional reference/notes.
 * Status/snapshots/creator/businessId are structurally absent.
 */
export const goodsReceiptCreateSchema = z.object({
  purchaseOrderId: z.string().trim().min(1).max(64),
  reference: referenceSchema.optional(),
  notes: notesSchema,
});

/**
 * §107 — DRAFT-only header patch. Only reference/notes are patchable;
 * purchaseOrderId/status/snapshots/creator are immutable (a draft receipt
 * is anchored to exactly one PO for its whole life).
 */
export const goodsReceiptUpdateSchema = z
  .object({
    reference: referenceSchema.optional(),
    notes: notesSchema,
  })
  .refine((v) => v.reference !== undefined || v.notes !== undefined, {
    message: "Nothing to update.",
  });

/**
 * §63 — line create: purchaseOrderLineId + receivedQty. A client-supplied
 * productId is AUTHORITATIVE-FIELD INPUT and is rejected (§36 preferred
 * behavior — reject unexpected authoritative-field input).
 */
export const goodsReceiptLineCreateSchema = z
  .object({
    purchaseOrderLineId: z.string().trim().min(1).max(64),
    receivedQty: receivedQtySchema,
  })
  .strict();

/**
 * §68 — line update: ONLY receivedQty. No product reassignment, no PO-line
 * reassignment, no snapshot mutation (snapshots are historical, §28).
 */
export const goodsReceiptLineUpdateSchema = z
  .object({
    receivedQty: receivedQtySchema,
  })
  .strict();

/**
 * §80/§82/§83 — list filters. q searches receipt reference + PO reference
 * snapshot + supplier snapshot + product snapshot names/SKUs (§81).
 * status is a CLOSED vocabulary token (ALL → undefined). from/to are
 * strict calendar dates applied to createdAt (§83 — documented decision:
 * the list is a receiving-document feed; drafts have no postedAt yet, so
 * createdAt is the only timestamp every receipt row is guaranteed to
 * have). pageSize max 100 (§80); from > to rejected.
 */
export const goodsReceiptListQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .max(80)
      .optional()
      .transform((v) => v || undefined),
    status: z
      .string()
      .optional()
      .transform((v) => (v || undefined) === "ALL" ? undefined : v || undefined)
      .refine((v) => v === undefined || isGoodsReceiptStatus(v), {
        message: "Unknown goods receipt status.",
      }),
    purchaseOrderId: z
      .string()
      .trim()
      .max(64)
      .optional()
      .transform((v) => v || undefined),
    from: calendarDate.optional().transform((v) => v || undefined),
    to: calendarDate.optional().transform((v) => v || undefined),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: "from must be on or before to.",
    path: ["from"],
  });
