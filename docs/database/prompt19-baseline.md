# Prompt 19 — Production Database Migration Baseline Record

**Document ID:** DB-P19-BASELINE
**Round:** Prompt 19 — Migration Discipline & Schema Baseline
**Date of operations:** 2026-09-23 (machine timestamps 05:20–05:22 UTC)
**Source database:** `db/custom.db` (SQLite, 483328 bytes, via `DATABASE_URL`)
**Companion docs:** `docs/database/migration-workflow.md` (going-forward discipline), `docs/database/data-inventory-before-baseline.md` (authoritative before-counts), `docs/audit/database-production-plan.md` (broader plan)

Machine-audit record of the one-time baseline: the repository previously had **no `prisma/migrations/` directory** and the schema was managed by `prisma db push` (script `db:push` = `prisma db push --accept-data-loss`). Prompt 19 created a verified baseline migration, marked it applied on the live database, and proved restore + deploy paths — **with zero schema change and zero data change**.

---

## 1. Sequence of operations

| Step | What | When (UTC) |
|---|---|---|
| §3/§4 | Safety snapshot `pre-prompt19` + integrity checks | 05:20:05 |
| §14 | Pre-inventory captured (`scripts/db-inventory.mjs`) | 05:20:35 |
| §6 | Drift check: live DB vs `prisma/schema.prisma` | 05:20–05:21 |
| §8 | Baseline migration generated from the schema | 05:21 |
| §3/§13 | Second backup `pre-baseline` immediately before real-DB baseline | 05:21:57 |
| §13 | `prisma migrate resolve --applied 0_init` on the real DB | 05:21:58 (row `finished_at`) |
| §12 | `prisma migrate status` on real DB → up to date | 05:22 |
| §15/§39 | Post-inventory + integrity checks | 05:22:09 |

## 2. Backups (§3/§13)

Both stored in `db/backups/` (**git-ignored** — checksums documented here are safe; the artifacts never enter version control):

| Artifact | Taken | SHA-256 | Size |
|---|---|---|---|
| `db/backups/pre-prompt19-20260923-052005.db` | before ANY operation | `ec8b4958d5f6b305cb51036fb89200026f5c87ca95dabd010ebce5e80e812e80` | 483328 bytes |
| `db/backups/pre-baseline-20260923-052157.db` | immediately before the real-DB baseline | `ec8b4958d5f6b305cb51036fb89200026f5c87ca95dabd010ebce5e80e812e80` | 483328 bytes |

Identical hashes are expected: the pre-baseline backup is a second snapshot of the same untouched database, proving nothing had changed between the two captures.

## 3. Integrity (§4/§15) — before AND after

| Check | Before | After |
|---|---|---|
| `PRAGMA integrity_check` | ok | ok |
| `PRAGMA quick_check` | ok | ok |
| `PRAGMA foreign_key_check` | 0 rows | 0 rows |

## 4. Drift check (§6) — zero drift

```bash
bunx prisma migrate diff \
  --from-url file:/home/z/my-project/db/custom.db \
  --to-schema-datamodel prisma/schema.prisma \
  --script
```

Output was exactly:

```sql
-- This is an empty migration.
```

**Result: ZERO drift** between `prisma/schema.prisma` and the live database. The generated baseline is therefore a faithful description of production reality, not an aspiration.

## 5. Baseline migration (§8) — `0_init`

Generated with:

```bash
bunx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/0_init/migration.sql
```

Artifact: `prisma/migrations/0_init/migration.sql` — **352 lines, pure DDL**. Review summary (verified by direct inspection of the committed file):

| Property | Value |
|---|---|
| `CREATE TABLE` statements | **16** (all application models) |
| Index statements | **35** — 28 `CREATE INDEX` + 7 `CREATE UNIQUE INDEX` (unique constraints) |
| Foreign-key constraints | **29** — 20 `ON DELETE CASCADE`, 8 `ON DELETE SET NULL`, **1 `ON DELETE RESTRICT` (`Business.ownerId`)** |
| Money columns | `INTEGER` (minor units — A08 law preserved, e.g. `Sale.totalMinor INTEGER`) |
| DML statements | **none** — no `DROP`, no `DELETE FROM`, no `INSERT INTO`, no `UPDATE` (the only `DELETE`/`UPDATE` tokens are FK action clauses `ON DELETE …`/`ON UPDATE …`, which are DDL) |
| Secrets / PII | none — column and index names only; no row data, no connection strings, no tokens |

`prisma/migrations/` is deliberately **NOT git-ignored** (`.gitignore` carries an explicit note): migration files are immutable release artifacts and must be version-controlled.

