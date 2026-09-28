# First Production Deployment (AI Business Copilot)

**Document ID:** DEPLOY-FIRST-v1
**Phase:** Prompt 29 §121 (created) — first-time production bring-up.
**Companions:** `docs/deployment/production-operations.md` (steady-state
runbook + release sequence) · `docs/deployment/release-rollback.md` ·
`docs/deployment/environment-variables.md` (variable reference) ·
`docs/deployment/backup-restore-plan.md` ·
`docs/deployment/production-checklist.md` (v1 checklist, still valid)

Every step is operator-run. Nothing is auto-provisioned. Secret VALUES never
appear in any output or doc — names and statuses only.

---

## 0. Preconditions

- Repo checked out on the production host; `bun` + Node available;
  `bun install` completed; `bun run db:generate` run (Prisma client present).
- A process manager decision made (systemd/tmux/nohup) — the app runs as
  `NODE_ENV=production bun .next/standalone/server.js` with logs captured
  (rotation is the process manager's job, runbook §9).
- Exactly ONE application instance per database (§73) and one owner of the
  port (§72) — see `docs/deployment/production-operations.md` §5.

## 1. Environment provisioning

Create the production `.env` from `.env.example` (placeholders only there;
never commit the filled file). Mandatory core (validated by
`src/lib/config/production.ts`; startup exits non-zero in production when
these are missing/invalid — §6):

| Variable | Requirement |
|---|---|
| `DATABASE_URL` | SQLite `file:` URL to the production database file (project convention: absolute path to `db/custom.db`). `:memory:` is rejected — a restart would silently lose every record. |
| `NEXTAUTH_SECRET` | ≥32 chars. Generate with `openssl rand -base64 32`. Production-specific value — never copied from dev/staging (§123). Rotating it later invalidates all sessions. |
| `NEXTAUTH_URL` | Absolute canonical origin the app is served on (e.g. `https://app.example.com`). Must match the public origin behind the proxy. |
| `APP_BASE_URL` | Absolute URL used to build password-reset links (falls back to `NEXTAUTH_URL`, but set it explicitly in production so reset links never depend on request headers). |

Optional-but-recommended at bring-up (advisory otherwise, reported honestly
as NOT_CONFIGURED): the public trust block (`PUBLIC_BASE_URL` must be
**https** when set, `PUBLIC_COMPANY_LEGAL_NAME`, `PUBLIC_SUPPORT_EMAIL`,
`PRIVACY_CONTACT_EMAIL`, `LEGAL_CONTACT_EMAIL`, `SECURITY_CONTACT_EMAIL`),
and the backup/observability variables in §4/§5.

**Gate:** `NODE_ENV=production node scripts/production-config-check.mjs`
must exit **0** (`ACCEPTABLE: 0 blocking problems`) BEFORE proceeding.
Advisory NOT_CONFIGURED findings are acceptable; INVALID/blocking findings
are not. This check reports statuses only — it never prints secret values.

## 2. SMTP configuration (Prompt 29 §7–§11)

The production email transport is a real SMTP adapter (nodemailer). All of
the following are required TOGETHER for the transport to count as CONFIGURED
(checking only the host is explicitly forbidden, §18):

| Variable | Requirement |
|---|---|
| `EMAIL_SERVER_HOST` | SMTP relay host |
| `EMAIL_SERVER_PORT` | 1–65535 (typ. 465 with implicit TLS) |
| `EMAIL_FROM` | Valid from-address (RFC shape) |
| `EMAIL_SERVER_USER` / `EMAIL_SERVER_PASSWORD` | Credentials — either both set or both unset. The password is a secret: secrets manager only, server-only, never logged, never returned by any API (§9). |
| `EMAIL_SECURE` | **`true` REQUIRED in production** (implicit TLS, typically port 465). Explicit `false`/`0` (plain/STARTTLS-only mode) is BLOCKED in production (§10). Unset is INVALID in production. Certificate verification is never disabled (`rejectUnauthorized: true`). |
| `EMAIL_TIMEOUT_MS` | Bounded delivery timeout, 1000..60000 ms, default 10000. A send can never hang an HTTP request indefinitely (connection/greeting/socket timeouts + an overall race in the adapter). |

Without any `EMAIL_*` configuration the transport is honestly NOT_CONFIGURED:
password-reset requests return a uniform 503 in production (no fake
readiness). With INVALID (half-configured) settings the app treats it as a
production-blocking posture problem — fix it before launch. Delivery is one
bounded attempt per request; failures are logged with safe error classes only.

## 3. HTTPS (Prompt 29 §97/§99)

- `PUBLIC_BASE_URL` must be an **https** origin once public posture matters;
  an http value in production is a blocking finding of
  `production-config-check` (§99).
- **HSTS is emitted only when `PUBLIC_BASE_URL` starts with `https://`**
  (`next.config.ts`) — the header must never be claimed for an HTTP-only
  deployment. Terminate TLS at Caddy (or your proxy) and keep the
  proxy contract: `node scripts/caddy-config-check.mjs` must pass
  (`X-Forwarded-For`/`X-Forwarded-Proto`/`X-Real-IP` overwritten from the
  socket peer; localhost upstreams — §95/§96).

## 4. Backup setup (Prompt 29 §46–§57)

1. Set `BACKUP_DIR` (default `db/backups/` relative to the project) — MUST
   NOT be web-served or committed. The database backup contains password
   hashes and session data: store encrypted / at-rest protected (§60);
   APPLICATION-LEVEL BACKUP ENCRYPTION NOT IMPLEMENTED (§59) — encryption
   and the offsite copy are manual operator duties.
2. Take the FIRST backup and verify it:

   ```bash
   node scripts/backup-db.mjs
   node scripts/verify-backup.mjs db/backups/backup-<timestamp>.db   # or the printed name
   ```

3. Run the first restore drill (proves restorability on an isolated clone;
   never touches production):

   ```bash
   node scripts/restore-drill.mjs
   ```

4. Decide the schedule now (cron/systemd EXAMPLES in the runbook §4 — not
   auto-installed, §109) and set `BACKUP_MAX_AGE_HOURS` (readiness shows
   BACKUP_STALE past it; default 26h) and the retention variables for
   `scripts/prune-backups.mjs` (`BACKUP_RETENTION_DAILY`/`WEEKLY` —
   operational policy, NOT legal retention).

## 5. Migration discipline (first schema apply)

For a FRESH database (file does not exist yet) `prisma migrate deploy`
creates it — run it directly; the §45 gate would refuse here by design
(it requires an existing database + verified backup). For every deploy
against a LIVE database the gate MUST be OPEN first. Either way, take the
§4 backup immediately after the first successful migrate so every later
deploy has its rollback anchor.

```bash
NODE_ENV=production node scripts/production-preflight.mjs --gate   # live-DB deploys: must be OPEN
bun run db:migrate:deploy                                          # the ONLY sanctioned command
bun run db:migrate:status                                          # confirm up to date
```

`db:push` / `db:reset` / `prisma migrate dev` are development-only and
hard-blocked in production (`scripts/db-guard.cjs`).

### Seed restrictions

- **Pricing:** the EUR-v1 baseline is applied by a migration;
  `bun scripts/seed-pricing.ts` is an idempotent verify/repair tool — it
  never mutates existing amounts and never invents prices. An IRR book is
  created ONLY when an operator explicitly passes real amounts (created
  INACTIVE unless `--activate`). No placeholder prices anywhere (Rule 05).
- **AI cost rates:** production AI rates are NOT env values — they are
  verified `AiCostRate` rows created through the governed rate service with
  evidence. Zero verified rates is an honest NOT_CONFIGURED state (readiness
  `aiCostRates: NOT_CONFIGURED`); never seed an unevidenced production rate.
- **No demo/seed data in production:** no fake users, businesses, or
  financial rows (Rule 05). The dev seed/test accounts belong to dev only.

## 6. Platform operator bootstrap (Prompt 29 §122)

Create the first user through the normal sign-up flow, then promote it from
the host via the offline CLI — there is NO HTTP bootstrap route:

```bash
bun scripts/platform-operator.ts bootstrap --email <email> --role PLATFORM_SUPER_ADMIN
```

The user must already exist; `--yes` (or typed confirmation) is required.
Full policy: `docs/security/platform-admin-security.md`.

## 7. Start + gates

```bash
bun run build        # isolated process — no dev server running (runbook §2)
node scripts/release-preflight.mjs
bun run start        # NODE_ENV=production bun .next/standalone/server.js
```

Startup fail-fast: with invalid mandatory production configuration the
process exits non-zero immediately (§6) — fix and restart. Then:

```bash
curl -fsS http://localhost:3000/api/health   # liveness: status "ok"
curl -fsS http://localhost:3000/api/ready    # readiness: statuses + version only
```

`/api/ready` answering `degraded` with optional components NOT_CONFIGURED is
the honest first-day state if you have not configured email/backup yet —
it must not be `blocked` (blocked = database/migrations/mandatory config).

## 8. Smoke test list (first deploy)

Run against the production origin, in order; stop at the first failure:

1. `GET /api/health` → `status:"ok"`, version matches `src/lib/app-version.ts`.
2. `GET /api/ready` → not `blocked`; components match what you configured.
3. Every response carries `X-Request-ID` (client-supplied values are honored
   only if 8–64 chars of `[A-Za-z0-9._-]`; anything else is replaced by a
   server UUID).
4. Sign-up the first owner account; sign-in; create the first business.
5. Tenant isolation: second account; attempt business #1's data (e.g.
   `GET /api/v1/businesses/<id1>/export`) → 403.
6. Export/import round-trip on the new business (dry_run then merge) —
   consistent counts, zero surprises.
7. Password reset request for the owner email → with SMTP configured: email
   arrives (EN/FA template per user locale), generic 200 always; without
   SMTP: uniform 503 and the readiness `email` component says
   NOT_CONFIGURED (honest).
8. `POST /api/v1/auth/password-reset/request` + confirm path with the
   emailed token (30-minute TTL, single use).
9. Backup artifacts exist in `BACKUP_DIR` with `verified=true` sidecars;
   `db/backups/last-restore-drill.json` says PASS.

Note: `bun scripts/e2e-smoke.ts` is a DEV/QA harness using documented dev
test accounts — run it against a staging/dev deployment, not against the
production database (it would create test data).

## 9. Rollback readiness

Before announcing the deployment, confirm the rollback path exists: the
release tree + previous artifacts retained, first verified backup in place,
drill record PASS. Procedure: `docs/deployment/release-rollback.md`.
After the first deploy, steady-state operations follow
`docs/deployment/production-operations.md` (§120 sequence).
