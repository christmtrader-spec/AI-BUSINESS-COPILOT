# Production & Monetization Readiness — Baseline Audit

**Document ID:** AUDIT-P17-BASELINE
**Round:** Prompt 17 (r18) — Production Readiness + Monetization Readiness Audit
**Scope:** AI-powered business management and financial insight platform (multi-tenant SaaS). This is **not accounting software**; no double-entry ledger, tax, or statutory-reporting claims are made anywhere in the product.
**Sources of truth:** code (authoritative), `package.json`, `prisma/schema.prisma`, `docs/PROJECT-CONSTITUTION.md`, `docs/TECH-DECISION-RECORD.md`, `docs/ARCHITECTURE.md`, plus the 41-route security audit summarized in `docs/audit/security-findings.md`.

---

## A. Current framework

| Layer | Version | Evidence |
|---|---|---|
| Next.js (App Router) | ^16.1.1 | `package.json:62` |
| React | ^19.0.0 | `package.json:67` |
| TypeScript | ^5 (strict; `ignoreBuildErrors: true` in build config — see §S) | `package.json:95`, `next.config.ts:6-8` |
| Tailwind CSS | 4.x + `shadcn/ui` (New York) | `package.json:87,93`, `docs/TECH-DECISION-RECORD.md §1` |
| Validation | zod ^4.0.2 | `package.json:83` |
| ORM | Prisma ^6.11.1 | `package.json:66` |
| Auth | next-auth ^4.24.11 (credentials) | `package.json:63` |
| Runtime | bun (dev/lint/scripts); standalone Node server for prod start | `package.json:6-8` |

## B. Runtime

Single process, single node. Dev: `next dev -p 3000` (`package.json:6`). Prod: `NODE_ENV=production bun .next/standalone/server.js` with `output: "standalone"` (`package.json:8`, `next.config.ts:4`). Database is a single SQLite file (`db/custom.db` via `DATABASE_URL`, `prisma/schema.prisma:9-12`, `docs/TECH-DECISION-RECORD.md §5`). No containers, no workers, no queue.

## C. Frontend architecture

SPA-in-App-Router: a single client route (`src/app/page.tsx`) mounts `AppRoot` (`src/modules/shell/app-root.tsx`) which switches views without URL navigation. Feature modules live in `src/modules/*` (shell, auth, onboarding, dashboard, parties, products, inventory, sales, expenses, payments, balances, reports, copilot, settings, audit, finance-shared) per Constitution A17. State: Zustand for view/UI state + TanStack Query for server cache (TDR D5). i18n: next-intl with `en`/`fa` dictionaries and RTL via logical utilities (`src/i18n/messages/en.ts`, `fa.ts`, Constitution A05/A06). Styling: Tailwind 4 + shadcn/ui; fonts Geist (Latin) / Vazirmatn (Persian, self-hosted) (`src/app/layout.tsx:2-7`, `src/app/globals.css:130-136`).

## D. Backend

Route Handlers only, under `src/app/api/v1/**`; no server actions (`"use server"` absent from `src/` — grep verified), no `middleware.ts` — **every route self-guards**. Request pipeline per route: zod validation (`parseBody`, `src/lib/api-helpers.ts:67-75`) → `getAuthContext` (session→userId→`X-Business-Id` header→DB membership, `src/lib/tenant.ts:38-77`) → `requirePermission` (RBAC matrix, `src/lib/rbac.ts:37-70`) → Prisma query scoped by `businessId` → `audit()` on critical mutations (`src/lib/audit.ts`) → envelope `{ ok, data } | { ok: false, error: { code, message } }` via the `route()` wrapper (never leaks stack traces/DB errors, `src/lib/api-helpers.ts:42-64`).

## E. Database

Prisma 6 + SQLite. Money = `Int` minor units everywhere (A08; `schema.prisma` comments, `src/lib/money.ts`). Financial records (`Customer`, `Supplier`, `Product`, `Sale`, `Expense`) use soft delete (`deletedAt`); `Payment` and `AuditLog` are hard rows. Per-business sequential invoice numbers with `@@unique([businessId, number])` (`schema.prisma:244`). Schema applied via `prisma db push` (`package.json:10`) — **no migrations history** (see scorecard).

## F. Auth provider

NextAuth v4 credentials provider, JWT session strategy, 30-day `maxAge`, bcryptjs comparison, stable `NEXTAUTH_SECRET` (prod throws without it; dev fallback literal documented in `src/lib/auth.ts:18-32`, TDR §5). Login rate limit 10/5min per email+IP (`src/lib/auth.ts:49-56`). No password reset/change endpoint yet; no MFA.

