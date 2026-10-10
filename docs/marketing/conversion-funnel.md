# Conversion Funnel — Prompt 25 §49/§53/§101-§108

## Model

```
Visitor → pricing_viewed → plan_selected → signup → business_created
        → onboarding → (trial / free) → checkout → paid
        → first_customer / first_product / first_sale / copilot_first_question
```

## Event registry (single source: `src/lib/analytics.ts`)

| Event | Emitter | Dedupe |
| --- | --- | --- |
| PRICING_VIEWED | client (allowlisted ingest) | session × UTC day |
| PLAN_SELECTED | client (allowlisted) | session × UTC day |
| SIGNUP_STARTED | client (allowlisted) | session × UTC day |
| ONBOARDING_STARTED | client (allowlisted) | session × UTC day |
| SIGNUP_COMPLETED | server (register route) | once per user |
| BUSINESS_CREATED | server (businesses route) | once per business |
| ONBOARDING_COMPLETED | server (status auto / complete route) | once per business |
| TRIAL_STARTED | server (billing service startTrial) | once per business |
| CHECKOUT_STARTED | server (payments service, provider accepted) | once per session |
| CHECKOUT_COMPLETED | server (fulfillSession — webhook AND verify paths) | once per session |
| PAYMENT_FAILED | server (create-failure / webhook failed) | once per session |
| FIRST_CUSTOMER_CREATED | server (customers route, post-create count = 1) | once per business |
| FIRST_PRODUCT_CREATED | server (products route, post-create count = 1) | once per business |
| FIRST_SALE_CREATED | server (sales route, invoice number = 1) | once per business |
| COPILOT_FIRST_QUESTION | server (copilot route, after a metered answer) | once per business |

Critical lifecycle events CANNOT be forged: the public ingest endpoint
(`POST /api/v1/public/analytics`) accepts ONLY the four allowlisted names
and answers `422 EVENT_NOT_ALLOWED` for anything else (§104/§122).

## "Business Activated" (§48)

Deterministic definition implemented in `GET /api/v1/onboarding/status`:
**onboarding acknowledged OR all four checklist tasks have real data**
(customer > 0, product > 0, sale > 0, copilot question > 0). The read
endpoint completes the onboarding idempotently when that condition becomes
true — completion always reflects actual behavior, never a UI load (§91).

## Privacy model (§50/§103/§106/§107/§172)

- Stored columns: name, userId?, businessId?, planCode?, billingPeriod?,
  currency?, page?, source?, locale?, dedupeKey, createdAt.
- NEVER stored: passwords, payment credentials, customer PII, financial
  amounts, raw AI prompts/responses, form contents, raw provider payloads.
- Properties are sanitized (format-checked, length-capped) in
  `src/lib/analytics.ts`; unknown properties are dropped.
- The client session marker is a random per-tab UUID in sessionStorage — it
  identifies a session, never a person.
- First-party only: no third-party scripts, no tracking cookies (§108/§134).

## Retention (§106)

Rows are tiny (≤ a few hundred bytes). Operators can prune with:
`DELETE FROM "AnalyticsEvent" WHERE "createdAt" < now() - INTERVAL 'N days'`
(SQLite: `WHERE "createdAt" < <epoch-ms cutoff>`). A 180-day retention is a
sensible default; nothing currently auto-deletes (honest statement).

## Testing (§171)

The Prompt 25 harness fires synthetic client events with unique session ids
and never asserts on the real funnel counts, so production analytics are
not polluted by test runs.
