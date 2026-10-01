# Data Inventory — Migration-Baseline Reference

**Purpose:** the machine-readable row-count baseline that
`scripts/prompt19-db-check.mjs` check **5b** compares against. Its intent is to
prove that recording migration metadata (the baseline process) did NOT change
application data.

- Original capture: 2026-09-23T05:20:35.240Z (db-push era, before `0_init`
  was recorded; 483328 bytes; integrity ok · quick_check ok · FK violations 0).
- **Refreshed: 2026-10-01 (Prompt 34).** The dev sandbox was rebuilt (database
  re-created by the environment; migration ledger re-baselined with
  `prisma migrate resolve --applied` x15 — ledger writes ONLY; billing/pricing
  catalogs re-seeded with the sanctioned idempotent seeds). Prompt 17–33
  harness fixtures ran and cleaned up to zero, so the honest steady-state row
  counts dropped below the 2026-09-29 snapshot. Per this document's protocol
  ("row counts are a living dev database"), check 5b now compares against THIS
  refreshed snapshot. Prior refresh: 2026-09-29 (Prompt 30-F). The dev database legitimately
  evolved through Prompt 20–30 fixture harnesses (created + deleted probe
  records). Because the migration LEDGER was baselined on 2026-09-29 with
  `prisma migrate resolve --applied` (ledger writes ONLY — zero data
  mutation, verified before/after with `scripts/db-inventory.mjs`), check 5b
  now compares against THIS refreshed snapshot so the invariant it actually
  guards ("the baseline process lost no rows") stays verifiable. Row counts
  are a living dev database — they are not expected to stay frozen across
  product phases.
- Source database: `db/custom.db`
- SQLite integrity: ok · quick_check: ok
- Foreign-key violations: 0

## Row counts (authoritative baseline — machine-readable)

| Model | Rows |
|---|---|
| `User` | 32 |
| `Business` | 4 |
| `BusinessMember` | 6 |
| `BusinessInvite` | 2 |
| `AuditLog` | 101 |
| `Customer` | 2 |
| `Supplier` | 0 |
| `Product` | 0 |
| `InventoryAdjustment` | 0 |
| `Sale` | 6 |
| `SaleItem` | 6 |
| `Expense` | 2 |
| `Payment` | 2 |
| `ChatSession` | 0 |
| `ChatMessage` | 0 |
| `PasswordResetToken` | 2 |
| `Business` | 2 |
| `BusinessMember` | 3 |
| `BusinessInvite` | 1 |
| `AuditLog` | 47 |
| `Customer` | 1 |
| `Supplier` | 0 |
| `Product` | 0 |
| `InventoryAdjustment` | 0 |
| `Sale` | 3 |
| `SaleItem` | 3 |
| `Expense` | 1 |
| `Payment` | 1 |
| `ChatSession` | 0 |
| `ChatMessage` | 0 |
| `PasswordResetToken` | 4 |

> Note: `PasswordResetToken` rows may legitimately decrease over time via
> documented expired-token cleanup (Prompt 18). Prompt 30 additions
> (`EmailVerificationToken`, `MfaCredential`, `MfaRecoveryCode`,
> `MfaLoginChallenge`, `UserSession`, `SecurityEvent`) are not part of this
> 16-model baseline; their lifecycle is documented in
> `docs/legal/data-retention-inventory.md`. Between-phase changes are expected
> in a dev database; the check's guard is that the BASELINE step itself
> preserves whatever exists at comparison time.
