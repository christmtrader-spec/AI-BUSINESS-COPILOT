# Backup & Restore Plan (AI Business Copilot)

**Document ID:** BACKUP-RESTORE-v1.0
**Phase:** Prompt 17 (deployment readiness)
**Companions:** `docs/deployment/production-checklist.md` (deployment + first-run),
`docs/billing/billing-architecture.md` (billing is design-only; no billing data exists yet)

Two layers of protection, both already supported by shipped code:

1. **Infrastructure backup** — the SQLite database file itself (operator-run).
2. **Application backup** — owner-driven JSON export/import (in-app, shipped
   in Phase 06).

---

## 1. What must be backed up

| Artifact | Backup? | Why |
|---|---|---|
| **`db/custom.db`** | ✅ **REQUIRED — single source of truth** | All application data lives in this one SQLite file (`docs/TECH-DECISION-RECORD.md:20` "Prisma + SQLite (file `db/custom.db`)"; datasource `prisma/schema.prisma:9-12` resolves `DATABASE_URL`) |
| **`.env`** | ✅ required — **stored separately from db backups** | Secrets (`DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL` — names only; see `docs/deployment/production-checklist.md` §4). Losing `NEXTAUTH_SECRET` means every user session is invalidated on rotation (TDR §5, `docs/TECH-DECISION-RECORD.md:132`) |
| **`prisma/migrations/`** (once created) | ✅ with the repo | Schema history; needed to rebuild/reproduce (`production-checklist.md` §3) |
| `.next/` build output | ❌ not needed | Fully rebuildable from source via `npm run build` (`package.json:7`; standalone output `next.config.ts:4`) |
| `node_modules/` | ❌ not needed | Reinstallable (`bun.lock`) |
| Uploaded files | ❌ none exist today | No file-storage feature is implemented (A15 is interface-only, `docs/PROJECT-CONSTITUTION.md:242-246`) — revisit when A15 lands |

**Consequence:** a restore = db file + `.env` + a matching build tree. Nothing
else exists.

---

## 2. Backup procedure (SQLite db file)

SQLite is a live file — never copy it with `cp` while the server writes.

### Option A — cold copy (simplest, default)

1. Stop the server (§2 start command in `production-checklist.md`).
2. Copy the file:
   ```bash
   cp db/custom.db /backups/custom-$(date +%F-%H%M).db
   ```
3. Restart the server.

### Option B — SQLite Online Backup API (no downtime)

Use the `sqlite3` CLI backup command, which uses the Online Backup API and
produces a consistent snapshot while the app runs:

```bash
sqlite3 db/custom.db ".backup '/backups/custom-$(date +%F-%H%M).db'"
```

(Python equivalent, if scripting: `sqlite3.connect(src).backup(dest)` — same
API.) Prefer Option A around upgrades; use Option B for the daily cadence.

Always ship backups **off the host** (separate machine/object storage) —
same-box backups don't survive disk loss.

## 3. Cadence

| Trigger | Cadence | Rationale |
|---|---|---|
| Scheduled | **Daily** (Option B) | Small-business financial data; daily loss window is the accepted MVP tradeoff |
| Pre-upgrade | **Every deploy** (Option A, cold) | Rollback anchor (`production-checklist.md` §9.2–9.3) |
| Before destructive ops | On demand (e.g. before an import `merge`, business delete) | Import merge mutates the dataset in one transaction (`src/app/api/v1/businesses/[id]/import/route.ts:479-603`); business delete is irreversible |

**Retention suggestion: 7 daily + 4 weekly** (≈11 restore points, trivially
small storage for SQLite files). Prune older than that; keep the pre-upgrade
snapshot of the current release until the next successful upgrade.

**Encryption at rest (required):** backups contain the full financial
dataset + audit trail — treat them as the most sensitive artifact. Encrypt
before off-host transfer (e.g. `age`/`gpg` asymmetric to an operator key, or
provider-side encryption at rest on the storage bucket). The `.env` copy is
encrypted under a **different** key than the db backups (separation of
secrets from data). Keys/procedures live with the operator's secrets manager,
never in this repo.

## 4. Restore procedure (db file)

```bash
# 1. STOP the server (kill the §2 process; verify port 3000 is free)
# 2. Replace the db file (keep the corrupt/current one for forensics)
mv db/custom.db db/custom.db.quarantine-$(date +%s)
cp /backups/custom-<chosen>.db db/custom.db
# 3. Integrity check — MUST pass before starting
sqlite3 db/custom.db "PRAGMA integrity_check;"
#    → expect exactly:  ok
# 4. Start the server (production-checklist.md §2)
# 5. Smoke verify (§5 below)
```

If `integrity_check` fails on the restored file, try the next-newest backup;
do not start the server on a corrupt file.

## 5. Verification procedure (prove backups are real)

A backup that was never restored is a hope, not a backup. Drill:

