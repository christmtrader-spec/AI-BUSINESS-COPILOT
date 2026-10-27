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

/**
 * Three-state PATCH text: ABSENT key → undefined (untouched), explicit
 * null/"" → null (cleared), a real value → trimmed value.
 *
 * NEVER build update schemas with `<create>Schema.partial()` (zod v4):
 * `.partial()` does NOT suppress `.default()` — an absent `stockQty` still
 * fires its default 0 — and `.nullish().transform()` pipelines still RUN
 * for absent keys, funneling untouched nullable fields to null. Caught live
 * by prompt40-stocktake-check (Q4): PATCH {isActive:false} zeroed
 * Product.stockQty; the same idiom cleared sku/unit on product PATCH,
 * phone/email/address/note on party PATCH and supplierId/note on expense
 * PATCH. Absent = untouched; only explicit values (null = clear) are written.
 */
const threeStateText = (v: string | null | undefined) => (v === undefined ? undefined : v || null);

export const partyUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().max(40).nullish().transform(threeStateText),
  email: z
    .union([z.email(), z.literal("")])
    .nullish()
    .transform(threeStateText),
  address: z.string().trim().max(300).nullish().transform(threeStateText),
  note: z.string().trim().max(1000).nullish().transform(threeStateText),
});

export const productCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  sku: z.string().trim().max(60).nullish().transform((v) => v || null),
  unit: z.string().trim().max(20).nullish().transform((v) => v || null),
  salePriceMinor: z.number().int().min(0).max(9_000_000_000),
  costPriceMinor: z.number().int().min(0).max(9_000_000_000),
  stockQty: z.number().int().min(0).default(0),
  lowStockAt: z.number().int().min(0).max(1_000_000).default(5),
});

/** PATCH semantics — absent = untouched, null/"" = clear (see threeStateText). */
export const productUpdateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  sku: z.string().trim().max(60).nullish().transform(threeStateText),
  unit: z.string().trim().max(20).nullish().transform(threeStateText),
  salePriceMinor: z.number().int().min(0).max(9_000_000_000).optional(),
  costPriceMinor: z.number().int().min(0).max(9_000_000_000).optional(),
  // NO defaults on the update schema: a PATCH omitting stockQty must never
  // zero the stock, and one omitting lowStockAt must never reset it to 5.
  stockQty: z.number().int().min(0).optional(),
  lowStockAt: z.number().int().min(0).max(1_000_000).optional(),
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

// Payables aging (§2 row 15) + R81 receivables terms: dueDate is DATE-ONLY
// ("YYYY-MM-DD") — interpreted with the sanctioned Prompt-35 §84 rule
// (UTC midnoon) so the calendar day is identical in every display timezone.
// Garbage calendar dates (2026-02-31) are rejected, not silently nulled.
// SHARED authority: sales, expenses and supplier bills parse terms through
// this one schema — one law for both sides of the book.
export const dueDateStringSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
  // JS Date ROLLS OVER out-of-range days (2026-02-31 → Mar 3), so the NaN
  // check alone would silently accept garbage. Validate the calendar day
  // explicitly (leap-year aware) BEFORE constructing the instant.
  .refine(
    (v) => {
      const [y, m, d] = v.split("-").map(Number);
      if (m < 1 || m > 12 || d < 1) return false;
      const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return d <= daysInMonth;
    },
    "Invalid calendar date.",
  )
  .transform((v) => new Date(`${v}T12:00:00.000Z`))
  .refine((d) => !Number.isNaN(d.getTime()), "Invalid calendar date.");

export const saleCreateSchema = z.object({
  customerId: z.string().trim().max(64).nullish().transform((v) => v || null),
  items: z.array(saleItemInputSchema).min(1, "At least one line item is required").max(50),
  discountMinor: z.number().int().min(0).max(9_000_000_000).default(0),
  note: z.string().trim().max(1000).nullish().transform((v) => v || null),
  issueDate: z.string().datetime().nullish().transform((v) => (v ? new Date(v) : null)),
  // R81 — stated payment terms. Absent/null → null (no terms stated — the
  // honest AGING framing); "YYYY-MM-DD" → §84 UTC-midnoon instant.
  dueDate: dueDateStringSchema.nullish().transform((v) => (v == null ? null : v)),
});

export const expenseCreateSchema = z.object({
  supplierId: z.string().trim().max(64).nullish().transform((v) => v || null),
  category: z.string().trim().min(1).max(60),
  amountMinor: z.number().int().min(1).max(9_000_000_000),
  spentAt: z.string().datetime().nullish().transform((v) => (v ? new Date(v) : null)),
  // undefined → undefined (absent = "untouched" for PATCH), null → null
  // (explicit clear), "YYYY-MM-DD" → UTC-midnoon Date (§84).
  dueDate: dueDateStringSchema
    .nullish()
    .transform((v) => (v === undefined ? undefined : v)),
  reference: z
    .string()
    .trim()
    .max(80)
    .nullish()
    .transform((v) => (v === undefined ? undefined : v || null)),
  note: z.string().trim().max(1000).nullish().transform((v) => v || null),
});

