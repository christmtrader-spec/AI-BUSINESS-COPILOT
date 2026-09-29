# Data Portability — Security Reference

> Prompt 31 · Customer Data Export + Secure Import Center.
> Status: **IMPLEMENTED & TESTED** (Prompt 31 harness 106/106, unit 71/71,
> static audit 53/53). This document describes the implementation AS BUILT —
> every claim below maps to source files under `src/lib/data-portability/`.

## 1. Scope and non-scope

Data portability is the customer-facing ability to **export** business data
in a documented, portable form and **import** it back with full validation
before anything changes.

It is explicitly **NOT**:

- a database backup (that is `db/backups/` + `scripts/backup-db.mjs` — an
  operator recovery artifact; an export is a customer portability dataset);
- a raw SQL / SQLite / Prisma-dump import (rejected by content signature);
- a platform data path (PlatformAuditLog, PlatformOperator, AI cost rates,
  merchant credentials are structurally absent from every dataset);
- an undo/restore facility (§341/§342 — Prompt 31 implements neither).

## 2. Implementation source of truth

| Concern | File |
| --- | --- |
| Limits + storage-root validation | `src/lib/data-portability/config.ts` |
| Artifact storage (write/verify/stream) | `src/lib/data-portability/storage.ts` |
| Export catalog + sensitivity | `src/lib/data-portability/export-catalog.ts` |
| Export manifest + integrity | `src/lib/data-portability/manifest.ts` |
| Export job service | `src/lib/data-portability/export-service.ts` |
| Import field allowlist (client-safe) | `src/lib/data-portability/import-fields.ts` |
| Import catalog (server) | `src/lib/data-portability/import-catalog.ts` |
| File parsing (CSV/JSON) | `src/lib/data-portability/import-parse.ts` |
| Row validation | `src/lib/data-portability/validators.ts` |
| Money decimal-string ↔ minor units | `src/lib/data-portability/money-csv.ts` |
| Import job service | `src/lib/data-portability/import-service.ts` |
| Routes | `src/app/api/v1/exports/**`, `src/app/api/v1/imports/**` |
| UI | `src/modules/settings/data-portability/**` at `#/data` |
| Models | `DataExportJob`, `DataImportJob` (Prisma, ON DELETE CASCADE) |

## 3. Authorization model

- Tenant context is resolved **server-side** by `getAuthContext` (session →
  membership → role). No route accepts a business id from the path or body.
- Export create/download/cancel and import upload/mapping/validate/dry-run/
  commit/cancel: **OWNER/ADMIN only** (`assertExportRole`/`assertImportRole`).
- The commit route re-checks role at commit time (§277), plus step-up:
  recent password auth, and — when the account has MFA enabled — recent
  strong auth (password + TOTP/recovery) via the Prompt 30 step-up service
  (`requireRecentPasswordAuth`/`requireRecentStrongAuth`). Server-owned
  recency only (SecurityEvent timestamps); no client flags are trusted.
- Job ids (Prisma cuids) are identifiers, NOT credentials: every read,
  download and commit re-checks live membership + role + status + expiry.
- Membership/role changes take effect immediately: a former member or
  downgraded admin fails the live re-check (§274-§277).

## 4. Export security

- **Datasets**: explicit allowlist (`EXPORT_DATASET_KEYS`, §5/§239). Unknown
  keys → 422. Selecting `sales` implies `sale_items` (relationships never
  flattened, §46/§54).
- **Sensitivity** (§6): `business` = PUBLIC_BUSINESS; every other dataset =
  CONFIDENTIAL. No dataset touches identity/security tables (§12-§19) —
  enforced structurally and re-checked by `scripts/data-portability-audit.mjs`.
- **Formats** (§7): JSON (single file: `{ manifest, datasets }`) or CSV
  (always a ZIP package: `manifest.json` + one CSV per dataset, fflate,
  §149). ZIP creation only — we never extract untrusted archives (§148).
- **Manifest** (§9): schema version, app version, timestamps, business
  meta (name/timezone/currency/precision — no owner/session/platform data),
  per-dataset record counts, integrity block, generation status.
- **Checksums** (§21/§312): manifest.integrity = SHA-256 over the exact
  dataset payload bytes (documented, externally recomputable);
  `DataExportJob.checksum` = SHA-256 over the whole artifact, re-verified at
  every download (tampered file → 410, never served).
