# Environment Variables Reference

**Document ID:** DEPLOY-ENV-VARS-v1
**Round:** Prompt 19 §24 (template established Prompt 18, expanded Prompt 19)
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
| `EMAIL_FROM` | Optional (reserved) | No | From-address for auth emails |
| `EMAIL_SERVER_HOST` | Optional (reserved) | No | SMTP host for the future email adapter |
| `EMAIL_SERVER_PORT` | Optional (reserved) | No | SMTP port |
| `EMAIL_SERVER_USER` | Optional (reserved) | No (credential when set) | SMTP username |
| `EMAIL_SERVER_PASSWORD` | Optional (reserved) | **Yes** | SMTP password |
| `NODE_ENV` | Set by runtime | No | Gates dev fallbacks; **hard-blocks dangerous DB commands in production** via `scripts/db-guard.cjs` |

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

- **Purpose:** `From:` address for auth emails (password reset). Reserved for the Prompt-18 email abstraction (`src/lib/email/index.ts`); consumed by the future SMTP adapter.
- **Required:** optional until an SMTP adapter is wired.
- **Development behavior:** unused by the console transport (reset links are logged instead of sent).
- **Production behavior:** used once the adapter ships; without a configured transport, password reset returns a **uniform 503** — the product never pretends an email was sent.
- **Secret:** no.

### `EMAIL_SERVER_HOST` / `EMAIL_SERVER_PORT`

- **Purpose:** SMTP host/port for the future email adapter (reserved block, documented in `.env.example`).
- **Required:** optional today. `EMAIL_SERVER_HOST` is the **on/off signal**: production **without** `EMAIL_SERVER_HOST` → password-reset requests return the uniform `503 RESET_DELIVERY_UNAVAILABLE` **before any user lookup** (no enumeration).
- **Development behavior:** unused (console transport).
- **Production behavior:** required once email delivery is activated.
- **Secret:** no (the host/port are infrastructure facts; keep them out of client code regardless).

### `EMAIL_SERVER_USER` / `EMAIL_SERVER_PASSWORD`

- **Purpose:** SMTP credentials for the future email adapter.
- **Required:** optional until the adapter is wired; then required by the SMTP provider.
- **Development behavior:** unused (console transport).
- **Production behavior:** provide via a secrets manager; never in the repo.
- **Secret:** `EMAIL_SERVER_PASSWORD` is **yes**; `EMAIL_SERVER_USER` is a credential when set — treat both as sensitive.

## `NODE_ENV` — the database guard flag (not in `.env.example` on purpose)

`NODE_ENV` is a runtime flag, not a configured secret, but it is load-bearing for database safety:

- `scripts/db-guard.cjs` reads it and **hard-blocks** `db:push`, `db:reset`, and `db:migrate` (exit 1, exact messages in `docs/database/migration-workflow.md` §1) whenever it equals `production`.
- The production start command (`bun run start`) sets `NODE_ENV=production` itself.
- It also disables the dev-only `NEXTAUTH_SECRET` fallback and selects the dev console email transport.

## Rules (unchanged by Prompt 19)

1. Real `.env` files are never committed (`.gitignore` `.env*`); only the placeholder `.env.example` is version-controlled.
2. New variables must be added to `.env.example` **and** to this document at the same time.
3. Values are never quoted in docs, logs, tickets, or chat — names only.
4. Production secrets come from a secrets manager, not from the repo.
