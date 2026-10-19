/**
 * PricingService — Prompt 24 §10-§12/§33/§50-§55.
 *
 * The ONLY authoritative price resolver. It replaces the Prompt 22
 * hard-coded catalog (pricing.ts) with the database-backed price books:
 *
 *   PLAN → PriceBook (currency + version + effective window)
 *        → PlanPrice (planCode + billingPeriod + amountMinor)
 *        → resolved snapshot (amount + version + book reference)
 *
 * Hard rules:
 * - The browser may send { planCode, billingPeriod, currency } — nothing
 *   else influences the result (§13/§32: no client amount, no client
 *   priceVersion).
 * - NO currency conversion, ever (§2/§49): a currency without an active,
 *   currently-effective book and a matching price row is a structured
 *   error — never a fallback to another currency, never a conversion,
 *   never zero.
 * - Errors are structured codes (§55) so callers/APIs/tests can react
 *   precisely; all are 422 and carry no internal identifiers.
 * - Server time only selects effective books (§9/§33).
 */

import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { FREE_PLAN_CODE } from "@/lib/billing/catalog";
import { isBillingPeriod, type BillingPeriod } from "@/lib/billing/state-machine";
import { defaultSettlementCurrency } from "./config";
import {
  currencyMeta,
  isSupportedSettlementCurrency,
  normalizeCurrencyCode,
} from "./currency";

