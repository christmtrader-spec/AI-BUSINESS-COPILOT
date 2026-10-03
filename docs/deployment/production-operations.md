# Production Operations Runbook (AI Business Copilot)

**Document ID:** DEPLOY-OPS-v1
**Phase:** Prompt 29 §120 (created) — operational runbook for deploying and running
the single-node production deployment.
**Stack:** Next.js 16 standalone · Prisma 6 + SQLite (single file) · NextAuth v4 ·
Caddy reverse proxy (optional TLS terminator)
**Companions:** `docs/deployment/first-production-deploy.md` (first deployment) ·
`docs/deployment/release-rollback.md` (rollback policy) ·
`docs/deployment/backup-restore-plan.md` (backup/restore detail) ·
`docs/database/migration-workflow.md` (migration discipline) ·
`docs/security/observability-and-logging.md` (logging contract) ·
`docs/deployment/environment-variables.md` (variable reference)

All commands assume the repo root and a shell with the production `.env`
loaded. Secret VALUES never appear in this document or in any script output —
names and statuses only.

---

## 1. The deployment/release sequence (Prompt 29 §120)

Run the steps **in this exact order**. Each step is a gate for the next; a
failed step stops the release. Nothing here is automatic — every command is
run by the operator.

| # | Step | Command | Pass condition |
|---|------|---------|----------------|
| 1 | **Backup** the database | `node scripts/backup-db.mjs` | exit 0; a new `backup-<timestamp>.db` + sidecar `.json` in `BACKUP_DIR` (default `db/backups/`) |
| 2 | **Verify** the backup | `node scripts/verify-backup.mjs <backup-file>` | exit 0 (`PASS`); sidecar flips `verified=true` |
| 3 | **Preflight** (read-only) | `node scripts/production-preflight.mjs` | exit 0 (`PREFLIGHT: acceptable`) |
| 4 | **Build** in an isolated process | `bun run build` (see §2 — stop dev server first) | `.next/standalone/server.js` + static + `public/` present |
| 5 | Verify the release artifact | `node scripts/release-preflight.mjs` | exit 0 (`RELEASE: artifact acceptable`) |
| 6 | **Migration status** | `bun run db:migrate:status` | state is understood (pending set known before applying) |
| 7 | **Migration gate** | `node scripts/production-preflight.mjs --gate` | exit 0 (`MIGRATION GATE: OPEN`) |
| 8 | **Migrate** | `bun run db:migrate:deploy` | exit 0; `prisma migrate status` shows up to date |
| 9 | **Start** | `bun run start` (i.e. `NODE_ENV=production bun .next/standalone/server.js`) | process stays up; startup gate does not exit 1 |
| 10 | **Health** (liveness) | `curl -fsS http://localhost:3000/api/health` | HTTP 200, `"status":"ok"` |
| 11 | **Readiness** | `curl -fsS http://localhost:3000/api/ready` | HTTP 200; body `status` is `ready` or an honest `degraded` with per-component statuses (see §8) |
| 12 | **Smoke** | manual checks (see `docs/deployment/first-production-deploy.md` §8) | auth + core flows respond; `X-Request-ID` present on responses |
| 13 | **Monitor** | watch stdout logs (structured JSON lines) + readiness endpoint | no `api.request.failed` at ERROR; backups stay fresh |

Notes per step:

- **Step 1–2 are mandatory before every migration** (§45). The preflight gate
  (step 7) re-checks them and refuses to open if no verified backup exists.
- **Step 4 (build isolation, §67/§69):** never run `bun run build` while a dev
  server (or any process) is mutating `.next/`. Stop the dev server first, and
  after any `prisma generate` RESTART the dev server before the next build —
  a stale Turbopack compile cache can split a module into two instances and
  produce invisible read-staleness (recorded incident, r28 worklog). If in
  doubt: `rm -rf .next` before the release build.
- **Step 8 is the ONLY sanctioned production schema command** — `db:push`,
  `db:reset`, and `prisma migrate dev` are development-only and hard-blocked
  in production by `scripts/db-guard.cjs`.

## 2. Build isolation procedure (§67/§69)

