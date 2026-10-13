# Backup & Restore Plan (AI Business Copilot)

**Document ID:** BACKUP-RESTORE-v1.1
**Phase:** Prompt 17 (created) · revised Prompt 19 (verified restore drill, backup pipeline codified, `db/backups/` location)
**Companions:** `docs/deployment/production-checklist.md` (deployment + first-run),
`docs/database/migration-workflow.md` (migration discipline),
`docs/database/prompt19-baseline.md` (baseline + drill record),
`docs/database/data-inventory-before-baseline.md` (authoritative counts),
`docs/billing/billing-architecture.md` (billing is design-only; no billing data exists yet)

Two layers of protection, both already supported by shipped code:

1. **Infrastructure backup** — the SQLite database file itself (operator-run).
2. **Application backup** — owner-driven JSON export/import (in-app, shipped
   in Phase 06).

---

## 0. Prompt 29 automation (implemented)

Prompt 29 shipped the backup/verify/drill/prune automation. These scripts are
the PRIMARY procedure from now on; the manual procedures below (§2 cold copy
/ §4 file restore) remain documented as **fallback** when the tooling cannot
run (e.g. scripting environment unavailable).

| Script | What it does | Exit codes |
|---|---|---|
| `scripts/backup-db.mjs` | SQLite **`VACUUM INTO`** snapshot through a separate read-only connection — a **transaction-consistent online backup** (never a byte-copy of a live file, §47; bounded retry on SQLITE_BUSY, fail-safe if no consistent snapshot is obtainable). Computes **SHA-256** and validates the fresh artifact (`integrity_check` / `quick_check` / `foreign_key_check`) BEFORE declaring it valid (§50/§112/§114). Writes a **sidecar JSON** (§48) with timestamp, size, checksum, migration count, app version, environment, masked source path — never secrets. **Never overwrites** an existing backup (timestamped name, existence aborts, §46). | 0 = created + validated · 1 = failure (no valid backup declared) |
| `scripts/verify-backup.mjs <file>` | Verifies WITHOUT altering the artifact: file exists/non-empty; **SHA-256 checksum vs sidecar** (mismatch = immediate FAIL, §113); opens as SQLite; integrity/quick/FK checks; migration metadata readable. On success it flips the sidecar's `verified=true` — the only mutation (metadata sidecar, never the `.db`). | 0 = verified · 1 = FAILED · 2 = usage |
| `scripts/restore-drill.mjs` | Automated restore drill that **never touches production**: picks the named or latest VERIFIED backup; **checksum verified FIRST** (§113); copies to an **isolated tmp clone** (`os.tmpdir`); integrity checks on the clone; **entity row-count probes** (User, Business, Subscription, Customer, Product, Sale, Expense, AuditLog, UsageEvent, AiCostRecord, PlatformAuditLog — read-only); `prisma migrate status` against the clone for migration compatibility (§116); per-check **PASS/FAIL** report written to **`db/backups/last-restore-drill.json`** (read by the readiness component). **Refuses production targets (exit 2)** and refuses in-place restore even with `--allow-production-restore` (**exit 3 — in-place restore is NOT implemented**); the production DB is never overwritten automatically. | 0 = PASS · 1 = FAIL · 2 = production target rejected · 3 = in-place restore not implemented · 4 = usage |
| `scripts/prune-backups.mjs` | Optional LOCAL retention cleanup. **Dry-run by default**; deletions only with explicit `--apply`. **Never deletes a backup without checksum metadata (sidecar)** — such artifacts are reported and SKIPPED (§56); the newest sidecar'd backup is always kept. Retention model: newest N distinct DAY + newest N distinct WEEK snapshots (`BACKUP_RETENTION_DAILY` default 7, `BACKUP_RETENTION_WEEKLY` default 4). **These are OPERATIONAL backup policies, NOT legal data-retention periods** (§57). | 0 = ok (dry-run or applied) · 1 = usage/IO error |

Honest state (unchanged by the automation):

- **Prompt 40 note — stocktake coverage:** `InventoryStocktake` +
  `InventoryStocktakeLine` live in the same SQLite file, so they are included
  in every backup (`backup-db.mjs`) and every file-wide verification
  (`verify-backup.mjs`: checksum/integrity/quick/FK checks) by construction.
- **Prompt 41 note — purchase order coverage:** `PurchaseOrder` +
  `PurchaseOrderLine` are likewise same-file, same-by-construction coverage:
  included in every backup and in every file-wide verification; the
  restore-drill read-only smoke probe list includes both models, so a restore
  is only declared healthy when procurement rows are readable again.
  The restore-drill read-only smoke entity list now probes **15 entities**
  (the 11 listed above + the two stocktake models + the two purchase-order
  models); backups that predate the models are reported honestly for those
  probes, never a drill failure.

- **Offsite copies remain a MANUAL operator duty** — no script ships backups
  off-host; same-box backups do not survive disk loss. Verify the copy's
  checksum at the destination.