- **Bounds** (§24/§26): `EXPORT_MAX_RECORDS` (default 100 000), `EXPORT_MAX_BYTES`
  (default 50 MiB), `EXPORT_MAX_DATASETS` (default 12). Exceeding a bound
  FAILS the job with `EXPORT_LIMIT_EXCEEDED` — partial files are never
  labeled complete (§320).
- **Storage** (§11/§18/§303/§304): artifacts live under
  `DATA_PORTABILITY_ROOT` (default `var/data-portability/`, git-ignored).
  The root is validated at EVERY use — `public/`, `.next/`, `static/`,
  `node_modules/` are rejected. Files are written via temp file + atomic
  rename, mode 0600; symlinked targets are refused (§313).
- **Download** (§30/§31/§168/§206): `Content-Disposition: attachment`
  (sanitized ASCII filename, §262/§263), `Cache-Control: private, no-store`,
  `X-Content-Type-Options: nosniff`, restrictive CSP sandbox. No range
  requests (§32). Rate-limited 30/hour/user.
- **Expiry** (§16/§166): `EXPORT_FILE_TTL_HOURS` (default 72). Expired jobs
  report EXPIRED; download → 410. Cleanup via
  `scripts/prune-expired-exports.mjs` (dry-run default, `--apply`).
- **State machine** (§165): QUEUED → PROCESSING → COMPLETED | FAILED |
  CANCELED; EXPIRED only from COMPLETED. Transitions use atomic conditional
  updates (§316). Stale QUEUED/PROCESSING beyond
  `PORTABILITY_STALE_JOB_MINUTES` (default 20) are reaped to FAILED
  (§317/§318 — export generation is read-only and safe to retry).
- **Privacy in logs/audit** (§33-§35/§170/§249): audit records carry
  jobId/datasets/format/counts/requestId only — never file contents,
  customer rows or amounts. Operational events: `portability.export.failed`.

## 5. Import security

- **Datasets** (§59): customers, suppliers, products ONLY. Financial history
  (sales/expenses/payments/receivables/payables) is **NOT importable** —
  documented, intentional (§116-§118/§221). Imports create no users,
  members, credentials or billing state (§107-§110/§288-§296).
- **Upload** (§57/§62/§65): multipart, bounded by `IMPORT_MAX_BYTES`
  (default 10 MiB; content-length pre-check + full cap). Extension AND MIME
  AND content signature must agree; NUL-byte/binary payloads rejected; SQL
  and HTML/XML never accepted (§140/§208/§209). Row cap derives from the
  byte cap (documented). Files staged outside web roots under a
  server-generated key; the display filename is sanitized metadata only
  (§147). SHA-256 of the staged file is stored and re-verified at commit —
  mismatch → `IMPORT_FILE_CHANGED` (§311).
- **Mapping** (§69/§70/§88): source column → target field against the
  per-dataset allowlist (`import-fields.ts`, shared by UI and server so both
  sides render/enforce the SAME catalog). System fields (id, businessId,
  timestamps) are not importable (§71); identity/security/billing/platform
  fields are structurally absent (§291-§296); `__proto__`/`constructor`/
  SQL fragments cannot become query fragments (§238 — targets are matched
  by exact catalog equality). A `businessId` column in an uploaded file is
  simply an unmapped column — cross-tenant data can never attach (§73).
- **Validation** (§74-§80/§97/§228-§230): every row is validated server-side.
  Empty = null (uniform, §228); required missing → `ROW_REQUIRED_FIELD_MISSING`;
  email/phone/boolean/integer formats enforced; money parsed from exact
  decimal strings into integer minor units using the BUSINESS precision —
  no floats, no client currency switching (§77/§225/§286). Row errors store
  rowNumber + field + stable code — never raw values (§321/§322), bounded by
  `IMPORT_MAX_ERRORS` (default 500, §172). The downloadable error report is
  a bounded CSV (row_number, field, error_code, localized message, §98/§192).
- **Duplicates** (§81-§84/§269): deterministic single-pass algorithm shared
  by dry-run and commit — file-internal repeats + exact normalized matches
  against current tenant rows (customers/suppliers: email → phone → name;
  products: SKU → name). No fuzzy/AI matching (§270/§271). Modes: **SKIP**
  (default) and **REJECT** (duplicates are errors that block commit).
  UPDATE mode is NOT implemented in Prompt 31 (§388 honest report).
