/**
 * Public pricing catalog — Prompt 25 §4-§7/§21/§60/§81/§116/§125-§127.
 *
 * The PUBLIC pricing layer over the authoritative PricingService. It NEVER
 * invents prices: every amount flows from priceCatalogForCurrency() (the
 * same resolver checkout uses — §136/§119: one catalog, one truth). The
 * endpoint built on this module requires NO session and exposes NO internal
 * identifiers (no DB ids, no audit metadata, no provider internals §116).
 *
 * Honest availability model:
 * - A currency is listed when the platform ALLOWS it for settlement
 *   (SETTLEMENT_CURRENCIES) — but `available` is true only when an active,
 *   currently-effective price book exists (§81: never assume EUR/IRR exist).
 * - A plan without a price in the requested currency is NOT_PRICED —
 *   never zero, never converted (§19/§23/§78: no FX anywhere).
 *
 * Caching (§60): a small in-process TTL cache keeps the public page fast
 * (§125: one endpoint, few queries) while never serving stale prices as
 * authoritative: TTL is short (30s) AND checkout always re-resolves the
 * price server-side (§118/§119 — the pricing page is informational only).
 */

import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";
import { ENTITLEMENTS, configuredTrialDays } from "@/lib/billing/catalog";
import { SETTLEMENT_CURRENCIES, currencyMeta } from "./currency";
import { priceCatalogForCurrency, type CatalogPrice, type PlanAvailability } from "./pricing-service";
import { defaultSettlementCurrency, paymentsAvailable } from "./config";

export type PublicPlanPrice = {
  monthlyMinor: number;
  yearlyMinor: number;
  currency: string;
  priceVersion: string;
};

export type PublicPlan = {
  code: string;
  name: string;
  description: string;
  /** Stable catalog order (§7) — never sorted client-side. */
  sortOrder: number;
  /** false only for ENTERPRISE (negotiated, not self-service). */
  selfService: boolean;
  availability: PlanAvailability;
  /** Server-authoritative price (null for FREE/ENTERPRISE/unpriced — §6). */
  pricing: PublicPlanPrice | null;
  /** Entitlement snapshot for the comparison table (§10 — same catalog). */
  entitlements: Record<string, number | null | boolean>;
};

export type PublicCurrency = {
  code: string;
  displayName: string;
  symbol: string;
  minorUnitExponent: number;
  /** Active + currently-effective price book exists for this currency. */
  available: boolean;
};

export type PublicPricingPayload = {
  plans: PublicPlan[];
  /** Entitlement presentation metadata (§139 — codes are stable machines,
   *  display names live in i18n; the group powers the comparison layout). */
  definitions: Array<{
    code: string;
    type: "LIMIT" | "BOOLEAN";
    unit: string | null;
    group: string;
  }>;
  /** The currency THIS payload's prices are denominated in. */
  settlementCurrency: string;
  currencies: PublicCurrency[];
  paymentsEnabled: boolean;
  trialsEnabled: boolean;
  /** CONFIGURED trial length (§34) — only meaningful when trialsEnabled. */
  trialDays: number | null;
  /** §74 — the EXPLICIT featured plan (operator configuration), never
   *  inferred from price. null = no featured plan is configured. */
  featuredPlan: string | null;
};

// ---------------------------------------------------------------------------
// Feature groups (§70) — presentation metadata ONLY; the machine codes in
// ENTITLEMENT_CODES are untouched (§139). Only genuinely implemented
// capabilities are grouped (no FILE STORAGE etc., §12).
// ---------------------------------------------------------------------------

const ENTITLEMENT_GROUPS: Record<string, string> = {
  CUSTOMERS_MAX: "business",
  PRODUCTS_MAX: "business",
  BUSINESSES_MAX: "business",
  TEAM_MEMBERS_MAX: "team",
  AI_COPILOT: "ai",
  AI_REQUESTS_MAX: "ai",
  AI_MESSAGES_MAX: "ai",
  ADVANCED_REPORTS: "reporting",
  CSV_EXPORT: "exports",
};

// ---------------------------------------------------------------------------
// Catalog resolution (graceful per currency)
// ---------------------------------------------------------------------------

type CatalogCacheEntry = { payload: PublicPricingPayload; expiresAt: number };

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CatalogCacheEntry>();

/** Test/operator hook — clears the public pricing cache (§117). */
export function invalidatePublicPricingCache(): void {
  cache.clear();
}

/**
 * Which settlement currencies currently have an active + effective book.
 * One indexed query; the allowlist keeps the result deterministic.
 */
