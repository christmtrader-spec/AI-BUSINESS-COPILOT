/**
 * Currency representation — Prompt 23 §53-§55 + Prompt 24 §15/§22-§25.
 *
 * Internal money is INTEGER MINOR UNITS. Currencies differ in the number of
 * minor digits (EUR=2 cents, IRR=0 rials — ISO 4217 exponents). Every
 * conversion between display strings, provider payloads and minor units
 * goes through this deterministic, integer-only mapping — never floats in
 * money math, never per-call guessing.
 *
 * Prompt 24 additions:
 * - CurrencyDefinition metadata (§23): explicit exponent/name/symbol per
 *   code — never inferred from the UI or the browser locale.
 * - Explicit SETTLEMENT currency allowlist (§15): IRR + EUR. Metadata for
 *   other display currencies exists, but only allowlisted codes may be
 *   REQUESTED for platform checkout — no currency is activated implicitly.
 * - Rial/Toman policy (§24/§25): IRR is stored as RIALS (1 unit = 1 Rial,
 *   ISO 4217 IRR, exponent 0). Toman (1 Toman = 10 Rials) is NOT a
 *   settlement currency here; it may only ever appear as a display-side
 *   concern through an explicit future business rule — never by silently
 *   dividing/multiplying amounts.
 */

export type CurrencyDefinition = {
  /** ISO 4217 code (upper-case). */
  code: string;
  /** Number of minor-unit digits (ISO 4217 exponent). */
  minorUnitExponent: number;
  displayName: string;
  symbol: string;
  /** Metadata liveness. Checkout REQUESTS are additionally gated by the
   *  settlement allowlist below (metadata ≠ activation, §15). */
  active: boolean;
};

export const CURRENCY_DEFINITIONS: readonly CurrencyDefinition[] = [
  { code: "EUR", minorUnitExponent: 2, displayName: "Euro", symbol: "€", active: true },
  { code: "USD", minorUnitExponent: 2, displayName: "US Dollar", symbol: "$", active: true },
  { code: "GBP", minorUnitExponent: 2, displayName: "Pound Sterling", symbol: "£", active: true },
  {
    code: "IRR",
    minorUnitExponent: 0, // zero-decimal: 1 minor unit = 1 Rial (§24)
    displayName: "Iranian Rial",
    symbol: "ریال",
    active: true,
  },
  { code: "IQD", minorUnitExponent: 3, displayName: "Iraqi Dinar", symbol: "ع.د", active: false },
  { code: "AED", minorUnitExponent: 2, displayName: "UAE Dirham", symbol: "د.إ", active: false },
  { code: "TRY", minorUnitExponent: 2, displayName: "Turkish Lira", symbol: "₺", active: false },
];

/**
 * Explicit platform SETTLEMENT currency catalog (Prompt 24 §15): every
 * billable currency must appear here AND have an explicitly configured
 * (activated) PriceBook. Nothing is activated automatically — adding a
 * currency to the platform means adding it HERE plus seeding/activating a
 * price book for it.
 */
export const SETTLEMENT_CURRENCIES: readonly string[] = ["EUR", "IRR"];

function currencyDefinition(code: string): CurrencyDefinition | null {
  return CURRENCY_DEFINITIONS.find((c) => c.code === code.toUpperCase()) ?? null;
}

/** Deterministic minor-unit digits for a currency code (default 2, §54). */
export function currencyMinorDigits(currency: string): number {
  const def = currencyDefinition(currency);
  return def ? def.minorUnitExponent : 2;
}

/** Minor units → major units (integer arithmetic on the exponent). */
export function minorToMajor(amountMinor: number, currency: string): number {
  const digits = currencyMinorDigits(currency);
  return amountMinor / 10 ** digits;
}

/** Major units → minor units; rejects non-representable input (§55). */
export function majorToMinor(amountMajor: number, currency: string): number | null {
  const digits = currencyMinorDigits(currency);
  const scaled = amountMajor * 10 ** digits;
  if (!Number.isSafeInteger(scaled)) return null;
  return scaled;
}

/** Safe metadata lookup (§23) — null for unknown codes. */
export function currencyMeta(code: string): CurrencyDefinition | null {
  const def = currencyDefinition(code);
  return def && def.active ? def : null;
}

/**
 * Whether `code` may be REQUESTED as a platform settlement currency
 * (Prompt 24 §15/§41): must be in the explicit allowlist AND have live
 * metadata. Having a price for it is a separate, DB-level condition —
 * this gate only decides whether the REQUEST is even meaningful.
 */
export function isSupportedSettlementCurrency(code: string): boolean {
  if (typeof code !== "string") return false;
  const upper = code.trim().toUpperCase();
  return (
    SETTLEMENT_CURRENCIES.includes(upper) &&
    (currencyDefinition(upper)?.active ?? false)
  );
}

/** Canonical upper-case code or null when malformed (§41 — validate, never guess). */
export function normalizeCurrencyCode(code: unknown): string | null {
  if (typeof code !== "string") return null;
  const upper = code.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(upper) ? upper : null;
}
