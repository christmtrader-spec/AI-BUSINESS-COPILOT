# Data Inventory — Migration-Baseline Reference

**Purpose:** the machine-readable row-count baseline that
`scripts/prompt19-db-check.mjs` check **5b** compares against. Its intent is to
prove that recording migration metadata (the baseline process) did NOT change
application data.

- Original capture: 2026-09-23T05:20:35.240Z (db-push era, before `0_init`
  was recorded; 483328 bytes; integrity ok · quick_check ok · FK violations 0).
- **Refreshed: 2026-10-03 (Prompt 37-F).** The dev sandbox was rebuilt again
  by the environment (`.env` reduced to `DATABASE_URL`-only; migration ledger
  absent). Restored per this document's living-dev-DB protocol: migration
  ledger re-baselined with `prisma migrate resolve --applied` ×18 (ledger
  writes ONLY — zero data mutation; `migrate status` → 18 applied / 0
  pending), billing/pricing catalogs re-seeded with the sanctioned idempotent
  seeds, and the documented dev env baseline restored
  (`NEXTAUTH_URL`/`APP_BASE_URL`/`NEXTAUTH_SECRET`/`AUTH_EMAIL_VERIFICATION_MODE=OPTIONAL`/
  `BILLING_TRIALS_*`/`MFA_ENABLED`+`MFA_ENCRYPTION_KEY`). The FULL regression
  (Prompt 17–37-F) then ran green and every E2E fixture suite cleaned up to
  zero (rows below include by-design persistent auth/audit fixtures from
  P17/P18/P27/P28/P29/P30 harnesses — integrity ok · quick_check ok ·
  FK violations 0 · 1445888 bytes). Prior refreshes: 2026-10-02 (Prompt 37),
  2026-10-01 (Prompt 34), 2026-09-29 (Prompt 30-F). Row counts are a living
  dev database — they are not expected to stay frozen across product phases.
- Source database: `db/custom.db`
- SQLite integrity: ok · quick_check: ok
- Foreign-key violations: 0

## Row counts (authoritative baseline — machine-readable)

| Model | Rows |
|---|---|
| `User` | 39 |
| `Business` | 6 |
| `BusinessMember` | 10 |
| `BusinessInvite` | 1 |
| `AuditLog` | 116 |
| `Customer` | 8 |
| `Supplier` | 1 |
| `Product` | 3 |
| `InventoryAdjustment` | 1 |
| `Sale` | 3 |
| `SaleItem` | 3 |
| `Expense` | 1 |
| `Payment` | 1 |
| `ChatSession` | 0 |
| `ChatMessage` | 0 |
| `PasswordResetToken` | 6 |

> Note: `PasswordResetToken` rows may legitimately decrease over time via
> documented expired-token cleanup (Prompt 18). Prompt 30 additions
> (`EmailVerificationToken`, `MfaCredential`, `MfaRecoveryCode`,
> `MfaLoginChallenge`, `UserSession`, `SecurityEvent`) are not part of this
> 16-model baseline; their lifecycle is documented in
> `docs/legal/data-retention-inventory.md`. Between-phase changes are expected
> in a dev database; the check's guard is that the BASELINE step itself
> preserves whatever exists at comparison time.
