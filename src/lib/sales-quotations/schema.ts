/**
 * Prompt 47 — zod request schemas for the sales-quotation APIs (server).
 *
 * LAWS (inherited from the audited P41–P45 pattern):
 *  - status / lifecycle timestamps / currency snapshot / customer snapshot
 *    / product snapshots / createdBy / totals / convertedAt /
 *    sourceQuotationId are NEVER client input (§15) — the server derives
 *    every authority field. .strict() rejects forbidden authority fields
 *    at the boundary.
 *  - qty is an integer 1..1_000_000 (§6) — zod rejects 0, negatives, 1.5,
 *    NaN and Infinity at the boundary.
 *  - unitPriceMinor is an integer 0..9_000_000_000 (§6/§11).
 *  - dates are strict calendar dates (no rollover — 2026-02-31 and
 *    2026-13-01 rejected). The validity ORDERING (validUntil ≥
 *    quotationDate) is enforced in the service against the derived
 *    defaults so a partial patch cannot dodge it.
 *  - reference is normalized server-side (trim/collapse/control chars);
 *    blank → server generation (§10).
 *  - customerNotes/internalNotes are bounded; internal notes are NEVER
 *    echoed into search, audit payloads or the printable offer (§10/§16).
 */
import { z } from "zod";
import {
  QUOTATION_QTY_MIN,
  SALES_QUOTATION_CUSTOMER_NOTES_MAX,
  SALES_QUOTATION_INTERNAL_NOTES_MAX,
  SALES_QUOTATION_PRICE_MAX,
  SALES_QUOTATION_QTY_MAX,
  SALES_QUOTATION_REFERENCE_MAX,
  SALES_QUOTATION_REFERENCE_MIN,
  isSalesQuotationStatus,
  isValidCalendarDate,
  normalizeSalesQuotationReference,
} from "./types";

const calendarDate = z
  .string()
  .refine(isValidCalendarDate, "Use a valid YYYY-MM-DD calendar date.");

/**
 * Reference schema: server-side normalization (trim/collapse/control
 * chars) then bounds. A blank/whitespace-only value becomes undefined →
 * the service generates QT-<date>-<token>; a PROVIDED but invalid
 * reference (control chars, <2 or >80 visible chars) → 422.
 */
const referenceSchema = z
  .string()
  .max(SALES_QUOTATION_REFERENCE_MAX + 16) // pre-normalization headroom
  .optional()
  .transform((v) => (v === undefined ? undefined : v.trim() || undefined))
  .refine((v) => v === undefined || normalizeSalesQuotationReference(v) !== null, {
    message: `Reference must be ${SALES_QUOTATION_REFERENCE_MIN}-${SALES_QUOTATION_REFERENCE_MAX} visible characters.`,
  })
  .transform((v) => (v === undefined ? undefined : (normalizeSalesQuotationReference(v) as string)));

/** Customer-facing notes: trimmed, blank → null, bounded; 3-state in patches. */
const customerNotesSchema = z
  .string()
  .max(SALES_QUOTATION_CUSTOMER_NOTES_MAX + 16) // pre-trim headroom
  .nullish()
  .transform((v) => (v == null ? v : v.trim() || null))
  .refine((v) => v == null || v.length <= SALES_QUOTATION_CUSTOMER_NOTES_MAX, {
    message: `Notes must be at most ${SALES_QUOTATION_CUSTOMER_NOTES_MAX} characters.`,
  });

/** INTERNAL notes: bounded the same way; never audited/searched/printed. */
const internalNotesSchema = z
  .string()
  .max(SALES_QUOTATION_INTERNAL_NOTES_MAX + 16)
  .nullish()
  .transform((v) => (v == null ? v : v.trim() || null))
  .refine((v) => v == null || v.length <= SALES_QUOTATION_INTERNAL_NOTES_MAX, {
    message: `Notes must be at most ${SALES_QUOTATION_INTERNAL_NOTES_MAX} characters.`,
  });

/** qty boundary: integer 1..1_000_000 (§6). */
const qtySchema = z
  .number()
  .int("qty must be an integer.")
  .min(QUOTATION_QTY_MIN, "qty must be at least 1.")
  .max(SALES_QUOTATION_QTY_MAX);

