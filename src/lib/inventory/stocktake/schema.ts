/**
 * Prompt 40 — zod request schemas for the stocktake APIs (server-side).
 *
 * Closed vocabulary enforcement (§7/§9/§24): countType can only be omitted
 * (→ SELECTED) or explicitly "SELECTED"; status is NEVER client input.
 * countedQty: integer 0..1_000_000_000 (§17) — the ONLY client quantity.
 */
import { z } from "zod";
import {
  STOCKTAKE_NOTES_MAX,
  STOCKTAKE_REFERENCE_MAX,
  STOCKTAKE_REFERENCE_MIN,
  COUNTED_QTY_MAX,
  isStocktakeCountType,
} from "./types";

export const stocktakeCreateSchema = z.object({
  reference: z
    .string()
    .trim()
    .min(STOCKTAKE_REFERENCE_MIN)
    .max(STOCKTAKE_REFERENCE_MAX),
  notes: z
    .string()
    .trim()
    .max(STOCKTAKE_NOTES_MAX)
    .nullish()
    .transform((v) => v || null),
  countType: z
    .string()
    .refine((v) => isStocktakeCountType(v), { message: "Unsupported count type." })
    .optional(),
});

/** §52 — DRAFT-only edit endpoint: reference/notes only. Never status. */
export const stocktakeUpdateSchema = z
  .object({
    reference: z
      .string()
      .trim()
      .min(STOCKTAKE_REFERENCE_MIN)
      .max(STOCKTAKE_REFERENCE_MAX)
      .optional(),
    notes: z
      .string()
      .trim()
      .max(STOCKTAKE_NOTES_MAX)
      .nullish()
      .transform((v) => (v === undefined ? undefined : v || null)),
  })
  .refine((v) => v.reference !== undefined || v.notes !== undefined, {
    message: "Nothing to update.",
  });

export const stocktakeAddLineSchema = z.object({
  productId: z.string().trim().min(1).max(64),
});

export const stocktakeCountSchema = z.object({
  countedQty: z
    .number()
    .int("countedQty must be an integer.")
    .min(0)
    .max(COUNTED_QTY_MAX),
});

/** §25 — list filters: q searches reference ONLY; bounded pagination. */
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Strict calendar-date validation for list filters — rejects 2026-02-31 and
 * any JS Date rollover (same lesson as Prompt 38's dueDate leap-year refine
 * and Prompt 39 §94: a format-only regex let 2026-02-31 roll over to
 * 2026-03-03 and silently filter the wrong window).
 */
function isValidCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

const calendarDate = z
  .string()
  .refine(isValidCalendarDate, "Use a valid YYYY-MM-DD calendar date.");

export const stocktakeListQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .max(STOCKTAKE_REFERENCE_MAX)
      .optional()
      .transform((v) => v || undefined),
    status: z
      .string()
      .optional()
      .transform((v) => v || undefined),
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

/** §26/§65 — detail line pagination, default 50, max 100. */
export const stocktakeLinesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});
