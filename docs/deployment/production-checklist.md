# Production Deployment Checklist (AI Business Copilot)

**Document ID:** DEPLOY-CHECKLIST-v1.1
**Phase:** Prompt 17 (created) · revised Prompt 18 (build gate, auth) & Prompt 19 (migration baseline, guards, health probe)
**Stack:** Next.js 16 App Router standalone · Prisma 6.11.1 + SQLite (`db/custom.db`) · NextAuth v4 · Caddy reverse proxy
**Companions:** `docs/deployment/backup-restore-plan.md` · `docs/database/migration-workflow.md` · `docs/database/prompt19-baseline.md` · `docs/deployment/environment-variables.md`

All commands assume the repo root `/home/z/my-project`.

---

## 1. Build

Defined in `package.json:7`:

```bash
npm run build
# = next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/
```

- `output: "standalone"` is set in `next.config.ts:4`; the copy steps make the
  standalone server self-contained (static assets + `public/`).
- Verify after build: `.next/standalone/server.js` exists and
  `.next/standalone/.next/static` is populated.
- ✅ **Type-checking is enforced** — `typescript.ignoreBuildErrors` was
  **removed in Prompt 18**; `next build` fails on type errors. Run
  `bun run lint` (`package.json:9`) before shipping as well.
- Note: standalone tracing bundles the Prisma query engine, but NOT the
  `prisma/migrations/` directory — run migrations from the repo checkout
  (`docs/database/migration-workflow.md` §5).

## 2. Start

Defined in `package.json:8`:

```bash
NODE_ENV=production bun .next/standalone/server.js 2>&1 | tee server.log
```

- Logs go to stdout and are captured into `server.log` (dev uses `dev.log`,
  `package.json:6`). Any process manager (systemd unit, tmux, `nohup`) must
  keep this exact command and environment.
- `NODE_ENV=production` is mandatory — it both switches Next.js behavior and
  disables the dev-only `NEXTAUTH_SECRET` fallback (`src/lib/auth.ts:25-28`).
- Do not use `npm run dev` in production (dev server + `tee dev.log` is the
  sandbox pattern, `package.json:6`).

## 3. Database setup (Prisma) — migration-based since Prompt 19

Datasource is SQLite via `DATABASE_URL` (`prisma/schema.prisma:9-12`); the
production file is `db/custom.db` (TDR §1, `docs/TECH-DECISION-RECORD.md:20`).

1. Set `DATABASE_URL` (see §4) so Prisma resolves the production db file.
2. Run `bun run db:generate` (`package.json:11`) to produce the client for the
   standalone bundle's expected environment (verify the generated client is
   present in the deployed tree; standalone bundles include it via node_modules
   tracing — verify on first deploy).
3. **MIGRATION BASELINE — DONE (Prompt 19, 2026-09-23).**

   The schema is now migration-based: baseline migration **`0_init`** is
   generated, committed, and marked applied on `db/custom.db` with **zero
   drift** and zero data change (full machine-audit record:
   `docs/database/prompt19-baseline.md`). The `db push` era is over.

   Operating rules (enforced + documented, `docs/database/migration-workflow.md`):
   - **Staging/production schema changes:** `bun run db:migrate:deploy`
     (i.e. `prisma migrate deploy`) — the ONLY sanctioned command, run against
     a freshly backed-up database.
   - **Pre-deploy verification:** `bun run db:migrate:status` must show the
     expected pending/apply state before every deploy.
   - **Production guards:** `db:push`, `db:reset`, and `db:migrate`
     (`prisma migrate dev`) are DEVELOPMENT ONLY and hard-blocked with exit 1
     when `NODE_ENV=production` (`scripts/db-guard.cjs` — exact block messages
     in the workflow doc §1). Never invoke the underlying `prisma db push` by
     hand against real data either.
   - `prisma/migrations/` is version-controlled and **immutable once applied**
     (workflow doc §2); future changes ship as NEW migrations (workflow doc §3).

## 4. Required environment variables

**`.env.example` now exists** (placeholders only, version-controlled via the
`.gitignore` `!.env.example` exception). The canonical per-variable reference
is **`docs/deployment/environment-variables.md`** — keep it in sync when
variables are added. Minimum set:

