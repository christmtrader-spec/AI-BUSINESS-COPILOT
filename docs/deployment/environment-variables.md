# Environment Variables Reference

**Document ID:** DEPLOY-ENV-VARS-v2
**Round:** Prompt 19 §24 (template established Prompt 18, expanded Prompt 19) · expanded Prompt 29 (email transport contract, observability, backup/restore automation)
**Canonical template:** `.env.example` (version-controlled, placeholders only — the `.gitignore` `!.env.example` exception keeps it in the repo while every real `.env` stays out)

`.env.example` now **exists** with placeholders for all variables below. Copy it to `.env` and fill in real values; never commit the filled file, never paste real values into documentation. The canonical usage notes live in `.env.example` and this document.

---

## Quick reference

| Variable | Required | Secret? | Purpose |
|---|---|---|---|
| `DATABASE_URL` | ✅ always | **Yes** (contains filesystem path; treat as infrastructure detail) | Prisma/SQLite connection string |
| `NEXTAUTH_SECRET` | ✅ production (throws without it) | **Yes** | NextAuth v4 JWT signing/encryption key |
| `NEXTAUTH_URL` | ✅ production | No | Canonical origin NextAuth serves on |
| `APP_BASE_URL` | Optional in dev; recommended explicit in production | No | Base URL for password-reset email links |
| `EMAIL_FROM` | Required together with host+port for production SMTP | No | From-address for auth emails (SMTP adapter, Prompt 29) |
| `EMAIL_SERVER_HOST` | Required together (Prompt 29) | No | SMTP host |
| `EMAIL_SERVER_PORT` | Required together (Prompt 29) | No | SMTP port (1–65535; typ. 465) |
| `EMAIL_SERVER_USER` | With password (both or neither) | Credential when set | SMTP username |
| `EMAIL_SERVER_PASSWORD` | With user | **Yes** | SMTP password — server-only, never logged/returned (§9) |
| `EMAIL_SECURE` | **Explicit in production** (`true` required) | No | TLS mode: `true` = implicit TLS (typ. 465); explicit `false` BLOCKED in production (§10) |
| `EMAIL_TIMEOUT_MS` | Optional (default 10000) | No | Bounded delivery timeout 1000..60000 ms — never unbounded |
| `NODE_ENV` | Set by runtime | No | Gates dev fallbacks; **hard-blocks dangerous DB commands in production** via `scripts/db-guard.cjs` |
| `LOG_LEVEL` | Optional | No | `debug\|info\|warn\|error`; production default INFO, development DEBUG |
| `SECURE_SERVER_DIAGNOSTICS` | Optional (default off) | No | **Only** way to include stack traces in PRODUCTION logs — deliberate opt-in, keep off normally |
| `GRACEFUL_SHUTDOWN_TIMEOUT_MS` | Optional (default 8000) | No | Hard cap for SIGTERM/SIGINT graceful shutdown (1000..60000 ms) |
| `BACKUP_DIR` | Optional (default `db/backups/`) | No (operational config) | Backup destination — MUST NOT be web-served or committed |
| `BACKUP_MAX_AGE_HOURS` | Optional (default 26) | No | Operational backup-staleness policy → readiness BACKUP_STALE. **NOT legal retention** |
| `RESTORE_DRILL_MAX_AGE_DAYS` | Optional (default 30) | No | Operational drill-staleness policy → readiness STALE. **NOT legal retention** |
| `BACKUP_RETENTION_DAILY` | Optional (default 7) | No | `prune-backups.mjs` daily buckets. **Operational, NOT legal retention** (§57) |
| `BACKUP_RETENTION_WEEKLY` | Optional (default 4) | No | `prune-backups.mjs` weekly buckets. **Operational, NOT legal retention** (§57) |

## Per-variable detail

### `DATABASE_URL`

- **Purpose:** the Prisma datasource connection (`prisma/schema.prisma`). For SQLite a `file:` URL pointing at the database file (project convention: absolute file URL to `db/custom.db`).
- **Required:** always — the app cannot reach any data without it.
- **Development behavior:** points at the local dev database; relative paths resolve against `prisma/schema.prisma`. Wrong value = the app silently uses a different/empty database.
- **Production behavior:** must point at the production database file. Backups of that exact file are mandatory before any schema migration (`docs/deployment/backup-restore-plan.md`).
- **Secret:** yes in the sense that it encodes infrastructure layout — never committed, never logged (`docs/database/migration-workflow.md` §9).

