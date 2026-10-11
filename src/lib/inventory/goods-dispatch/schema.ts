/**
 * Prompt 44 — zod request schemas for the goods-dispatch APIs (server-side).
 *
 * LAWS (inherited from the audited P43 pattern):
 *  - status is NEVER client input — post/cancel live on dedicated
 *    endpoints and the server derives them from the current row state.
 *  - businessId / customer snapshot / product snapshots / createdBy /
 *    postedAt are NEVER accepted from the client. Unlike P43 returns
 *    (where productId was rejected because the server derived it from the
 *    receipt line), a DISPATCH line's authoritative input IS the product —
 *    the user picks the product directly; snapshots still derive
 *    server-side from the tenant-scoped Product row.
 *  - qty is an integer 1..1_000_000 — zod rejects 0, negatives, 1.5, NaN
 *    and Infinity at the boundary.
 *  - reasonCode is the closed vocabulary — no arbitrary strings.
 *  - dates are strict calendar dates (no rollover — 2026-02-31 and
 *    2026-13-01 rejected).
 */
import { z } from "zod";
import {
  GOODS_DISPATCH_NOTES_MAX,
  GOODS_DISPATCH_QTY_MAX,
  GOODS_DISPATCH_REFERENCE_MAX,
  GOODS_DISPATCH_REFERENCE_MIN,
  DISPATCH_QTY_MIN,
  GOODS_DISPATCH_REASON_CODES,
  isGoodsDispatchStatus,
  normalizeGoodsDispatchReference,
  isValidCalendarDate,
} from "./types";

const calendarDate = z
  .string()
  .refine(isValidCalendarDate, "Use a valid YYYY-MM-DD calendar date.");

/**
 * Reference schema: server-side normalization (trim/collapse/control
 * chars) then bounds. A blank/whitespace-only value becomes undefined →
 * the service generates DSP-<date>-<token>; a PROVIDED but invalid
 * reference (control chars, <2 or >80 visible chars) → 422.
 */
const referenceSchema = z
  .string()
  .max(GOODS_DISPATCH_REFERENCE_MAX + 16) // pre-normalization headroom
  .optional()
  .transform((v) => (v === undefined ? undefined : v.trim() || undefined))
  .refine((v) => v === undefined || normalizeGoodsDispatchReference(v) !== null, {
    message: `Reference must be ${GOODS_DISPATCH_REFERENCE_MIN}-${GOODS_DISPATCH_REFERENCE_MAX} visible characters.`,
  })
  .transform((v) => (v === undefined ? undefined : (normalizeGoodsDispatchReference(v) as string)));

/** Notes: trimmed, blank → null, bounded; three-state in patches. */
const notesSchema = z
  .string()
  .max(GOODS_DISPATCH_NOTES_MAX + 16) // pre-trim headroom
  .nullish()
  .transform((v) => (v == null ? v : v.trim() || null))
  .refine((v) => v == null || v.length <= GOODS_DISPATCH_NOTES_MAX, {
    message: `Notes must be at most ${GOODS_DISPATCH_NOTES_MAX} characters.`,
  });

/** qty boundary: integer 1..1_000_000. */
const qtySchema = z
  .number()
  .int("qty must be an integer.")
  .min(DISPATCH_QTY_MIN, "qty must be at least 1.")
  .max(GOODS_DISPATCH_QTY_MAX);

/** Closed reason vocabulary (no arbitrary unbounded strings). */
const reasonCodeSchema = z.enum(GOODS_DISPATCH_REASON_CODES);

/**
 * Create request. Only customerId (optional) + optional reference/notes.
 * Status/customer snapshot/creator/businessId are structurally absent —
 * the server derives every snapshot from the tenant-scoped rows.
 */
export const goodsDispatchCreateSchema = z.object({
  customerId: z
    .string()
    .trim()
    .max(64)
    .optional()
    .transform((v) => v || undefined),
  reference: referenceSchema.optional(),
  notes: notesSchema,
});

/** DRAFT-only header patch. Only reference/notes are patchable. */
export const goodsDispatchUpdateSchema = z
  .object({
    reference: referenceSchema.optional(),
    notes: notesSchema,
  })
  .refine((v) => v.reference !== undefined || v.notes !== undefined, {
    message: "Nothing to update.",
  });

/**
 * Line create — TWO explicit source modes (Prompt 45 §41):
 *  - STANDALONE (P44 contract): productId + qty + reasonCode;
 *  - ORDER-BASED (Prompt 45): salesOrderLineId + qty ONLY — the product,
 *    snapshots, customer and reason derive from the order (server-controlled;
 *    injecting productId/reasonCode with a salesOrderLineId is rejected).
 * Strict — no extra authoritative fields (goodsDispatchId, snapshots,
 * status, businessId) are accepted.
 */
export const goodsDispatchLineCreateSchema = z
  .object({
    productId: z.string().trim().min(1).max(64).optional(),
    salesOrderLineId: z.string().trim().min(1).max(64).optional(),
    qty: qtySchema,
    reasonCode: reasonCodeSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.salesOrderLineId) {
      if (v.productId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Provide either productId (standalone) or salesOrderLineId (order-based), not both.",
          path: ["salesOrderLineId"],
        });
      }
      if (v.reasonCode !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "The dispatch reason is server-controlled for order fulfillment.",
          path: ["reasonCode"],
        });
      }
    } else if (!v.productId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A dispatch line requires productId or salesOrderLineId.",
        path: ["productId"],
      });
    } else if (!v.reasonCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "reasonCode is required.",
        path: ["reasonCode"],
      });
    }
  });

/** Line update: ONLY qty (+ reasonCode on STANDALONE dispatches — order
 *  lines keep the server-controlled SALE reason). No product reassignment,
 *  no snapshot mutation (snapshots are historical, frozen at add time). */
export const goodsDispatchLineUpdateSchema = z
  .object({
    qty: qtySchema,
    reasonCode: reasonCodeSchema.optional(),
  })
  .strict();

/**
 * List filters. q searches dispatch reference + customer snapshot +
 * product snapshot names/SKUs. status is a CLOSED vocabulary token
 * (ALL → undefined). customerId narrows to one customer. from/to are
 * strict calendar dates applied to createdAt. pageSize max 100;
 * from > to rejected.
 */
export const goodsDispatchListQuerySchema = z
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
      .refine((v) => v === undefined || isGoodsDispatchStatus(v), {
        message: "Unknown goods dispatch status.",
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