async function currencyAvailability(now: Date): Promise<Map<string, boolean>> {
  const books = await db.priceBook.findMany({
    where: {
      active: true,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    select: { currency: true },
    distinct: ["currency"],
  });
  const withBook = new Set(books.map((b) => b.currency));
  const map = new Map<string, boolean>();
  for (const code of SETTLEMENT_CURRENCIES) {
    map.set(code, withBook.has(code));
  }
  return map;
}

/**
 * Build the public payload for ONE settlement currency. `catalog` may be
 * null when that currency has no usable book — paid plans then resolve to
 * NOT_PRICED honestly (§127: EUR stays available while IRR shows
 * unavailable; the whole page never fails because one currency is unpriced).
 */
async function buildPayload(currency: string, catalog: Awaited<ReturnType<typeof priceCatalogForCurrency>> | null): Promise<PublicPricingPayload> {
  const now = new Date();
  const [plans, availability] = await Promise.all([
    db.plan.findMany({
      where: { active: true, isPublic: true },
      orderBy: { sortOrder: "asc" },
      include: { planEntitlements: { include: { entitlement: true } } },
    }),
    currencyAvailability(now),
  ]);

  const currencies: PublicCurrency[] = [];
  for (const code of SETTLEMENT_CURRENCIES) {
    const meta = currencyMeta(code);
    if (!meta) continue;
    currencies.push({
      code,
      displayName: meta.displayName,
      symbol: meta.symbol,
      minorUnitExponent: meta.minorUnitExponent,
      available: availability.get(code) ?? false,
    });
  }

  const planCatalog: PublicPlan[] = plans.map((p) => {
    const item = catalog?.byPlan.get(p.code) ?? null;
    const pricing: CatalogPrice | null = item?.pricing ?? null;
    return {
      code: p.code,
      // DB names are English catalog strings; the UI localizes display
      // copy by plan code (§8) — the API keeps neutral catalog text.
      name: p.name,
      description: p.description,
      sortOrder: p.sortOrder,
      selfService: p.code !== "ENTERPRISE",
      availability: item?.availability ?? "NOT_PRICED",
      pricing: pricing
        ? {
            monthlyMinor: pricing.monthlyMinor,
            yearlyMinor: pricing.yearlyMinor,
            currency: pricing.currency,
            priceVersion: pricing.priceVersion,
          }
        : null,
      entitlements: Object.fromEntries(
        p.planEntitlements.map((pe) => [
          pe.entitlement.code,
          pe.entitlement.type === "LIMIT" ? pe.value : pe.boolValue,
        ]),
      ),
    };
  });

  return {
    plans: planCatalog,
    // Filled by definitionsFromCatalog() in publicPricingForCurrency —
    // kept out of buildPayload so the cache entry stays currency-scoped.
    definitions: [],
    settlementCurrency: currency,
    currencies,
    paymentsEnabled: paymentsAvailable(),
    trialsEnabled: process.env.BILLING_TRIALS_ENABLED === "1",
    trialDays: process.env.BILLING_TRIALS_ENABLED === "1" ? configuredTrialDays() : null,
    featuredPlan: featuredPlanFromEnv(),
  };
}

/**
 * §74 — the featured plan is an EXPLICIT operator configuration
 * (PRICING_FEATURED_PLAN=<PLAN_CODE>), never inferred from price and never
 * a hard-coded "most popular" claim. Empty/invalid → null (no highlight).
 */
function featuredPlanFromEnv(): string | null {
  const raw = process.env.PRICING_FEATURED_PLAN?.trim().toUpperCase();
  return raw && /^[A-Z0-9_]{1,32}$/.test(raw) ? raw : null;
}

/** The definition TYPE/UNIT must come from the real catalog (§10/§138). */
function definitionsFromCatalog(): PublicPricingPayload["definitions"] {
  return ENTITLEMENTS.map((d) => ({
    code: d.code,
    type: d.type,
    unit: d.unit,
    group: ENTITLEMENT_GROUPS[d.code] ?? "business",
  }));
}

/**
 * The public pricing payload for an OPTIONAL currency parameter.
 * - Invalid/unsupported currency → structured 422 (never guessed).
 * - A currency WITH an active book → full prices from the PricingService.
 * - A currency WITHOUT a book (e.g. IRR today) → valid payload with
 *   available:false and NOT_PRICED paid plans (§78 — unavailable, not zero).
 */
export async function publicPricingForCurrency(rawCurrency?: string | null): Promise<PublicPricingPayload> {
  let currency: string;
  if (rawCurrency === undefined || rawCurrency === null || rawCurrency === "") {
    currency = defaultSettlementCurrency();
  } else {
    const { normalizeCurrencyCode, isSupportedSettlementCurrency } = await import("./currency");
    const normalized = normalizeCurrencyCode(rawCurrency);
    if (!normalized || !isSupportedSettlementCurrency(normalized)) {
      throw new ApiError(422, "CURRENCY_NOT_SUPPORTED", "This settlement currency is not supported.", {
        currency: rawCurrency,
      });
    }
    currency = normalized;
  }

  const cached = cache.get(currency);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;

  // Reuse the AUTHORITATIVE catalog resolver; a missing/inactive book for
  // the requested currency is honest unavailability here, not an error.
  let catalog: Awaited<ReturnType<typeof priceCatalogForCurrency>> | null = null;
  try {
    catalog = await priceCatalogForCurrency(currency);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "PRICEBOOK_NOT_FOUND" && code !== "PRICEBOOK_INACTIVE") throw error;
  }

  const [payload, definitions] = await Promise.all([buildPayload(currency, catalog), definitionsFromCatalog()]);
  payload.definitions = definitions;

  cache.set(currency, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
  return payload;
}