## G. AI provider

`z-ai-web-dev-sdk` is imported only inside `src/lib/ai/provider.ts` behind the `AIProvider` interface, guarded by `import "server-only"` (`provider.ts:1,12`). The copilot grounding snapshot (`src/lib/ai/snapshot.ts`) pre-computes every monetary figure server-side with `formatMoney` and hands the model display **strings** — the model never sees raw minor units and never computes totals (Constitution A11–A13). Copilot is read-only; tools are an explicit allow-list with tenant/role checks.

## H. File/storage

None. No user file uploads exist; `StorageAdapter` is a reserved interface only (A15). CSV exports are generated in-memory on the fly (`src/lib/csv.ts`); backup export/import is JSON over the existing API (`src/lib/backup-schema.ts`).

## I. Tenant model

`User → BusinessMember → Business` (`schema.prisma:18-83`). The active business arrives as an `X-Business-Id` header and is **re-verified per request** against a `BusinessMember` row (`src/lib/tenant.ts:45-56`); `businessId` is never trusted from query/body. `[id]` routes additionally re-check `ctx.businessId === id` (e.g. `members/[memberId]/route.ts:37-39`). All Prisma reads/writes on business-scoped tables filter by `businessId`.

## J. RBAC

Six roles — `OWNER / ADMIN / MANAGER / STAFF / ACCOUNTANT / VIEWER` — with a server-side permission matrix of 10 permissions (`data:read/write`, `settings:read/manage`, `members:read/manage`, `audit:read`, `copilot:use`, `finance:manage`, `business:delete`) plus role ranks (`src/lib/rbac.ts`). OWNER-only: `business:delete`, granting OWNER, import (tightened from `settings:manage`, `businesses/[id]/import/route.ts:62-70`). ADMIN can never touch OWNER rank (`ROLE_RANK` checks). Enforced in every route via `requirePermission` (35 route files call `getAuthContext`).

## K. Financial model

Integer minor units only; all arithmetic through `src/lib/money.ts` (`toMinor` string-math, `statusOf` single source for UNPAID/PARTIAL/PAID). One payments pipeline: every Payment create/reverse updates the denormalized `paidMinor`/`status` on the target Sale/Expense **in the same `$transaction`** (`payments/route.ts`, `payments/[id]/route.ts:35-56`), with reversal lookups filtered by `businessId`. Reports are deterministic aggregates (`src/lib/reports.ts` via `buildReportSummary`).

## L. Testing infra

No unit or e2e framework (no jest/vitest/playwright in `package.json`). Existing: `scripts/e2e-smoke.ts` (HTTP smoke suite: module GETs, minor-unit checks, RBAC negatives, export→import round-trip, copilot SSE contract), `scripts/i18n-audit.ts` (en/fa dictionary completeness), `agent-browser` manual QA (360–1920 px matrix per Constitution §8). **New this round:** `scripts/prompt17-security-check.mjs` — HTTP harness that re-asserts the security fixes from the audit (see `docs/audit/security-findings.md §Regression coverage`).

## M. Deployment assumptions

Single node on port 3000 behind a Caddy gateway (`Caddyfile` at repo root). Standalone output (`next.config.ts:4`). No containers, no CI/CD pipeline, no health endpoint beyond the unauthenticated `GET /api` root (`src/app/api/route.ts`). Documented procedures: `docs/deployment/production-checklist.md`, `docs/deployment/backup-restore-plan.md`.

## N. Environment variables

Names only (never values). Present in `.env`: `DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`. Referenced by code/schema: `DATABASE_URL` (`prisma/schema.prisma:11`), `NEXTAUTH_SECRET` (`src/lib/auth.ts:25`), `NODE_ENV` (dev-fallback gate, `src/lib/auth.ts:26`); `NEXTAUTH_URL` is consumed by NextAuth itself. The AI SDK manages its own credentials outside `.env`. **No `.env.example` exists** — `docs/deployment/production-checklist.md` should carry the canonical list. `NEXTAUTH_SECRET` is mandatory in production (NextAuth `NO_SECRET` throw; TDR §5).

## O. Billing/subscription

None implemented — **by design** (Constitution A16, Rule 05). Architecture is design-only: `docs/billing/billing-architecture.md`. No plan fields, no entitlements code, no payment-processor dependencies.

## P. Payment functionality

The `Payment` model records **internal cash-flow** (money in against sales / money out against expenses, `schema.prisma:288-309`). It is **not** a payment gateway: no card data, no processor integration, no external money movement. A gateway abstraction exists only as design (`docs/billing/billing-architecture.md`).