- **Dry run** (§86/§285): would-create / would-skip / duplicates against
  current data — ZERO mutation of business rows.
- **Commit** (§91-§95/§102/§163/§309/§319/§373/§374): typed confirmation
  `IMPORT DATA`; step-up; fresh file checksum; validation AND duplicate
  detection recomputed INSIDE the commit transaction (stale validation is
  never trusted). ALL-OR-NOTHING: any invalid row (or REJECT-mode duplicate)
  aborts with no writes — a single SQLite transaction makes this atomic, so
  a crash mid-commit rolls back completely (no partial import can exist).
  Idempotency via the server-side commit token: an already-committed job
  returns its recorded result instead of re-importing. INSERTs are chunked
  (`IMPORT_COMMIT_BATCH_SIZE`, default 500) inside the one transaction.
- **Stale jobs** (§317/§318): COMMITTING/PARSING/VALIDATING jobs stuck past
  the threshold are reaped to FAILED (`IMPORT_COMMIT_FAILED`) with the safe
  message that no partial data was written; mutations are never auto-retried.
- **Expiry** (§63/§167): `IMPORT_FILE_TTL_HOURS` (default 72); expired jobs
  cannot commit; cleanup via `scripts/prune-expired-imports.mjs` deletes the
  staged file. Cancel also deletes the staged file immediately.
- **Rate limits/abuse** (§36/§100): create 5/15 min, mapping/validate/
  dry-run 30/h, commit 10/h, downloads 30/h — per business+user(+IP).
  Concurrency caps: `MAX_ACTIVE_EXPORTS_PER_BUSINESS` /
  `MAX_ACTIVE_IMPORTS_PER_BUSINESS` (default 2 each; expired jobs excluded).

## 6. Content safety

- Export CSVs reuse the shared RFC-4180 writer with the OWASP
  formula-injection guard (§151/§264): leading `=`/`+`/`@`/tab/CR and
  non-numeric `-` are apostrophe-prefixed; negative numbers stay numeric.
- Imported values remain DATA — nothing is evaluated (§152/§207); JSON via
  `JSON.stringify` (§153); UTF-8 end-to-end with BOM handling (§67/§154) —
  Persian round-trip is verified by the harness (§155/§365).

## 7. Audit and observability

- Tenant AuditLog actions: `data_export.requested|completed|failed|
  downloaded|canceled` and `data_import.created|validated|dry_run|
  committed|failed|canceled` — metadata only (§34/§99). File cleanup NEVER
  deletes audit records (§248).
- Operational events (Prompt 29 vocabulary): `portability.export.failed`,
  `portability.import.failed` with requestId/jobId/businessId/duration —
  no file or row content ever logged (§170/§171/§381).
- Readiness (§297/§305/§358): `/api/ready` and Platform System expose the
  `portabilityStorage` component (READY / NOT_CONFIGURED / BLOCKED) — status
  only, never paths.

## 8. Backup vs export (§130/§256/§340/§390)

| | BACKUP | EXPORT |
| --- | --- | --- |
| Purpose | system recovery (operator) | business-data portability (customer) |
| Shape | full SQLite DB + sidecar manifest | tenant-scoped datasets + manifest |
| Restore path | `scripts/restore-drill.mjs` | import center (validated, reviewed) |
| Retention | backup rotation policy | operational TTL (NOT legal retention) |

The DataExportJob must never be called a "restore point" (§340) and the
product never implements tenant rollback from an export (§341).

## 9. Known limitations (honest, §389-§391)

- **Single-node local filesystem storage** — no cloud object storage, no
  multi-instance story; operator must include `var/data-portability` in
  volume/backup planning if artifact durability matters.
- **No application-level export encryption** — if the volume is encrypted by
  infrastructure, that is documented as infrastructure, not claimed here (§20).
- **Synchronous generation** — bounded by the record/byte caps; very large
  businesses would need a future background-worker architecture
  (FUTURE BACKGROUND JOB ARCHITECTURE, §391 — intentionally not built).
- **Local storage is not durable** — deleting the directory orphans nothing
  (job rows remain, downloads 410) but artifacts are gone; TTL cleanup is
  the intended lifecycle.
- **UPDATE duplicate mode** not implemented (SKIP/REJECT only).
- **Date-range export filtering** not implemented (§25 optional).
