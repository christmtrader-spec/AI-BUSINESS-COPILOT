# Payment Current State — Prompt 23 (honesty report, §161/§167)

## IMPLEMENTED (code exists, deterministic, tested)
- Real-provider adapter structure: `PaymentProvider` contract extended with capabilities + `verifyPayment` + `parseCallback`; Zarinpal v4 adapter (`src/lib/payments/zarinpal.ts`) with sandbox/production endpoint separation, IRR-only currency gate, minimal safe description, no-retry creation, 15s timeout, conservative status normalization.
- Payment configuration model (§6-§11, §88-§90): `PAYMENTS_ENABLED` / `PAYMENT_PROVIDER` / `PAYMENT_ENV` / `PAYMENT_BASE_URL` validation with explicit, secret-free blockers; fail-closed everywhere; mock is development/test-only and BLOCKED in production; missing credentials never fall back to mock; an explicitly chosen but unusable provider blocks payments instead of silently switching.
- Server-authoritative pricing with snapshot: sessions store `amountMinor` + `currency` + `pricingVersion` + `initiatedByUserId` (§13/§149).
- Redirect callback flow: `GET /api/v1/payments/callback/[provider]` (untrusted params only locate the attempt) + in-app return page (`/?payment_return=<id>`) that polls the normalized status API and can trigger bounded server-side verification (`POST /api/v1/billing/checkout/[id]/verify`, 10/min).
- Verification gates: amount (§21), currency (§22), provider-reference echo (§23), business/plan ownership (§24/§25 — existing tenant scoping + provider binding).
- State machine: `PENDING → SUCCEEDED | FAILED | EXPIRED | CANCELED | RECONCILIATION_REQUIRED`; mismatches and impossible outcomes go to RECONCILIATION_REQUIRED with recorded reason — never silent failure, never fake success.
- Idempotency: webhook eventId dedupe (ProcessedWebhookEvent) + verify-event dedupe + terminal guards + idempotent plan change → one subscription activation ever (§28/§32/§73/§74).
- Subscription activation ONLY through the Prompt 20 `changePlan` service (entitlements + usage limits resolve through the existing architecture; usage is never reset on upgrade, §49/§50).
- Audit trail: `billing.checkout_created`, `billing.payment_started`, `billing.payment_verified`, `billing.payment_succeeded`, `billing.payment_failed`, `billing.payment_reconciliation_required`, `billing.checkout_simulated`.
- UI: provider-aware checkout dialog (read-only confirmation: business/plan/amount/currency/period §110-§111), safe return page (§41-§44/§139), reconciliation state badges; en+fa RTL, mobile, keyboard/aria-live.
- Safe logging posture: no secrets, no raw provider payloads; only refs + normalized results.

## TESTED (executed in this environment)
- Contract tests with MOCKED transport: request/verify/inquiry mappings, amount mapping (IRR identity), timeout/malformed/5xx → UNKNOWN, callback parse (forged/garbage), webhook-refusal.
- API-level tests against the running app (mock provider): config fail-closed, tampering (amount/currency), duplicate protection, tenant isolation, RBAC, replay/forgery (existing p22 suite extended for the reconciliation state).
- Full regression: p17-p22 + smoke suites (see worklog for the round's exact numbers).

## SANDBOX VERIFIED
**NOT VERIFIED — BLOCKED.** No Zarinpal sandbox credentials exist in this environment. No sandbox payment was executed; nothing is claimed.

## PRODUCTION VERIFIED
**NOT VERIFIED — BLOCKED.**

## PRODUCTION ACTIVATION BLOCKED — exact blockers (§161)
1. **No merchant credentials**: `ZARINPAL_MERCHANT_ID` (sandbox AND production) is absent — no commercial account exists in this deployment.
2. **Currency mismatch (policy decision required)**: the plan catalog settles in EUR; Zarinpal supports IRR only. Activating the real provider requires an explicit catalog-currency change (a pricing decision — excluded by this phase's STOP condition).
3. **No public HTTPS origin**: `PAYMENT_BASE_URL` must be a real HTTPS domain reachable by the provider's redirect; this environment is a local sandbox.
4. **Inquiry response shape must be re-confirmed** against current provider docs at activation (adapter already maps conservatively).
5. **No webhook capability** (provider-side): callback + verification is the authoritative mechanism — documented; nothing to configure.

Until every blocker is resolved, payment initiation with the real provider fails closed (`PAYMENTS_UNAVAILABLE` / `PROVIDER_UNAVAILABLE` / `PROVIDER_CURRENCY_UNSUPPORTED`) and the sandbox mock remains the only executable provider — exactly as the configuration dictates, never by accident.
