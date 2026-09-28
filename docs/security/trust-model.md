# Trust Model — AI Business Copilot

**Document ID:** SEC-TRUST-v2
**Round:** r27-docs-c · Prompt 29 update (operational trust additions, §10)
**Spec refs:** Prompt-spec §199 (trust model); §147/§238/§240 (internal-only placement)
**Basis:** `src/lib/tenant.ts`, `src/lib/rbac.ts`, `src/lib/auth.ts`, `src/lib/auth-security.ts`, `src/lib/ai/provider.ts`, `src/lib/ai/snapshot.ts`, `src/lib/audit.ts`, `src/lib/payments/*`, `src/lib/email/*`, `src/lib/observability/*`, `prisma/schema.prisma`, `next.config.ts`.
**Companion docs:** `docs/security/authentication-current-state.md`, `docs/security/data-classification.md`, `docs/security/account-lifecycle.md`, `docs/ai/ai-cost-architecture.md`.

> **INTERNAL DOCUMENT.** This file lives in `docs/security/` and is never linked
> from any public page (public pages are `/privacy`, `/terms`, `/ai-data-use`,
> `/cookies`). It describes engineering reality for operators and auditors, not
> marketing promises.

---

## 1. What this document is

A plain statement of the boundaries the product actually enforces, the
mechanisms behind each boundary, and — equally important — the claims we
deliberately do **not** make. Every section ends in observable code, not intent.

## 2. Tenant isolation

- **Tenancy is per-query, never per-token.** The active business is not a JWT
  claim. Every business-scoped API call resolves `ctx.businessId` from the
  server-side session → user → membership chain (`src/lib/tenant.ts`
  `getAuthContext`); the client-sent business id is used only as a lookup key
  that must match a live `BusinessMember` row, **never** as an authorization
  decision.
- **Every Prisma query filters by `businessId`** after the membership check
  (tenant law A01/A02). There is no query path that returns another tenant's
  rows; cross-tenant reads would require a code change, not a crafted request.
- **Roles live on the membership, not the user.** The same account can be
  OWNER of one business and VIEWER of another; each request uses the role of
  the membership it just verified.
- **Invites are one-time, expiring, and role-preset.** `BusinessInvite.token`
  is a 48-char opaque random value; acceptance consumes it, grants only the
  pre-set role, can never mint OWNER, and is rate-limited (10 / 5 min).
  Revocation is explicit (`revokedAt`).
- **Chat transcripts are double-scoped**: `ChatSession` rows are keyed by
  both `businessId` and `userId`; a member can only ever read their own
  conversations inside their own business.

## 3. Authentication

- **NextAuth v4 Credentials + JWT strategy**, `maxAge` 30 days; the JWT
  carries `sub` and `sv` (session version) — nothing more.
- **`User.sessionVersion` is the invalidation lever.** Password change,
  password reset, and account deletion all bump it; two server checkpoints
  enforce it — `getAuthContext` (all business APIs) and `assertFreshSession`
  (account-scoped APIs: `/api/v1/me`, password change). A stale token fails
  on its next use with `401 SESSION_INVALIDATED`.
- **bcrypt, cost 12**, at every write site; hashes are never returned by any
  API and never enter audit metadata.
- **Rate limits** (in-memory, per-process): login 10/5 min per email+IP,
  register 10/15 min per IP, password-change 10/15 min, reset request
  5/15 min per IP and 3/hour per email, reset confirm per-IP and per-token,
  account deletion 5/15 min. Full table: `docs/security/authentication-current-state.md` §4.
- **Password reset stores only a SHA-256 hash**
  of a single-use 30-minute
  token; `requestedIp`/`userAgent` are recorded for after-the-fact review.
  Email delivery: a real SMTP adapter exists (Prompt 29, behind the same
  `EmailProvider` seam); **production stays NOT_CONFIGURED until the operator
  supplies valid settings** — it still fails closed with the uniform
  `503 RESET_DELIVERY_UNAVAILABLE` (no fake readiness), and the reset token
  is persisted ONLY after successful delivery (send-before-persist, §13 of
  the reset doc).
- **Account deletion** requires password + typed `DELETE` + a fresh-session
  gate, is blocked with `409 OWNED_BUSINESS_BLOCKED` while the user owns a
  business, and writes platform-level audit `auth.account_deleted`.