### `NEXTAUTH_SECRET`

- **Purpose:** NextAuth v4 JWT/JWE signing + encryption key.
- **Required:** **production throws without it** (NextAuth fails fast via `NO_SECRET`). Generate with `openssl rand -hex 32` (or `openssl rand -base64 32`, as noted in `.env.example`).
- **Development behavior:** a stable dev-only fallback literal exists in `src/lib/auth.ts` and is **disabled when `NODE_ENV=production`**.
- **Production behavior:** mandatory; rotating it invalidates all existing sessions.
- **Secret:** **yes** — the single most sensitive value in the file.

### `NEXTAUTH_URL`

- **Purpose:** canonical origin NextAuth issues cookies/CSRF against.
- **Required:** yes in production; set it to the externally reachable origin (scheme + host).
- **Development behavior:** `http://localhost:3000` (implicit default in dev).
- **Production behavior:** must match the public `https://` origin behind the reverse proxy or session cookies fail.
- **Secret:** no.

### `APP_BASE_URL`

- **Purpose:** base URL used to **build password-reset email links** (`${base}/#/reset-password/<token>`), via `appBaseUrl = APP_BASE_URL ?? NEXTAUTH_URL` (`src/lib/auth-security.ts`). Reset links **never** trust the incoming request `Host` header — this variable is the anti-reset-poisoning control.
- **Required:** optional (falls back to `NEXTAUTH_URL`), but explicit setting is recommended in production so the two concerns can differ.
- **Development behavior:** falls back to `NEXTAUTH_URL`; missing both → reset requests return a uniform `503` (never a fake success).
- **Production behavior:** set to the public origin; missing both → uniform `503 RESET_DELIVERY_UNAVAILABLE`.
- **Secret:** no.

### `EMAIL_FROM`

- **Purpose:** `From:` address for auth emails (password reset), consumed by the SMTP adapter (`src/lib/email/smtp-provider.ts`, Prompt 29).
- **Required:** part of the ALL-OR-NOTHING production contract — the transport counts as CONFIGURED only when host + port + from exist together (+ credential consistency); checking only `EMAIL_SERVER_HOST` is explicitly forbidden (§18).
- **Development behavior:** unused by the console transport (reset links are logged instead of sent).
- **Production behavior:** without a configured transport, password reset returns a **uniform 503** — the product never pretends an email was sent.
- **Secret:** no.

### `EMAIL_SERVER_HOST` / `EMAIL_SERVER_PORT`

- **Purpose:** SMTP host/port for the real adapter (Prompt 29 §7).
- **Required:** with `EMAIL_FROM` (all-or-nothing, §18). An INVALID (half-configured) transport is a production blocking problem in the config validator (§10).
- **Development behavior:** unused (console transport; `EMAIL_PROVIDER=test-memory` selects the TEST-ONLY in-memory provider, never resolvable in production).
- **Production behavior:** required once email delivery is activated.
- **Secret:** no (host/port are operational facts; keep them out of client code regardless).

### `EMAIL_SERVER_USER` / `EMAIL_SERVER_PASSWORD`

- **Purpose:** SMTP credentials for the adapter; either BOTH set or BOTH unset (`PASSWORD_WITHOUT_USER` / `USER_WITHOUT_PASSWORD` are validation failures).
- **Development behavior:** unused (console transport).
- **Production behavior:** provide via a secrets manager; never in the repo. The password is passed to nodemailer in-process only and is carried in the parsed config but NEVER appears in any status/report/DTO/log (§9).
- **Secret:** `EMAIL_SERVER_PASSWORD` is **yes**; `EMAIL_SERVER_USER` is a credential when set — treat both as sensitive.

### `EMAIL_SECURE` (Prompt 29 §10)