## 6. Clone test (§11/§12)

A copy of the live database at `/tmp/aibc-p19-baseline.db` was marked as baselined and inspected:

- `DATABASE_URL=file:/tmp/aibc-p19-baseline.db prisma migrate resolve --applied 0_init` → success
- `prisma migrate status` → **"Database schema is up to date!"**
- `_prisma_migrations` row `0_init` with `applied_steps_count = 0` — metadata only, **zero SQL executed** against the clone
- Data intact: 17 tables (16 application + `_prisma_migrations`), 34 users, 13 businesses, 11 sales

Workspace discarded afterwards.

## 7. Canary test (§16)

Disposable workspace `/tmp/p19-canary` (copy of schema + migrations + clone) was used to prove the deploy path end-to-end:

- Synthetic migration `20260923120000_canary_test` (`CREATE TABLE "Prompt19Canary"` with a nullable `"note" TEXT` column) applied to the clone via `prisma migrate deploy`
- Result: **SUCCESS — "All migrations have been successfully applied"**; data intact
- Workspace discarded afterwards. The real `prisma/migrations/` contains **only `0_init`** — the canary never touched the repository or the real database

This proves the `prisma migrate deploy` path works before it is ever needed in production.

## 8. Restore test (§34) — disaster recovery VERIFIED, not just claimed

The pre-prompt19 backup was copied to `/tmp/aibc-p19-restore.db` and exercised:

1. `PRAGMA integrity_check` → ok; `PRAGMA foreign_key_check` → 0 violations
2. Row counts match the inventory: **34 users / 13 businesses**
3. `PrismaClient` connects and reads: `businesses = 13`, `users = 34`, `SUM(Sale.totalMinor) = 300008500`
4. Sample business rows readable (e.g. "Sara's Handmade Shop")

Clone discarded afterwards. The claim "backups are restorable" is therefore backed by a performed test. The standing procedure is codified in `docs/deployment/backup-restore-plan.md`.

## 9. Real-database baseline (§13)

```bash
prisma migrate resolve --applied 0_init   # against db/custom.db
prisma migrate status                      # → "Database schema is up to date!"
```

- **No tables were recreated, no rows were touched** — `resolve` writes migration bookkeeping only
- `_prisma_migrations` now exists on the real DB (it did NOT exist before) with **exactly one applied migration**: `0_init` (`finished_at` 2026-09-23T05:21:58.060Z, `applied_steps_count = 0`, not rolled back)
- Post-baseline table count: **17** (16 application tables + `_prisma_migrations`)

## 10. Before/after comparison (§14/§39) — all identical

`scripts/db-inventory.mjs` (read-only probe) captured `/tmp/p19-inventory-before.json` (05:20:35Z) and `/tmp/p19-inventory-after.json` (05:22:09Z). Result:

- **ALL 16 table counts identical** (authoritative table: `docs/database/data-inventory-before-baseline.md` — User 34, Business 13, BusinessMember 19, BusinessInvite 6, AuditLog 230, Customer 23, Supplier 0, Product 2, InventoryAdjustment 10, Sale 11, SaleItem 13, Expense 5, Payment 9, ChatSession 1, ChatMessage 2, PasswordResetToken 4)
- **All money totals identical** (minor units): `saleTotalMinor` 300008500, `salePaidMinor` 7000, `expenseAmountMinor` 163702, `expensePaidMinor` 60000, `paymentInMinor` 7000, `paymentOutMinor` 60000
- **Per-business and per-owner aggregates byte-identical**
- **Relationship orphan checks all 0** in both captures
- The ONLY differences between the two captures: the `capturedAt` timestamp and `migrationTables: [] → ["_prisma_migrations"]`

(The `/tmp/*.json` artifacts are ephemeral; the durable record is `docs/database/data-inventory-before-baseline.md` plus this document. `PasswordResetToken` rows may legitimately decrease over time via the documented Prompt-18 expired-token cleanup — all other counts must never decrease.)

## 11. State after baseline (honest summary)

- `prisma/migrations/` contains exactly one migration: `0_init`. The repo's schema-management era has moved from `db push` to migration-based workflow (`docs/database/migration-workflow.md`).
- `db push` / `db reset` / `prisma migrate dev` are **development-only** and hard-blocked in production by `scripts/db-guard.cjs` (exact block messages documented in the workflow doc).
- **Not done in this phase (by design):** no schema change, no data change, no engine change (SQLite remains), no CI/CD. Whether the Prisma query engine ships inside the Next standalone artifact must be **verified at first real deploy** (recommended check — see `docs/database/migration-workflow.md` §5).
