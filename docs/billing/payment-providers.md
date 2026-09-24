# Payment Provider Abstraction — Prompt 22

> Status: **IMPLEMENTED** (provider-agnostic checkout + webhook fulfillment,
> sandbox `mock` provider active by default). No real payment processor is
> wired; no real money moves; no payment instruments are ever stored.

## Purpose & invariants

Prompt 21's STOP condition deferred all payment work. Prompt 22 introduces the
**abstraction layer** — the seam a real provider (Stripe / Zarinpal / …) plugs
into later — with a fully working sandbox path for development and testing.

Non-negotiable invariants (enforced in code, verified by
`scripts/prompt22-payments-check.mjs`):

1. **Server-authoritative money.** The browser sends only
   `{ planCode, billingPeriod }`. The amount comes from the price catalog
   (`src/lib/payments/pricing.ts`), is snapshotted on the session, and every
   webhook success event is cross-checked against that snapshot. A mismatch
   fails the session CLOSED — never a wrong plan.
2. **Idempotent end to end.** Three independent layers:
   - `(provider, eventId)` unique → `ProcessedWebhookEvent` (replay guard),
   - session terminal-state guards (terminal sessions never re-fulfill),
   - Prompt 20 `changePlan` is itself a no-op when the plan already matches.
3. **Trust = signature, never session.** `POST /api/v1/webhooks/payments/[provider]`
   has NO NextAuth session auth. Verification is a timing-safe HMAC-SHA256
   over the RAW body with a Stripe-style `t=<ts>,v1=<sig>` header and a 5-minute
   replay window. Any failure → opaque 401 (`WEBHOOK_UNVERIFIED`); gateways
   retry, probes learn nothing.
4. **Fail closed.** Unknown/unconfigured provider slugs → 422
   `PROVIDER_UNAVAILABLE` (or 404 on the webhook route). Nothing falls back to
   another provider.
5. **Crash-window reconciliation.** `SUCCEEDED` sessions with `fulfilledAt
   = null` are auto-healed on the next read by re-running the idempotent plan
   change (deterministic outcome, no double transactions).

## Where things live

| Concern | File |
|---|---|
| Provider contract + event types | `src/lib/payments/types.ts` |
| HMAC signature scheme | `src/lib/payments/signature.ts` |
| Sandbox (mock) provider | `src/lib/payments/mock-provider.ts` |
| Registry (fail-closed resolution) | `src/lib/payments/registry.ts` |
| Price catalog (EUR minor units) | `src/lib/payments/pricing.ts` |
| Checkout/fulfillment service | `src/lib/payments/service.ts` |
| API: create session | `POST /api/v1/billing/checkout` (OWNER/ADMIN, 10/min) |
| API: session status | `GET /api/v1/billing/checkout/[id]` (lazy expiry + auto-heal) |
| API: sandbox simulate | `POST /api/v1/billing/checkout/[id]/simulate` (mock only) |
| API: payment history + CSV | `GET /api/v1/billing/payments` (`?format=csv`) |
| API: provider list | `GET /api/v1/billing/providers` (no secrets) |
| Webhook | `POST /api/v1/webhooks/payments/[provider]` |
| UI: sandbox checkout dialog | `src/modules/billing/checkout-dialog.tsx` |
| UI: payment history card | `src/modules/billing/payments-history-card.tsx` |
| UI: plan dialog with prices | `src/modules/billing/subscription-view.tsx` |
| Harness | `scripts/prompt22-payments-check.mjs` (bun) |

## Data model (Prisma)

- **CheckoutSession** — business-scoped; snapshots `planCode`, `billingPeriod`,
  `amountMinor`, `currency`; `status ∈ PENDING | SUCCEEDED | FAILED | EXPIRED |
  CANCELED`; `providerRef` unique per provider; 30-minute expiry; sessions
  cascade with the business.
- **PaymentTransaction** — money record, unique per `(provider, providerEventId)`
  (a retried webhook can never create two records); status SUCCEEDED/FAILED
  (REFUNDED reserved).
- **ProcessedWebhookEvent** — the replay-protection ledger. Rows are kept
  forever (cheap, tiny, and the audit value outweighs the bytes).

## Pricing (internal defaults)

| Plan | Monthly | Yearly (10× → 2 months free) |
|---|---|---|
| FREE | — (not purchasable) | — |
| STARTER | €9.00 | €90.00 |
| BUSINESS | €19.00 | €190.00 |
| PRO | €49.00 | €490.00 |
| ENTERPRISE | contact sales (§38 — not self-service) | — |

- Settlement currency is **EUR** (plan-catalog currency), independent of each
  business's display currency (A04). The UI labels this explicitly.
- Amounts are integer minor units everywhere; formatting to locale currency
  happens only at the presentation edge (`formatMinor`).

## Sandbox flow (what the UI actually does)

1. OWNER/ADMIN opens Settings → Subscription → Switch plan. Paid plans show
   server prices and two payment buttons (Monthly / Yearly) plus the legacy
   Prompt 20 internal switch (kept, clearly labeled «بدون پرداخت» tooling).
2. Creating a session cancels any still-PENDING session (one live checkout
   per business) and opens the in-app sandbox dialog (`/?checkout=<id>`).
3. «Pay now (simulate success)» / «Simulate failure» call the simulate
   endpoint, which builds the **byte-identical signed gateway request** and
   pushes it through the real verification → fulfillment pipeline. The dialog
   only ever renders server state and polls every 3 s while PENDING.
4. On success: session SUCCEEDED + transaction recorded + subscription
   upgraded through `changePlan(source: "payment-webhook:webhook")` + audits
   (`billing.checkout_created` / `billing.payment_succeeded` /
   `billing.payment_failed` / `billing.checkout_simulated`).

## Configuration

- `PAYMENT_PROVIDERS` — optional comma-separated allowlist of provider slugs
  (e.g. `mock`). Absent = all code-registered adapters that report
  `configured: true`.
- `PAYMENT_WEBHOOK_SECRET` — explicit webhook HMAC secret (≥16 chars). When
  unset, a stable secret is derived from `NEXTAUTH_SECRET` so signatures
  survive restarts in development. **A production deployment MUST set an
  explicit secret and rotate it like any credential.**

## Adding a real provider later

1. Implement the `PaymentProvider` interface in
   `src/lib/payments/<provider>.ts` (createCheckout / verifyWebhook /
   getSessionStatus), gate `configured` on its env keys' presence.
2. Register the adapter in `src/lib/payments/registry.ts`.
3. Nothing else changes — service, routes, UI, and the idempotency machinery
   are provider-agnostic by construction.

## Out of scope (deliberate)

Real processor integrations, card fields, 3-D Secure, refunds beyond the
reserved status, dunning/PAST_DUE automation, proration, tax/VAT — all belong
to the next payment phases and require real credentials.