/** unitPriceMinor boundary: integer 0..9_000_000_000 (§6). Absent → the
 * offered price defaults from Product.salePriceMinor SERVER-side (§6/§12). */
const unitPriceMinorSchema = z
  .number()
  .int("unitPriceMinor must be an integer.")
  .min(0, "unitPriceMinor cannot be negative.")
  .max(SALES_QUOTATION_PRICE_MAX);

/**
 * Create request (§10). Only customer/reference/dates/discount/notes are
 * client fields. Status, currency snapshot, customer snapshot, totals,
 * creator and businessId are structurally absent — .strict() rejects any
 * injected authority field (§15). validUntilDate is REQUIRED (the offer's
 * validity is the point of a quotation); quotationDate defaults to the
 * SERVER's business-local today (§10).
 */
export const salesQuotationCreateSchema = z
  .object({
    customerId: z
      .string()
      .trim()
      .max(64)
      .optional()
      .transform((v) => v || undefined),
    reference: referenceSchema.optional(),
    quotationDate: calendarDate.optional(),
    validUntilDate: calendarDate,
    expectedDeliveryDate: calendarDate.optional().nullable().transform((v) => v || undefined),
    discountMinor: z.number().int().min(0).max(SALES_QUOTATION_PRICE_MAX).optional(),
    customerNotes: customerNotesSchema,
    internalNotes: internalNotesSchema,
  })
  .strict();

/**
 * DRAFT-only header patch (§10). Allowed: customerId, reference,
 * quotationDate, validUntilDate, expectedDeliveryDate, discountMinor,
 * customerNotes, internalNotes. Forbidden: businessId, status, currency
 * snapshot, createdByUserId, lifecycle timestamps, computed totals,
 * converted order link — .strict() + field allowlist.
 */
export const salesQuotationUpdateSchema = z
  .object({
    customerId: z
      .string()
      .trim()
      .max(64)
      .nullish()
      .transform((v) => (v == null ? (v === null ? null : undefined) : v || undefined)),
    reference: referenceSchema.optional(),
    quotationDate: calendarDate.optional(),
    validUntilDate: calendarDate.optional(),
    expectedDeliveryDate: calendarDate.nullish().transform((v) => (v === undefined ? undefined : v || null)),
    discountMinor: z.number().int().min(0).max(SALES_QUOTATION_PRICE_MAX).optional(),
    customerNotes: customerNotesSchema,
    internalNotes: internalNotesSchema,
  })
  .strict()
  .refine(
    (v) =>
      v.customerId !== undefined ||
      v.reference !== undefined ||
      v.quotationDate !== undefined ||
      v.validUntilDate !== undefined ||
      v.expectedDeliveryDate !== undefined ||
      v.discountMinor !== undefined ||
      v.customerNotes !== undefined ||
      v.internalNotes !== undefined,
    { message: "Nothing to update." },
  );

/** Line create (§11): productId + qty (+ optional offered price). */
export const salesQuotationLineCreateSchema = z
  .object({
    productId: z.string().trim().min(1).max(64),
    qty: qtySchema,
    unitPriceMinor: unitPriceMinorSchema.optional(),
  })
  .strict();

/** Line update: ONLY qty and/or unitPriceMinor. No product reassignment,
 * no snapshot mutation (snapshots are historical, frozen at add time). */
export const salesQuotationLineUpdateSchema = z
  .object({
    qty: qtySchema.optional(),
    unitPriceMinor: unitPriceMinorSchema.optional(),
  })
  .strict()
  .refine((v) => v.qty !== undefined || v.unitPriceMinor !== undefined, {
    message: "Nothing to update.",
  });

/**
 * List filters (§15). q searches quotation reference + customer snapshot +
 * product snapshot names/SKUs. status is a CLOSED vocabulary token
 * (ALL → undefined). customerId narrows to one customer. from/to are
 * strict calendar dates applied to quotationDate in the AUTHENTICATED
 * business timezone (never a client timezone). pageSize max 100;
 * from > to rejected.
 */
export const salesQuotationListQuerySchema = z
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
      .refine((v) => v === undefined || isSalesQuotationStatus(v), {
        message: "Unknown sales quotation status.",
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

/** Export locale: strict, only en|fa (shared portability convention). */
export const salesQuotationExportQuerySchema = z.object({
  locale: z.enum(["en", "fa"]).optional(),
});
