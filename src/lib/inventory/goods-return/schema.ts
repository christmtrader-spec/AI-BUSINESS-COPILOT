/**
 * Prompt 43 — zod request schemas for the goods-return APIs (server-side).
 *
 * LAWS:
 *  - status is NEVER client input (§9) — post/cancel live on dedicated
 *    endpoints and the server derives them from the current row state.
 *  - businessId / supplier snapshot / receipt reference snapshot / PO
 *    reference snapshot / product identity / createdBy / postedAt are
 *    NEVER accepted from the client (§22/§25/§56/§57). productId is
 *    REJECTED if submitted (§28 — the server derives it from the
 *    GoodsReceiptLine); so is goodsReturnId.
 *  - returnedQty is an integer 1..1_000_000 (§32) — zod rejects 0,
 *    negatives, 1.5, NaN and Infinity at the boundary.
 *  - reasonCode is the closed §23 vocabulary — no arbitrary strings.
 *  - dates are strict calendar dates (same law as P41/P42 — no rollover,
 *    §74 — 2026-02-31 and 2026-13-01 rejected).
 */
import { z } from "zod";
import {
  GOODS_RETURN_NOTES_MAX,
  GOODS_RETURN_QTY_MAX,
  GOODS_RETURN_REFERENCE_MAX,
  GOODS_RETURN_REFERENCE_MIN,
  RETURNED_QTY_MIN,
  GOODS_RETURN_REASON_CODES,
  isGoodsReturnStatus,
  normalizeGoodsReturnReference,
} from "./types";

/** §24/§52 — the ONE canonical strict calendar-date law (types.ts). */
import { isValidCalendarDate } from "./types";
export { isValidCalendarDate };

const calendarDate = z
  .string()
  .refine(isValidCalendarDate, "Use a valid YYYY-MM-DD calendar date.");

/**
 * §19 — reference schema: server-side normalization (trim/collapse/control
 * chars) then bounds. A blank/whitespace-only value becomes undefined →
 * the service generates RET-<date>-<token> (§20); a PROVIDED but invalid
 * reference (control chars, <2 or >80 visible chars) → 422.
 */
const referenceSchema = z
  .string()
  .max(GOODS_RETURN_REFERENCE_MAX + 16) // pre-normalization headroom
  .optional()
  .transform((v) => (v === undefined ? undefined : v.trim() || undefined))
  .refine((v) => v === undefined || normalizeGoodsReturnReference(v) !== null, {
    message: `Reference must be ${GOODS_RETURN_REFERENCE_MIN}-${GOODS_RETURN_REFERENCE_MAX} visible characters.`,
  })
  .transform((v) => (v === undefined ? undefined : (normalizeGoodsReturnReference(v) as string)));

/** §22 — notes: trimmed, blank → null, bounded; three-state in patches. */
const notesSchema = z
  .string()
  .max(GOODS_RETURN_NOTES_MAX + 16) // pre-trim headroom
  .nullish()
  .transform((v) => (v == null ? v : v.trim() || null))
  .refine((v) => v == null || v.length <= GOODS_RETURN_NOTES_MAX, {
    message: `Notes must be at most ${GOODS_RETURN_NOTES_MAX} characters.`,
  });

/**
 * §32 — returnedQty boundary: integer 1..1_000_000. NaN/Infinity fail
 * zod's int() refinement; 0/negatives fail min; 1.5 fails int.
 */
const returnedQtySchema = z
  .number()
  .int("returnedQty must be an integer.")
  .min(RETURNED_QTY_MIN, "returnedQty must be at least 1.")
  .max(GOODS_RETURN_QTY_MAX);

/** §23 — closed reason vocabulary (no arbitrary unbounded strings). */
const reasonCodeSchema = z.enum(GOODS_RETURN_REASON_CODES);

/**
 * §56 — create request. Only goodsReceiptId + optional reference/notes.
 * Status/snapshots/creator/businessId are structurally absent — the server
 * derives every snapshot from the tenant-scoped source receipt (§56).
 */
export const goodsReturnCreateSchema = z.object({
  goodsReceiptId: z.string().trim().min(1).max(64),
  reference: referenceSchema.optional(),
  notes: notesSchema,
});

/**
 * §59 — DRAFT-only header patch. Only reference/notes are patchable;
 * goodsReceiptId/status/snapshots/creator/postedAt/cancelledAt are
 * immutable (a draft return is anchored to exactly one receipt for its
 * whole life — §14).
 */
export const goodsReturnUpdateSchema = z
  .object({
    reference: referenceSchema.optional(),
    notes: notesSchema,
  })
  .refine((v) => v.reference !== undefined || v.notes !== undefined, {
    message: "Nothing to update.",
  });

/**
 * §57 — line create: goodsReceiptLineId + returnedQty + reasonCode. A
 * client-supplied productId is AUTHORITATIVE-FIELD INPUT and is rejected
 * (§28 preferred behavior — reject unexpected authoritative-field input;
 * the product derives from the source receipt line).
 */
export const goodsReturnLineCreateSchema = z
  .object({
    goodsReceiptLineId: z.string().trim().min(1).max(64),
    returnedQty: returnedQtySchema,
    reasonCode: reasonCodeSchema,
  })
  .strict();

/**
 * §58 — line update: ONLY returnedQty + reasonCode. No source-line
 * reassignment, no product reassignment, no snapshot mutation (snapshots
 * are historical, §30).
 */
export const goodsReturnLineUpdateSchema = z
  .object({
    returnedQty: returnedQtySchema,
    reasonCode: reasonCodeSchema,
  })
  .strict();

/**
 * §72 — list filters. q searches return reference + source receipt
 * reference + PO reference snapshot + supplier snapshot + product
 * snapshot names/SKUs (§73). status is a CLOSED vocabulary token
 * (ALL → undefined). goodsReceiptId narrows to one source receipt.
 * from/to are strict calendar dates applied to createdAt (§74). pageSize
 * max 100 (§72); from > to rejected.
 */
export const goodsReturnListQuerySchema = z
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
      .refine((v) => v === undefined || isGoodsReturnStatus(v), {
        message: "Unknown goods return status.",
      }),
    goodsReceiptId: z
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
