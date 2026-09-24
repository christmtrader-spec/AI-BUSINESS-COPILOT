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
import { FREE_PLAN_CODE } from "@/lib/billing/catalog";
import { isBillingPeriod, type BillingPeriod } from "@/lib/billing/state-machine";
import { defaultSettlementCurrency } from "./config";
import {
  currencyMeta,
  isSupportedSettlementCurrency,
  normalizeCurrencyCode,
} from "./currency";

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
