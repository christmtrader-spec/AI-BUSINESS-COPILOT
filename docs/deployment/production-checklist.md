# Production Deployment Checklist (AI Business Copilot)

**Document ID:** DEPLOY-CHECKLIST-v1.0
**Phase:** Prompt 17 (deployment readiness)
**Stack:** Next.js 16 App Router standalone · Prisma + SQLite (`db/custom.db`) · NextAuth v4 · Caddy reverse proxy
**Companion:** `docs/deployment/backup-restore-plan.md`

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
- ⚠️ `next.config.ts:6-8` sets `typescript.ignoreBuildErrors: true` — the build
  will NOT fail on type errors. Run `bun run lint` (`package.json:9`) and fix
  issues manually before shipping.

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

## 3. Database setup (Prisma) — READ THE WARNING

Datasource is SQLite via `DATABASE_URL` (`prisma/schema.prisma:9-12`); the
production file is `db/custom.db` (TDR §1, `docs/TECH-DECISION-RECORD.md:20`).

1. Set `DATABASE_URL` (see §4) so Prisma resolves the production db file.
2. Run `bun run db:generate` (`package.json:11`) to produce the client for the
   standalone bundle's expected environment (verify the generated client is
   present in the deployed tree; standalone bundles include it via node_modules
   tracing — verify on first deploy).
3. **MIGRATION BASELINE — required before first production start:**

   > ⚠️ **The project uses `prisma db push --accept-data-loss` in development**
   > (`package.json:10`, script `db:push`). `db push` **diffs and mutates the
   > database directly — it is NOT migration-safe**: it can drop/recreate
   > tables/columns without history, which is unacceptable for production data.
   > There is **no `prisma/migrations/` history in this repository today**.

   Required action (one-time, before prod):
   ```bash
   bun run db:migrate      # = prisma migrate dev (package.json:12)
   # when prompted, choose "init/create a new baseline migration"
   # commit prisma/migrations/ to the repository
   ```
   Production schema changes thereafter use `prisma migrate deploy` against a
   backed-up database (see `docs/deployment/backup-restore-plan.md` §3
   "pre-upgrade backup"). `db:push` is banned against any real dataset.

## 4. Required environment variables

`.env` currently contains **exactly these three keys** (names verified;
values never documented here):

| Variable | Mandatory | Purpose | Notes |
|---|---|---|---|
| `DATABASE_URL` | ✅ | Prisma/SQLite connection (`file:../db/custom.db` shape — TDR §5, `docs/TECH-DECISION-RECORD.md:131`) | Points the app at the db file; wrong value = app silently uses a different/empty database |
| `NEXTAUTH_SECRET` | ✅ **prod throws without it** | NextAuth v4 JWT/JWE signing + encryption key (`src/lib/auth.ts:24-28`; production fails fast via next-auth's `NO_SECRET`) | Dev has a stable literal fallback (`auth.ts:26-28`) that is **disabled in production**; generate with `openssl rand -hex 32` (TDR §5, `:135`); rotating invalidates all sessions (`:132`) |
| `NEXTAUTH_URL` | ✅ | Canonical origin NextAuth issues cookies against (TDR §5, `:133`) | Must match the externally reachable origin (scheme + host) or CSRF/session cookies fail behind the proxy |

**No other secrets exist** in this project today: the AI provider SDK is
keyed through the platform, no SMTP, no payment provider (billing is design
only — `docs/billing/billing-architecture.md`), no third-party API keys.
When one is added, it must be documented here (never committed, never quoted).

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

- **Health endpoint (EXISTS, static):** `GET /api` returns a JSON hello
  (`src/app/api/route.ts:3-5`). It is cheap and unauthenticated — use it for
  liveness probes: `curl -fsS http://localhost:3000/api`.
- Note it does not touch the database; for a deeper readiness signal use the
  login page (`GET /`) plus the app itself. (A db-ping health route is a
  future enhancement — do not assume it exists.)
- **Startup watchdog:** the sandbox pattern `scripts/keep-dev-up.cjs`
  (`scripts/keep-dev-up.cjs:8-20` probes `http://localhost:3000/` expecting
  HTTP 200; `:28-38` re-spawns `bun run dev` detached) demonstrates the
  expected shape. For production, adapt the same probe/respawn idea to the
  §2 start command (and your process manager) — the script as written starts
  the DEV server and must not be run as-is in production.

## 7. First-run checklist (new deployment)

Execute in order; do not skip verification steps:

| # | Step | Verify |
|---|---|---|
| 1 | Env vars set (§4), Caddy up, app started with §2 command | `curl -fsS localhost:3000/api` → JSON |
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

- [ ] Build artifacts verified (§1), lint clean
- [ ] Env vars set from a secrets manager, values never in the repo (§4)
- [ ] `prisma/migrations/` baseline created and committed (§3) — `db:push` never used against prod
- [ ] Caddy TLS + `NEXTAUTH_URL` origin match (§5)
- [ ] Health probe wired into watchdog/monitor (§6)
- [ ] First-run checklist §7 steps 1–6 all green
- [ ] Backup schedule live and first restore drill passed
  (`docs/deployment/backup-restore-plan.md`)
- [ ] Launch-copy checklist reviewed (`docs/marketing/launch-readiness.md` §3)
