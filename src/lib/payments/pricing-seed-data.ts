/**
 * Pricing seed data — Prompt 24 §28/§37/§102.
 *
 * THE ONLY place in application code that carries the legacy EUR amounts
 * (they used to live in src/lib/payments/pricing.ts as the authoritative
 * catalog). From Prompt 24 on, RUNTIME resolution reads the database
 * (PricingService); this module exists solely for:
 *   - the migration (prisma/migrations/20260924113235_prompt24_price_books —
 *     same values inlined as idempotent SQL), and
 *   - scripts/seed-pricing.ts (controlled, idempotent re-seed for
 *     environments that want to verify/repair the baseline).
 *
 * §28 rules: create missing books/prices, never duplicate, never delete
 * active history, never overwrite existing amounts — a price change is a
 * NEW version (docs/billing/price-versioning.md).
 */

export type PriceBookSeedPrice = {
  planCode: "STARTER" | "BUSINESS" | "PRO";
  monthlyMinor: number;
  /** Explicit stored yearly amount — the 10× (2 months free) policy is
   *  DATA, never computed at runtime (§21/§61). */
  yearlyMinor: number;
};

export type PriceBookSeed = {
  /** Deterministic id — makes re-seeding idempotent at the PK level too. */
  id: string;
  /** §70 — stable commercial code; prices are never encoded in the code. */
  code: string;
  /** §69 — readable unique version. */
  version: string;
  currency: string;
  description: string;
  prices: readonly PriceBookSeedPrice[];
};

/**
 * EUR-v1 — the Prompt 22 baseline, migrated VERBATIM (§20/§37: do not
 * silently change the amounts):
 *   STARTER  €9.00/mo   = 900 minor   | yearly 9000
 *   BUSINESS €19.00/mo  = 1900 minor  | yearly 19000
 *   PRO      €49.00/mo  = 4900 minor  | yearly 49000
 */
export const EUR_PRICE_BOOK_V1: PriceBookSeed = {
  id: "pricebook_eur_standard_v1",
  code: "EUR_STANDARD",
  version: "v1-2026-09",
  currency: "EUR",
  description:
    "Prompt 24 baseline catalog — migrated verbatim from the Prompt 22 EUR prices. Amounts unchanged; yearly = 2 months free (10x monthly).",
  prices: [
    { planCode: "STARTER", monthlyMinor: 900, yearlyMinor: 9000 },
    { planCode: "BUSINESS", monthlyMinor: 1900, yearlyMinor: 19000 },
    { planCode: "PRO", monthlyMinor: 4900, yearlyMinor: 49000 },
  ],
};

/** All books the baseline seed ensures. IRR is deliberately ABSENT (§19
 *  option B): the schema + service support it, but no IRR prices exist
 *  until an operator explicitly configures them (no invented prices). */
export const BASELINE_PRICE_BOOKS: readonly PriceBookSeed[] = [EUR_PRICE_BOOK_V1];
