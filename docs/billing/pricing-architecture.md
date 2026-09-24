# Pricing Architecture — Prompt 24

## The problem this replaces

Through Prompt 23 the authoritative prices lived as **hard-coded constants**
in `src/lib/payments/pricing.ts` (`STARTER: 900 …`, EUR only, yearly computed
as `monthly × 10` at runtime). That had three consequences: a second
settlement currency (IRR, required by the Zarinpal adapter) had no home; a
price change meant a code deploy; and the yearly policy was arithmetic, not
data.

## Target flow (§118)

```
Plan (identity: FREE|STARTER|BUSINESS|PRO|ENTERPRISE)
  ↓
PriceBook   (currency + version + effective window + active)
  ↓
PlanPrice   (planCode + billingPeriod + amountMinor — immutable rows)
  ↓
PricingService.resolvePrice()   ← server time only
  ↓
CheckoutSession                 (snapshot: amount, currency, version, book)
  ↓
PaymentProvider                 (capability-gated: currencies)
  ↓
Verified Payment → SubscriptionService
```

## Domain separation (§3)

- **Plan** — commercial identity + entitlements. NEVER carries prices.
- **PriceBook / PlanPrice** — the money. One book per (currency, version).
- **Payment** — a snapshot of one resolved price at one moment.

Plan identity never forks per currency (no `STARTER_IRR` plan codes, §6) and
billing periods never fork plan codes (no `STARTER_MONTHLY`, §7).

## Resolution rules (PricingService, §10)

1. Plan must exist, be active, and be purchasable (FREE/ENTERPRISE rejected).
2. Billing period validated (MONTHLY | YEARLY).
3. Currency validated against the settlement allowlist (EUR | IRR) — never
   the browser locale (§42); omission resolves to `PAYMENT_SETTLEMENT_CURRENCY`
   or the documented default `EUR` (§97).
4. The newest **active**, currently-effective book for that currency wins
   (`effectiveFrom <= now < effectiveTo`, server clock only, §9/§33).
5. The explicit `PlanPrice` row for (book, plan, period) must exist and be
   active. Yearly amounts are stored, never computed (§21/§61).
6. The resolved snapshot is `{ planCode, billingPeriod, currency, amountMinor,
   priceBookId (internal), priceBookCode, priceVersion, effectiveFrom }`.
   Only readable codes/versions leave the server (§12).

## Failure codes (§55) — all 422, no fallbacks (§11/§50)

| Code | Meaning |
|---|---|
| `PLAN_NOT_PURCHASABLE` | FREE / ENTERPRISE / unknown / inactive plan |
| `CURRENCY_NOT_SUPPORTED` | code not in the settlement allowlist (e.g. USD) |
| `PRICEBOOK_NOT_FOUND` | allowlisted currency with no book rows at all |
| `PRICEBOOK_INACTIVE` | book exists but inactive / not yet effective / expired |
| `PRICE_NOT_CONFIGURED` | active book lacks a price row for plan+period |
| `PRICE_VERSION_NOT_AVAILABLE` | price row exists but was retired (active=false) |
| `PROVIDER_CURRENCY_UNSUPPORTED` | provider capability gate (checkout) |

## Provider compatibility (§16-§18/§47)

`PricingService.providerSupportsCurrency(provider, currency)` reads ONLY
`provider.capabilities.currencies` (`["IRR"]` for Zarinpal, `["*"]` for the
sandbox mock). There is no `if provider === "zarinpal"` anywhere in pricing
logic, and the system never converts and never silently switches providers.

## What the browser may send

`POST /api/v1/billing/checkout` accepts **only**
`{ planCode, billingPeriod, currency? }` (strict — anything else is 422,
§80). Amounts, versions, books and providers are server-resolved.

## Where the prices live

Database only (`PriceBook` / `PlanPrice`). Baseline seed: the Prompt 24
migration + `scripts/seed-pricing.ts` (idempotent, see
`price-books.md`). No public price editor exists (§26/§27).