## Q. Observability

`dev.log`/`server.log` stdout via tee (`package.json:6,8`); `AuditLog` table per mutation (`src/lib/audit.ts`); no metrics, tracing, or health probes. Errors are logged server-side only and mapped to safe envelopes (`src/lib/api-helpers.ts:49`).

## R. Security controls (inventory)

1. Tenant pipeline: session→membership re-verification per request (`src/lib/tenant.ts`).
2. Server-side RBAC matrix + rank hierarchy (`src/lib/rbac.ts`).
3. zod validation at every boundary, including the backup file schema (`src/lib/backup-schema.ts`).
4. bcryptjs password hashing (cost 12 at registration).
5. Rate limits: login 10/5min; register 10/15min/IP; copilot 10/min; copilot sync 60/min; invite-accept 10/5min; payments write 60/min, reversal 30/min; business create 5/hour; invite create 30/hour; export 4/5min; import 4/5min; report export 10/5min (all per-user/business/IP keyed, `src/lib/rate-limit.ts`).
6. Append-only audit trail with IP + user agent (A09).
7. CSV formula-injection guard (`src/lib/csv.ts:15-30`).
8. Backup caps: 25 MB request cap (413) + hard row caps + zod money refinements (`businesses/[id]/import/route.ts:88-91`, `src/lib/backup-schema.ts:190-215`).
9. Chunked copilot streaming with failure recovery (client-side retry + failed-turn stays local, `schema.prisma:347`).

## S. Known limitations

SQLite (single-file, single-writer; theoretical P2002 invoice-number race → 500, serialized in practice); in-memory per-process rate limiter; month-filtered list endpoints load whole per-business tables into memory; no password reset/change or MFA; no email delivery (invites are token links); `audit()` failures are logged, not alerted; member emails visible to `data:read` roles; register returns 409 (email-enumeration tradeoff); client can append `role:"assistant"` lines to its own transcript (non-authoritative — answers recomputed per ask); no middleware (per-route guarding by convention + review); `typescript.ignoreBuildErrors: true` weakens the build gate; no CI; monitoring absent; marketing/legal surfaces incomplete (see scorecard).

---

## 30-category scorecard

Statuses only (no numeric scores). READY / PARTIALLY READY / NOT READY / BLOCKED / NOT APPLICABLE.

| # | Category | Status | Justification |
|---|---|---|---|
| 1 | Application architecture | READY | Modular monolith, Route Handlers + zod pipeline, no server actions; module boundaries hold (`src/modules/*`, `src/lib/*`). |
| 2 | Database integrity | PARTIALLY READY | Money/status invariants enforced in code + backup schema; but SQLite single-file and schema managed by `db push` with no migrations history. |
| 3 | Tenant isolation | READY | Every business route re-verifies membership; `[id]`+`businessId` pair loads; 41-route audit found no leak (see security-findings). |
| 4 | Authentication | PARTIALLY READY | bcrypt + JWT + login rate limit solid; no password reset/change, no MFA. |
| 5 | Authorization | READY | Server-enforced 10-permission matrix, rank hierarchy, OWNER-only gates for delete/import. |
| 6 | Financial correctness | READY | Int minor units, single-writer payments pipeline, `statusOf` derived, backup refinements reject inconsistent money. |
| 7 | Auditability | READY | `AuditLog` on every critical mutation with before/after + IP/UA; note: `audit()` failure is logged, not alerted. |
| 8 | AI safety | READY | Read-only tools, tenant-scoped snapshot with pre-formatted money strings, deterministic calc first, no raw DB access. |
| 9 | API security | READY | zod at all boundaries; central `ApiError`/`route()` mapping; no internals leaked; CSV export guarded. |
| 10 | Rate limiting | PARTIALLY READY | Broad per-key coverage (see §R5) but limiter is in-memory and per-process — resets on restart, not shared across instances. |
| 11 | File security | NOT APPLICABLE | No user file storage or uploads exist (A15 reserved only). |
| 12 | Error handling | READY | Consistent envelope; unknown errors logged server-side; ZodError → 422 with issues. |
| 13 | Logging | PARTIALLY READY | stdout via tee + audit table only; no request IDs, no structured levels. |
| 14 | Monitoring | NOT READY | No metrics, tracing, uptime probes, or alerting of any kind. |
| 15 | Testing | PARTIALLY READY | No CI test framework; HTTP smoke harness (e2e-smoke) + new security-check harness + manual browser QA. |
| 16 | Accessibility | PARTIALLY READY | Landmarks, skip link, aria-sort tables, Radix dialogs; gaps: contrast unverified, chart SVGs lack text alternatives (see accessibility-findings). |
| 17 | Localization | READY | en/fa complete per `scripts/i18n-audit.ts`; RTL first-class. Noted: minor hardcoded EN strings (onboarding stepper, one error splash); no separate marketing landing page. |
| 18 | Responsive UX | READY | agent-browser QA at 360–1920 px, light/dark, LTR/RTL per Constitution §8 matrix. |
| 19 | Data lifecycle | PARTIALLY READY | Business deletion + CSV export exist; no user account deletion or data-rectification path. |
| 20 | Account deletion | NOT READY | Missing entirely — deferred to a future phase (must precede public launch). |
| 21 | Business deletion | READY | OWNER-only, typed confirmation, cascade delete, audited (`businesses/[id]/danger/route.ts`, `businesses/[id]/route.ts`). |
| 22 | Backup/restore | READY | Export→import round-trip; OWNER-only import; 25 MB cap; row caps; zod money refinements. |
| 23 | Subscription architecture | NOT READY | Design-only (`docs/billing/billing-architecture.md`) — intentional per A16. |
| 24 | Payment abstraction | NOT READY | Design-only; current `Payment` is internal cash-flow, not a gateway — intentional. |
| 25 | Entitlements | NOT READY | No plan/entitlement code exists — intentional (design doc only). |
| 26 | Usage tracking | NOT READY | No metering of AI calls or storage — intentional; rate limiting is the only usage control. |
| 27 | Marketing readiness | PARTIALLY READY | Product usable and QA'd; pricing page, landing funnel, and legal copy missing (`docs/marketing/launch-readiness.md`). |
| 28 | Legal/trust | NOT READY | No terms/privacy pages; no GDPR/data-protection assessment performed — required before launch. |
| 29 | Production deployment | PARTIALLY READY | Single-node standalone + Caddy works; no CI/CD, no health endpoint beyond `/api` root, no migration discipline (`db push`). |
| 30 | Disaster recovery | PARTIALLY READY | Manual SQLite file backup procedure documented (`docs/deployment/backup-restore-plan.md`); no automated backups, no restore drill in CI. |

