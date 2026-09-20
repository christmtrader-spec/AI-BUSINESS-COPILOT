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

/** Parse an optional status filter for transactions. */
export function statusParam(url: URL): "UNPAID" | "PARTIAL" | "PAID" | null {
  const raw = (url.searchParams.get("status") ?? "").trim().toUpperCase();
  if (raw === "UNPAID" || raw === "PARTIAL" || raw === "PAID") return raw;
  return null;
}

// ---------------------------------------------------------------------------
// Phase 03 — Transactions. Money arrives as integer MINOR UNITS (A08);
// totals/discounts are recomputed server-side — client values are never
// trusted for line totals or the final total.
// ---------------------------------------------------------------------------

export const PAYMENT_METHODS = ["CASH", "BANK_TRANSFER", "CARD", "OTHER"] as const;

export const saleItemInputSchema = z.object({
  productId: z.string().trim().max(64).nullish().transform((v) => v || null),
  name: z.string().trim().min(1).max(160),
  unit: z.string().trim().max(20).nullish().transform((v) => v || null),
  qty: z.number().int().min(1).max(1_000_000),
  unitPriceMinor: z.number().int().min(0).max(9_000_000_000),
});

export const saleCreateSchema = z.object({
  customerId: z.string().trim().max(64).nullish().transform((v) => v || null),
  items: z.array(saleItemInputSchema).min(1, "At least one line item is required").max(50),
  discountMinor: z.number().int().min(0).max(9_000_000_000).default(0),
  note: z.string().trim().max(1000).nullish().transform((v) => v || null),
  issueDate: z.string().datetime().nullish().transform((v) => (v ? new Date(v) : null)),
});

export const expenseCreateSchema = z.object({
  supplierId: z.string().trim().max(64).nullish().transform((v) => v || null),
  category: z.string().trim().min(1).max(60),
  amountMinor: z.number().int().min(1).max(9_000_000_000),
  spentAt: z.string().datetime().nullish().transform((v) => (v ? new Date(v) : null)),
  note: z.string().trim().max(1000).nullish().transform((v) => v || null),
});

export const expenseUpdateSchema = expenseCreateSchema.partial();

export const paymentCreateSchema = z
  .object({
    saleId: z.string().trim().max(64).nullish().transform((v) => v || null),
    expenseId: z.string().trim().max(64).nullish().transform((v) => v || null),
    amountMinor: z.number().int().min(1).max(9_000_000_000),
    method: z.enum(PAYMENT_METHODS),
    note: z.string().trim().max(500).nullish().transform((v) => v || null),
    paidAt: z.string().datetime().nullish().transform((v) => (v ? new Date(v) : null)),
  })
  .refine((v) => Boolean(v.saleId) !== Boolean(v.expenseId), {
    message: "A payment must target exactly one sale or one expense.",
    path: ["saleId"],
  });
