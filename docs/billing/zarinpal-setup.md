# Zarinpal Setup — AI Business Copilot (Prompt 23)

Primary real payment provider adapter. **Status: IMPLEMENTED — PRODUCTION ACTIVATION BLOCKED** (see "Current blockers").

- Provider: Zarinpal Payment Gateway (Iranian PSP — matches this product's Persian/English market)
- API: **v4 REST** (`/pg/v4/payment/request.json`, `/pg/v4/payment/verify.json`, `/pg/v4/payment/inquiry.json`, StartPay redirect)
- Documentation source: doc.zarinpal.com Payment Gateway v4 (corroborated by independent v4 SDKs). Per Prompt 23 §151, the operator MUST re-verify every field against the provider's CURRENT official docs at activation time — the adapter's mapping is conservative (unknown shapes never produce terminal states).

## Account prerequisites
1. A legitimate Zarinpal merchant account in the operator's own legal name/jurisdiction (no KYC evasion, no sanctions circumvention — Prompt 23 §3).
2. A terminal/merchant UUID for **sandbox** and a separate one for **production** (never mixed — §8).
3. The operator's public HTTPS origin.

## Environment variables (all SERVER-SIDE — never in the client bundle)
| Variable | Purpose | Notes |
|---|---|---|
| `PAYMENTS_ENABLED` | `true`/`false` | Must be exactly `true` in production to enable payments |
| `PAYMENT_PROVIDER` | `zarinpal` | Fail-closed when unusable — never falls back to mock |
| `PAYMENT_ENV` | `sandbox` / `production` | Unambiguous; `mock` never allowed with a real provider |
| `PAYMENT_BASE_URL` | Public origin | Builds callback URLs; HTTPS required in production |
| `ZARINPAL_MERCHANT_ID` | Merchant UUID | The ONLY credential; rotate without code changes |

Placeholders live in `.env.example`. Real values never enter git, docs, logs, or the database.

## Sandbox setup
1. Set `PAYMENT_ENV=sandbox` + sandbox `ZARINPAL_MERCHANT_ID`.
2. Endpoints used: `https://sandbox.zarinpal.com/pg/v4/payment/{request,verify}.json`, StartPay `https://sandbox.zarinpal.com/pg/StartPay/{authority}`.
3. Callback URL registered per payment: `{PAYMENT_BASE_URL}/api/v1/payments/callback/zarinpal`.

## Production setup
1. Set `PAYMENT_ENV=production` + production `ZARINPAL_MERCHANT_ID` (separate from sandbox).
2. Endpoints switch to `https://payment.zarinpal.com/...` — same request mapping (sandbox/production parity is configuration-only, §153).
3. Follow `docs/deployment/payment-production-checklist.md` before enabling.

## Currency policy (§52/§53)
Zarinpal settles in **IRR (Iranian Rials) ONLY**. The adapter declares `currencies: ["IRR"]` and REFUSES any checkout session in another settlement currency (`PROVIDER_CURRENCY_UNSUPPORTED`) — no silent conversion, no browser exchange rates. Amount mapping is a deterministic integer identity: internal IRR minor unit = 1 Rial (ISO 4217 exponent 0, `src/lib/payments/currency.ts`). The current plan catalog settles in EUR — activating Zarinpal therefore REQUIRES an explicit catalog-currency decision (out of scope for this phase by STOP condition).

## Callback & webhook
- **Callback (browser redirect):** `GET /api/v1/payments/callback/zarinpal?Authority=…&Status=OK|NOK`. Query values are UNTRUSTED — `Status=OK` never marks success. The route locates the attempt via `Authority`, triggers ONE bounded server-side verification, then 302s to the in-app return page.
- **Webhooks:** Zarinpal v4 does NOT push payment webhooks. `capabilities.webhooks = false`; `POST /api/v1/webhooks/payments/zarinpal` rejects everything (401). **Callback + server-side verification (`verify.json`) is the authoritative mechanism** (Prompt 23 §29) — documented, not faked.
- Production webhook URL: N/A (provider does not support webhooks).
- Production callback URL: `https://<PAYMENT_BASE_URL>/api/v1/payments/callback/zarinpal`.

## Verification & reconciliation
- `verifyPayment()` maps: `code 100/101` → SUCCEEDED (101 = already verified → idempotent); `-51` → NOT_PAID; `-50` → UNKNOWN/AMOUNT_MISMATCH (money moved at a different amount → RECONCILIATION_REQUIRED); `-53` → UNKNOWN/GATEWAY_IP_MISMATCH; `-54` → NOT_PAID; timeouts/network/malformed → UNKNOWN (session stays PENDING — a timeout is never a failure, §36).
- Session status inquiry (`inquiry.json`) is mapped CONSERVATIVELY (only a provable `PAID` yields SUCCEEDED; everything else stays PENDING) — re-confirm the current inquiry response shape at activation.

## Credential rotation (§93/§156)
`ZARINPAL_MERCHANT_ID` is read per-request from the environment — rotation = update the env value + restart the process. No code changes, no data migrations, no stored copies.

## Provider-specific caveats
- `request.json` is NOT idempotent at the provider → the adapter never retries creation (§67); a failed create records a FAILED attempt locally and the user can start a fresh one.
- Description sent to provider is minimal/non-sensitive: `AI Business Copilot — <PLAN> Plan (<PERIOD>)` (§99). No business data, no customer PII (§98/§150).
- The provider page redirects the user; if the user abandons, the session stays PENDING until expiry (30 min) — honest pending UX, no fake failure.