/** PATCH semantics — absent = untouched, null = clear (see threeStateText). */
export const expenseUpdateSchema = z.object({
  supplierId: z.string().trim().max(64).nullish().transform(threeStateText),
  category: z.string().trim().min(1).max(60).optional(),
  amountMinor: z.number().int().min(1).max(9_000_000_000).optional(),
  spentAt: z
    .string()
    .datetime()
    .nullish()
    .transform((v) => (v === undefined ? undefined : v ? new Date(v) : null)),
  // undefined → undefined (absent = "untouched" for PATCH), null → null
  // (explicit clear), "YYYY-MM-DD" → UTC-midnoon Date (§84).
  dueDate: dueDateStringSchema.nullish().transform((v) => (v === undefined ? undefined : v)),
  reference: z.string().trim().max(80).nullish().transform(threeStateText),
  note: z.string().trim().max(1000).nullish().transform(threeStateText),
});

/** PATCH semantics — absent = untouched, null = clear (see threeStateText). */
export const saleUpdateSchema = z.object({
  customerId: z.string().trim().max(64).nullish().transform(threeStateText),
  // R83 — PATCH three-state law for stated terms: absent → undefined
  // (untouched — NOT null, which would clear), null → null (explicit clear
  // back to the honest AGING framing), "YYYY-MM-DD" → §84 midnoon instant.
  dueDate: dueDateStringSchema.nullish().transform((v) => (v === undefined ? undefined : v)),
  note: z.string().trim().max(1000).nullish().transform(threeStateText),
});

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
  // Prompt 21 idempotency (§16/§17): a client retrying the SAME logical
  // question re-sends the SAME requestId so the server never double-charges
  // usage. Optional + format-validated: the server generates one when
  // absent, and the client can never inject a non-UUID value into the
  // usage ledger (arbitrary strings are rejected, not trusted).
  requestId: z
    .string()
    .trim()
    .regex(
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
      "requestId must be a UUID.",
    )
    .optional(),
});

// R126 — stream stop/resume. The stop beacon and the resume poll address
// the Prompt 21 requestId (the answer's logical identity): the client
// generates one UUID per logical question, so stop/resume can never be
// tricked into touching another user's stream (ownership is re-checked
// server-side against the buffer's embedded businessId+userId).
export const copilotStopSchema = z.object({
  requestId: z
    .string()
    .trim()
    .regex(
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
      "requestId must be a UUID.",
    ),
});

export const copilotResumeSchema = z.object({
  requestId: z
    .string()
    .trim()
    .regex(
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
      "requestId must be a UUID.",
    ),
  // Index of the first delta the client has NOT seen (0-based). The buffer
  // is capped at 64KB per answer, so a sane client index is bounded; the
  // store clamps/serves what exists and reports overflow honestly.
  fromIndex: z.number().int().min(0).max(100_000),
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

// ---------------------------------------------------------------------------
// Prompt 20 — billing (§98: every billing input is validated; plan codes
// are stable machine identifiers, never display names).
// ---------------------------------------------------------------------------

/** Stable machine plan code: FREE | STARTER | BUSINESS | PRO | ENTERPRISE. */
export const planCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{1,39}$/, "Invalid plan code.");

/** POST /api/v1/billing/change-plan */
export const changePlanSchema = z.object({ planCode: planCodeSchema });

/** POST /api/v1/billing/cancel — §44 cancelAtPeriodEnd semantics. */
export const billingCancelSchema = z.object({}).strict();

/** POST /api/v1/billing/reactivate */
export const billingReactivateSchema = z.object({}).strict();

/**
 * POST /api/v1/billing/checkout — Prompt 22 + Prompt 24 §95. The browser
 * supplies ONLY the target plan + period + (optionally) the desired
 * settlement currency; the amount and price version are resolved and
 * snapshotted SERVER-side (PricingService) and are never client-supplied.
 * `.strict()` (Prompt 24 §80): any extra field — an `amount`, a
 * `priceVersion`, anything — is a 400 rejection, not a silent ignore.
 */
export const billingCheckoutSchema = z
  .object({
    planCode: planCodeSchema,
    billingPeriod: z.enum(["MONTHLY", "YEARLY"]).default("MONTHLY"),
    // Prompt 24 §41 — validated against the settlement allowlist by the
    // PricingService; arbitrary currency codes are 422 CURRENCY_NOT_SUPPORTED.
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter ISO 4217 code")
      .transform((c) => c.toUpperCase())
      .optional(),
  })
  .strict();

/** POST /api/v1/billing/checkout/[id]/simulate — sandbox provider only. */
export const billingSimulateSchema = z.object({
  outcome: z.enum(["succeeded", "failed", "expired"]),
});

/**
 * POST /api/v1/billing/trial — domain capability only (§19). The endpoint
 * is disabled unless the operator sets BILLING_TRIALS_ENABLED=1; nothing
 * starts trials automatically and there is no self-service policy yet.
 */
export const billingTrialSchema = z.object({
  action: z.enum(["start", "end"]),
  days: z.number().int().min(1).max(90).default(14),
});