1. Stop any running dev server and any running production process.
2. Confirm port 3000 is free and exactly one process tree will own it (§72).
3. Run `bun run build` (this runs `next build`, then copies `.next/static`
   and `public/` into `.next/standalone/`).
4. Run `node scripts/release-preflight.mjs` — it validates the version
   authority (`src/lib/app-version.ts` == `package.json`), the standalone
   artifact (server.js + static + public), the generated Prisma client, the
   migration directory, and the `.env.example` contract. If no build is
   present it records that honestly rather than pretending (§150) — a release
   without a verified artifact must not be deployed.

## 3. Migration gate (Prompt 29 §45)

`node scripts/production-preflight.mjs --gate` is run immediately before
`bun run db:migrate:deploy`. The gate REFUSES (exit 1, `MIGRATION GATE:
REFUSED`) when:

- `DATABASE_URL` is missing;
- the migration state is unexpected/unreadable (database file not found, not
  openable read-only, or the `_prisma_migrations` table cannot be read);
- the required backup is absent — **at least one VERIFIED backup must exist**
  (created by `scripts/backup-db.mjs`, verified by `scripts/verify-backup.mjs`);
- integrity validation fails (`prisma validate` must pass; the database must
  open read-only).

A failed gate means: take and verify a fresh backup, fix the blocking
problem, and re-run. Never bypass the gate. A failed restore drill is a
warning, not a block — but investigate before migrating (§45 spirit).

## 4. Backup automation (examples only — Prompt 29 §109)

Backup automation is NOT auto-installed by this repository. The scripts below
exist; scheduling them is an explicit operator decision. **Examples — adapt
paths/schedule; do not install blindly:**

cron example (daily 02:17, backup then verify then prune dry-run):

```cron
# /etc/crontab — EXAMPLE, operator-managed (Prompt 29 §109)
17 2 * * * app cd /srv/my-project && node scripts/backup-db.mjs >> /var/log/aibc-backup.log 2>&1
27 2 * * * app cd /srv/my-project && ls -t db/backups/backup-*.db | head -1 | xargs -I{} node scripts/verify-backup.mjs {} >> /var/log/aibc-backup.log 2>&1
37 2 * * * app cd /srv/my-project && node scripts/prune-backups.mjs >> /var/log/aibc-backup.log 2>&1
```

systemd timer example:

```ini
# aibc-backup.service — EXAMPLE (operator-managed)
[Unit]
Description=AI Business Copilot DB backup (Prompt 29 backup-db.mjs)
[Service]
Type=oneshot
User=app
WorkingDirectory=/srv/my-project
ExecStart=/usr/bin/node scripts/backup-db.mjs
ExecStartPost=/bin/sh -c 'ls -t db/backups/backup-*.db | head -1 | xargs -I{} node scripts/verify-backup.mjs {}'
```

```ini
# aibc-backup.timer — EXAMPLE
[Unit]
Description=Daily AI Business Copilot backup
[Timer]
OnCalendar=*-*-* 02:17:00
Persistent=true
[Install]
WantedBy=timers.target
```

What the scripts guarantee (`scripts/backup-db.mjs`):

- SQLite `VACUUM INTO` through a separate read-only connection — a
  transaction-consistent online snapshot (never `fs.copyFile` of a live file,
  §47); bounded retry on SQLITE_BUSY, fail-safe when no consistent snapshot
  can be obtained;
- SHA-256 checksum + `integrity_check` / `quick_check` / `foreign_key_check`
  validated before the backup is declared valid (§50/§112/§114);
- a sidecar JSON per backup (timestamp, size, checksum, migration count,
  app version, environment, masked source path) — never secrets (§48);
- never overwrites an existing artifact (timestamped name, existence aborts, §46).

### Operator duties that automation does NOT do

- **Offsite copy is a documented operator duty.** Same-box backups do not
  survive disk loss. Copy the `.db` + sidecar `.json` off the host on a
  schedule you operate (rsync/object storage), and verify the copy's checksum
  at the destination.