- **Purpose:** TLS mode flag. `true` → implicit TLS (typical port 465); `false` → STARTTLS negotiated by nodemailer (`requireTLS`) — plain-text delivery without any TLS is a development-only posture.
- **Required:** **explicit and `true` in production.** Unset/absent → INVALID (`SECURE_FLAG_REQUIRED_IN_PROD`); explicit `false`/`0` → BLOCKED (`INSECURE_MODE_BLOCKED`); certificate verification is never disabled (`rejectUnauthorized: true` — no tampering anywhere).
- **Secret:** no.

### `EMAIL_TIMEOUT_MS` (Prompt 29 §11)

- **Purpose:** bounds SMTP connection/greeting/socket timeouts AND an overall delivery race, so `send()` can never hang an HTTP request indefinitely.
- **Required:** optional; integer 1000..60000 (default 10000). Out-of-range → INVALID (`INVALID_TIMEOUT`).
- **Secret:** no.

## Prompt 29 variables — observability, shutdown, backups

### `LOG_LEVEL`

- **Purpose:** minimum level of the structured JSON logger (`src/lib/observability/logger.ts`).
- **Values:** `debug` · `info` · `warn` · `error`. Default: **INFO in production, DEBUG in development**.
- **Secret:** no.

### `SECURE_SERVER_DIAGNOSTICS`

- **Purpose:** the ONLY way stack traces appear in PRODUCTION server logs (§28). Leave EMPTY in normal production; set to exactly `true` temporarily while diagnosing, then unset.
- **Secret:** no (but the stacks it unlocks can contain paths — treat enabled-state logs as sensitive).

### `GRACEFUL_SHUTDOWN_TIMEOUT_MS`

- **Purpose:** hard cap for the SIGTERM/SIGINT graceful shutdown window (`src/instrumentation-node.ts`, §70): flush + Prisma disconnect, then forced exit. The process never hangs past the cap.
- **Values:** integer 1000..60000; **default 8000**. Out-of-range values fall back to the default.
- **Secret:** no.

### `BACKUP_DIR`

- **Purpose:** destination for `scripts/backup-db.mjs` / `verify-backup.mjs` / `restore-drill.mjs` / `prune-backups.mjs` (default `db/backups/` relative to the project). Consumed by the readiness component for backup/drill staleness.
- **Classification:** **operational config, NOT a secret** — but the directory it names holds the most sensitive artifacts on the host (database copies with password hashes + session data, §60). MUST NOT be web-served or committed; offsite copies are a manual operator duty; APPLICATION-LEVEL BACKUP ENCRYPTION NOT IMPLEMENTED (§59).
- **Secret:** no.

### `BACKUP_MAX_AGE_HOURS` / `RESTORE_DRILL_MAX_AGE_DAYS`

- **Purpose:** operational staleness policies consumed by readiness (`src/lib/observability/readiness.ts`): the `backups` component shows STALE past `BACKUP_MAX_AGE_HOURS` (default 26 — daily cadence + slack); the `restoreDrill` component shows STALE past `RESTORE_DRILL_MAX_AGE_DAYS` (default 30).
- **NOT legal retention:** these tune operational alerting only; they say nothing about how long personal data may be kept (§57).
- **Secret:** no.

### `BACKUP_RETENTION_DAILY` / `BACKUP_RETENTION_WEEKLY`

- **Purpose:** how many distinct daily/weekly snapshot buckets `scripts/prune-backups.mjs` keeps (defaults 7 / 4). The newest sidecar'd backup is always kept; artifacts without checksum metadata are NEVER deleted.
- **NOT legal retention:** OPERATIONAL backup counts only (§57) — never present them as data-retention policy.
- **Secret:** no.

### New file locations (created by the backup tooling)

| Path | What |
|---|---|
| `$BACKUP_DIR/backup-<UTC-timestamp>.db` | the SQLite snapshot (`VACUUM INTO`, never overwritten, §46) |
| `$BACKUP_DIR/backup-<UTC-timestamp>.json` | sidecar metadata: sha256, integrity results, migration count, app version, environment, masked source path, `verified` flag (§48) |
| `$BACKUP_DIR/last-restore-drill.json` | latest restore-drill PASS/FAIL record (§54) — read by the readiness `restoreDrill` component |

