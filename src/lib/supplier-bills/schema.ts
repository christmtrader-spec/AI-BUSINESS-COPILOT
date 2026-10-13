/**
 * Prompt 48 — zod request schemas for the supplier-bill APIs (server).
 *
 * LAWS (inherited from the audited P41–P47 pattern):
 *  - status / lifecycle timestamps / currency snapshot / supplier snapshot
 *    / PO snapshot / product snapshots / createdBy / totals / expenseId /
 *    postedAt / cancelledAt are NEVER client input (§15 analog) — the
 *    server derives every authority field. .strict() rejects forbidden
 *    authority fields at the boundary.
 *  - billedQty is an integer 1..1_000_000 (§6) — zod rejects 0, negatives,
 *    1.5, NaN and Infinity at the boundary.
 *  - unitPriceMinor is an integer 0..1_000_000_000 (§8) — zero allowed
 *    (free invoice line, P41 §29 law); a zero TOTAL bill is rejected by
 *    the POSTING policy, not by the line schema.
 *  - billDate is REQUIRED and strict-calendar (no rollover); dueDate is
 *    optional and strict-calendar. Both normalize to the canonical
 *    UTC-midnoon instant (date-only business semantics, Prompt-35 §84).
 *  - lineTotalMinor / subtotalMinor / totalMinor / discount-derived totals
 *    are STRUCTURALLY ABSENT from every client schema — server-derived
 *    only (§9: "Do not trust client-supplied totals").
 *  - Unsupported charge fields (tax, shipping, FX) are rejected by
 *    .strict() rather than silently dropped (§9).
 *  - reference is normalized server-side (trim/collapse/control chars);
 *    blank → server generation (SB-<date>-<token>).
 *  - internalNotes are bounded; NEVER echoed into search/audit/export (§16).
 */
import { z } from "zod";
import {
  BILL_UNIT_PRICE_MINOR_MAX,
  BILLED_QTY_MAX,
  BILLED_QTY_MIN,
  SUPPLIER_BILL_INVOICE_REFERENCE_MAX,
  SUPPLIER_BILL_NOTES_MAX,
  SUPPLIER_BILL_REFERENCE_MAX,
  SUPPLIER_BILL_REFERENCE_MIN,
  isValidCalendarDate,
  normalizeSupplierBillReference,
  normalizeSupplierInvoiceReference,
} from "./types";

const calendarDate = z
  .string()
  .refine(isValidCalendarDate, "Use a valid YYYY-MM-DD calendar date.");

/**
 * Internal reference schema: server-side normalization then bounds. Blank →
 * undefined → the service generates SB-<date>-<token>; a PROVIDED but
 * invalid reference (control chars, <2 or >80 visible chars) → 422.
 */
const referenceSchema = z
  .string()
  .max(SUPPLIER_BILL_REFERENCE_MAX + 16) // pre-normalization headroom
  .optional()
  .transform((v) => (v === undefined ? undefined : v.trim() || undefined))
  .refine((v) => v === undefined || normalizeSupplierBillReference(v) !== null, {
    message: `Reference must be ${SUPPLIER_BILL_REFERENCE_MIN}-${SUPPLIER_BILL_REFERENCE_MAX} visible characters.`,
  })
  .transform((v) =>
    v === undefined ? undefined : (normalizeSupplierBillReference(v) as string),
  );

/**
 * Supplier invoice reference: optional, three-state in patches (undefined =
 * untouched, null = clear), normalized, bounded, uniqueness enforced by the
 * (businessId, supplierId, supplierInvoiceReference) DB constraint.
 */
const supplierInvoiceReferenceSchema = z
  .string()
  .max(SUPPLIER_BILL_INVOICE_REFERENCE_MAX + 16)
  .nullish()
  .transform((v) =>
    v === undefined ? undefined : v === null ? null : v.trim() || null,
  )
  .refine((v) => v === undefined || v === null || normalizeSupplierInvoiceReference(v) !== null, {
    message: `Supplier invoice reference must be at most ${SUPPLIER_BILL_INVOICE_REFERENCE_MAX} visible characters without control characters.`,
  })
  .transform((v) =>
    v === undefined || v === null ? v : (normalizeSupplierInvoiceReference(v) as string),
  );