## 4. Authorization (RBAC matrix)

Server-side matrix in `src/lib/rbac.ts`; the frontend never gates anything on
its own. Product copy speaks of "member roles"; the code defines **six**:

| Permission | OWNER | ADMIN | MANAGER | STAFF | ACCOUNTANT | VIEWER |
|---|---|---|---|---|---|---|
| `data:read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `data:write` | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `settings:read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `settings:manage` | ✓ | ✓ | — | — | — | — |
| `members:read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `members:manage` | ✓ | ✓ | — | — | — | — |
| `audit:read` | ✓ | ✓ | — | — | ✓ | — |
| `copilot:use` | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `finance:manage` | ✓ | ✓ | ✓ | — | ✓ | — |
| `business:delete` | ✓ | — | — | — | — | — |

Notes: role rank (`OWNER 60 → VIEWER 10`) gates privilege escalation — you
cannot grant a role at or above your own; `business:delete` is OWNER-only by
construction (ADMIN explicitly omits it); VIEWER is read-only and excluded
from the copilot.

## 5. AI provider boundary

- **One seam.** `src/lib/ai/provider.ts` is the only file allowed to import
  the AI SDK (`server-only`); no route, component, or client bundle touches a
  provider directly. Swapping vendors means editing this file alone.
- **What crosses it:** the system prompt (rules + business name/currency/
  timezone), the user's question with conversation turns, and the grounding
  snapshot built by `src/lib/ai/snapshot.ts` — an **explicit DTO** (KPI
  display strings, daily timeline, top products, expense categories,
  outstanding invoices/bills with counterparty names, low-stock items,
  recent payments with user notes).
- **What can never cross it:** password hashes, reset/session tokens, provider
  keys, payment secrets, raw DB objects, AI-cost rates or `AiCostRecord` data,
  platform audit metadata, operator notes. The snapshot is assembled from
  explicit `select` lists, so a new DB column cannot leak by accident.
- **What comes back:** response text plus normalized usage metadata
  (tokens, provider-reported model or `UNKNOWN` — never invented).
- **Failure path:** failed AI requests are never persisted to chat history
  (client-local only, `ChatMessage.failed` stays unsynced).
- Cost governance (`assertAiCostGuard`) sits at this boundary in both copilot
  routes; it is default-DISABLED, fail-open, and never blocks on UNKNOWN cost
  (see `docs/ai/ai-cost-governance.md`).

## 6. Payment boundary

- **Tenant finance ≠ platform billing.** Sales, expenses, payments, and
  receivables are the tenant's own books (`Sale`, `Expense`, `Payment`).
  Platform billing (plans, subscriptions, checkout, provider cost) lives in
  separate models (`Subscription`, `CheckoutSession`, `PaymentTransaction`,
  `AiCostRecord`) — see `docs/billing/platform-billing-vs-business-finance.md`.
- The payment provider adapter is confined to `src/lib/payments/*` behind the
  `PaymentProvider` interface; merchant credentials are environment-only and
  server-only. No live payment processing is active today (mock/sandbox
  readiness only).
- AI provider **cost** data is platform-internal commercial data: it never
  enters copilot context, tenant APIs, or tenant exports, and is not visible
  to any tenant-facing route (none exists).

## 7. Audit

- Single sanctioned writer: `audit()` in `src/lib/audit.ts` — actor, action,
  entity, before/after JSON, IP, user-agent. Append-only; no update/delete
  endpoints exist. `businessId: null` marks **platform-level** events
  (`auth.account_deleted`, password-reset lifecycle).
- **Visibility split:** tenant audit view and business exports filter by
  `ctx.businessId`, so platform-level rows are invisible in-product by design
  and remain for operator review via direct DB access. Audit rows cascade with
  business deletion (tenant-level retention); platform-level rows survive the
  actor via `onDelete: SetNull` on `actorId`.
- Exports are permission-gated (`settings:manage`), audited, and sanitized:
  the business JSON backup excludes password hashes, provider secrets, and
  payment transactions; CSV exports pass the OWASP formula-injection guard
  (`src/lib/csv.ts`).

## 8. Data lifecycle

- **Deletion cascades (tenant-side):** deleting a business cascades members'
  business-scoped data including `ChatSession`/`ChatMessage`, invites, and
  usage events tied to the business. Deleting a user account cascades their
  memberships and transcripts.
- **Retained internal records:** `AiCostRecord` is deliberately **not**
  FK-bound to `Business` (plain `businessId` string) so platform cost history
  survives business deletion — an internal-retention-by-design decision
  (`docs/ai/ai-cost-architecture.md`). Platform-level audit events persist
  through account deletion via `SetNull`.
- Financial rows use soft delete (`deletedAt`); no purge job exists — rows
  persist until business deletion.

## 9. Operational trust additions (Prompt 29)

Boundaries introduced by the Prompt 29 reliability/observability work, each
ending in observable code:

- **SMTP credentials are server-only and never logged.**
  `EMAIL_SERVER_PASSWORD` is parsed in `src/lib/email/config.ts`, passed to
  nodemailer in-process, and NEVER returned by any status/report/DTO/audit —
  and even if code tried, the structured logger redacts
  `email_server_password`-shaped keys by construction (§9/§33).
- **Backups are the most sensitive artifact.** A database backup contains
  password hashes AND session data — it must be stored encrypted / at-rest
  protected, never web-served, never committed, and copied offsite (manual
  operator duty) under encryption. **APPLICATION-LEVEL BACKUP ENCRYPTION NOT
  IMPLEMENTED** (§59 — verbatim): the app does not encrypt backup artifacts;
  the operator owns at-rest/off-host protection (§60).
- **Observability redacts secrets by construction.** Redaction is enforced
  inside the logger (recursive key rules, oversized values DROPPED not
  sliced, bounded depth/size) — not delegated to call-site discipline
  (`docs/security/observability-and-logging.md` §4). Stack traces are absent
  from production logs unless `SECURE_SERVER_DIAGNOSTICS=true` is set
  deliberately (§28).
- **The readiness endpoint is public-safe by construction.**
  `GET /api/ready` (and `publicReadinessDTO`) exposes overall
  ready/degraded/blocked + per-component status words + version ONLY — no
  migration names, no counts, no file paths, no backup names/timestamps, no
  provider model names, no AI cost figures, no SMTP details (§42/§93/§172).
  Detailed diagnostics stay in the operator-only Platform System view.

## 10. Explicit non-claims

We do **not** claim:

1. **No full CSP.** Only `frame-ancestors 'none'` is configured
   (`next.config.ts`, Prompt 29 §98) alongside `X-Frame-Options: DENY`,
   `nosniff`, `Referrer-Policy`, `Permissions-Policy`; HSTS only when
   `PUBLIC_BASE_URL` is https. A full script/style CSP is future hardening —
   not claimed today.
2. **No encryption-at-rest claim.** SQLite storage is not field-level
   encrypted; nothing in this repo asserts otherwise. Backup artifacts are
   likewise unencrypted at the application level (§9 above).
3. **No transport guarantee.** HTTPS depends on hosting/deployment config
   (`PUBLIC_BASE_URL` https-flag is surfaced as readiness signal only); the
   application itself makes no transport promise.
4. **No compliance certification** (no GDPR/CCPA assessment, no SOC 2, no
   penetration test), no bug bounty, no SLA, no 24/7 support promise.
5. **No multi-node hardening.** Single-node SQLite; in-memory rate limiter
   per process; limits multiply with instances.

## Current state (honest)

- Enforced today: per-query tenancy, six-role RBAC with rank hierarchy,
  sessionVersion invalidation, rate limits, append-only audit, single AI seam
  with structural context minimization, payment/AI-cost separation,
  request-ID correlation + redacted structured logging, fail-fast production
  configuration gate, backup/verify/drill tooling with production-restore
  refusal (all Prompt 29 unless noted).
- Gaps and dependencies: full CSP is future hardening (frame-ancestors only);
  transport and at-rest protections are deployment concerns outside this
  repo; backup offsite copies and encryption are manual operator duties
  (application-level backup encryption NOT IMPLEMENTED); production email
  stays NOT_CONFIGURED until an operator supplies valid SMTP settings (fails
  closed) and live payments are not configured (both fail closed); rate
  limiting is in-memory, process-local only; legal/compliance review
  outstanding (see `docs/audit/production-monetization-baseline.md`).
- This model is a snapshot of the code as of the Prompt 29 round; any
  boundary change must update this document in the same round.
