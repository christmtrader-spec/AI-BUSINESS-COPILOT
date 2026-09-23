# Migration Workflow — Database Change Discipline

**Document ID:** DB-MIGRATION-WORKFLOW-v1
**Round:** Prompt 19 — Migration Discipline & Schema Baseline
**Scope:** every current and future schema/data change to any non-disposable database
**Companions:** `docs/database/prompt19-baseline.md` (the completed baseline record), `docs/deployment/backup-restore-plan.md` (backup pipeline), `docs/audit/database-production-plan.md` (engine strategy)
**Stack facts:** Prisma 6.11.1 · SQLite (`db/custom.db` via `DATABASE_URL`) · baseline migration `0_init` applied 2026-09-23

---

## 1. Script classification (implemented in `package.json`)

| Script | Underlying command | Allowed environments | Guard |
|---|---|---|---|
| `bun run db:generate` | `prisma generate` | **ALL** (development, staging, production) | none needed — generates the client, touches no database |
| `bun run db:push` | `node scripts/db-guard.cjs push` **&&** `prisma db push --accept-data-loss` | **DEVELOPMENT ONLY** | hard-blocked when `NODE_ENV=production` (exit 1) |
| `bun run db:migrate` | `node scripts/db-guard.cjs migrate-dev` **&&** `prisma migrate dev` | **DEVELOPMENT ONLY** | hard-blocked when `NODE_ENV=production` (exit 1) |
| `bun run db:migrate:deploy` | `prisma migrate deploy` | **STAGING / PRODUCTION** (also usable in development) | none — this is the sanctioned deploy path |
| `bun run db:migrate:status` | `prisma migrate status` | **ALL** | none — read-only; run it before every deploy |
| `bun run db:reset` | `node scripts/db-guard.cjs reset` **&&** `prisma migrate reset` | **DEVELOPMENT ONLY** | hard-blocked when `NODE_ENV=production` (exit 1) |

The guard (`scripts/db-guard.cjs`) is live-tested. With `NODE_ENV=production` the blocked commands fail with exit code 1 and these **exact messages**:

| Command | Exact production block message |
|---|---|
| `db:push` | `db push is disabled in production. Use prisma migrate deploy.` |
| `db:reset` | `Database reset is development-only and is blocked in production.` |
| `db:migrate` | `prisma migrate dev is development-only. Use prisma migrate deploy for staging/production.` |

In non-production environments the guard exits 0 and the underlying Prisma command runs. `NODE_ENV` is therefore load-bearing for database safety (see also `docs/deployment/environment-variables.md`).

**Standing rule:** `db push` never runs against any shared or real dataset. It exists only to iterate on a throwaway development database where losing data is acceptable.

## 2. Immutability policy

> **Applied migration files are immutable.**

- Never edit, delete, or rename a migration that has been applied to any database beyond a disposable dev clone. `0_init` is applied — it is frozen forever.
- Future schema changes require **new** migrations with new, monotonically increasing names (Prisma timestamp-prefixed).
- Never rewrite old SQL to change production state. If a migration turned out to be wrong, the correction is a **new forward migration** (or, in development before anything is shared, `db:reset` + regenerate — never on real data).
- `prisma/migrations/` is version-controlled (`.gitignore` deliberately does not ignore it). Migration files are release artifacts, reviewed like code.

## 3. Future schema-change workflow (the 11 steps)

Every schema change follows this sequence, in order, without skipping verification steps:

1. **Modify `prisma/schema.prisma`** — the schema is the single source of truth for structure.
2. **Create the migration in development** — `bun run db:migrate` (i.e. `prisma migrate dev`) against a disposable development database. Let Prisma generate the SQL; do not hand-write it unless necessary, and never paste DDL straight into a database.
3. **Review the generated SQL** — read the file in `prisma/migrations/<timestamp>_<name>/migration.sql` line by line: schema-only, no destructive surprises (check `DROP`/column-type changes against real data expectations), no credentials/PII (§7).
4. **Test on a disposable database** — copy of current data, or an empty database for the from-scratch path: `prisma migrate deploy` must apply cleanly. For risky changes, test against a realistic data volume.
5. **Run the application test suites** — at minimum `bun scripts/e2e-smoke.ts`, plus the relevant regression harnesses (`scripts/prompt17-security-check.mjs`, `scripts/prompt18-auth-check.mjs`, `scripts/prompt19-db-check.mjs`) and lint/type-check.
6. **`bun run db:migrate:status`** — confirm the target database's pending/apply state before deploying anything.
7. **Commit the migration** — the migration file is committed together with the code that uses the new schema (they are one atomic change).
8. **Back up the production database** — mandatory, immediately before deploy (SQLite file backup + checksum; `docs/deployment/backup-restore-plan.md`). **The DB file MUST be backed up before ANY schema migration.**
9. **`bun run db:migrate:deploy`** — the only schema-change command for staging/production. **Do NOT `db push` on production — ever** (the guard blocks it, and the ban is also policy, because guards can be bypassed by invoking `prisma db push` directly).
10. **Verify the application** — exercise the affected flows; `GET /api/health` must report `status: "ok"` with the expected migration counts.
11. **Verify database health** — `bun run db:migrate:status` shows applied; run `scripts/db-inventory.mjs` for integrity + counts; compare against the inventory doc when the change is expected to be structure-only.

## 4. Data-migration policy

Schema changes that also transform **data** (backfills, format conversions, denormalization repairs) are treated as first-class, deliberate migrations:

