# Payment Production Checklist — Prompt 23 (§91/§157-§160)

## Required environment variables (all server-side)
- `PAYMENTS_ENABLED=true` (exact literal in production)
- `PAYMENT_PROVIDER=zarinpal`
- `PAYMENT_ENV=production`
- `PAYMENT_BASE_URL=https://<your-domain>` (HTTPS mandatory; callback URLs derive from it)
- `ZARINPAL_MERCHANT_ID=<production merchant UUID>` (separate from sandbox — never mixed)

## Preconditions (all must be true — §160 gate)
- [ ] Merchant account + production terminal in the operator's legal name (KYC/AML respected)
- [ ] Plan catalog settlement currency **IRR** (Zarinpal settles IRR only) — explicit pricing decision made
- [ ] HTTPS origin, valid callback URL `https://<domain>/api/v1/payments/callback/zarinpal`
- [ ] Webhook: N/A — provider does not support webhooks; callback + server verification is authoritative (documented)
- [ ] Provider inquiry/verify response shapes re-confirmed against CURRENT official docs
- [ ] Sandbox payment executed and verified at least once (recorded: date, authority, result)
- [ ] Secrets deployed via the secret manager (never in git/client/logs)
- [ ] `PAYMENTS_ENABLED` default-off verified: unset variable in production = payments unavailable

## Deployment order (§157)
1. Backup database
2. Apply schema migration (`prisma migrate deploy` — never `db push`)
3. Deploy application (payments still disabled)
4. Configure secrets
5. Set `PAYMENT_ENV=production`, run configuration checks (`GET /api/v1/billing/providers` → no blockers)
6. Safe verification: create a real checkout for the cheapest plan, complete it in the provider's environment, confirm server-side verification + single activation
7. `PAYMENTS_ENABLED=true`
8. Monitor audit trail (`billing.payment_*`) + reconciliation cases
9. Provider-approved smoke test if available (never real-money destructive testing, §84/§86)

## Disable / rollback (§94/§158/§159)
- Flip `PAYMENTS_ENABLED=false` (or unset) and restart → initiation returns `PAYMENTS_UNAVAILABLE` immediately.
- Existing subscriptions, entitlements, payment history: untouched. No destructive rollback ever — payment rows are never deleted.
- A stuck PENDING session simply expires (30 min) or is superseded by the next checkout (CANCELED).

## Production readiness gate
The integration is "PRODUCTION READY" only when every checkbox above is true. Current state and the exact open blockers: `docs/billing/payment-current-state.md`.