**Bottom line:** the core product (architecture, tenant isolation, RBAC, financial correctness, AI safety, API security) is production-grade for a single-node MVP. Monetization categories (23–26) are intentionally NOT READY (design-only). Public-launch blockers before charging customers: legal/trust pages (28), account deletion (20), monitoring (14), and a real test/CI harness for regressions (15).

> **Note (added Prompt 19):** the section **"Resolution tracking (Prompts 17 → 18 → 19)"** at the end of this document records which findings above have since been resolved or remain open. The original audit text above is preserved verbatim as the historical baseline.

---

## Resolution tracking (Prompts 17 → 18 → 19)

Status vocabulary: RESOLVED · PARTIALLY RESOLVED · NOT RESOLVED · RESOLVED WITH DOCUMENTED LIMITATIONS. Original findings above are preserved verbatim; this section only tracks their evolution.

| # | Original finding (Prompt 17) | Resolution status | Phase resolved | Current state |
|---|---|---|---|---|
| 1 | **Authentication** (scorecard #4): PARTIALLY READY — "no password reset/change, no MFA" | **RESOLVED WITH DOCUMENTED LIMITATIONS** → CURRENT: **AUTHENTICATION BASELINE COMPLETE WITH DOCUMENTED LIMITATIONS** | Prompt 18 | HARDENED in Prompt 18: password change (`POST /api/v1/auth/password-change`), secure password reset (hashed single-use 30-minute tokens, `docs/security/password-recovery.md`), session invalidation via `User.sessionVersion` enforced at both checkpoints, account deletion (`DELETE /api/v1/me`), email abstraction, 4 audit events, new rate limits. Still open (documented, intentional): no MFA, no email verification, no per-device session list; JWT revocation is checkpoint-based, not push-based. |
| 2 | **Database migration discipline** (scorecard #2, §E, #29): schema managed by `db push` with **no migrations history** | **RESOLVED (workflow), PARTIALLY RESOLVED (engine limits)** → CURRENT: **migration-based workflow with documented limitations** | Prompt 19 | Baseline migration `0_init` generated from `prisma/schema.prisma` with **zero drift**, committed, and marked applied on `db/custom.db` (`prisma migrate resolve`, no tables recreated, no rows touched). Guards hard-block `db:push`/`db:reset`/`prisma migrate dev` in production; `db:migrate:deploy` is the sanctioned command; immutability + 11-step change workflow documented (`docs/database/migration-workflow.md`); full record in `docs/database/prompt19-baseline.md`. SQLite single-writer limitations remain by design (`docs/audit/database-production-plan.md`). |
| 3 | **Account deletion** (scorecard #20 NOT READY; #19 data lifecycle PARTIALLY READY): "Missing entirely" | **RESOLVED WITH DOCUMENTED LIMITATIONS** | Prompt 18 | `DELETE /api/v1/me` implemented: password + typed `confirmation: "DELETE"`, session-version freshness, rate limit, ownership guard (any owned business → `409 OWNED_BUSINESS_BLOCKED` — `ownerId` can never dangle), audited hard delete. Data classification A–E and "not recoverable" policy: `docs/security/account-lifecycle.md`. No trash/reactivation by design. |
| 4 | **CSV formula injection** (§R7, listed as control): fixed in the same audit round | **RESOLVED** (in Prompt 17 itself) | Prompt 17 | `src/lib/csv.ts` `csvCell` neutralizes `= + @ \t \r` prefixes and dangerous `-` leads; shared by reports/monthly/client exports; covered by the 30/30 `scripts/prompt17-security-check.mjs` harness. |
| 5 | **Rate-limit coverage gaps** (§R5): several sensitive endpoints had no limits | **PARTIALLY RESOLVED** (coverage yes, shared limiter no) | Prompt 17 (payments 60/min, reversal 30/min, business create 5/hour, invite create 30/hour) + Prompt 18 (password change/reset/deletion limits) | Coverage now spans auth flows, payments, invites, exports/imports. The limiter itself remains **in-memory and per-process** (resets on restart; multiplies with instances) — documented limitation in `docs/audit/rate-limiting.md`, deliberately NOT resolved (needs an ADR for a shared store). |
| 6 | **Build gate weakened** (§A/§S: `typescript.ignoreBuildErrors: true`) | **RESOLVED** | Prompt 18 | `ignoreBuildErrors` removed; `tsconfig` excludes non-app scaffolding; `bunx tsc --noEmit` → 0 errors project-wide; production build passes **with** type-checking. |
| 7 | **Environment variables undocumented / no `.env.example`** (§N: "**No `.env.example` exists**") | **RESOLVED** | Prompt 18 (created) + Prompt 19 (expanded & documented) | `.env.example` exists with 9 placeholder keys (`DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `APP_BASE_URL`, `EMAIL_*` block), version-controlled via the `.gitignore` `!.env.example` exception; canonical reference: `docs/deployment/environment-variables.md`. No real values anywhere. |
| 8 | **Monitoring** (scorecard #14 NOT READY; §M "no health endpoint") | **PARTIALLY RESOLVED** | Prompt 19 | `GET /api/health` implemented: minimal public probe (status ok/degraded, app version, database reachable, migration applied/pending counts), rate-limited 30/min/IP, 15 s cache, zero internal exposure. A full monitoring stack (metrics, alerting, uptime provider) remains **NOT implemented**. |
| 9 | **Disaster recovery** (scorecard #30 PARTIALLY READY: "no restore drill") | **PARTIALLY RESOLVED** | Prompt 19 | Pipeline codified: **backup → checksum → migration → integrity check → smoke test** (`docs/deployment/backup-restore-plan.md` §2.1). The file-restore path was **actually drilled on a clone** 2026-09-23 (integrity ok, 0 FK violations, counts/money match inventory, PrismaClient reads verified — `docs/database/prompt19-baseline.md` §8). Automated backups and off-host shipping remain **NOT implemented** (operator tasks). |
| 10 | **Email delivery absent** (§S "no email delivery (invites are token links)") | **PARTIALLY RESOLVED** | Prompt 18 | `EmailProvider` boundary + dev console transport implemented; reset emails render en/fa; production **without** `EMAIL_SERVER_HOST` returns a uniform 503. The SMTP adapter itself is **pending** — production email delivery does not work yet. |

### Explicitly NOT resolved (unchanged, by design or deferred)

- **Billing/subscription/payment gateway/entitlements/usage tracking** (scorecard #23–26): **NOT implemented — design-only** per `docs/billing/billing-architecture.md` (intentional, A16).
- **Legal/trust pages** (#28), **marketing funnel** (#27), **CI/CD** (#15, #29), **full monitoring/alerting** (#14), **MFA**, **email verification** — not implemented; still pre-launch work.
- **SQLite single-writer / no horizontal scaling** (#2, #10, #29 caveats): unchanged by design — engine triggers documented in `docs/database/migration-workflow.md` §10.