/** INTERNAL notes: bounded; never audited/searched/exported (§16). */
const internalNotesSchema = z
  .string()
  .max(SUPPLIER_BILL_NOTES_MAX + 16) // pre-trim headroom
  .nullish()
  .transform((v) => (v == null ? v : v.trim() || null))
  .refine((v) => v == null || v.length <= SUPPLIER_BILL_NOTES_MAX, {
    message: `Notes must be at most ${SUPPLIER_BILL_NOTES_MAX} characters.`,
  });

/** billedQty boundary: integer 1..1_000_000 (§6). */
const billedQtySchema = z
  .number()
  .int("billedQty must be an integer.")
  .min(BILLED_QTY_MIN, "billedQty must be at least 1.")
  .max(BILLED_QTY_MAX);

/** unitPriceMinor boundary: integer 0..1_000_000_000 (§8). */
const unitPriceMinorSchema = z
  .number()
  .int("unitPriceMinor must be an integer.")
  .min(0, "unitPriceMinor cannot be negative.")
  .max(BILL_UNIT_PRICE_MINOR_MAX);

/** Bill-level discount: integer ≥ 0; discount ≤ subtotal is enforced by the
 * canonical totals math in the service (which owns the subtotal). */
const discountMinorSchema = z
  .number()
  .int("discountMinor must be an integer.")
  .min(0, "discountMinor cannot be negative.")
  .max(BILL_UNIT_PRICE_MINOR_MAX);

/**
 * Create request (§5/§15). The bill is born against EXACTLY ONE purchase
 * order — supplier, currency and PO snapshots derive from that PO
 * server-side. billDate is REQUIRED (the invoice date is the point of the
 * document). Status/currency/supplier snapshots/totals/expense link are
 * structurally absent — .strict() rejects any injected authority field.
 */
export const supplierBillCreateSchema = z
  .object({
    purchaseOrderId: z
      .string()
      .trim()
      .min(1, "purchaseOrderId is required.")
      .max(64),
    reference: referenceSchema,
    supplierInvoiceReference: supplierInvoiceReferenceSchema,
    billDate: calendarDate,
    dueDate: calendarDate.optional().nullable().transform((v) => v || undefined),
    discountMinor: discountMinorSchema.optional(),
    internalNotes: internalNotesSchema,
  })
  .strict();

/**
 * DRAFT-only header patch (§10). Allowed: supplierInvoiceReference,
 * billDate, dueDate, discountMinor, internalNotes. Forbidden (immutable
 * relations): supplierId, purchaseOrderId, reference, status, currency,
 * totals, expenseId — .strict() rejects them.
 */
export const supplierBillUpdateSchema = z
  .object({
    supplierInvoiceReference: supplierInvoiceReferenceSchema,
    billDate: calendarDate.optional(),
    dueDate: calendarDate.nullish().transform((v) => (v === undefined ? undefined : v)),
    discountMinor: discountMinorSchema.optional(),
    internalNotes: internalNotesSchema,
  })
  .strict();

/** Draft line add (§6). The PO line is the procurement product authority. */
export const supplierBillLineAddSchema = z
  .object({
    purchaseOrderLineId: z
      .string()
      .trim()
      .min(1, "purchaseOrderLineId is required.")
      .max(64),
    billedQty: billedQtySchema,
    unitPriceMinor: unitPriceMinorSchema,
  })
  .strict();

/** Draft line patch — the PO line of an existing line NEVER changes. */
export const supplierBillLineUpdateSchema = z
  .object({
    billedQty: billedQtySchema.optional(),
    unitPriceMinor: unitPriceMinorSchema.optional(),
  })
  .strict();

/** List filters (§15) — bounded pagination; date windows are calendar dates. */
export const supplierBillListQuerySchema = z
  .object({
    q: z.string().trim().max(80).optional(),
    supplierId: z.string().trim().max(64).optional(),
    purchaseOrderId: z.string().trim().max(64).optional(),
    status: z
      .enum(["DRAFT", "POSTED", "CANCELLED"])
      .optional(),
    billDateFrom: calendarDate.optional(),
    billDateTo: calendarDate.optional(),
    dueDateFrom: calendarDate.optional(),
    dueDateTo: calendarDate.optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