- **APPLICATION-LEVEL BACKUP ENCRYPTION NOT IMPLEMENTED** (§59 — verbatim).
  The application does not encrypt backup artifacts. The operator MUST
  encrypt at rest / in transit off-host (e.g. `age`/`gpg` to an operator key,
  or provider-side encryption at rest). Keys live with the operator's secrets
  manager, never in this repo.
- **Backup sensitivity (§60):** a database backup contains password hashes
  AND session/auth data — treat every backup artifact as the most sensitive
  file on the host: store encrypted/at rest protected, never web-served,
  never committed, never world-readable.

## 5. Single-node law (§73) and PID/port safety (§72)

- **Exactly ONE application instance may serve a given database file.** There
  is no second worker, no sidecar job runner, no replica: SQLite is
  single-writer and the in-memory state (rate limiting, caches) is
  per-process. Starting a second instance against the same `DATABASE_URL` is
  a configuration error, not a scaling strategy.
- **PID/port safety procedure (§72)** — before every start, and whenever a
  start fails oddly:
  1. Identify the current application process, e.g.
     `pgrep -af "standalone/server.js"` — expect at most ONE match.
  2. Confirm the port state: `curl -fsS http://localhost:3000/api/health`
     answers → an instance already owns :3000; do NOT start another.
  3. If a stale process holds the port without serving (boot gap/hang), stop
     IT deliberately (`kill <pid>`, SIGTERM — the app shuts down gracefully,
     §7), verify the port is free, then start.
  4. Never run two watchdogs that both respawn the server. The repo's
     `scripts/dev-guard.cjs` / `scripts/keep-dev-up.cjs` demonstrate the
     guard pattern (HTTP probe + PID lockfile + boot-gap detection) and are
     DEV tooling — adapt the idea to your process manager in production.

## 6. In-memory rate limiting is PROCESS-LOCAL (§74)

Rate limiting (`src/lib/rate-limit.ts`) is a sliding window in process
memory. Consequences (honest limits):

- No distributed protection: with more than one instance each would keep its
  own counters (limits effectively multiplied). Combined with §73 there is
  exactly one limiter per deployment.
- Restart clears counters; an attacker window resets with the process.
- No claim of cluster-wide abuse protection may ever be made for this app.

## 7. Graceful shutdown (Prompt 29 §70)

On `SIGTERM`/`SIGINT` the process (installed in `src/instrumentation-node.ts`):

1. emits a structured `shutdown.begin` line (signal recorded);
2. disconnects Prisma cleanly;
3. emits `shutdown.complete` and exits 0.

A hard cap prevents an indefinite hang: `GRACEFUL_SHUTDOWN_TIMEOUT_MS`
(accepted range 1000..60000, **default 8000 ms**) forces `shutdown.timeout`
+ exit. Process managers can therefore rely on SIGTERM terminating the app
within the cap; only send SIGKILL after that. Operator procedure for a
planned stop: send SIGTERM, wait for the cap, verify the port is free (§72).

## 8. Health vs readiness (Prompt 29 §94)

| Endpoint | Question | Behavior |
|---|---|---|
| `GET /api/health` | "Is the process alive?" | liveness/minimal: version, `database.reachable`, migration counts (applied/pending). Healthy responses cached 15s; degraded re-probed after 3s (§90). Safe to expose publicly. |
| `GET /api/ready` | "Can this process safely serve production traffic?" | full readiness: overall `ready` / `degraded` / `blocked` + per-component statuses (`database`, `migrations`, `configuration`, `email`, `payments`, `aiCostRates`, `legal`, `backups`, `restoreDrill`). 3s cache (§91). Public-safe: statuses + version ONLY — no counts, paths, names, or SMTP details (§42/§93/§172). |

Semantics: `blocked` = do NOT send traffic (database unreachable, migrations
pending, mandatory production configuration invalid). `degraded` = serving,
with honest operational gaps (email not configured, backups stale/missing,
restore drill stale, legal review pending, AI rates unverified) — readiness
deliberately does NOT fail merely because optional components are
unconfigured. Both endpoints answer HTTP 200 while they can report; the BODY
carries the state. Wire uptime monitors on `/api/health`; alert on
`/api/ready` body `status != "ready"` per your policy. Both are rate-limited
30/min/IP and echo `X-Request-ID`.

