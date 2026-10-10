# Onboarding — Prompt 25 §40-§49/§91-§100

## Flow

```
Signup → Welcome → Business profile (existing POST /api/v1/businesses)
       → First customer (POST /api/v1/customers, CUSTOMERS_MAX enforced)
       → First product (POST /api/v1/products, PRODUCTS_MAX enforced)
       → First sale (POST /api/v1/sales, real validation)
       → Copilot intro (samples ONLY — no metered request executed, §95)
       → Done (POST /api/v1/onboarding/complete)
```

- Skippable steps (§47): customer/product/sale/copilot can all be skipped;
  nothing fake is ever inserted (§94/§96). Business creation is the only
  mandatory step (the app requires a business to operate).
- The flow resumes after login (§46) exactly once per browser session and
  only when the user lands on the default dashboard — deep links,
  invite tokens and payment-return flows are never hijacked.
- Exit (§98): "Skip setup" calls `POST /api/v1/onboarding/dismiss` (server
  state), keeps the business fully usable and hands over to the dashboard
  checklist.

## Server state (§44/§45)

`Business.onboardingCompletedAt` / `Business.onboardingDismissedAt`.
Browser storage holds only UI progress (resume-once marker, pending-plan
hint) — the server timestamps always decide.

**Backfill:** the Prompt 25 migration marks every business that existed
before this phase as onboarding-complete (`onboardingCompletedAt =
createdAt`), so existing tenants are NEVER forced through the new flow.
New businesses start with NULL and receive the guided experience.

## Checklist (§99/§100)

`GET /api/v1/onboarding/status` derives tasks from REAL data
(customer/product/sale/copilot counts — no duplicate boolean flags), shows
only unfinished tasks, and auto-completes the onboarding (once, evented)
when all four are real. The dashboard card links each task to its existing
module; "Hide" dismisses via the server.

## Completion semantics (§91/§97)

`onboarding complete` = the business owner acknowledged the flow
(`POST /onboarding/complete`) OR all four checklist tasks have real data
(auto, deterministic, documented as the "Business Activated" definition in
docs/marketing/conversion-funnel.md). Completion is never inferred from a
page load, and skipping is never rewritten into completion.

## Events

ONBOARDING_STARTED (client, flow entry) · ONBOARDING_COMPLETED (server,
once per business) · BUSINESS_CREATED / FIRST_*_CREATED /
COPILOT_FIRST_QUESTION (server, see conversion-funnel.md).