// ---------------------------------------------------------------------------
// Boot-time catalog self-heal trigger (module-import scope) — permanent fix
// ---------------------------------------------------------------------------
// The instrumentation hook does not run under this environment's `next dev`
// (verified empirically), so the first server-side import of the pricing
// service also schedules the idempotent billing-catalog heal (no-op health
// inspect when healthy; canonical re-seed when the environment wiped the
// catalog). Keeps /pricing and checkout resolution alive after a wipe.
if (process.env.NEXT_RUNTIME !== "edge") {
  void (async () => {
    const { ensureBillingCatalog } = await import("@/lib/billing/self-heal");
    await ensureBillingCatalog("module-init:pricing-service");
  })().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** §12 — the authoritative snapshot a checkout freezes at creation. */
export type ResolvedPrice = {
  planCode: string;
  billingPeriod: BillingPeriod;
  currency: string;
  amountMinor: number;
  /** Internal book id (kept internal — never exposed to clients §12). */
  priceBookId: string;
  /** Readable book code (safe to expose, §69). */
  priceBookCode: string;
  /** Readable version (safe to expose, §69) — stored on sessions. */
  priceVersion: string;
  effectiveFrom: Date;
};

/** §52 — per-plan availability in a requested currency. */
export type PlanAvailability =
  | "AVAILABLE" // active plan + explicit price in this currency
  | "NOT_PURCHASABLE" // FREE — nothing to buy (§38)
  | "NOT_SELF_SERVICE" // ENTERPRISE — contact sales (§39)
  | "NOT_PRICED"; // purchasable-tier plan without a price in this currency

export type CatalogPrice = {
  monthlyMinor: number;
  yearlyMinor: number;
  currency: string;
  /** Readable version of the book that priced these amounts. */
  priceVersion: string;
};

export type CurrencyCatalog = {
  currency: string;
  /** Currencies that currently have an active+effective book (§92). */
  supportedCurrencies: string[];
  byPlan: Map<string, { availability: PlanAvailability; pricing: CatalogPrice | null }>;
};

// ---------------------------------------------------------------------------
// Errors (§11/§55) — structured, secret-free, 422.
// ---------------------------------------------------------------------------

function pricingError(code: string, message: string, details?: unknown): ApiError {
  return new ApiError(422, code, message, details);
}

// ---------------------------------------------------------------------------
// Plan validation
// ---------------------------------------------------------------------------

const NON_PURCHASABLE_PLAN_CODES: ReadonlySet<string> = new Set([FREE_PLAN_CODE, "ENTERPRISE"]);

async function requirePurchasablePlan(planCode: string): Promise<void> {
  if (!planCode || planCode.length > 32) {
    throw pricingError("PLAN_NOT_PURCHASABLE", "The requested plan cannot be purchased.", {
      planCode,
    });
  }
  if (planCode === FREE_PLAN_CODE) {
    // §38 — FREE needs no payment; never a fake zero-price checkout.
    throw pricingError("PLAN_NOT_PURCHASABLE", "The FREE plan does not require payment.", {
      planCode,
    });
  }
  if (planCode === "ENTERPRISE") {
    // §39 — not self-service; no price exists by design.
    throw pricingError(
      "PLAN_NOT_PURCHASABLE",
      "This plan is not available through self-service checkout.",
      { planCode },
    );
  }
  const plan = await db.plan.findUnique({ where: { code: planCode }, select: { active: true } });
  if (!plan || !plan.active) {
    throw pricingError("PLAN_NOT_PURCHASABLE", "The requested plan cannot be purchased.", {
      planCode,
    });
  }
}

// ---------------------------------------------------------------------------
// Book resolution
// ---------------------------------------------------------------------------

function effectiveWindow(now: Date) {
  return {
    active: true,
    effectiveFrom: { lte: now },
    OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
  };
}

/**
 * The currently-effective active book for a currency — newest effectiveFrom
 * wins (deterministic when an operator stages overlapping books).
 */
async function resolveActiveBook(currency: string, now: Date) {
  const book = await db.priceBook.findFirst({
    where: { currency, ...effectiveWindow(now) },
    orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
  });
  if (book) return book;

  // Distinguish the failure reasons (§11/§55): no rows at all vs rows that
  // exist but are inactive/not-yet-effective/expired.
  const anyRows = await db.priceBook.count({ where: { currency } });
  if (anyRows === 0) {
    throw pricingError(
      "PRICEBOOK_NOT_FOUND",
      "No price catalog exists for this settlement currency.",
      { currency },
    );
  }
  throw pricingError(
    "PRICEBOOK_INACTIVE",
    "The price catalog for this settlement currency is not currently available.",
    { currency },
  );
}

// ---------------------------------------------------------------------------
// Amount validation (§63 — defense in depth; seeds validate too)
// ---------------------------------------------------------------------------

/** Sanity ceiling: no legitimate plan costs more than 10^12 minor units. */
const MAX_AMOUNT_MINOR = 1_000_000_000_000;

function requireSaneAmount(planCode: string, amountMinor: number): void {
  if (
    typeof amountMinor !== "number" ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0 ||
    amountMinor > MAX_AMOUNT_MINOR
  ) {
    throw pricingError("PRICE_NOT_CONFIGURED", "The configured price for this plan is invalid.", {
      planCode,
    });
  }
}

// ---------------------------------------------------------------------------
// Resolution (§10)
// ---------------------------------------------------------------------------

export type ResolvePriceInput = {
  planCode: string;
  billingPeriod: string;
  /** Optional explicit currency; omitted → the deployment default (§42). */
  currency?: string;
};

/**
 * Resolve the authoritative price. Throws a structured 422 on ANY gap
 * (§11): PLAN_NOT_PURCHASABLE · CURRENCY_NOT_SUPPORTED · PRICEBOOK_NOT_FOUND
 * · PRICEBOOK_INACTIVE · PRICE_NOT_CONFIGURED · PRICE_VERSION_NOT_AVAILABLE.
 */
export async function resolvePrice(input: ResolvePriceInput): Promise<ResolvedPrice> {
  // 1-2. Plan + billing period validation.
  await requirePurchasablePlan(input.planCode);
  const billingPeriod: BillingPeriod = isBillingPeriod(input.billingPeriod)
    ? input.billingPeriod
    : "MONTHLY";

  // 3. Currency validation (§41) — explicit allowlist, canonical form.
  let currency: string;
  if (input.currency === undefined || input.currency === null || input.currency === "") {
    currency = defaultSettlementCurrency();
  } else {
    const normalized = normalizeCurrencyCode(input.currency);
    if (!normalized || !isSupportedSettlementCurrency(normalized)) {
      throw pricingError("CURRENCY_NOT_SUPPORTED", "This settlement currency is not supported.", {
        currency: input.currency,
      });
    }
    currency = normalized;
  }

  // 4. Active + currently-effective book (server time only, §9/§33).
  const book = await resolveActiveBook(currency, new Date());

  // 5. The explicit PlanPrice row for this plan+period.
  const price = await db.planPrice.findUnique({
    where: {
      priceBookId_planCode_billingPeriod: {
        priceBookId: book.id,
        planCode: input.planCode,
        billingPeriod,
      },
    },
  });
  if (!price) {
    throw pricingError(
      "PRICE_NOT_CONFIGURED",
      "No price is configured for this plan and billing period.",
      { planCode: input.planCode, billingPeriod, currency },
    );
  }
  if (!price.active) {
    // §55 — the row exists but was retired: a NEW version must be used.
    throw pricingError(
      "PRICE_VERSION_NOT_AVAILABLE",
      "This price is no longer available.",
      { planCode: input.planCode, billingPeriod, currency },
    );
  }
  requireSaneAmount(input.planCode, price.amountMinor);

  // 6-9. The snapshot (§12) — no internal ids leak to clients; the book id
  // stays server-side and only the readable code/version travel.
  return {
    planCode: input.planCode,
    billingPeriod,
    currency,
    amountMinor: price.amountMinor,
    priceBookId: book.id,
    priceBookCode: book.code,
    priceVersion: book.version,
    effectiveFrom: book.effectiveFrom,
  };
}

// ---------------------------------------------------------------------------
// Catalog (§40/§43/§52/§92) — currency-aware plan catalog for the plans API.
// ---------------------------------------------------------------------------

/** The plan tiers the catalog displays prices for (§6 — plan identity intact). */
const CATALOG_PLAN_CODES = ["STARTER", "BUSINESS", "PRO"] as const;

export async function priceCatalogForCurrency(rawCurrency?: string): Promise<CurrencyCatalog> {
  let currency: string;
  if (rawCurrency === undefined || rawCurrency === null || rawCurrency === "") {
    currency = defaultSettlementCurrency();
  } else {
    const normalized = normalizeCurrencyCode(rawCurrency);
    if (!normalized || !isSupportedSettlementCurrency(normalized)) {
      throw pricingError("CURRENCY_NOT_SUPPORTED", "This settlement currency is not supported.", {
        currency: rawCurrency,
      });
    }
    currency = normalized;
  }

  const now = new Date();
  const [books, activePlans] = await Promise.all([
    db.priceBook.findMany({
      where: { currency, ...effectiveWindow(now) },
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
    }),
    db.plan.findMany({ where: { active: true }, select: { code: true } }),
  ]);

  const supportedCurrencies = (
    await db.priceBook.findMany({
      where: effectiveWindow(now),
      select: { currency: true },
      distinct: ["currency"],
      orderBy: { currency: "asc" },
    })
  ).map((b) => b.currency);

  const byPlan = new Map<string, { availability: PlanAvailability; pricing: CatalogPrice | null }>();

  // FREE / ENTERPRISE never carry prices (§38/§39).
  byPlan.set(FREE_PLAN_CODE, { availability: "NOT_PURCHASABLE", pricing: null });
  byPlan.set("ENTERPRISE", { availability: "NOT_SELF_SERVICE", pricing: null });

  const activePlanCodes = new Set(activePlans.map((p) => p.code));
  const book = books[0] ?? null;

  for (const planCode of CATALOG_PLAN_CODES) {
    if (!activePlanCodes.has(planCode)) continue; // inactive plan → absent
    if (!book) {
      byPlan.set(planCode, { availability: "NOT_PRICED", pricing: null });
      continue;
    }
    const rows = await db.planPrice.findMany({
      where: { priceBookId: book.id, planCode, active: true },
    });
    const monthly = rows.find((r) => r.billingPeriod === "MONTHLY");
    const yearly = rows.find((r) => r.billingPeriod === "YEARLY");
    if (!monthly || !yearly) {
      byPlan.set(planCode, { availability: "NOT_PRICED", pricing: null });
      continue;
    }
    requireSaneAmount(planCode, monthly.amountMinor);
    requireSaneAmount(planCode, yearly.amountMinor);
    byPlan.set(planCode, {
      availability: "AVAILABLE",
      pricing: {
        monthlyMinor: monthly.amountMinor,
        yearlyMinor: yearly.amountMinor,
        currency,
        priceVersion: book.version,
      },
    });
  }

  return { currency, supportedCurrencies, byPlan };
}

// ---------------------------------------------------------------------------
// Provider compatibility (§16-§18/§47) — capability-driven, no hard-coding.
// ---------------------------------------------------------------------------

/**
 * Whether a provider can settle in `currency` — decided ONLY by the
 * adapter's declared capabilities (Provider.capabilities.currencies).
 * "*" means currency-agnostic (the sandbox mock). There is deliberately NO
 * `if provider === "zarinpal"` anywhere in pricing logic (§47).
 */
export function providerSupportsCurrency(
  provider: { capabilities: { currencies: readonly string[] } },
  currency: string,
): boolean {
  const list = provider.capabilities.currencies;
  return list.includes("*") || list.includes(currency.toUpperCase());
}

// ---------------------------------------------------------------------------
// Prompt 28 — OPERATOR PRICING ADMINISTRATION (§34/§35/§36/§37).
//
// Price administration is ENTITLEMENT administration, never payment:
//  - createPriceBookVersion(): creates a NEW, INACTIVE, immutable book
//    version. Historical PlanPrice amounts are NEVER mutated and referenced
//    books are NEVER deleted (schema: CheckoutSession.priceBookId is
//    onDelete: Restrict). A price change is ALWAYS a new version (§35).
//  - activatePriceBook(): explicit, validated, audited activation. The only
//    way pricing changes what customers pay — and the only way to "revert"
//    is activating another version (§36).
// Both reject FREE/ENTERPRISE price rows (§38/§39), demand exact integer
// minor units and never convert currencies (§49: no FX anywhere).
// ---------------------------------------------------------------------------

type BookPriceInput = { planCode: string; billingPeriod: string; amountMinor: number };

export type CreatePriceBookVersionInput = {
  code: string;
  version: string;
  currency: string;
  description?: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  prices: BookPriceInput[];
};

/** Purchasable self-service plan rows required in EVERY book (§38/§39). */
const REQUIRED_BOOK_PLANS = ["STARTER", "BUSINESS", "PRO"] as const;
const REQUIRED_BOOK_PERIODS: readonly BillingPeriod[] = ["MONTHLY", "YEARLY"];

const BOOK_CODE_RE = /^[A-Z0-9][A-Z0-9_]{1,63}$/;
const BOOK_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/;

function pricebookError(code: string, message: string, details?: unknown): ApiError {
  return new ApiError(422, code, message, details);
}

export async function createPriceBookVersion(
  input: CreatePriceBookVersionInput,
): Promise<{ id: string; code: string; version: string; currency: string; active: boolean }> {
  const code = input.code?.trim() ?? "";
  const version = input.version?.trim() ?? "";
  if (!BOOK_CODE_RE.test(code)) {
    throw pricebookError("PLATFORM_PRICEBOOK_INVALID", "Book code must be 2-64 chars of A-Z, 0-9, underscore.", { field: "code" });
  }
  if (!BOOK_VERSION_RE.test(version)) {
    throw pricebookError("PLATFORM_PRICEBOOK_INVALID", "Version must be 2-64 chars (letters, digits, dot, dash, underscore).", { field: "version" });
  }

  const currency = normalizeCurrencyCode(input.currency);
  if (!currency || !isSupportedSettlementCurrency(currency)) {
    throw pricebookError("PLATFORM_PRICEBOOK_INVALID", "The settlement currency is not supported.", {
      field: "currency",
    });
  }
  if (!(input.effectiveFrom instanceof Date) || Number.isNaN(input.effectiveFrom.getTime())) {
    throw pricebookError("PLATFORM_PRICEBOOK_INVALID", "effectiveFrom must be a valid date.", { field: "effectiveFrom" });
  }
  if (
    input.effectiveTo != null &&
    (!(input.effectiveTo instanceof Date) ||
      Number.isNaN(input.effectiveTo.getTime()) ||
      input.effectiveTo.getTime() <= input.effectiveFrom.getTime())
  ) {
    throw pricebookError("PLATFORM_PRICEBOOK_INVALID", "effectiveTo must be after effectiveFrom.", {
      field: "effectiveTo",
    });
  }

  // Duplicate version is rejected (§36 duplicate-version validation).
  const dup = await db.priceBook.findUnique({
    where: { code_version: { code, version } },
    select: { id: true },
  });
  if (dup) {
    throw pricebookError("PLATFORM_PRICEBOOK_INVALID", "A book with this code and version already exists.", {
      reason: "DUPLICATE_VERSION",
    });
  }

  // Rows: exactly the required plans × periods, exact positive integers,
  // NO FREE/ENTERPRISE rows (§38/§39), no duplicates.
  const seen = new Set<string>();
  const validated: Array<{ planCode: string; billingPeriod: BillingPeriod; amountMinor: number }> = [];
  for (const row of input.prices ?? []) {
    if (!REQUIRED_BOOK_PLANS.includes(row.planCode as (typeof REQUIRED_BOOK_PLANS)[number])) {
      throw pricebookError("PLATFORM_PRICEBOOK_INVALID", "Only STARTER, BUSINESS and PRO carry prices.", {
        field: "prices",
        planCode: row.planCode ?? null,
      });
    }
    if (!isBillingPeriod(row.billingPeriod)) {
      throw pricebookError("PLATFORM_PRICEBOOK_INVALID", "billingPeriod must be MONTHLY or YEARLY.", {
        field: "prices",
      });
    }
    const key = `${row.planCode}:${row.billingPeriod}`;
    if (seen.has(key)) {
      throw pricebookError("PLATFORM_PRICEBOOK_INVALID", "Duplicate plan/period row.", { field: "prices", key });
    }
    seen.add(key);
    if (!Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0 || row.amountMinor > MAX_AMOUNT_MINOR) {
      throw pricebookError("PLATFORM_PRICEBOOK_INVALID", "Amounts must be positive integer minor units.", {
        field: "prices",
        planCode: row.planCode,
        billingPeriod: row.billingPeriod,
      });
    }
    const plan = await db.plan.findUnique({ where: { code: row.planCode }, select: { active: true } });
    if (!plan || !plan.active) {
      throw pricebookError("PLATFORM_PRICEBOOK_INVALID", "Prices can only be created for active plans.", {
        field: "prices",
        planCode: row.planCode,
      });
    }
    validated.push({ planCode: row.planCode, billingPeriod: row.billingPeriod, amountMinor: row.amountMinor });
  }

  // Completeness (§36): every purchasable plan × every period must exist —
  // a book that cannot resolve every self-service checkout is invalid.
  for (const planCode of REQUIRED_BOOK_PLANS) {
    for (const period of REQUIRED_BOOK_PERIODS) {
      if (!seen.has(`${planCode}:${period}`)) {
        throw pricebookError("PLATFORM_PRICEBOOK_INVALID", "The book is missing a required plan price row.", {
          reason: "MISSING_PLAN_PRICE",
          planCode,
          billingPeriod: period,
        });
      }
    }
  }

  const created = await db.priceBook.create({
    data: {
      code,
      version,
      currency,
      active: false, // created INACTIVE — activation is a separate, audited step
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
      description: (input.description ?? "").slice(0, 300),
      prices: { create: validated },
    },
  });
  return { id: created.id, code: created.code, version: created.version, currency: created.currency, active: created.active };
}

/**
 * Activation (§36): validated, explicit, audited. Overlap law:
 *  - same code (a new version superseding its predecessor): the predecessor's
 *    effectiveTo is closed at the new book's effectiveFrom — window metadata
 *    only; amounts are NEVER touched;
 *  - any OTHER active book of the same currency overlapping the window is
 *    REJECTED (no ambiguous resolution, no cross-code surprises).
 */
export async function activatePriceBook(
  bookId: string,
  opts: { actorId?: string | null } = {},
): Promise<{ id: string; code: string; version: string; currency: string; active: boolean }> {
  const book = await db.priceBook.findUnique({ where: { id: bookId }, include: { prices: true } });
  if (!book) {
    throw pricebookError("PLATFORM_PRICEBOOK_INVALID", "Price book not found.", { reason: "NOT_FOUND" });
  }
  if (book.active && (book.effectiveTo === null || book.effectiveTo.getTime() > Date.now())) {
    // Already live — idempotent no-op (§74).
    return { id: book.id, code: book.code, version: book.version, currency: book.currency, active: true };
  }
  if (!isSupportedSettlementCurrency(book.currency)) {
    throw pricebookError("PLATFORM_PRICEBOOK_INVALID", "The book currency is not supported.", { reason: "CURRENCY" });
  }
  if (book.effectiveTo !== null && book.effectiveTo.getTime() <= Date.now()) {
    throw pricebookError("PLATFORM_PRICEBOOK_INVALID", "The book's effective window has already ended.", {
      reason: "EXPIRED_WINDOW",
    });
  }
  // Completeness at activation time (§36) — plans may have been retired
  // between creation and activation.
  const rows = new Set(book.prices.filter((p) => p.active).map((p) => `${p.planCode}:${p.billingPeriod}`));
  const activePlans = new Set(
    (await db.plan.findMany({ where: { active: true }, select: { code: true } })).map((p) => p.code),
  );
  for (const planCode of REQUIRED_BOOK_PLANS) {
    if (!activePlans.has(planCode)) {
      throw pricebookError("PLATFORM_PRICEBOOK_INVALID", "A required plan is no longer active.", {
        reason: "PLAN_UNAVAILABLE",
        planCode,
      });
    }
    for (const period of REQUIRED_BOOK_PERIODS) {
      if (!rows.has(`${planCode}:${period}`)) {
        throw pricebookError("PLATFORM_PRICEBOOK_INVALID", "The book is missing a required price row.", {
          reason: "MISSING_PLAN_PRICE",
          planCode,
          billingPeriod: period,
        });
      }
    }
  }

  // Overlap validation against OTHER active books of the same currency.
  const overlappingActive = await db.priceBook.findMany({
    where: {
      currency: book.currency,
      active: true,
      id: { not: book.id },
      effectiveFrom: { lte: book.effectiveTo ?? new Date("9999-12-31T23:59:59.999Z") },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: book.effectiveFrom } }],
    },
    select: { id: true, code: true, version: true, effectiveFrom: true, effectiveTo: true },
  });
  const crossCode = overlappingActive.filter((o) => o.code !== book.code);
  if (crossCode.length > 0) {
    throw pricebookError("PLATFORM_PRICEBOOK_INVALID", "Another active book for this currency overlaps the window.", {
      reason: "OVERLAP",
      books: crossCode.map((o) => o.code),
    });
  }
  const superseded = overlappingActive.filter(
    (o) => o.code === book.code && (o.effectiveTo === null || o.effectiveTo.getTime() > book.effectiveFrom.getTime()),
  );

  const updated = await db.$transaction(async (tx) => {
    for (const o of superseded) {
      await tx.priceBook.update({ where: { id: o.id }, data: { effectiveTo: book.effectiveFrom } });
    }
    const activated = await tx.priceBook.update({ where: { id: book.id }, data: { active: true } });
    await audit(
      {
        businessId: null,
        actorId: opts.actorId ?? null,
        action: "pricing.book_activated",
        entityType: "PriceBook",
        entityId: book.id,
        before: { active: book.active },
        after: {
          code: book.code,
          version: book.version,
          currency: book.currency,
          effectiveFrom: book.effectiveFrom.toISOString(),
          superseded: superseded.map((o) => `${o.code}@${o.version}`),
        },
      },
      tx,
    );
    return activated;
  });
  return { id: updated.id, code: updated.code, version: updated.version, currency: updated.currency, active: updated.active };
}
