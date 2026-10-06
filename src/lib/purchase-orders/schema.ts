/**
 * Prompt 41 — zod request schemas for the purchase-order APIs (server-side).
 *
 * LAWS:
 *  - status is NEVER client input (§14/§42) — transitions live on dedicated
 *    endpoints and the server derives them from the current row state.
 *  - businessId / currency snapshot / supplierNameAtOrder / createdByUserId /
 *    any total are NEVER accepted from the client (§164/§145/§146/§209).
 *  - expectedDate is strict calendar-date semantics (§20): 2026-02-31 is
 *    rejected, 2024-02-29 accepted, 2025-02-29 rejected — no JS rollover.
 *  - orderedQty integer 1..1_000_000 (§28); unitPriceMinor integer
 *    0..9_000_000_000 (§29, zero allowed for free/promotional lines).
 */
import { z } from "zod";
import {
  ORDERED_QTY_MAX,
  ORDERED_QTY_MIN,
  PURCHASE_ORDER_NOTES_MAX,
  PURCHASE_ORDER_REFERENCE_MAX,
  PURCHASE_ORDER_REFERENCE_MIN,
  UNIT_PRICE_MINOR_MAX,
  UNIT_PRICE_MINOR_MIN,
  isPurchaseOrderStatus,
  normalizePurchaseOrderReference,
} from "./types";

/** §20 — strict calendar-date validation (no silent rollover). */
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
 * §12/§13 — reference schema: server-side normalization (trim/collapse/
 * control chars) then bounds. A blank/whitespace-only value becomes
 * undefined → the service generates PO-<date>-<token> (§13); a PROVIDED
 * but invalid reference (control chars, <2 or >80 visible chars) → 422.
 */
const referenceSchema = z
  .string()
  .max(PURCHASE_ORDER_REFERENCE_MAX + 16) // pre-normalization headroom
  .optional()
  .transform((v) => (v === undefined ? undefined : v.trim() || undefined))
  .refine((v) => v === undefined || normalizePurchaseOrderReference(v) !== null, {
    message: `Reference must be ${PURCHASE_ORDER_REFERENCE_MIN}-${PURCHASE_ORDER_REFERENCE_MAX} visible characters.`,
  })
  .transform((v) => (v === undefined ? undefined : (normalizePurchaseOrderReference(v) as string)));

/** §21 — notes: trimmed, blank → null, bounded; three-state in patches. */
const notesSchema = z
  .string()
  .max(PURCHASE_ORDER_NOTES_MAX + 16) // pre-trim headroom
  .nullish()
  .transform((v) => (v == null ? v : v.trim() || null))
  .refine((v) => v == null || v.length <= PURCHASE_ORDER_NOTES_MAX, {
    message: `Notes must be at most ${PURCHASE_ORDER_NOTES_MAX} characters.`,
  });

/**
 * §164 — create request. reference MAY be omitted/blank → the service
 * generates PO-<date>-<token> (§13). orderedAt defaults to "now" when
 * omitted. Supplier/product/business/currency/status/totals never come
 * from the client.
 */
export const purchaseOrderCreateSchema = z.object({
  supplierId: z.string().trim().min(1).max(64),
  reference: referenceSchema.optional(),
  orderedAt: calendarDate.optional(),
  expectedDate: calendarDate.nullish().transform((v) => v || null),
  notes: notesSchema,
});

/**
 * §43 — DRAFT-only header patch. Only reference/orderedAt/expectedDate/notes
 * are patchable; businessId/supplierId/status/currency snapshot/creator/
 * lifecycle timestamps are structurally impossible to submit. Omitted fields
 * are unchanged; explicit null clears (§167 three-state convention).
 */
export const purchaseOrderUpdateSchema = z
  .object({
    reference: referenceSchema.optional(),
    orderedAt: calendarDate.optional(),
    expectedDate: z
      .union([calendarDate, z.null()])
      .optional()
      .transform((v) => (v === undefined ? undefined : v)),
    notes: notesSchema,
  })
  .refine(
    (v) =>
      v.reference !== undefined ||
      v.orderedAt !== undefined ||
      v.expectedDate !== undefined ||
      v.notes !== undefined,
    { message: "Nothing to update." },
  );

/** §165 — line create: ONLY productId + orderedQty + unitPriceMinor. */
export const purchaseOrderLineCreateSchema = z.object({
  productId: z.string().trim().min(1).max(64),
  orderedQty: z
    .number()
    .int("orderedQty must be an integer.")
    .min(ORDERED_QTY_MIN, "orderedQty must be at least 1.")
    .max(ORDERED_QTY_MAX),
  unitPriceMinor: z
    .number()
    .int("unitPriceMinor must be an integer.")
    .min(UNIT_PRICE_MINOR_MIN, "unitPriceMinor cannot be negative.")
    .max(UNIT_PRICE_MINOR_MAX),
});

/**
 * §166 — line update: ONLY orderedQty + unitPriceMinor. productId and the
 * snapshots are immutable for the life of the line (§35).
 */
export const purchaseOrderLineUpdateSchema = z
  .object({
    orderedQty: z
      .number()
      .int("orderedQty must be an integer.")
      .min(ORDERED_QTY_MIN, "orderedQty must be at least 1.")
      .max(ORDERED_QTY_MAX)
      .optional(),
    unitPriceMinor: z
      .number()
      .int("unitPriceMinor must be an integer.")
      .min(UNIT_PRICE_MINOR_MIN, "unitPriceMinor cannot be negative.")
      .max(UNIT_PRICE_MINOR_MAX)
      .optional(),
  })
  .refine((v) => v.orderedQty !== undefined || v.unitPriceMinor !== undefined, {
    message: "Nothing to update.",
  });

/**
 * §52/§54 — list filters. q searches reference + supplier snapshot +
 * product snapshot names/SKUs (§53). from/to are strict calendar dates on
 * orderedAt; from > to is rejected. pageSize max 100 (§52).
 */
export const purchaseOrderListQuerySchema = z
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
      .transform((v) => v || undefined)
      .refine((v) => v === undefined || isPurchaseOrderStatus(v), {
        message: "Unknown purchase order status.",
      }),
    from: calendarDate
      .optional()
      .transform((v) => v || undefined),
    to: calendarDate
      .optional()
      .transform((v) => v || undefined),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: "from must be on or before to.",
    path: ["from"],
  });
