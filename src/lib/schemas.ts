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

// ---------------------------------------------------------------------------
// Phase 05 — AI Copilot (read-only). The question and history are plain
// user text; all authoritative figures are injected server-side from
// lib/reports.ts (A11-A13) — nothing financial is accepted from the client.
// ---------------------------------------------------------------------------

export const copilotMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(2000),
});

export const copilotAskSchema = z.object({
  question: z.string().trim().min(1, "Ask a question first.").max(500),
  history: z.array(copilotMessageSchema).max(8).default([]),
  days: z
    .union([z.literal(7), z.literal(30), z.literal(90)])
    .catch(30)
    .default(30),
});

// ---------------------------------------------------------------------------
// Phase 07 — Copilot transcript persistence. The client keeps its own
// session/message ids; the server validates FORMAT (never trusts content
// beyond plain text) and caps sizes. Failed answers are intentionally not
// synced (client filters them before calling).
// ---------------------------------------------------------------------------

/** Client session id: "s-" + 11-40 url-safe chars (collision-proof uuid slice). */
export const chatSessionIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{6,64}$/, "Malformed session id.");

export const chatMessageAppendSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(8000),
  // Citation provenance — arbitrary JSON object, size-capped; never financial
  // authority (figures are recomputed on every ask — A11-A13).
  meta: z.unknown().optional(),
  // Only used when this append CREATES the session (auto-titled).
  title: z.string().trim().max(80).optional(),
});

/** PATCH /copilot/sessions/[id] — rename and/or pin one conversation. */
export const chatSessionUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    pinned: z.boolean().optional(),
  })
  .refine((v) => v.title !== undefined || v.pinned !== undefined, {
    message: "Nothing to update.",
  });