## Prompt 30 variables — identity security v2

| Variable | Required | Secret? | Purpose |
|---|---|---|---|
| `AUTH_EMAIL_VERIFICATION_MODE` | Optional (default `OFF`) | No | Email-ownership verification mode: `OFF` (unavailable, honest 503s) · `OPTIONAL` (user-initiated, accounts usable) · `REQUIRED` (business creation / trial start / paid checkout need a verified email — login is never gated). REQUIRED with production SMTP unconfigured → readiness **BLOCKED** (no silent downgrade). |
| `MFA_ENABLED` | Optional (default off) | No | Capability switch for TOTP MFA self-enrollment and the second factor at login for enrolled users. NEVER silently activated for existing users; no forced migration. |
| `MFA_ENCRYPTION_KEY` | **REQUIRED in production when `MFA_ENABLED=true`** (fail closed) | **Yes — HIGHLY_SENSITIVE** | AES-256 key material for the secret-box envelope that encrypts TOTP secrets at rest. EXACTLY 32 bytes (`openssl rand -base64 32`; base64/base64url/hex accepted). Server-only: never logged, never returned by an API, never committed, never sent to a secrets-adjacent doc with a value. Missing/invalid key with MFA enabled ⇒ capability BLOCKED. |
| `MFA_CHALLENGE_TTL_SECONDS` | Optional (default 300) | No | MFA login-challenge TTL, bounded 60–900 s. Challenges are single-use, hash-only, and invalidated by sessionVersion changes. |
| `MFA_STEP_UP_MAX_AGE_SECONDS` | Optional (default 600) | No | Recent-auth window for destructive operations (step-up), bounded 300–1800 s. Server-authoritative — never client timestamps. |
| `SESSION_LAST_SEEN_UPDATE_SECONDS` | Optional (default 300) | No | Per-session `lastSeenAt` write throttle, bounded 60–3600 s — prevents a per-request SQLite write storm. |

Details: `docs/security/identity-security-v2.md` (configuration table and capability semantics: `DISABLED` / `AVAILABLE` / `BLOCKED`), `docs/security/mfa.md` (key handling), `docs/security/email-verification.md` (mode semantics).

## Prompt 31 variables — customer data portability

| Variable | Required | Secret? | Purpose |
|---|---|---|---|
| `DATA_PORTABILITY_ROOT` | Optional (default `var/data-portability`) | No | Storage root for export artifacts and staged import uploads. MUST resolve OUTSIDE every web-served directory — `public/`, `.next/`, `static/`, `node_modules/` segments are rejected at every use (`PORTABILITY_STORAGE_INVALID`). |
| `EXPORT_FILE_TTL_HOURS` | Optional (default 72) | No | Operational artifact TTL, bounded 1–720 h. Expired downloads → 410; `scripts/prune-expired-exports.mjs` removes the files. NOT a legal retention policy. |
| `EXPORT_MAX_RECORDS` | Optional (default 100 000) | No | Hard generation cap (100..5,000,000). Exceeding it fails the job with `EXPORT_LIMIT_EXCEEDED` — never a partial file. |
| `EXPORT_MAX_BYTES` | Optional (default 52428800 = 50 MiB) | No | Artifact size cap. |
| `EXPORT_MAX_DATASETS` | Optional (default 12) | No | Max datasets per export request. |
| `IMPORT_FILE_TTL_HOURS` | Optional (default 72) | No | Staged-upload TTL, bounded 1–720 h; expired imports cannot commit; cleaned by `scripts/prune-expired-imports.mjs`. |
| `IMPORT_MAX_BYTES` | Optional (default 10485760 = 10 MiB) | No | Upload size cap (content-length pre-check + full cap + derived row cap). |
| `IMPORT_MAX_ERRORS` | Optional (default 500) | No | Stored row-level error cap (10..50000); beyond it the report is truncated and flagged. |
| `MAX_ACTIVE_EXPORTS_PER_BUSINESS` | Optional (default 2) | No | Active-export concurrency cap (1..10; expired jobs excluded). |
| `MAX_ACTIVE_IMPORTS_PER_BUSINESS` | Optional (default 2) | No | Active-import concurrency cap (1..10; expired jobs excluded). |

