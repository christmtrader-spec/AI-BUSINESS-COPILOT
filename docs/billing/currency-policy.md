# Currency Policy — Prompt 24 (§14/§15/§23-§25/§42/§59/§107)

## Three different "currencies" — never conflated

| Kind | Where it lives | Example | Used for |
|---|---|---|---|
| **Business display currency** | `Business.currencyCode` | EUR for a European shop | formatting the tenant's OWN finance numbers (sales, expenses) |
| **Platform settlement currency** | `PriceBook.currency` (resolved per checkout) | EUR today, IRR when activated | what the CUSTOMER IS CHARGED for the SaaS subscription |
| **Provider settlement currency** | `PaymentProvider.capabilities.currencies` | IRR (Zarinpal), `*` (mock) | what a given adapter can actually collect |

A business may display EUR while being charged IRR, and vice versa. The
display currency is **never** used as an implicit settlement currency (§59)
and platform billing never reads `Business.currencyCode` for money.

## The settlement allowlist (§15)

`SETTLEMENT_CURRENCIES = ["EUR", "IRR"]` in
`src/lib/payments/currency.ts` — the ONLY codes a client may request.
Anything else (USD, GBP, "TOMAN", …) → `422 CURRENCY_NOT_SUPPORTED`. Adding
a currency means: add metadata + add to the allowlist + seed/activate a
price book. Nothing activates automatically.

## Currency metadata (§23)

`CurrencyDefinition { code, minorUnitExponent, displayName, symbol, active }`:

| Code | Exponent | Minor unit | Notes |
|---|---|---|---|
| EUR | 2 | cent | active book `EUR_STANDARD v1-2026-09` |
| IRR | **0** | **1 unit = 1 Rial** | zero-decimal; schema/service ready, prices not configured |
| USD/GBP | 2 | — | display metadata only; NOT settlement-requestable |
| IQD/AED/TRY | 3/2/2 | — | display metadata, `active: false` |

Exponents are explicit configuration — never inferred from the UI or locale
(§23). `formatMinor()` is exponent-aware: IRR amounts render as integer
Rials, EUR amounts as 2-decimal euros; formatting never changes the
authoritative amount (§44/§86).

## Rial vs Toman (§24/§25)

IRR is stored and settled as **Rials** (ISO 4217, 1 minor unit = 1 Rial —
the unit Zarinpal's API expects). **Toman (1 Toman = 10 Rials) is NOT a
settlement currency and MUST NOT be introduced by dividing/multiplying
amounts.** If Toman display is ever wanted, it is an explicit, separately
designed display-layer rule — the authoritative number stays Rials.

## Default settlement currency (§42/§97)

When a request omits `currency`:
1. `PAYMENT_SETTLEMENT_CURRENCY` (validated against the allowlist) if set;
2. otherwise `EUR` — the documented default while EUR-v1 is the only
   activated book.

It is NEVER chosen from browser language, locale, IP or UI text. Switching
the default to IRR is an explicit operator action (activate an IRR book +
set the variable) and never re-prices existing sessions or subscriptions.

## No FX, ever (§2/§49/§62)

There is no EUR→IRR conversion anywhere — no browser rates, no public FX
APIs, no provider conversion, no hidden arithmetic at checkout. If a
currency has no active book with a price for the requested plan, the
purchase in that currency is simply unavailable (`PRICEBOOK_NOT_FOUND` /
`PRICE_NOT_CONFIGURED`). No rounding happens during selection: prices are
stored in minor units and used as-is (§62/§85).