## 9. Logging and log rotation (§38)

- The app writes plain JSON lines to stdout (errors to stderr) —
  `bun run start` captures them via `tee server.log`. The log contract,
  redaction, and event catalog: `docs/security/observability-and-logging.md`.
- **Log rotation is the process manager's job, not the app's** (§38). The
  application never rotates, truncates, or ships its own logs. Use
  logrotate/journald/your supervisor's stdout handling; keep structured lines
  intact (one JSON object per line) for grepping.

## 10. Environment separation (Prompt 29 §123)

The following secrets/config are NEVER copied between development, staging,
and production — each environment gets its own, generated values:

- `NEXTAUTH_SECRET` (session signing/encryption — sharing one secret means
  one environment can forge the other's sessions);
- `DATABASE_URL` (each environment has its own database file; a dev run must
  never be able to touch production data and vice versa);
- SMTP credentials (`EMAIL_SERVER_USER` / `EMAIL_SERVER_PASSWORD`);
- payment credentials (`ZARINPAL_MERCHANT_ID`, `PAYMENT_*` values) —
  sandbox and production use separate values by contract.

Staging may mirror production *shape*, never production *values*. Enforce
this at provisioning time (secrets manager per environment), and verify with
`node scripts/production-config-check.mjs` (reports statuses, never values).

## 11. Platform operator bootstrap (Prompt 29 §122)

The ONLY sanctioned way to create the first platform operator is the offline
CLI — **never an HTTP route** (no public bootstrap endpoint exists):

```bash
bun scripts/platform-operator.ts list
bun scripts/platform-operator.ts bootstrap --email <email> --role PLATFORM_SUPER_ADMIN [--yes]
bun scripts/platform-operator.ts set-role --email <email> --role <PLATFORM_ROLE> [--yes]
bun scripts/platform-operator.ts activate  --email <email> [--yes]
bun scripts/platform-operator.ts deactivate --email <email> [--yes]
```

Constraints: the user must ALREADY exist (bootstrap never creates users);
valid platform roles only; explicit `--yes` or typed confirmation; the
command runs on the host with the production env, not through the web tier.
Full policy: `docs/security/platform-admin-security.md`.

## 11b. Data portability storage + cleanup (Prompt 31 §255)

- **Storage root**: `DATA_PORTABILITY_ROOT` (default `var/data-portability/`) —
  non-public by construction; preflight (`scripts/production-preflight.mjs`,
  section 11) blocks roots inside web-served directories and checks
  writability. Include the directory in volume planning: artifacts are
  single-node local files (no cloud object storage is implemented).
- **Cleanup schedule** (cron examples, dry-run first, then apply):

  ```bash
  bun scripts/prune-expired-exports.mjs          # report (dry run)
  bun scripts/prune-expired-exports.mjs --apply  # remove expired export artifacts
  bun scripts/prune-expired-imports.mjs          # report (dry run)
  bun scripts/prune-expired-imports.mjs --apply  # expire + remove staged uploads
  ```

  Both scripts never delete audit records; the import pruner never touches a
  job stuck in COMMITTING (crash-recovery ownership belongs to the stale-job
  detector, which marks it FAILED with "no partial data was written").
- **Readiness**: `/api/ready` and Platform System expose `portabilityStorage`
  (READY / NOT_CONFIGURED / BLOCKED — status only, no paths, §305/§358).
- **Single-node law**: exports/imports are process-local file operations; a
  multi-instance deployment must first provide a shared filesystem or object
  storage ADR (documented limitation, `docs/security/data-portability.md` §9).

## 11c. Notification platform operations (Prompt 32)

- **Cleanup schedule** (operational retention only — NOT legal retention;
  mirrors the Prompt 31 pattern: dry-run first, review, then apply):

  ```bash
  bun scripts/prune-expired-notifications.mjs          # report (dry run)
  bun scripts/prune-expired-notifications.mjs --apply  # delete eligible rows
  ```

  Recommended cadence: run the dry-run **monthly**; after reviewing the
  counts, run with `--apply` **quarterly**. The script deletes only
  non-security notifications older than `NOTIFICATION_RETENTION_DAYS`
  (default 90) that are already read/archived/expired, and security-category
  notifications past `NOTIFICATION_SECURITY_RETENTION_DAYS` (default 365)
  that are read/archived. Deliveries cascade with their notification;
  preference rows and audit records are never touched.

- **Failed email diagnostics**: `GET /api/v1/platform/notifications`
  (read-only, `platform:system:read`) reports delivery counts by status
  (total/pending/processing/sent/failed/skipped), the top failed notification
  TYPES, catalog/template health, and email-transport readiness. Failures are
  normalized into the fixed codes `SMTP_CONFIG` · `SMTP_TIMEOUT` ·
  `SMTP_AUTH` · `SMTP_CONNECTION` · `TEMPLATE` · `INVALID_RECIPIENT` ·
  `ATTEMPTS_EXHAUSTED` · `STALE_PROCESSING` · `RECIPIENT_UNVERIFIED` ·
  `UNKNOWN` — never raw SMTP output. Viewing the diagnostics opportunistically
  reaps stale PROCESSING deliveries (marks them FAILED `STALE_PROCESSING`;
  never resends). Operator retry
  (`POST /api/v1/platform/notifications/deliveries/[deliveryId]/retry`,
  `PLATFORM_SUPER_ADMIN`/`PLATFORM_SUPPORT` only) is permitted ONLY for failed
  OPTIONAL email deliveries — mandatory security emails can never be resent
  through retry — and the attempt cap (`NOTIFICATION_EMAIL_MAX_ATTEMPTS`)
  still applies. Note (honest): these endpoints are API-only today; the
  Platform System console does not yet render a notification section.

- **Delivery monitoring guidance**: alert on a sustained high FAILED ratio in
  the diagnostics counts (e.g. failures dominating new deliveries over an
  hour — typically a transport problem: `SMTP_CONFIG`/`SMTP_AUTH`/
  `SMTP_CONNECTION`). Do NOT auto-disable notifications in response: in-app
  delivery is part of the security-history experience and mandatory security
  email is preference-independent. Treat a growing PENDING backlog as an
  email-transport symptom (dispatch is synchronous, bounded by
  `EMAIL_TIMEOUT_MS`).

- **Readiness component `notifications`** (`/api/ready` + Platform System):
  READY = catalog healthy AND the email transport configured; PARTIAL =
  catalog healthy but email unconfigured (in-app still works — degraded, not
  blocked); BLOCKED = catalog unhealthy. Public payloads carry the status
  only.

## 11d. CRM task reminder scheduler (Prompt 37)

CRM task reminders (due-soon + overdue notifications, Prompt 37) are driven
by an **EXTERNAL, operator-managed scheduler**. The application contains NO
in-process scheduler; if the schedule below is not installed, reminders
simply do not fire and the app stays healthy (§191).

**EXAMPLES ONLY — OPERATOR-MANAGED — NOT AUTO-INSTALLED:**

- **Linux cron (recommended: every 5 minutes, §70):**

  ```
  # /etc/crontab — EXAMPLE, operator-managed (Prompt 37 §70)
  */5 * * * * app cd /srv/my-project && bun scripts/process-crm-task-reminders.mjs --apply >> /var/log/aibc-crm-reminders.log 2>&1
  ```

- **systemd timer (§71)** — `aibc-crm-reminders.service`:

  ```ini
  [Unit]
  Description=AI Business Copilot CRM task reminders (Prompt 37)

  [Service]
  Type=oneshot
  User=app
  WorkingDirectory=/srv/my-project
  ExecStart=/usr/local/bin/bun scripts/process-crm-task-reminders.mjs --apply
  ```

  and `aibc-crm-reminders.timer`:

  ```ini
  [Timer]
  OnBootSec=5min
  OnUnitInactiveSec=5min

  [Install]
  WantedBy=timers.target
  ```

  systemd prevents overlapping runs of the same unit (concurrency
  protection, §73).

- **Windows Task Scheduler (§72)**: trigger every 5 minutes; program
  `bun.exe`; arguments `scripts/process-crm-task-reminders.mjs --apply`;
  working directory = project root; enable "Do not start a new instance".

- **Overlap protection** is the scheduler's job (`flock` for cron, systemd
  unit concurrency, Task Scheduler instance policy). The processor itself is
  IDEMPOTENT — a repeated/overlapping run dedupes on the Notification
  `(userId, type, sourceEventId)` unique index and produces zero duplicates
  (§73/§81). Idempotency is a safety net, NOT distributed scheduling: keep
  ONE scheduling owner per database (Prompt 37-F ADR §67).

