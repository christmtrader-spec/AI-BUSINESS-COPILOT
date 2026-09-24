# Payment Production Checklist — Billing View (§162)

Operator-facing copy of `docs/deployment/payment-production-checklist.md` (kept in sync):

1. **Config gate**: `GET /api/v1/billing/providers` must show the real provider with `usable: true` and the config summary with zero blockers. Any blocker = payments initiation is fail-closed (422 `PAYMENTS_UNAVAILABLE`) by design.
2. **Never mock in production**: `PAYMENT_PROVIDER=mock` + production runtime is a hard configuration error (§7/§130); the system refuses to start payments rather than silently switching providers (§90).
3. **Verification chain** before any plan activation (§48): intent exists → provider payment created → user completes provider flow → server verifies with the provider → amount verified → currency verified → reference verified → SUCCEEDED → `changePlan` → entitlements/usage re-resolve → audit events.
4. **Idempotency guarantees**: duplicate callback/webhook/verify → exactly one activation; stale FAILED can never overwrite SUCCEEDED; expired sessions reject new attempts (new intent required, §79).
5. **Reconciliation**: mismatch cases land in `RECONCILIATION_REQUIRED` — see `docs/billing/payment-reconciliation.md` for the runbook.
6. **Current status**: production activation is BLOCKED — see `docs/billing/payment-current-state.md` for the exact blocker list.
