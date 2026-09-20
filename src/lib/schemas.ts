/**
 * Shared zod schemas for Phase 02 master-data APIs.
 * Server contract: money arrives as integer MINOR UNITS (A08) —
 * decimal→minor conversion happens client-side via lib/money.
 */
import { z } from "zod";

export const optionalEmail = z
  .union([z.email(), z.literal("")])
  .nullish()
  .transform((v) => (v ? v : null));

export const partyCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(40).nullish().transform((v) => v || null),
  email: optionalEmail,
  address: z.string().trim().max(300).nullish().transform((v) => v || null),
  note: z.string().trim().max(1000).nullish().transform((v) => v || null),
});

export const partyUpdateSchema = partyCreateSchema.partial();

export const productCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  sku: z.string().trim().max(60).nullish().transform((v) => v || null),
  unit: z.string().trim().max(20).nullish().transform((v) => v || null),
  salePriceMinor: z.number().int().min(0).max(9_000_000_000),
  costPriceMinor: z.number().int().min(0).max(9_000_000_000),
  stockQty: z.number().int().min(0).default(0),
  lowStockAt: z.number().int().min(0).max(1_000_000).default(5),
});

export const productUpdateSchema = productCreateSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const stockAdjustSchema = z.object({
  delta: z.number().int().refine((v) => v !== 0, "delta must be non-zero"),
  reason: z.string().trim().min(1).max(200),
});

/** Parse + clamp list query params. */
export function listParams(url: URL) {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  const pageRaw = Number(url.searchParams.get("page") ?? 1);
  const sizeRaw = Number(url.searchParams.get("pageSize") ?? 20);
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const pageSize =
    Number.isInteger(sizeRaw) && sizeRaw > 0 && sizeRaw <= 100 ? sizeRaw : 20;
  return { q, page, pageSize };
}