| Variable | Mandatory | Purpose | Notes |
|---|---|---|---|
| `DATABASE_URL` | ✅ | Prisma/SQLite connection (`file:../db/custom.db` shape — TDR §5, `docs/TECH-DECISION-RECORD.md:131`) | Points the app at the db file; wrong value = app silently uses a different/empty database |
| `NEXTAUTH_SECRET` | ✅ **prod throws without it** | NextAuth v4 JWT/JWE signing + encryption key (`src/lib/auth.ts:24-28`; production fails fast via next-auth's `NO_SECRET`) | Dev has a stable literal fallback (`auth.ts:26-28`) that is **disabled in production**; generate with `openssl rand -hex 32` (TDR §5, `:135`); rotating invalidates all sessions (`:132`) |
| `NEXTAUTH_URL` | ✅ | Canonical origin NextAuth issues cookies against (TDR §5, `:133`) | Must match the externally reachable origin (scheme + host) or CSRF/session cookies fail behind the proxy |

Also in `.env.example` (used by the Prompt-18 auth flows):
`APP_BASE_URL` (base for password-reset links — never derived from request
headers) and the reserved `EMAIL_*` block. Production **without**
`EMAIL_SERVER_HOST` makes password-reset requests return a uniform `503`
(`docs/security/password-recovery.md` §8/§11). No SMTP adapter is wired yet.

**No other secrets exist** in this project today: the AI provider SDK is
keyed through the platform, no SMTP credentials configured, no payment
provider (billing is design only — `docs/billing/billing-architecture.md`),
no third-party API keys. When one is added, it must be documented in
`docs/deployment/environment-variables.md` and `.env.example`
(never committed, never quoted).

## 5. Reverse proxy (Caddy)

`Caddyfile` (repo root) proxies `:81` → `localhost:3000`
(`Caddyfile:16-21`) with an optional port-transform branch
(`Caddyfile:2-13`). Caddy terminates TLS in front of the app.

Key behavior to know:

- **Caddy OVERWRITES `X-Forwarded-For`** with the real client IP
  (`header_up X-Forwarded-For {remote_host}`, `Caddyfile:18`) — so the app's
  IP-based rate limiting and audit `ip` fields
  (e.g. `src/lib/auth.ts:51-55`, `src/lib/audit.ts` consumers) receive the
  true client address and cannot be spoofed by a client-sent header. Keep this
  line; do not add a second proxy hop that *appends* to `X-Forwarded-For`
  without re-reviewing this.
- `X-Forwarded-Proto {scheme}` (`Caddyfile:19`) — ensure `NEXTAUTH_URL` uses
  the public `https://` origin so cookies/redirects are scheme-correct.

## 6. Health check & watchdog

- **Health endpoint (EXISTS — Prompt 19):** `GET /api/health` is the
  liveness/readiness probe (`src/app/api/health/route.ts`): unauthenticated,
  rate-limited 30/min/IP, 15 s in-memory cache. Response:
  `{status: "ok" | "degraded", version, database:{reachable}, migrations:{applied, pending}, timestamp}`
  (version from `src/lib/app-version.ts`, currently `0.2.1`; migration counts
  derived from `_prisma_migrations`). It **never** exposes the DB URL, schema
  internals, table names or secrets — safe for public uptime monitoring:
  `curl -fsS http://localhost:3000/api/health`.
- `GET /api` (static JSON hello, `src/app/api/route.ts`) also remains for a
  no-database liveness ping.
- **Startup watchdog:** the sandbox pattern `scripts/keep-dev-up.cjs`
  (hardened in the r19-hotfix round: TCP :3000 probe, PID lockfile) and
  `scripts/dev-guard.cjs` (refuses a second `next dev`) demonstrate the
  expected shape. For production, adapt the same probe/respawn idea to the
  §2 start command (and your process manager) — these scripts as written are
  DEV-server tooling and must not be run as-is in production.

## 7. First-run checklist (new deployment)

Execute in order; do not skip verification steps:

| # | Step | Verify |
|---|---|---|
| 1 | Env vars set (§4), Caddy up, app started with §2 command | `curl -fsS localhost:3000/api/health` → `status:"ok"` (or `curl -fsS localhost:3000/api` → JSON for a no-DB ping) |
| 2 | Create the owner account | `GET /` renders the auth view; sign-up → `POST /api/v1/auth/register` → session established |
| 3 | Create the first business (onboarding) | Business settings persisted (currency/locale/timezone — `prisma/schema.prisma:43-48`) |
| 4 | **Verify tenant isolation** | Second account signs up; attempt to open business #1's data (e.g. `GET /api/v1/businesses/<id1>/export`) → must be 403 (`export/route.ts:31-33`); all queries tenant-scoped (`docs/ARCHITECTURE.md:64-77`) |
| 5 | **Verify backup round-trip** | Export JSON (`GET …/export`) → import `dry_run` then `merge` (`POST …/import`) → report counts consistent; full procedure in `docs/deployment/backup-restore-plan.md` §5 |
| 6 | Smoke suite | `bun scripts/e2e-smoke.ts --base <origin>` (`scripts/e2e-smoke.ts:18`) — RBAC negatives, money-integers, export/import round-trip (dev-only test accounts — run against a scratch business) |
| 7 | First backup taken | §"backup-restore-plan" — schedule established, artifact verified restorable |

## 8. Logs

- stdout → `server.log` via the §2 command (`tee`); dev log is `dev.log`
  (`package.json:6,8`).
- The Prisma client logs every query (`log: ['query']`, `src/lib/db.ts:10`) —
  expect chatty logs; watch disk usage and consider raising log level in a
  future hardening pass (out of scope here).
- The request pipeline returns generic errors to users and keeps diagnostics
  server-side (Constitution §7 "Error Handling",
  `docs/PROJECT-CONSTITUTION.md:361-364`).

## 9. Rollback plan

1. **Application:** keep the previous release directory. Deployments go to a
   new tree (e.g. `/srv/app-<date>/.next/standalone`); on failure, stop the
   server, point start (§2) back at the previous `.next/standalone/server.js`,
   start. Static assets ride inside the standalone tree (§1) — no shared
   state.
2. **Database:** stop the server → restore `db/custom.db` from the last
   verified backup (`docs/deployment/backup-restore-plan.md` §4) →
   `PRAGMA integrity_check` → start. This is why every deploy is preceded by
   a fresh backup (§3, pre-upgrade).
3. **Schema migrations:** if a rollback crosses a migration, restore the
   matching pre-upgrade database backup made for that release
   (`prisma migrate deploy` is forward-only).

## 10. Scaling caveats (honest limits of this architecture)

| Caveat | Evidence | Consequence |
|---|---|---|
| **Single process** | Zustand-less but rate limiting is in-process: "MVP scope: single process" (`src/lib/rate-limit.ts:2`, `Map` at `:9`) | Run exactly ONE server instance; N instances = N independent limiters (rate limits effectively multiplied) |
| **In-memory rate limiter** | `src/lib/rate-limit.ts:1-47` (sliding window per key, process-local) | Restart clears counters; multi-node needs a shared store + ADR (noted in-file `:3-5`) |
| **SQLite single-writer** | Datasource sqlite (`prisma/schema.prisma:10`); TDR D3 (`docs/TECH-DECISION-RECORD.md:53-60`) | Fine for single-node MVP; Postgres is the documented scale path (D3) — triggers: concurrent writers, reporting load, multi-node |
| **Local file DB** | `db/custom.db` | Backup discipline is mandatory (`docs/deployment/backup-restore-plan.md`); disk-full = outage |
| **No horizontal scaling** | Everything above | Vertical scale (bigger box) first; ADR before any distributed change (Rule 06, `docs/PROJECT-CONSTITUTION.md:289-293`) |

## 11. Go-live sign-off

- [ ] Build artifacts verified (§1) — build passes WITH type-checking; lint clean
- [ ] Env vars set from a secrets manager, values never in the repo (§4; template: `.env.example`)
- [ ] ✅ `prisma/migrations/` baseline `0_init` created and committed (§3,
  `docs/database/prompt19-baseline.md`) — deploys use `db:migrate:deploy`;
  `db:push` never used against prod (guarded)
- [ ] Caddy TLS + `NEXTAUTH_URL` origin match (§5)
- [ ] Health probe wired into watchdog/monitor (§6 — `GET /api/health`)
- [ ] First-run checklist §7 steps 1–6 all green
- [ ] Backup schedule live and first restore drill passed
  (`docs/deployment/backup-restore-plan.md` — the file-restore path was
  drill-verified on a clone in Prompt 19)
- [ ] Launch-copy checklist reviewed (`docs/marketing/launch-readiness.md` §3)
