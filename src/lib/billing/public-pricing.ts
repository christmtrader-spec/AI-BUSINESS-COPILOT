/**
 * Public pricing DTO builder — Prompt 25.
 *
 * Maps the AUTHORITATIVE PricingService catalog (PriceBook → PlanPrice rows,
 * server time resolution) into a tenant-safe, id-free public shape:
 * - NO PriceBook ids, plan DB ids, operator metadata, provider costs or
 *   reconciliation data ever cross this boundary.
 * - Availability is reported HONESTLY: NOT_PRICED is never displayed as
 *   "Free"; FREE is its own explicit plan kind; ENTERPRISE is Contact Sales
 *   with no checkout and no fake price.
 * - Prices are the EXACT stored integer minor units — no derived yearly
 *   amounts, no FX, no floating point.
 * - The CTA matrix is computed SERVER-SIDE from real capabilities (trial
 *   config, availability) — the browser never decides what is purchasable.
 */

import { ENTITLEMENTS, PLANS, type PlanCode } from "@/lib/billing/catalog";
import {
  priceCatalogForCurrency,
  type PlanAvailability,
} from "@/lib/payments/pricing-service";
import { isSupportedSettlementCurrency, normalizeCurrencyCode } from "@/lib/payments/currency";
import { ApiError } from "@/lib/api-helpers";
import { getTrialConfig } from "@/lib/billing/trial-config";
import { paymentsAvailable } from "@/lib/payments/config";

/** Entitlement feature entry — structure only; labels are localized in UI. */
export type PublicPlanFeature = {
  code: string;
  type: "LIMIT" | "BOOLEAN";
  /** LIMIT: number or null = unlimited. BOOLEAN: flag. */
  value: number | null | boolean;
  unit: string | null;
};

/** Server-computed call-to-action — the browser never invents purchase CTAs. */
export type PublicPlanCta = {
  kind: "SIGNUP" | "TRIAL" | "GET_STARTED" | "CONTACT_SALES";
  /** Capability state behind the CTA (honesty surface, §Prompt25). */
  state:
    | "TRIAL_AVAILABLE"
    | "PAYMENT_AVAILABLE"
    | "PAYMENT_DISABLED"
    | "NOT_SELF_SERVICE"
    | "NOT_PURCHASABLE"
    | "NOT_CONFIGURED";
  /** Trial length when a trial is genuinely available (else null). */
  trialDays: number | null;
};

export type PublicPlanPricing = {
  currency: string;
  /** Stored integer minor units — the ONLY price representation. */
  monthlyMinor: number;
  /** Stored integer minor units for the explicit YEARLY row. */
  yearlyMinor: number;
  /** Readable catalog version that priced these amounts. */
  priceVersion: string;
};

export type PublicPlanDTO = {
  code: string;
  name: string;
  description: string;
  /** Authoritative catalog ordering (NOT the DB id). */
  sortOrder: number;
  selfService: boolean;
  availability: PlanAvailability;
  pricing: PublicPlanPricing | null;
  features: PublicPlanFeature[];
  cta: PublicPlanCta;
};

export type PublicPricingDTO = {
  currency: string;
  /** Currencies that currently have an active+effective book. */
  supportedCurrencies: string[];
  /** Show a currency switcher ONLY when the architecture truly supports >1. */
  currencySwitcherAvailable: boolean;
  /** Whether the trial capability is genuinely configured right now. */
  trialAvailable: boolean;
  trialDays: number | null;
  /** Payment initiation status — surfaced honestly (never faked). */
  paymentsEnabled: boolean;
  /** Operator-configured sales contact for ENTERPRISE (no invented default). */
  contactSalesUrl: string | null;
  plans: PublicPlanDTO[];
};

