/**
 * Payment pricing — Prompt 22.
 *
 * SERVER-AUTHORITATIVE price catalog (Prompt 20 §39 deferred prices to the
 * payment phase; this file is that phase). Rules:
 *
 * - The browser NEVER supplies an amount. Checkout sessions snapshot the
 *   amount from this catalog at creation time; webhooks only reference the
 *   session id, and fulfillment re-reads the snapshot (§23/§24: server
 *   state is the only authority).
 * - Amounts are INTEGER MINOR UNITS (cents) — never floats (§29).
 * - Settlement currency is the plan-catalog currency (EUR), independent of
 *   each business's DISPLAY currency (A04). The UI labels this explicitly
 *   so a display-currency business never implies a display-currency charge.
 * - YEARLY = 10 × monthly (two months free) — a deterministic internal
 *   default, configurable via seed data in a real deployment (§38), never
 *   hard-coded in routes or components (§72: constants live HERE).
 * - FREE is 0 and not purchasable; ENTERPRISE is not self-service (§38) —
 *   it has no self-service price and checkout refuses it (fail closed).
 */

import { FREE_PLAN_CODE } from "@/lib/billing/catalog";
import { isBillingPeriod, type BillingPeriod } from "@/lib/billing/state-machine";

export const SETTLEMENT_CURRENCY = "EUR";

/** YEARLY = 12 monthly payments → 10 (2 months free). Deterministic. */
export const YEARLY_MONTHS_CHARGED = 10;

/**
 * Internal default prices (minor units). A real deployment would move these
 * into seed data; the shape stays identical so nothing else changes.
 */
export const PLAN_PRICES = {
  FREE: null,
  STARTER: 900, // €9.00 / month
  BUSINESS: 1900, // €19.00 / month
  PRO: 4900, // €49.00 / month
  // ENTERPRISE: no self-service price (contact sales — §38).
} as const satisfies Record<string, number | null>;

export type PriceablePlanCode = Exclude<keyof typeof PLAN_PRICES, "FREE">;

export function isPriceablePlanCode(code: string): code is PriceablePlanCode {
  return (
    code !== FREE_PLAN_CODE &&
    code in PLAN_PRICES &&
    PLAN_PRICES[code as keyof typeof PLAN_PRICES] !== null
  );
}

/** Deterministic price for a plan + period. null = not self-service purchasable. */
export function priceFor(
  planCode: string,
  billingPeriod: string,
): { amountMinor: number; currency: string; billingPeriod: BillingPeriod } | null {
  if (!isPriceablePlanCode(planCode)) return null;
  const monthly = PLAN_PRICES[planCode];
  if (monthly === null) return null;
  const period: BillingPeriod = isBillingPeriod(billingPeriod) ? billingPeriod : "MONTHLY";
  const amountMinor = period === "YEARLY" ? monthly * YEARLY_MONTHS_CHARGED : monthly;
  return { amountMinor, currency: SETTLEMENT_CURRENCY, billingPeriod: period };
}

/** All self-service prices for catalog display (plan dialog / checkout UI). */
export function priceCatalog(): Array<{
  planCode: PriceablePlanCode;
  monthlyMinor: number;
  yearlyMinor: number;
  currency: string;
}> {
  return (Object.keys(PLAN_PRICES) as Array<keyof typeof PLAN_PRICES>)
    .filter((code): code is PriceablePlanCode => isPriceablePlanCode(code))
    .map((planCode) => ({
      planCode,
      monthlyMinor: PLAN_PRICES[planCode] as number,
      yearlyMinor: (PLAN_PRICES[planCode] as number) * YEARLY_MONTHS_CHARGED,
      currency: SETTLEMENT_CURRENCY,
    }));
}

/** Format minor units for display — server DTOs' clients and UI share this. */
export function formatMinor(amountMinor: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale === "fa" ? "fa-IR" : locale, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    }).format(amountMinor / 100);
  } catch {
    return `${currency} ${(amountMinor / 100).toFixed(2)}`;
  }
}
