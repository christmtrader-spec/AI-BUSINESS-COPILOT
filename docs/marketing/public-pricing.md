# Public Pricing — Prompt 25

## What exists

The public pricing experience is a first-class view inside the existing
single-page app: `#/pricing` (hash router — the only exposed route is `/`).
It renders **without a session** and again **inside the shell** for signed-in
users (same component, two mounting points).

## Data flow (one source of truth)

```
PriceBook / PlanPrice (DB, Prompt 24)
        │
        ▼
PricingService.priceCatalogForCurrency()     ← the ONLY price resolver
        │
        ▼
GET /api/v1/public/pricing[?currency=EUR|IRR] ← public, no session
        │
        ▼
PricingView (cards, comparison, FAQ, CTAs, JSON-LD)
```

- No component contains a price literal. All amounts are `amountMinor`
  integers formatted through `formatMinor()` (exponent-aware: EUR 2 digits,
  IRR 0 digits).
- Yearly amounts are the **stored** `YEARLY` PlanPrice rows — never
  `monthly × N` (Prompt 24 §21).
- Savings badges are computed per plan from the two stored prices and are
  shown only when mathematically positive (`savePercent`). No "N months
  free" wording exists.
- Checkout NEVER trusts this page: it re-resolves the price server-side and
  snapshots the session (Prompt 24). The pricing page is informational.

## Response shape (safe fields only)

```jsonc
{
  "plans": [{ "code", "name", "description", "sortOrder", "selfService",
              "availability", "pricing": {"monthlyMinor","yearlyMinor",
              "currency","priceVersion"} | null, "entitlements" }],
  "definitions": [{ "code", "type", "unit", "group" }],
  "settlementCurrency": "EUR",
  "currencies": [{ "code", "displayName", "symbol", "minorUnitExponent",
                   "available": true }],
  "paymentsEnabled": true,
  "trialsEnabled": false,
  "trialDays": null,          // configured length when trials are enabled
  "featuredPlan": null        // only ever set by PRICING_FEATURED_PLAN
}
```

Never returned: DB ids, `priceBookId`, audit metadata, provider
credentials, subscription records, admin fields.

## Currency behavior

- `currencies` lists every **settlement-allowlisted** currency
  (`SETTLEMENT_CURRENCIES` in `src/lib/payments/currency.ts`) with an honest
  `available` flag (true ⇔ an active, currently-effective book exists).
- Today: `EUR available`, `IRR listed but unavailable` (no book — §78
  wording: "Pricing in this currency is not currently available").
- Unsupported codes (USD…) → 422 `CURRENCY_NOT_SUPPORTED`.
- No FX anywhere. The selector is never driven by IP/locale/geolocation.

## CTA states (per plan × auth × availability)

| Condition | Public CTA | Authenticated CTA |
| --- | --- | --- |
| FREE | Start free → signup | Current plan (disabled) / Change plan → billing |
| Paid, AVAILABLE | Choose X → signup (plan hint stored) | Upgrade / Change plan → billing |
| Paid, not priced in currency | Not available (disabled) | Not available (disabled) |
| Payments disabled | Contact us | Contact us |
| ENTERPRISE | Contact sales (dialog) | Contact sales (dialog) |

CTAs never mutate subscriptions. Upgrade/change always routes into the
existing billing flow.

## Contact sales (§27-§29)

`POST /api/v1/public/contact` — fields: name, email, optional company,
message, UI locale. Honeypot field silently drops bots. IP rate limit
5/15min. **Retention statement:** leads are stored solely to reply, are
readable only by operators with DB access, are never used for marketing
profiles, and can be deleted on request (no automated CRM exists).

## SEO (§56-§59/§130/§135)

- Root metadata: factual title/description/canonical/OG/Twitter
  (src/app/layout.tsx), `alternates.languages` en/fa.
- The pricing view injects JSON-LD `Product` + `Offer` built **only** from
  the live catalog and **only** for plans whose availability is AVAILABLE
  in the payload currency. No IRR offers, no stale numbers.
- No unsupported claims (no "full accounting", no guaranteed savings).

## Errors

- Catalog fetch failure → "Pricing is temporarily unavailable." + retry.
  Never €0, never fallback prices.
- One unpriced currency never breaks the page (EUR stays available while
  IRR shows unavailable).

## Cache

- In-process TTL cache: 30s per currency (`publicPricingForCurrency`),
  plus `Cache-Control: public, max-age=30, stale-while-revalidate=60`.
- Checkout is the amount authority and re-resolves on every session
  creation, so no cache can make a wrong charge (§118/§119).