function ctaForPlan(
  code: string,
  availability: PlanAvailability,
  trial: { available: boolean; days: number | null },
): PublicPlanCta {
  if (code === "FREE") {
    return { kind: "SIGNUP", state: "NOT_PURCHASABLE", trialDays: null };
  }
  if (code === "ENTERPRISE") {
    return { kind: "CONTACT_SALES", state: "NOT_SELF_SERVICE", trialDays: null };
  }
  if (availability === "AVAILABLE") {
    if (trial.available) {
      return { kind: "TRIAL", state: "TRIAL_AVAILABLE", trialDays: trial.days };
    }
    // Payment-initiation disabled for real purchase → an honest
    // "Get Started" (signup) — never a fake "Buy Now".
    return { kind: "GET_STARTED", state: "PAYMENT_DISABLED", trialDays: null };
  }
  // NOT_PRICED in this currency → cannot promise purchase; account creation
  // remains possible. NOT_CONFIGURED is the honest state.
  return { kind: "GET_STARTED", state: "NOT_CONFIGURED", trialDays: null };
}

export async function buildPublicPricing(rawCurrency?: string | null): Promise<PublicPricingDTO> {
  let currency: string | undefined;
  if (rawCurrency !== undefined && rawCurrency !== null && rawCurrency !== "") {
    const normalized = normalizeCurrencyCode(rawCurrency);
    if (!normalized || !isSupportedSettlementCurrency(normalized)) {
      throw new ApiError(422, "CURRENCY_NOT_SUPPORTED", "This settlement currency is not supported.", {
        currency: rawCurrency,
      });
    }
    currency = normalized;
  }

  const catalog = await priceCatalogForCurrency(currency);
  const trialConfig = getTrialConfig();
  const paymentsEnabled = paymentsAvailable();
  const trial = {
    available: trialConfig.enabled,
    days: trialConfig.trialDays,
  };

  const planByCode = new Map(PLANS.map((p) => [p.code, p]));

  const plans: PublicPlanDTO[] = [];
  for (const spec of PLANS) {
    const entry = catalog.byPlan.get(spec.code as PlanCode);
    // Inactive plans silently vanish from the authoritative catalog —
    // mirror that here (an inactive plan is never advertised publicly).
    const availability = entry?.availability ?? "NOT_PRICED";
    const pricing = entry?.pricing ?? null;

    const features: PublicPlanFeature[] = ENTITLEMENTS.map((e) => ({
      code: e.code,
      type: e.type,
      // §Prompt25 comparison law: LIMIT null = UNLIMITED — NEVER collapsed to
      // 0 (0 is a real finite limit; null means unlimited). The seed
      // guarantees every plan lists every entitlement, so undefined can only
      // be a code bug — the fallback keeps types honest without inventing 0.
      value:
        spec.entitlements[e.code] !== undefined
          ? spec.entitlements[e.code]
          : e.type === "LIMIT"
            ? 0
            : false,
      unit: e.type === "LIMIT" ? e.unit : null,
    }));

    plans.push({
      code: spec.code,
      name: spec.name,
      description: spec.description,
      sortOrder: spec.sortOrder,
      selfService: spec.code !== "ENTERPRISE",
      availability,
      pricing: pricing
        ? {
            currency: pricing.currency,
            monthlyMinor: pricing.monthlyMinor,
            yearlyMinor: pricing.yearlyMinor,
            priceVersion: pricing.priceVersion,
          }
        : null,
      features,
      cta: ctaForPlan(spec.code, availability, trial),
    });
  }
  void planByCode;

  return {
    currency: catalog.currency,
    supportedCurrencies: catalog.supportedCurrencies,
    currencySwitcherAvailable: catalog.supportedCurrencies.length > 1,
    trialAvailable: trialConfig.enabled,
    trialDays: trialConfig.trialDays,
    paymentsEnabled,
    // Enterprise contact channel is operator-configured; when absent the UI
    // renders an honest disabled CTA — never a fake form or fake mailto.
    contactSalesUrl:
      typeof process.env.NEXT_PUBLIC_SALES_CONTACT === "string" &&
      process.env.NEXT_PUBLIC_SALES_CONTACT.trim().length > 0
        ? process.env.NEXT_PUBLIC_SALES_CONTACT.trim()
        : null,
    plans,
  };
}