All values are parsed as strict integers — negative/zero-where-invalid/NaN/Infinity/non-integer
fall back to the documented default (§182). Defaults are deliberately conservative; no variable
has an "unlimited" mode (§183). Details: `docs/security/data-portability.md`,
`docs/data/data-export.md`, `docs/data/data-import.md`.

## Prompt 32 variables — unified notification platform

| Variable | Required | Secret? | Purpose |
|---|---|---|---|
| `NOTIFICATION_EMAIL_MAX_ATTEMPTS` | Optional (default 3) | No | Bounded retry cap for email deliveries (1–10). Beyond the cap the delivery is terminal FAILED `ATTEMPTS_EXHAUSTED`. |
| `NOTIFICATION_RETENTION_DAYS` | Optional (default 90) | No | Operational retention for NON-security notifications (7–3650); applies only to read/archived/expired rows. NOT a legal retention policy. |
| `NOTIFICATION_SECURITY_RETENTION_DAYS` | Optional (default 365) | No | Longer operational retention for SECURITY-category notifications (30–3650); security history is never aggressively pruned. NOT a legal retention policy. |
| `NOTIFICATION_MAX_PAGE_SIZE` | Optional (default 100) | No | Hard maximum `pageSize` for the notification list endpoints (10–200). |
| `NOTIFICATION_MAX_DATA_BYTES` | Optional (default 32768) | No | Serialized per-notification `dataJson` payload cap (1024–262144); oversized payloads are rejected. |
| `NOTIFICATION_CLEANUP_BATCH_SIZE` | Optional (default 500) | No | Batch size for `scripts/prune-expired-notifications.mjs` and the cleanup service (50–5000) — never one unbounded delete. |
| `NOTIFICATION_STALE_DELIVERY_MINUTES` | Optional (default 30) | No | A PROCESSING email delivery stuck longer than this is marked FAILED `STALE_PROCESSING` (5–1440) — never auto-resent. |
| `NOTIFICATION_ACTIVE_DELIVERY_LIMIT` | Optional (default 100) | No | Upper bound of PENDING email deliveries per user (10–1000); above it OPTIONAL emails are skipped (in-app never suppressed; mandatory security email bypasses). |
| `NOTIFICATION_POLL_INTERVAL_MS` | Optional (default 45000) | No | Documented unread-count poll interval bound for the notification bell (10000–600000). |

All nine are optional with validated bounds. Every value is parsed as a strict
integer; missing/out-of-range/non-integer/NaN/Infinity values fall back to the
documented default (never NaN/negative/unbounded, §345). The notification
platform uses the existing `EMAIL_*` transport — it introduces no SMTP
variables of its own. Details: `docs/security/notification-security.md`,
`docs/product/notifications.md`, `docs/product/notification-matrix.md`.

## `NODE_ENV` — the database guard flag (not in `.env.example` on purpose)

`NODE_ENV` is a runtime flag, not a configured secret, but it is load-bearing for database safety:

- `scripts/db-guard.cjs` reads it and **hard-blocks** `db:push`, `db:reset`, and `db:migrate` (exit 1, exact messages in `docs/database/migration-workflow.md` §1) whenever it equals `production`.
- The production start command (`bun run start`) sets `NODE_ENV=production` itself.
- It also disables the dev-only `NEXTAUTH_SECRET` fallback and selects the dev console email transport.

## Rules (unchanged by Prompt 19; extended Prompt 29)

1. Real `.env` files are never committed (`.gitignore` `.env*`); only the placeholder `.env.example` is version-controlled.
2. New variables must be added to `.env.example` **and** to this document at the same time.
3. Values are never quoted in docs, logs, tickets, or chat — names only. The Prompt 29 tooling enforces this in output: config checks, preflights, readiness and logs report statuses/reasons, never values (§4).
4. Production secrets come from a secrets manager, not from the repo.
5. Environment separation (§123): `NEXTAUTH_SECRET`, `DATABASE_URL`, SMTP credentials and payment credentials are NEVER copied between development, staging, and production.
