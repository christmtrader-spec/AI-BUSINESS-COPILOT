/**
 * Currency representation — Prompt 23 §53-§55.
 *
 * Internal money is INTEGER MINOR UNITS. Currencies differ in the number of
 * minor digits (EUR=2 cents, IRR=0 rials — ISO 4217 exponents). Every
 * conversion between display strings, provider payloads and minor units
 * goes through this deterministic, integer-only mapping — never floats in
 * money math, never per-call guessing.
 */

const CURRENCY_MINOR_DIGITS: Record<string, number> = {
  EUR: 2,
  USD: 2,
  GBP: 2,
  IRR: 0, // Iranian Rial — ISO 4217 exponent 0 (zero-decimal)
  IQD: 3,
  AED: 2,
  TRY: 2,
};

/** Deterministic minor-unit digits for a currency code (default 2, §54). */
export function currencyMinorDigits(currency: string): number {
  return CURRENCY_MINOR_DIGITS[currency.toUpperCase()] ?? 2;
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
