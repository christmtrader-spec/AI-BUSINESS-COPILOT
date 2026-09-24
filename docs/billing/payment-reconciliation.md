# Payment Reconciliation — Operations Runbook (Prompt 23 §45/§139/§140)

## What lands in RECONCILIATION_REQUIRED
A checkout session becomes `RECONCILIATION_REQUIRED` (terminal, never auto-resolved) when provider evidence conflicts with our authoritative snapshot:
- `AMOUNT_MISMATCH` — provider reports/verifies an amount different from the session snapshot (webhook claim or verify `-50`).
- `CURRENCY_MISMATCH` — provider currency differs from the session currency.
- `REFERENCE_MISMATCH` — provider echoed an authority/reference that does not bind to the attempt.
- `GATEWAY_IP_MISMATCH` — provider IP-control tripped during verification (-53).

The session keeps `reconciliationReason` + a `metaJson` discrepancy record (expected vs reported) and the audit log gets `billing.payment_reconciliation_required`.

## What MUST NOT happen
- No automatic plan activation from a reconciliation case (§45).
- No automatic "mark as failed" either — money may have moved; only investigation settles it.
- No arbitrary manual "mark paid" tooling (§46 — a controlled admin authorization workflow is future work).

## Investigating a case (no provider secrets needed, §140/§46)
Every case is traceable through:
1. `CheckoutSession.id` (+ `initiatedByUserId`, `pricingVersion`, snapshot amount/currency)
2. `PaymentTransaction` rows (provider event ids, money records)
3. `ProcessedWebhookEvent` ledger (what was delivered/processed)
4. Audit trail (`billing.payment_*` actions in chronological order)
5. Provider references stored on the session (`providerRef` — Authority) and transaction meta (e.g. `ZP-<ref_id>`)

Read-only visibility: query the DB by session id / provider ref; the audit view exposes the payment lifecycle per business. Do NOT expose provider secrets anywhere.

## Resolution paths (manual, operator-driven)
- **Money truly moved at the wrong amount** → resolve with the provider (refund/partial-charge flow is future work, §141); then either (a) re-price honestly through a NEW PaymentIntent/checkout at the correct amount, or (b) cancel the case and record the outcome in audit.
- **Money moved correctly (provider error was transient)** → re-verify through a fresh internal verification run; if the provider authoritatively confirms amount+currency+reference, the standard fulfillment path activates the plan exactly once. Never edit session status by hand without provider evidence.
- **No money moved** → the session can be closed as FAILED via a provider-verified failure; the user starts a new payment.

## User-facing copy (§139)
Users NEVER see "payment failed" for an unknown state. The return page shows:
- PENDING → "Your payment is being verified."
- RECONCILIATION_REQUIRED → "Payment verification requires additional processing." (+ reassurance: no double charge, subscription unchanged meanwhile)

## Data retention
Payment history is never deleted (§97). Reconciliation cases remain queryable indefinitely; retention policy beyond that is a documented future decision.