- **Dry run first**: `bun scripts/process-crm-task-reminders.mjs` (no
  `--apply`) prints safe counters only (mode/scanned/candidates/created/
  duplicates/skipped/failed) and never writes.

- **CLI usage contract (Prompt 37-F §5–§9)** — validated BEFORE the
  processor runs (zero database access on rejection, exit 1):
  - `--apply` + `--dry-run` together → exit 1 (`CONFLICTING_FLAGS`).
  - Unknown flags (e.g. `--foobar`) → exit 1 (`UNKNOWN_FLAG`).
  - `--business-id=<id>` must match `^[a-zA-Z0-9_-]{6,64}$`, else exit 1
    (`INVALID_BUSINESS_ID`).
  - `--max=<n>` must be a decimal integer within 10–500, else exit 1
    (`INVALID_MAX` / `MAX_OUT_OF_RANGE`) — the CLI never silently clamps a
    dangerous workload. Duplicate boolean flags are accepted idempotently;
    duplicate value flags take the last occurrence.
  - Exit codes: 0 = run completed (dry or apply) · 1 = invalid usage OR
    systemic failure. A single bad candidate never aborts the run.

- **Troubleshooting**:
  - *Exit 1 with `CLI_USAGE_INVALID`*: fix the flags above — nothing was
    written.
  - *Exit 1 with an error name and no result*: systemic (usually the
    database) — check the DB path/service; the run made no partial
    notification commitments beyond per-candidate isolation.
  - *Reminders not firing*: the schedule is not installed or not running —
    reminders resume on the next successful run within the configured
    windows; missed reminders are not replayed beyond the overdue lookback.
  - *`failed` > 0*: per-candidate errors (the run continues); investigate
    with the dry-run counters — logs never contain task content.

