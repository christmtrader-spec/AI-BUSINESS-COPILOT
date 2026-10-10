# Free Trial — Prompt 25 §30-§39

## What exists

The trial capability is the EXISTING Prompt 20 domain logic
(`startTrial`/`endTrial` in `src/lib/billing/service.ts`), surfaced through:

- `POST /api/v1/billing/trial` `{ action: "start" | "end" }` — OWNER/ADMIN
  only, rate-limited, and **disabled unless `BILLING_TRIALS_ENABLED=1`**
  (anything else → 422 `BUSINESS_NOT_ELIGIBLE`).
- The billing page trial button, which is rendered only when the public
  pricing payload reports `trialsEnabled: true` (configuration-aware, §33).
- The FAQ trial item, rendered only when trials are enabled (§114).

## Policy (all enforced server-side)

- **One trial per business** (`trialStart` must be null — §32). Deleting a
  business does NOT reset any user-level ledger, and the event dedupe key
  (`trial:{businessId}`) is per business; repeat-trial abuse through
  business recreation remains governed by the existing BUSINESSES_MAX
  entitlement + audit trail. No device fingerprinting (§32).
- **Duration is configuration, not invention** (§34): `BILLING_TRIAL_DAYS`
  (1..90, documented default 14) resolved by `configuredTrialDays()`. The
  public payload exposes the SAME number as `trialDays`, so marketing copy
  and the granted trial can never disagree. When trials are disabled the
  number is never advertised.
- **A trial is not a price** (§35): no €0 checkout, no payment session,
  no PaymentIntent. `startTrial` transitions the subscription to TRIALING
  through the Prompt 20 state machine (TRIAL_STARTED event + audit).
- **Eligibility is server-authoritative** (§89): the UI hides the button
  when a trial was used, but the server re-checks at click time and answers
  with an honest localized message (§88 — no internal reason leaked).

## Expiration

`expireSubscriptionIfDue` (Prompt 20) remains the ONLY expiration authority
(§37). No second job exists. Expiry follows the existing lifecycle:
TRIALING → EXPIRED, entitlements fall back per the standing rules (§13),
and the billing page shows the real state (§38/§39: no invented
"downgrade to FREE" promise beyond what the state machine actually does).

## Honest status

CONFIGURED = `BILLING_TRIALS_ENABLED=1` + optional `BILLING_TRIAL_DAYS`.
In this deployment trials are currently **DISABLED** (the env flag is not
set), so: no trial CTA, no trial FAQ, and the trial API answers 422.
The domain capability is IMPLEMENTED and TESTED; activation is a one-line
operator decision.
