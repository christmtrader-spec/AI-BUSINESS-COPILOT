# Zarinpal Pricing Readiness — Prompt 24 (§108/§116/§117)

## Readiness matrix (honest state)

| Requirement | State |
|---|---|
| Currency-aware price catalog (PriceBook/PlanPrice) | ✅ IMPLEMENTED + SEEDED (EUR-v1) |
| EUR price book | ✅ ACTIVE — `EUR_STANDARD v1-2026-09` (900/1900/4900 monthly; explicit yearly 9000/19000/49000) |
| IRR schema + allowlist + service support | ✅ IMPLEMENTED |
| IRR price book | ❌ **NOT CONFIGURED** — no real prices exist; nothing invented (§19) |
| Zarinpal adapter (IRR-only, fail-closed) | ✅ IMPLEMENTED (sandbox/production endpoints separated) |
| Zarinpal + EUR | ✅ correctly REJECTED (`PROVIDER_CURRENCY_UNSUPPORTED` / capability gate) |
| Zarinpal + IRR | ⛔ reaches the provider only after an IRR book is activated |
| Real credentials (`ZARINPAL_MERCHANT_ID`) | ❌ ABSENT |
| Public HTTPS callback origin | ❌ ABSENT (local sandbox) |
| Provider documentation re-verification at activation | ⛔ PENDING (must reconfirm response/inquiry behavior against current Zarinpal docs at activation time) |
| Sandbox payment executed | ❌ NEVER — none claimed |
| Production payment executed | ❌ NEVER — none claimed |

## Current production blockers, exactly (§116)

1. **Price configuration blocker** — no activated IRR price book. IRR
   checkout returns `422 PRICEBOOK_NOT_FOUND` (by design; no fallback, no
   FX).
2. **Provider currency blocker** — Zarinpal settles IRR only; the EUR book
   cannot be used with it. Until an IRR book exists, real checkout is
   impossible regardless of credentials.
3. **Provider credentials blocker** — `ZARINPAL_MERCHANT_ID` (sandbox AND
   production) is absent; the adapter fails closed without it.
4. **HTTPS blocker** — `PAYMENT_BASE_URL` must be a public HTTPS origin the
   provider can redirect back to; this environment has none.
5. **Documentation verification blocker** — adapter request/verify/inquiry
   mappings must be reconfirmed against the CURRENT official Zarinpal
   documentation during activation (never assumed).

## Exact activation path (when the business decision is made)

1. Decide IRR prices (a commercial decision — explicitly excluded from
   Prompt 24's scope).
2. Seed + activate: `bun scripts/seed-pricing.ts --currency IRR --monthly
   … --yearly … --activate` (see price-books.md).
3. Optionally set `PAYMENT_SETTLEMENT_CURRENCY=IRR` to make IRR the default
   catalog for clients that don't name a currency.
4. Provide `ZARINPAL_MERCHANT_ID` (sandbox first), `PAYMENT_ENV=sandbox`,
   public HTTPS `PAYMENT_BASE_URL`.
5. Re-verify the adapter contract against current provider docs; run a
   sandbox payment end-to-end (callback → verify → fulfillment).
6. Only then `PAYMENT_ENV=production` with live credentials.

**Until every line above is true: REAL PAYMENT REMAINS BLOCKED, and no
readiness is claimed (§117).** EUR checkout through the sandbox mock
provider remains fully functional for testing.
