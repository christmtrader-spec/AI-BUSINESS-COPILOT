# Platform Billing Operations — Prompt 28

Status: IMPLEMENTED (internal console). Payment production remains
NOT ACTIVE. This document describes the operator-facing billing
functionality that actually exists. No compliance or uptime claims.

## 1. Where billing operations live

- Console: `#/platform/subscriptions`, `#/platform/payments`,
  `#/platform/pricing`.
- APIs: `/api/v1/platform/subscriptions`, `/api/v1/platform/payments`,
  `/api/v1/platform/pricing`, `/api/v1/platform/businesses/[id]/subscription/{pause,resume,plan}`,
  `/api/v1/platform/businesses/[id]/trial`.
- All flows run through the EXISTING billing service layer
  (`src/lib/billing/service.ts`) and its state machine. No API route
  performs direct `prisma.subscription.*` mutations (statically enforced).

## 2. Subscription pause (§25)

- Path: ACTIVE → PAUSED (declared by the Prompt-20 state machine; first
  exercised by Prompt 28).
- Effects: paid entitlements become unavailable the standard way — the
  effective plan falls back to FREE-level features; data is preserved; no
  payment success is fabricated; no checkout is created.
- Guards: `platform:subscriptions:manage`, reason (≤300), reauthentication,
  typed confirmation `PAUSE SUBSCRIPTION` in the UI, rate limit
  (`platform:<op>:subscription-pause`).
- Records: SubscriptionEvent `PAUSED`, tenant audit
  `billing.subscription_paused`, platform audit
  `billing.subscription_paused` (with requestId, operator, reason).
- Idempotent: pausing a PAUSED subscription is a no-op (`changed: false`).

## 3. Subscription resume (§26)

- Path: PAUSED → ACTIVE. Event `RESUMED`, audits
  `billing.subscription_resumed`. The entitlement cache is invalidated
  inside the service, so paid features return immediately. Idempotent.

## 4. Cancel from PAUSED (§27)

Only transitions the existing state machine already defines are reachable:
PAUSED → CANCELED works through the EXISTING `cancelSubscription` service
(cancel-at-period-end semantics). No new transitions were invented.

## 5. Operator plan change (§28)

- `POST .../subscription/plan` with a valid plan code → the existing
  `changePlan` service (state-machine enforced, events + tenant audit
  written transactionally, entitlement cache invalidated).
- This is ENTITLEMENT ADMINISTRATION. It is never labeled "payment
  successful" — the SubscriptionEvent data records `source: platform-admin`
  and the platform audit records old plan, new plan, business, operator and
  reason.

## 6. Trial operations (§29)

- Only the existing `startTrial` / `endTrial` services are reachable.
- Duration ALWAYS comes from the current trial configuration
  (`BILLING_TRIAL_DAYS`, validated 1..90); the one-trial rule and the state
  machine are enforced inside the service. If trials are disabled by
  configuration the API answers honestly with `TRIAL_DISABLED`.

## 7. Payment operations (§30-§33)

- READ-ONLY list over CheckoutSession, PaymentTransaction and
  ProcessedWebhookEvent with filters (provider/status/business/currency/
  date) and pagination. No payment credentials, raw webhook signatures or
  sensitive gateway payloads are ever serialized.
- Reverify (`POST /api/v1/platform/payments/[id]/reverify`): calls the
  EXISTING provider verification abstraction. THE PROVIDER REMAINS
  AUTHORITATIVE — there is no request field that could set
  SUCCEEDED/FAILED/CANCELED, and no generic mark-paid / force-success /
  activate-from-admin endpoint exists anywhere in the application (the
  Prompt 28 static scanner fails if one appears).
- Investigation (`POST .../investigation`): records a reason, review status
  (OPEN/UNDER_REVIEW/RESOLVED) and a bounded internal note (≤500 chars)
  into `CheckoutSession.metaJson` under `platformReview` (merged — existing
  metadata preserved). Amount, currency, providerRef and signature evidence
  are structurally unmodifiable (no such request fields exist).

## 8. Pricing administration (§34-§37)

- `GET /api/v1/platform/pricing` — every PriceBook (code, version,
  currency, active, currently-effective, window) with its immutable
  PlanPrice rows. No hard-coded prices anywhere.
- `createPriceBookVersion` (`src/lib/payments/pricing-service.ts`):
  creates a NEW, INACTIVE book version. Historical PlanPrice amounts are
  never mutated; referenced books are never deleted (schema-level
  `onDelete: Restrict` from CheckoutSession). Validation: code/version
  shape, supported settlement currency, explicit effective window, exact
  positive integer minor units, no FREE/ENTERPRISE rows, no duplicate
  version, complete rows (STARTER/BUSINESS/PRO × MONTHLY/YEARLY), plans
  active.
- `activatePriceBook`: explicit, audited activation. Re-validates rows,
  currency, window (expired windows rejected) and overlap: a same-code
  predecessor's window is closed at the new book's effectiveFrom (window
  metadata only — amounts untouched); cross-code overlap is REJECTED
  (no ambiguous resolution). Reversible only by activating another version.
- IRR SAFETY (§37): no IRR book exists. The console shows an honest
  "IRR: NOT CONFIGURED" badge until an operator creates a genuine IRR book
  with real amounts. No IRR/Toman price is invented anywhere.

## 9. Checkout snapshot stability (§110)

Sessions freeze `pricingVersion`, `priceBookId` and `priceBookCode` at
creation (Prompt 23/24 behavior, unchanged). New book versions never
re-price an open or historical checkout; resolution picks the newest
ACTIVE, currently-effective book per currency.

## 10. Cache invalidation (§75)

Every billing mutation path (pause/resume/plan change/trial and payment
fulfillment) invalidates the in-process entitlement cache
(`invalidateBillingCache`) — no server restart is needed. The cache is
UI-read-only (15 s TTL); gates always verify against a fresh read.

## 11. Prohibited operations (permanent)

No endpoint exists — and none may be added — to mark a payment paid,
force a session status, activate a subscription from a payment result
without provider-authoritative verification, or bypass the state machine.
The Prompt 28 scanner (`scripts/prompt28-platform-check.mjs` §J) enforces
this statically.