- **APPLICATION-LEVEL BACKUP ENCRYPTION NOT IMPLEMENTED** (§59 — verbatim).
  The application does not encrypt backup artifacts; the operator MUST
  encrypt at rest / in transit off-host (e.g. `age`/`gpg`, or provider-side
  encryption at rest). Backups contain password hashes + session data —
  treat them as the most sensitive artifact (§60).
- Scheduling is the operator's decision — cron/systemd EXAMPLES (not
  auto-installed, §109) live in `docs/deployment/production-operations.md` §4.

---

## 1. What must be backed up

| Artifact | Backup? | Why |
|---|---|---|
| **`db/custom.db`** | ✅ **REQUIRED — single source of truth** | All application data lives in this one SQLite file (`docs/TECH-DECISION-RECORD.md:20` "Prisma + SQLite (file `db/custom.db`)"; datasource `prisma/schema.prisma:9-12` resolves `DATABASE_URL`) |
| **`.env`** | ✅ required — **stored separately from db backups** | Secrets (`DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL` — names only; see `docs/deployment/production-checklist.md` §4). Losing `NEXTAUTH_SECRET` means every user session is invalidated on rotation (TDR §5, `docs/TECH-DECISION-RECORD.md:132`) |
| **`prisma/migrations/`** | ✅ with the repo | Schema history; **now EXISTS** — baseline `0_init` committed (Prompt 19). Needed to rebuild/reproduce and to run `prisma migrate deploy` at deploy time (`docs/database/migration-workflow.md` §5) |
| `.next/` build output | ❌ not needed | Fully rebuildable from source via `npm run build` (`package.json:7`; standalone output `next.config.ts:4`) |
| `node_modules/` | ❌ not needed | Reinstallable (`bun.lock`) |
| Uploaded files | ❌ none exist today | No file-storage feature is implemented (A15 is interface-only, `docs/PROJECT-CONSTITUTION.md:242-246`) — revisit when A15 lands |

**Consequence:** a restore = db file + `.env` + a matching build tree. Nothing
else exists.

---

## 2. Backup procedure (SQLite db file) — MANUAL FALLBACK

SQLite is a live file — never copy it with `cp` while the server writes.
Prompt 29 note: the PRIMARY procedure is now `node scripts/backup-db.mjs` +
`node scripts/verify-backup.mjs <file>` (§0 above) — the options below are
the fallback when the script tooling cannot run.

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

### Backup location (Prompt 19)

Project backups live in **`db/backups/`** (git-ignored — checksums may be
documented, artifacts never enter version control). Concrete Prompt-19
examples, both SHA-256
`ec8b4958d5f6b305cb51036fb89200026f5c87ca95dabd010ebce5e80e812e80`,
483328 bytes:

- `db/backups/pre-prompt19-20260923-052005.db` — safety snapshot before ANY operation
- `db/backups/pre-baseline-20260923-052157.db` — second snapshot immediately before the real-DB baseline

## 2.1 Required pipeline (every time — no exceptions)

Every schema migration on a non-disposable database follows this fixed
pipeline (`docs/database/migration-workflow.md` §3/§6). **The DB file MUST be
backed up before ANY schema migration** — this is the rollback anchor, and
`prisma migrate deploy` is forward-only.

```
backup  →  checksum  →  migration  →  integrity check  →  smoke test
```

1. **Backup** — Option A (cold) or Option B (online) into `db/backups/` with a timestamped name.
2. **Checksum** — `sha256sum` the artifact; record the hash next to the file name in the operator log (Prompt-19 example above).
3. **Migration** — `bun run db:migrate:deploy` only (`db push`/`reset`/`migrate dev` are development-only and production-blocked, `docs/database/migration-workflow.md` §1).
4. **Integrity check** — `PRAGMA integrity_check`, `PRAGMA quick_check`, `PRAGMA foreign_key_check` (expect `ok` / `ok` / 0 rows).
5. **Smoke test** — application reads/writes on the affected flows + `GET /api/health` reporting `status: "ok"`.

Standard read-only probe for steps 4–5: **`scripts/db-inventory.mjs`**
(integrity, quick_check, FK violations, per-table counts, money totals,
relationship orphans — no record contents).

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

## 4. Restore procedure (db file) — MANUAL OPERATOR PROCEDURE

Prompt 29 note: restore remains a MANUAL, documented operator procedure —
nothing in the tooling ever overwrites the production database
automatically (`scripts/restore-drill.mjs` refuses production targets,
exit 2 / exit 3). Verify the chosen backup with
`node scripts/verify-backup.mjs <file>` BEFORE this procedure, and run
`node scripts/restore-drill.mjs` on the isolated clone first whenever time
allows.

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

## 4.1 VERIFIED restore procedure (performed 2026-09-23, Prompt 19 §34)

The file-restore path is **not a claim — it was executed on a clone** using
the pre-prompt19 backup (`db/backups/pre-prompt19-20260923-052005.db`),
copied to `/tmp/aibc-p19-restore.db`:

1. **Copy the file** to a scratch location (never restore in place first).
2. **Integrity:** `PRAGMA integrity_check` → ok; `PRAGMA foreign_key_check` → 0 violations.
3. **Row counts vs the inventory doc** (`docs/database/data-inventory-before-baseline.md`, probed with `scripts/db-inventory.mjs`): **34 users / 13 businesses** — match.
4. **PrismaClient connects and reads:** `businesses = 13`, `users = 34`, `SUM(Sale.totalMinor) = 300008500` — match.
5. **Read sample business data** (e.g. "Sara's Handmade Shop") — rows readable.

Clone discarded afterwards; production untouched. **This drill verified that
the Prompt-19 backup is restorable and the data is intact.** Repeat this
procedure on a clone whenever the backup strategy or schema changes, and on
the regular monthly cadence below.

## 5. Verification procedure (prove backups are real)

A backup that was never restored is a hope, not a backup. Drill:

1. **Restore into staging, not prod:** copy the artifact to a staging host/dir
   with its own `DATABASE_URL` + `NEXTAUTH_SECRET` (a *different* secret —
   never share prod's), point a test instance at it, run
   `PRAGMA integrity_check` first (§4). Minimum drill: §4.1 (copy → integrity
   + FK check → counts vs `docs/database/data-inventory-before-baseline.md`
   via `scripts/db-inventory.mjs` → PrismaClient connect → read business data).
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
   Repeat monthly. The Prompt-19 file-restore drill (§4.1) is the recorded
   precedent.

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
  (`export/route.ts:49-189`). Prompt 48 adds `supplierBills` +
  `supplierBillLines` (validate-for-fidelity, NEVER re-imported — the
  posting transaction is the only sanctioned origin of a bill; the linked
  payable round-trips through `expenses` with dueDate + reference).
  Money is documented as integer minor units
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
  50,000 / members 500 accepted-but-ignored (`:205-206`); supplierBills
  20,000 / supplierBillLines 50,000 accepted-but-NOT-imported (row schemas
  verify lifecycle invariants: POSTED ⇔ expenseId+postedAt,
  CANCELLED ⇔ cancelledAt, and bill/line integer math).
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

- [ ] Daily Option-B job live, artifacts land off-host encrypted *(recommended — not yet implemented)*
      Prompt 29 update: the automation SCRIPTS now exist (`scripts/backup-db.mjs`
      + `verify-backup.mjs` + `prune-backups.mjs`); SCHEDULING them is the
      operator's step (cron/systemd examples, `production-operations.md` §4 —
      not auto-installed, §109). Offsite + encryption remain manual (§59).
- [ ] Pre-upgrade cold snapshots on every deploy (production-checklist §9) — **done for the Prompt-19 baseline; standing rule** (`docs/database/migration-workflow.md` §3/§6)
      Prompt 29 update: every deploy takes a script backup + verification
      FIRST (`production-operations.md` §1 sequence; §45 migration gate
      refuses to open without a verified backup).
- [ ] Retention prune (7 daily / 4 weekly) running *(recommended — not yet implemented; script exists: `node scripts/prune-backups.mjs`, dry-run default, `--apply` to delete)*
- [ ] `.env` backed up separately under a different key *(recommended — operator task at deploy time)*
- [x] File-restore drill completed on a clone (§4.1, Prompt 19, 2026-09-23):
      integrity ok, FK check clean, counts/money match the inventory,
      PrismaClient reads verified — recorded in
      `docs/database/prompt19-baseline.md`
- [ ] Full staging drill (export/import round-trip + security checks, §5
      steps 2–3) — repeat monthly
- [ ] Owner-facing export documented in the onboarding/FAQ copy
      (`docs/marketing/launch-readiness.md` §3 approved claims)


## Prompt 42 — Goods Receipt restore verification

`scripts/restore-drill.mjs` probes `GoodsReceipt`, `GoodsReceiptLine`, `GoodsReturn` and `GoodsReturnLine` with
read-only `SELECT COUNT(*)` smoke queries after the restore (same
honest-absent rule as every entity: backups predating Prompt 42 are reported
as `table absent in this backup`, never a drill failure). Expected final probe
surface: User, Business, Subscription, Customer, Supplier, Product, Sale,
Expense, AuditLog, UsageEvent, AiCostRecord, PlatformAuditLog,
InventoryStocktake, InventoryStocktakeLine, PurchaseOrder, PurchaseOrderLine,
**GoodsReceipt, GoodsReceiptLine, GoodsReturn, GoodsReturnLine, GoodsDispatch, GoodsDispatchLine, SalesOrder, SalesOrderLine**.


### Prompt 45 — sales orders in the restore surface

`restore-drill.mjs` probes `SalesOrder` and `SalesOrderLine` alongside all
earlier domains (honest-absent rule preserved: older backups predate the
tables and are reported, never a drill failure). `env-repair.mjs`
baselines the `20261011090000_prompt45_sales_orders` migration so a sandbox
ledger revert can never leave it falsely pending.
