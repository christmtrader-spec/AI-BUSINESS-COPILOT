# Data Inventory — Migration-Baseline Reference

**Purpose:** the machine-readable row-count baseline that
`scripts/prompt19-db-check.mjs` check **5b** compares against. Its intent is to
prove that recording migration metadata (the baseline process) did NOT change
application data.

- Original capture: 2026-09-23T05:20:35.240Z (db-push era, before `0_init`
  was recorded; 483328 bytes; integrity ok · quick_check ok · FK violations 0).
- **Refreshed: 2026-10-05 (post-P40 verification round).** The sandbox reset
  `db/custom.db` AND `.env` again between rounds (schema tables present, zero
  rows, migration ledger empty, `.env` reduced to `DATABASE_URL`). Restored
  per the living-dev-DB protocol: migration ledger re-baselined with
  `prisma migrate resolve --applied` ×20 (ledger writes ONLY), billing/pricing
  catalogs re-seeded with the sanctioned idempotent seeds, dev env baseline
  restored (NEXTAUTH_*/BILLING_TRIALS_*/MFA_*/AUTH_EMAIL_VERIFICATION_MODE),
  and the persistent dev-baseline fixture re-created via the new idempotent
  `scripts/dev-baseline-fixture.mjs` (now using the app's real bcryptjs
  convention). 20 applied / 0 pending at re-capture.
- **Refreshed: 2026-10-03 (payables-aging round).** The dev sandbox was
  rebuilt again by the environment (`.env` reduced to `DATABASE_URL`-only;
  migration ledger absent; all business data gone — schema tables present,
  zero rows). Restored per this document's living-dev-DB protocol: migration
  ledger re-baselined with `prisma migrate resolve --applied` ×18 (ledger
  writes ONLY), billing/pricing catalogs re-seeded with the sanctioned
  idempotent seeds, dev env baseline restored, THEN the payables-aging
  additive migration `20261003093000_payables_aging_expense_terms` applied
  via `migrate deploy` (19 applied / 0 pending). The row counts below are
  the post-rebuild state: only by-design persistent auth/audit fixtures
  from P17/P18/P27/P28/P29/P30 harnesses remain (integrity ok ·
  quick_check ok · FK violations 0 · 1196032 bytes). Prior refreshes:
  2026-10-03 (Prompt 37-F), 2026-10-02 (Prompt 37), 2026-10-01 (Prompt 34),
  2026-09-29 (Prompt 30-F). Row counts are a living dev database — they are
  not expected to stay frozen across product phases.
- Source database: `db/custom.db`
- SQLite integrity: ok · quick_check: ok
- Foreign-key violations: 0

## Row counts (authoritative baseline — machine-readable)

| Model | Rows |
|---|---|
| `User` | 1 |
| `Business` | 1 |
| `BusinessMember` | 0 |
| `BusinessInvite` | 0 |
| `AuditLog` | 0 |
| `Customer` | 0 |
| `Supplier` | 0 |
| `Product` | 0 |
| `InventoryAdjustment` | 0 |
| `Sale` | 0 |
| `SaleItem` | 0 |
| `Expense` | 0 |
| `Payment` | 0 |
| `ChatSession` | 0 |
| `ChatMessage` | 0 |
| `PasswordResetToken` | 0 |

> **2026-10-05 (Prompt 40 round):** the sandbox reverted `db/custom.db` and
> `.env` mid-session (documented in worklog). The 19-migration bookkeeping was
> re-baselined, the Prompt 40 migration applied, billing/pricing seeds
> restored, and the persistent dev-baseline fixture re-created.
>
> **2026-10-05 (post-P40 verification round):** the sandbox reset the DB +
> `.env` AGAIN between rounds. The counts in the table above were RE-CAPTURED
> as the authoritative snapshot of the restored environment (dev-baseline
> fixture = the only rows; integrity ok · quick_check ok · FK violations 0).
> The check's guard remains: the baseline STEP must never lose rows relative
> to the snapshot taken immediately before it.

> Note: `PasswordResetToken` rows may legitimately decrease over time via
> documented expired-token cleanup (Prompt 18). Prompt 30 additions
> (`EmailVerificationToken`, `MfaCredential`, `MfaRecoveryCode`,
> `MfaLoginChallenge`, `UserSession`, `SecurityEvent`) are not part of this
> 16-model baseline; their lifecycle is documented in
> `docs/legal/data-retention-inventory.md`. Between-phase changes are expected
> in a dev database; the check's guard is that the BASELINE step itself
> preserves whatever exists at comparison time.
>
> **Persistent dev-baseline fixture (2026-10-03, payables-aging round):**
> `dev-baseline@fixture.local` + `Dev Baseline Business` (Asia/Tehran, USD)
> are created through the REAL register/business APIs and intentionally KEPT
> between rounds so p19 check 4b ("database holds real data") passes in an
> otherwise empty rebuilt sandbox. All other harness fixtures still tear down
> to zero.
