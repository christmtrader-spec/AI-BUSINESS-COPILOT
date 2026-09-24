/**
 * Pricing DISPLAY helpers — Prompt 24.
 *
 * Prompt 22 made this file the authoritative price catalog; Prompt 24 moved
 * that authority into the database-backed PricingService
 * (src/lib/payments/pricing-service.ts) with seed data in
 * pricing-seed-data.ts. NOTHING authoritative lives here anymore — by
 * design (§75/§76: no code-level pricing). What remains is pure display
 * formatting shared by server DTOs' clients and UI (§44: the UI may format,
 * it may never SEND a formatted string back as an amount).
 */

import { currencyMinorDigits } from "./currency";

/**
 * Format minor units for display — exponent-aware (Prompt 24 §23/§86):
 * EUR (2 digits) → "€9.00"; IRR (0 digits) → an integer Rial amount with
 * NO decimal arithmetic. Formatting never alters the authoritative amount.
 */
export function formatMinor(amountMinor: number, currency: string, locale: string): string {
  const digits = currencyMinorDigits(currency);
  const major = amountMinor / 10 ** digits;
  try {
    return new Intl.NumberFormat(locale === "fa" ? "fa-IR" : locale, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(major);
  } catch {
    return `${currency} ${major.toFixed(digits)}`;
  }
}