- Transformations must be **explicit migration steps**, never hidden in application startup or lazily executed by request handlers (see §6 — nothing in `src/` runs migrations, and it stays that way).
- Each data migration ships with a short written record (in the PR description or a doc under `docs/database/`) covering four points:
  1. **Old structure/state** — what exists before;
  2. **New structure/state** — what exists after;
  3. **Transformation** — the exact rule applied to every affected row;
  4. **Recovery** — how to restore if the migration must be undone (typically: restore the pre-migration backup, because `prisma migrate deploy` is forward-only).
- Data migrations are tested on a data-bearing clone (step 4 above) before they ever touch staging/production, and the row-count/money invariants of `docs/database/data-inventory-before-baseline.md` are used to prove nothing was silently lost.

## 5. Deployment compatibility (standalone output — honest facts)

- `next.config.ts` uses `output: "standalone"`; the `build` script additionally copies `.next/static` and `public/` into `.next/standalone/`.
- Next standalone tracing bundles the **Prisma query engine** with `@prisma/client`, so the app runtime can query the database.
- **However, `prisma/migrations/` is NOT automatically copied into the standalone artifact.** At deploy time, migrations must be run **from the repository checkout** (where `prisma/migrations/` exists alongside `prisma/schema.prisma`), or the migrations directory must be shipped explicitly as part of the release.
- Practical consequence: the deploy sequence is *ship build artifact + keep repo checkout (or ship `prisma/migrations/`)* → run `bun run db:migrate:deploy` from the checkout with the production `DATABASE_URL` → then start/replace the server.
- **RECOMMENDED (not yet performed) check:** at the first real deploy, verify the Prisma engine is actually present in the standalone bundle (i.e. the standalone server starts and `GET /api/health` reports `database.reachable: true`). This has not been verified against a real production deployment yet.

## 6. Production command policy (the 8-step release sequence)

Never `prisma migrate dev` in production — it is development-only, guarded, and its shadow-database behavior has no place against real data. Production schema changes follow exactly this sequence:

1. **Backup** — SQLite file backup + SHA-256 checksum into `db/backups/` (git-ignored) and off-host per `docs/deployment/backup-restore-plan.md`.
2. **Validate** — `bun run db:migrate:status` against production: expected pending migration list must match the release notes exactly.
3. **Deploy files** — put the new build artifact and the repo checkout (with `prisma/migrations/`) in place (§5).
4. **Migrate** — `bun run db:migrate:deploy`; expect "All migrations have been successfully applied" (path proven by the Prompt-19 canary test, `docs/database/prompt19-baseline.md` §7).
5. **Health check** — `GET /api/health` → `status: "ok"`, `migrations.applied` increased as expected, `migrations.pending: 0`.
6. **Smoke validation** — exercise the affected application flows (login, a read path, a write path).
7. **Confirm logs** — review `server.log`/`stdout` for errors; record the migration run per §7.
8. **Mark the release** — record release id, timestamp, migration names, and health result in the operator log; keep the pre-upgrade backup until the next successful upgrade.

## 7. Migration SQL hygiene

- Migration SQL is **schema-only**: DDL (and, for data migrations, the deliberate DML described in §4).
- **No credentials, no connection strings, no PII, no secrets of any kind** may appear in a migration file — it is a version-controlled artifact.
- The `0_init` baseline was reviewed against this rule and passes (see `docs/database/prompt19-baseline.md` §5).
- Reviewers should reject migrations containing literal emails, tokens, passwords, or environment-specific hosts/paths.

## 8. No auto-migration on application start (verified, keep it that way)

Verified by grep during Prompt 19 (§43/§44): **there is no `migrate`/`push`/`reset` logic anywhere in `src/` startup code.** Application startup and migration deployment are separate concerns:

- The app connects with `PrismaClient` and assumes the schema is already deployed.
- Schema deployment happens exclusively through the commands in §1, run deliberately by an operator/agent.
- **Policy: keep it this way.** Do not add "auto-migrate on boot", "ensure schema", or any destructive startup "repair" logic. Silent startup-time DDL is unauditable, races with multi-instance starts, and hides failures that §6 is designed to surface.

## 9. Observability during migrations

When running migrations (any environment beyond a disposable dev database), record:

- the **command result** (`prisma migrate deploy` output summary — migration names, success/failure);
- the **application version / release id** (`src/lib/app-version.ts` is the single version source) the migration shipped with;
- the **timestamp** of the run;
- the operator/agent that ran it.

**Never log database credentials** — no `DATABASE_URL` values, no connection strings in logs, operator notes, or this documentation. `GET /api/health` deliberately exposes only migration *counts* (derived from `_prisma_migrations`), never schema internals, table names, or the DB URL.

## 10. Current vs future engine decision

- **CURRENT (this phase, unchanged):** SQLite, single file `db/custom.db`, single node. The baseline was executed against it with zero drift (§1 of the baseline record). No engine change was performed or is planned for the current horizon.
- **FUTURE (trigger-based, not now):** PostgreSQL becomes the trigger-based decision when the project hits any of:
  - sustained **concurrent writers** (SQLite's single-writer lock starts hurting under real parallel payment/report load);
  - a requirement for **horizontal scaling** (second app instance / split API+DB);
  - **significantly larger workloads** (data volume or report aggregation outgrowing embedded SQLite);
  - an **operational requirement** (managed backups/PITR, connection pooling, server-side constraint depth).
- Until a trigger fires, no Postgres migration work is scheduled. The full engine analysis (enum promotion, transaction-isolation hardening for the payments pipeline, data-type mapping, cutover plan) lives in `docs/audit/database-production-plan.md`.
