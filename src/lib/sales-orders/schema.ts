/**
 * Prompt 45 — zod request schemas for the sales-order APIs (server-side).
 *
 * LAWS (inherited from the audited P41–P45 pattern):
 *  - status / lifecycle timestamps / currency snapshot / customer snapshot
 *    / product snapshots / createdBy / totals / dispatchedQty /
 *    remainingToDispatchQty / salesOrderId are NEVER client input
 *    (§112) — the server derives every authority field. .strict() rejects
 *    forbidden authority fields at the boundary.
 *  - orderedQty is an integer 1..1_000_000 (§18) — zod rejects 0,
 *    negatives, 1.5, NaN and Infinity at the boundary.
 *  - unitPriceMinor is an integer 0..9_000_000_000 (§21/§22).
 *  - dates are strict calendar dates (no rollover — 2026-02-31 and
 *    2026-13-01 rejected).
 *  - reference is normalized server-side (trim/collapse/control chars);
 *    blank → server generation (§14).
 */
import { z } from "zod";
import {
  ORDER_QTY_MIN,
  SALES_ORDER_NOTES_MAX,
  SALES_ORDER_PRICE_MAX,
  SALES_ORDER_QTY_MAX,
  SALES_ORDER_REFERENCE_MAX,
  SALES_ORDER_REFERENCE_MIN,
  isSalesOrderStatus,
  isValidCalendarDate,
  normalizeSalesOrderReference,
} from "./types";

const calendarDate = z
  .string()
  .refine(isValidCalendarDate, "Use a valid YYYY-MM-DD calendar date.");

/**
 * Reference schema: server-side normalization (trim/collapse/control
 * chars) then bounds. A blank/whitespace-only value becomes undefined →
 * the service generates SO-<date>-<token>; a PROVIDED but invalid
 * reference (control chars, <2 or >80 visible chars) → 422.
 */
const referenceSchema = z
  .string()
  .max(SALES_ORDER_REFERENCE_MAX + 16) // pre-normalization headroom
  .optional()
  .transform((v) => (v === undefined ? undefined : v.trim() || undefined))
  .refine((v) => v === undefined || normalizeSalesOrderReference(v) !== null, {
    message: `Reference must be ${SALES_ORDER_REFERENCE_MIN}-${SALES_ORDER_REFERENCE_MAX} visible characters.`,
  })
  .transform((v) => (v === undefined ? undefined : (normalizeSalesOrderReference(v) as string)));

/** Notes: trimmed, blank → null, bounded; three-state in patches. */
const notesSchema = z
  .string()
  .max(SALES_ORDER_NOTES_MAX + 16) // pre-trim headroom
  .nullish()
  .transform((v) => (v == null ? v : v.trim() || null))
  .refine((v) => v == null || v.length <= SALES_ORDER_NOTES_MAX, {
    message: `Notes must be at most ${SALES_ORDER_NOTES_MAX} characters.`,
  });

/** orderedQty boundary: integer 1..1_000_000 (§18). */
const orderedQtySchema = z
  .number()
  .int("orderedQty must be an integer.")
  .min(ORDER_QTY_MIN, "orderedQty must be at least 1.")
  .max(SALES_ORDER_QTY_MAX);

/** unitPriceMinor boundary: integer 0..9_000_000_000 (§21). Absent → the
 * agreed price defaults from Product.salePriceMinor SERVER-side (§21). */
const unitPriceMinorSchema = z
  .number()
  .int("unitPriceMinor must be an integer.")
  .min(0, "unitPriceMinor cannot be negative.")
  .max(SALES_ORDER_PRICE_MAX);

/**
 * Create request (§75). Only customer/reference/dates/discount/notes are
 * client fields. Status, currency snapshot, customer snapshot, totals,
 * creator and businessId are structurally absent — .strict() rejects any
 * injected authority field (§112).
 */
export const salesOrderCreateSchema = z
  .object({
    customerId: z
      .string()
      .trim()
      .max(64)
      .optional()
      .transform((v) => v || undefined),
    reference: referenceSchema.optional(),
    orderDate: calendarDate.optional(),
    expectedDate: calendarDate.optional().nullable().transform((v) => v || undefined),
    discountMinor: z.number().int().min(0).max(SALES_ORDER_PRICE_MAX).optional(),
    notes: notesSchema,
  })
  .strict();

/**
 * DRAFT-only header patch (§26). Allowed: reference, orderDate,
 * expectedDate, discountMinor, notes, customerId (where supported).
 * Forbidden: businessId, status, currency snapshot, createdByUserId,
 * lifecycle timestamps, computed totals — .strict() + field allowlist.
 */
export const salesOrderUpdateSchema = z
  .object({
    customerId: z
      .string()
      .trim()
      .max(64)
      .nullish()
      .transform((v) => (v == null ? (v === null ? null : undefined) : v || undefined)),
    reference: referenceSchema.optional(),
    orderDate: calendarDate.optional(),
    expectedDate: calendarDate.nullish().transform((v) => (v === undefined ? undefined : v || null)),
    discountMinor: z.number().int().min(0).max(SALES_ORDER_PRICE_MAX).optional(),
    notes: notesSchema,
  })
  .strict()
  .refine(
    (v) =>
      v.customerId !== undefined ||
      v.reference !== undefined ||
      v.orderDate !== undefined ||
      v.expectedDate !== undefined ||
      v.discountMinor !== undefined ||
      v.notes !== undefined,
    { message: "Nothing to update." },
  );

/** Line create (§20/§21): productId + orderedQty (+ optional price). */
export const salesOrderLineCreateSchema = z
  .object({
    productId: z.string().trim().min(1).max(64),
    orderedQty: orderedQtySchema,
    unitPriceMinor: unitPriceMinorSchema.optional(),
  })
  .strict();

/** Line update: ONLY orderedQty and/or unitPriceMinor. No product
 * reassignment, no snapshot mutation (snapshots are historical, frozen at
 * add time). */
export const salesOrderLineUpdateSchema = z
  .object({
    orderedQty: orderedQtySchema.optional(),
    unitPriceMinor: unitPriceMinorSchema.optional(),
  })
  .strict()
  .refine((v) => v.orderedQty !== undefined || v.unitPriceMinor !== undefined, {
    message: "Nothing to update.",
  });

/**
 * §40 — order-context linked dispatch creation. Only notes are client
 * fields; the customer snapshot, order link and status derive from the
 * SERVER (the dispatch gets its own business-unique reference §35).
 */
export const salesOrderDispatchCreateSchema = z
  .object({
    notes: notesSchema,
  })
  .strict();

/**
 * List filters (§67). q searches order reference + customer snapshot +
 * product snapshot names/SKUs. status is a CLOSED vocabulary token
 * (ALL → undefined). customerId narrows to one customer. from/to are
 * strict calendar dates applied to createdAt. pageSize max 100;
 * from > to rejected.
 */
export const salesOrderListQuerySchema = z
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
      .transform((v) => ((v || undefined) === "ALL" ? undefined : v || undefined))
      .refine((v) => v === undefined || isSalesOrderStatus(v), {
        message: "Unknown sales order status.",
      }),
    customerId: z
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