- **Limits**: `CRM_REMINDER_MAX_PER_RUN` (default 100, range 10–500) caps
  notification attempts per run; `CRM_REMINDER_OVERDUE_LOOKBACK_HOURS`
  (default 168, range 1–720) bounds overdue rescanning — an operational
  scanning boundary, NOT a retention policy (§41). Invalid/NaN/negative /
  out-of-range values are clamped into the documented bounds (never
  unbounded). See `docs/product/crm-task-reminders.md` and
  `docs/security/crm-task-reminders-security.md`.

- **Log hygiene**: the CLI/processor emit counts/mode/runId/timestamps only
  (Prompt 37-F §11 — no task ids, business ids, dueAt values, offsets,
  titles or bodies). Cron redirection (`>> /var/log/...`) plus the OS
  standard log rotation (logrotate/systemd-journald) is the supported
  retention mechanism; the application retains no reminder logs of its own.

- **No scheduler HTTP endpoint, no CRON_SECRET**: the CLI runs locally
  against the database (§158/§171). Scheduler availability must never affect
  `/api/health` or `/api/ready` (§190/§191).

## 12. Related procedures

- Rollback: `docs/deployment/release-rollback.md` (§118/§119) — forward-only
  migrations; recovery via verified backup or additive corrective migration.
- Restore drill: `node scripts/restore-drill.mjs` (isolated temp clone; never
  touches production; writes `db/backups/last-restore-drill.json` which feeds
  the `restoreDrill` readiness component). Retention pruning:
  `node scripts/prune-backups.mjs` (dry-run default; `--apply` to delete).
- Reverse-proxy contract: `node scripts/caddy-config-check.mjs [path]` —
  verifies `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Real-IP` are
  overwritten from the socket peer and upstreams are localhost-bound (§95/§96).
  Deployment Caddyfiles MUST match the repo `Caddyfile` contract.
- First deployment: `docs/deployment/first-production-deploy.md` (§121).