1. **Restore into staging, not prod:** copy the artifact to a staging host/dir
   with its own `DATABASE_URL` + `NEXTAUTH_SECRET` (a *different* secret —
   never share prod's), point a test instance at it, run
   `PRAGMA integrity_check` first (§4).
2. **Round-trip:** from the staging instance, export the business
   (`GET /api/v1/businesses/[id]/export`) and import into a scratch business
   (`POST …/import?mode=dry_run` then `mode=merge`) — the report must show
   consistent counts and zero `LINE_TOTAL_MISMATCH`/`ID_OCCUPIED`
   surprises (`import/route.ts:190-211` conflict model).
   Endpoint law: export needs `settings:manage` + active-business match
   (`export/route.ts:31-34`); import is **OWNER-only**
   (`import/route.ts:63-70`).
3. **Security checks:** run the security-check suite
   (`bun scripts/prompt17-security-check.mjs`, the Prompt 17 deliverable —
   if it is not present in `scripts/` at drill time, fall back to
   `bun scripts/e2e-smoke.ts --base <staging>` (`scripts/e2e-smoke.ts:18`)
   and the tenant-isolation step of `production-checklist.md` §7 step 4).
4. **Record** the drill date, artifact name, and result in the operator log.
   Repeat monthly.

## 6. Application-level backup story (EXISTS — owner-driven, per business)

This is the **self-service escape hatch** users get without operator help;
shipped and rate-limited:

### Export (EXISTS)

- `GET /api/v1/businesses/[id]/export` downloads the **entire business** as
  one portable JSON file, `attachment` filename
  `backup-<slug>-<date>.json` (`export/route.ts:203-214`).
- Envelope id: **`$schema: "ai-business-copilot/backup@1"`**
  (`export/route.ts:84`; authoritative validator constant
  `BACKUP_SCHEMA_ID`, `src/lib/backup-schema.ts:18`).
- Contents: business config (incl. `currencyCode`/`decimalPrecision`,
  `export/route.ts:105-115`), members, customers, suppliers, products,
  inventory adjustments, sales + items, expenses, payments, audit trail
  (`export/route.ts:49-189`). Money is documented as integer minor units
  inside the file (`export/route.ts:116-119`, A08).
- Privacy: password hashes never leave the server; other members are reduced
  to ids/names/emails (`export/route.ts:11-13`).
- Gates: active-business match (`:31-33`), `settings:manage`
  (OWNER/ADMIN, `:34`), rate limit 4 per 5 min/user (`:36-44`), audited
  `data.export` (`:191-201`).

### Import (EXISTS)

- `POST /api/v1/businesses/[id]/import` with the backup JSON as body.
- **Two modes** (`import/route.ts:5-9,82`): `dry_run` — validate + diff,
  no writes; `merge` — apply the diff inside ONE transaction
  (`:479-603`). Existing rows are **never modified or deleted** (`:9`).
- **Two id strategies** (`:11-19,83`): `keep` (restore into the same business
  after data loss) and `new` (fresh ids, sale numbers re-sequenced, references
  remapped — copying into another business).
- **OWNER-only gate** — even ADMINs are excluded (`:63-70`); `settings:manage`
  is still checked first (`:62`). Rate limit 4/5min (`:72-80`).
- **Caps** (zod, `src/lib/backup-schema.ts`): 25 MB body cap
  (`import/route.ts:88-92`); per-entity row caps — customers/suppliers/
  products 5,000, adjustments/sales/expenses 20,000, payments 50,000
  (`backup-schema.ts:207-213`); 200 items per sale (`:142`); audit trail
  50,000 / members 500 accepted-but-ignored (`:205-206`).
- Sale line totals are re-verified with integer math on import
  (`import/route.ts:305-316`); a currency mismatch yields a loud warning in
  the report (`:27-29,114`); `members`/`auditTrail` are never imported
  (`:27-29`).

### When to use which layer

| Scenario | Use |
|---|---|
| Host loss / corruption / bad deploy | Operator file restore (§4) |
| Accidental mass deletion within one business | Owner import `keep`+`merge` from the latest JSON export (§6) |
| Migrating data to a fresh deployment | Both: file restore for everything, then owner exports if only selected businesses move |
| User requests a copy of their data | Owner JSON export (§6) |

## 7. Checklist sign-off

- [ ] Daily Option-B job live, artifacts land off-host encrypted
- [ ] Pre-upgrade cold snapshots on every deploy (production-checklist §9)
- [ ] Retention prune (7 daily / 4 weekly) running
- [ ] `.env` backed up separately under a different key
- [ ] Restore drill completed: staging restore + export/import round-trip +
      security checks (§5) — recorded with date
- [ ] Owner-facing export documented in the onboarding/FAQ copy
      (`docs/marketing/launch-readiness.md` §3 approved claims)
