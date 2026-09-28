# Release Rollback (AI Business Copilot)

**Document ID:** DEPLOY-ROLLBACK-v1
**Phase:** Prompt 29 §118/§119 (created)
**Companions:** `docs/deployment/production-operations.md` (deploy sequence) ·
`docs/deployment/backup-restore-plan.md` (backup/restore detail) ·
`docs/database/migration-workflow.md` (forward-only migration law)

---

## 1. Rollback policy in one paragraph (Prompt 29 §118/§119)

Application rollback is **redeploy the previous artifact**. Database rollback
is **never automatic**: there is NO `prisma migrate down`, no schema
reverse-migration, and the production database is **never overwritten
automatically** by any script. A bad migration is recovered either by
**restoring a verified backup** (explicit operator procedure) or by shipping
a **corrective ADDITIVE migration**. Every deploy is preceded by a fresh,
verified backup precisely so this policy is executable.

## 2. Application rollback (safe, routine)

The standalone build is a self-contained tree (`.next/standalone/` with
static assets and `public/` inside). Deployments therefore go to a new
release tree (e.g. `/srv/app-<release>/`), and rollback is:

1. Stop the current process (SIGTERM — graceful shutdown, §70 of the runbook).
2. Point the start command at the previous tree's
   `.next/standalone/server.js`.
3. Start (`bun run start` equivalent) and verify:
   - `GET /api/health` → `status:"ok"`;
   - `GET /api/ready` → overall not `blocked`; per-component statuses match
     expectations (§94 of the runbook);
   - a logged-in flow works (sign-in + one business read) and responses carry
     `X-Request-ID`.

Keep at least the previous release tree until the new release has survived a
monitoring window. Static assets ride inside the standalone tree — no shared
state to clean up.

### When application-only rollback is safe (schema-compatible case)

Migrations in this project are ADDITIVE and forward-only (new tables, new
nullable columns, new indexes). Under that discipline the **previous
application artifact is compatible with the NEW schema**: an older artifact
simply ignores columns/tables it does not know. Application-only rollback
without touching the database is therefore safe when:

- the release's migrations were additive only (no renamed/dropped columns,
  no type changes, no destructive data backfills), AND
- the previous artifact's expected migration baseline is a subset of what is
  applied (check `bun run db:migrate:status` — it must not report the DB as
  behind the OLD artifact's expectations in a way the old code cannot handle;
  additive extras are harmless).

If a release ever contains a destructive migration, that release's rollback
is NOT application-only — see §3/§4.

## 3. Database rollback policy (Prompt 29 §119)

**There is no automatic database rollback.** Prisma migrations are
forward-only; `prisma migrate down` does not exist in this workflow and will
not be added. A migration that corrupts or mis-serves data is recovered by
exactly one of:

### Option A — restore a verified backup (data-integrity failures)

The recovery path for "the migration (or the release running against it)
damaged data":

1. Stop the application (graceful shutdown; verify port free — runbook §72).
2. Choose the verified backup created immediately before the migration
   (step 1 of every deploy). Re-verify it:
   `node scripts/verify-backup.mjs <backup-file>` — checksum + integrity
   must PASS (`verified=true` in the sidecar).
3. Prove restorability without touching production, if the situation allows
   the time: `node scripts/restore-drill.mjs --backup <file>` runs on an
   isolated temp clone (checksum first, integrity, row-count probes,
   `prisma migrate status` against the clone) and writes
   `db/backups/last-restore-drill.json`.
4. **Operator-managed restore** — a documented manual procedure
   (`docs/deployment/backup-restore-plan.md` §4): quarantine the current db
   file (keep it for forensics), place the verified backup at the
   `DATABASE_URL` path, `PRAGMA integrity_check` must return `ok` before
   start, then start and re-verify health/readiness.
   - The drill script itself REFUSES production targets (exit 2) and
     refuses in-place restore even with `--allow-production-restore`
     (exit 3: `IN_PLACE_RESTORE_NOT_IMPLEMENTED`) — **the production DB is
     never overwritten automatically**.
   - Be aware of what you lose: rows written between the backup and the
     incident are gone with the restore. Record the decision and the window.
5. After restore, the application artifact to run is the one matching that
   backup's schema generation (see §4).

### Option B — corrective ADDITIVE migration (logic failures)

If the migration applied fine but the CODE mishandles the new schema, or a
migration left a harmless-but-wrong shape (e.g. a wrong default on a new
nullable column), do not roll anything back: ship a NEW forward migration
that corrects the state additively, after the standard pipeline
(backup → verify → gate → `db:migrate:deploy`).

## 4. Matching artifact to schema after a restore

A restored backup contains the `_prisma_migrations` state of its time. After
a backup restore:

- Run `bun run db:migrate:status`. If the deployed artifact is NEWER than the
  restored schema, re-apply the pending migrations forward:
  `node scripts/production-preflight.mjs --gate` then
  `bun run db:migrate:deploy` (fresh backup first per the runbook sequence —
  the restored file becomes the new rollback anchor).
- Alternatively run the OLDER artifact that matches the restored schema and
  re-release normally. Never try to force the schema backwards.

## 5. Forward-only additive discipline

- All schema evolution ships as NEW migration files; applied migrations are
  immutable (`docs/database/migration-workflow.md`).
- Migrations are ADDITIVE by design (this is what makes application-only
  rollback safe, §2). Destructive changes require an explicit, documented
  decision and a pre-approved recovery plan — treat them as
  "rollback = restore backup" releases.
- The deploy sequence always takes + verifies a backup BEFORE the gate and
  the migration (`docs/deployment/production-operations.md` §1, §45 gate).

## 6. Health/readiness verification after ANY rollback

| Check | Command | Pass |
|---|---|---|
| Liveness | `curl -fsS http://localhost:3000/api/health` | 200, `status:"ok"` |
| Readiness | `curl -fsS http://localhost:3000/api/ready` | 200; overall `ready` (or honestly `degraded` for known optional gaps) — never `blocked` |
| Migrations | `bun run db:migrate:status` | state understood; no unexpected pending set |
| Correlation | any API response | `X-Request-ID` header present |
| Functional | sign-in + one business-scoped read | succeeds; audit rows written |

Record the rollback (trigger, artifact restored/kept, backup used if any,
verification output) in the operator log.

## 7. Honest limitations

- **No automatic rollback exists anywhere in this system.** Every step above
  is a human-operated procedure; there is no tooling that detects a bad
  release and reverts it.
- **In-place production restore is NOT implemented** — restore is a manual,
  documented operator procedure; the drill script categorically refuses to
  overwrite the production database file.
- A backup restore loses the data written after that backup; the RPO equals
  the backup cadence the operator actually runs (the readiness `backups`
  component goes `STALE` past `BACKUP_MAX_AGE_HOURS`, default 26h, but no
  system enforces a restore point more recent than the last verified backup).
- Rollback safety reasoning (§2) depends on the additive-migration discipline
  being actually followed; a destructive migration breaks the
  "old artifact runs on new schema" guarantee and forces the backup-restore
  path.
