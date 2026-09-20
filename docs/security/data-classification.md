# Data Classification — AI Business Copilot

**Document ID:** SEC-DATACLASS-v1
**Round:** Prompt 17 (r18)
**Basis:** `prisma/schema.prisma` (storage truth), the 41-route audit (`docs/audit/security-findings.md`), and route-level grep of every place each field can be returned.

> **No legal-compliance claim.** No GDPR, CCPA, or any other data-protection assessment has been performed. This document is an engineering classification only; it does not assert that handling described here satisfies any regulation. Legal review is a pre-launch requirement (scorecard #28 in `docs/audit/production-monetization-baseline.md`).

---

## 1. Tier model

| Tier | Definition | Examples in this product |
|---|---|---|
| PUBLIC | Safe to expose without authentication | Marketing/landing strings, app name, `GET /api` health message |
| INTERNAL | Aggregated/derived data; harmful only in aggregate or to competitors | Dashboard KPIs, report summaries, copilot grounding snapshots |
| SENSITIVE | Business records and personal data; disclosure harms a tenant or person | Financial records, party PII, audit trail (IPs, user agents), transcripts |
| HIGHLY SENSITIVE | Credentials, secrets, bearer tokens | Password hashes, session JWTs, invite tokens, `NEXTAUTH_SECRET` |

## 2. PUBLIC

| Data | Storage | Exposure path | Retention | Controls |
|---|---|---|---|---|
| App name, tagline, sign-in copy (en/fa) | i18n dictionaries (`src/i18n/messages/en.ts`, `fa.ts`) | Rendered on the signed-out root view; no API returns business data pre-auth | n/a | None needed; no PII |
| Health message | — (static) | `GET /api` returns a static JSON message (`src/app/api/route.ts`) | n/a | No auth by design; leaks nothing |

No business, user, or usage data is returned without a valid session.

## 3. INTERNAL (aggregate metrics)

| Data | Storage (source tables) | Exposure path → roles | Retention | Protection controls |
|---|---|---|---|---|
| Dashboard KPIs, report summaries, monthly series | Derived from `Sale`, `SaleItem`, `Expense`, `Payment`, `Product` | `GET /api/v1/reports/summary`, `reports/monthly`, `reports/monthly/[month]`, dashboard queries → any member with `data:read` (all 6 roles) | Derived on request; not stored | Tenant pipeline (`src/lib/tenant.ts`); zod on query params; rate limit on report export (10/5min/user) |
| Copilot grounding snapshot | Same sources, computed per ask (`src/lib/ai/snapshot.ts`) | `POST /api/v1/copilot`, `/copilot/stream` → `copilot:use` roles (VIEWER excluded) | Not persisted as such; Q&A transcript persisted per user (see §4) | Money pre-formatted server-side; counts + provenance chips; rate limit 10/min; read-only tools |

Aggregates reveal the same figures as the underlying Sensitive rows but only within the tenant boundary — the API never serves aggregates cross-tenant.

## 4. SENSITIVE

| Data | Storage (Prisma model / table) | Exposure path → roles | Retention | Protection controls |
|---|---|---|---|---|
| Sales invoices + line items (amounts, notes) | `Sale`, `SaleItem` | `sales`, `sales/[id]`, payments/receivables views, reports, export → `data:read` roles; writes → `data:write` | Soft delete (`deletedAt`) — retained indefinitely | Tenant pipeline; zod; audit on mutations; CSV formula guard on export; `@@unique([businessId, number])` |
| Expenses | `Expense` | `expenses`, `expenses/[id]`, payables, reports, export → same roles | Soft delete | Same as above |
| Payments (cash in/out) | `Payment` | `payments` list/POST, `payments/[id]` DELETE → `finance:manage` (OWNER/ADMIN/MANAGER/ACCOUNTANT) | Hard rows; deletion = reversal pipeline (audited, rate-limited 30/min) | Single-writer `$transaction` updates `paidMinor`/`status`; reversal lookup filtered by `businessId` |
| Inventory (stock, prices, adjustments) | `Product`, `InventoryAdjustment` | `products`, `products/[id]`, `products/[id]/stock`, `inventory/adjustments` → `data:read`/`data:write` | Products soft delete; adjustments hard | Tenant pipeline; audit on adjustments (actor recorded) |
| Customer/supplier PII: name, phone, email, address, note | `Customer`, `Supplier` | `customers`, `suppliers` (+`[id]`) → `data:read` roles; CSV export → `settings:manage` (OWNER/ADMIN) | Soft delete | Tenant pipeline; zod max-lengths; formula-injection guard covers PII columns in exports |
| Member identities (name, email, role) | `User` (via `BusinessMember`) | `businesses/[id]/members` GET → `members:read` (documented LOW: visible to all `data:read`-adjacent roles) | Until member removal or business deletion | Rank hierarchy on role changes; OWNER row protected (`OWNER_TRANSFER_REQUIRED`) |
| Audit trail incl. actor, IP, user agent, before/after JSON | `AuditLog` | `GET /api/v1/audit` → `audit:read` (OWNER/ADMIN/ACCOUNTANT) | Indefinite; cascades with business | Write-only via `audit()` helper; no update/delete endpoints exist |
| Copilot transcripts (user questions, AI answers, citations) | `ChatSession`, `ChatMessage` | `copilot/sessions*` → the owning user only (`userId`-scoped; per `(businessId, userId)`) | Until session/user/business deletion | Owner-scoped by design; content capped 8000 chars; assistant lines non-authoritative (documented LOW) |
| Invite metadata (role, expiry, creator, acceptor) | `BusinessInvite` | `businesses/[id]/invites` → `members:manage`; token itself is Highly Sensitive (§5) | `expiresAt` + `revokedAt`; accepted invites retain linkage | One-time token; OWNER ungrantable; accept rate-limited 10/5min |

## 5. HIGHLY SENSITIVE

| Data | Storage | Exposure path | Retention | Protection controls |
|---|---|---|---|---|
| Password hashes | `User.passwordHash` (bcryptjs, cost 12 at registration) | **Never returned by any API.** Used only inside `authorize()` for `bcrypt.compare` (`src/lib/auth.ts:61`) | Until user deletion | bcrypt; no password change/reset endpoint yet (documented LOW); login rate-limited 10/5min per email+IP |
| Session JWTs | httpOnly NextAuth cookie (`next-auth.session-token`), 30-day `maxAge` | Carried on every request; `/api/auth/session` returns only `{ id, email, name }` — never the token itself | 30 days or logout | Signed/encrypted with `NEXTAUTH_SECRET`; membership never trusted from the token (re-verified per request, `src/lib/tenant.ts:50-56`) |
| Invite tokens | `BusinessInvite.token` — `randomBytes(36).toString("base64url")` (48 chars, `businesses/[id]/invites/route.ts:106`) | Returned to `members:manage` callers when minting/listing invites (by design: links are shared manually); consumable once via `POST /api/v1/invites/[token]` | One-time use; `expiresAt` bounded | Opaque + unique-indexed; grants only the pre-set role; OWNER ungrantable; accept rate-limited |
| `NEXTAUTH_SECRET` | `.env` (server-only) | Never in any response, repo file, or client bundle; consumed by NextAuth only | Until rotation | Rotation invalidates all sessions (TDR §5); prod fails fast if missing (`src/lib/auth.ts:24-28`); stable dev fallback is dev-gated by `NODE_ENV` |

## 6. Cross-cutting protection controls

1. Tenant pipeline: session → userId → `X-Business-Id` → DB membership → role on every business route (`src/lib/tenant.ts`).
2. Server-side RBAC (10 permissions, rank hierarchy, `src/lib/rbac.ts`) — frontend hiding is never relied upon.
3. zod at every boundary, including the restore-file schema with hard row caps (`src/lib/backup-schema.ts`).
4. Prisma-only data access (parameterized; no raw string SQL anywhere in `src/`).
5. Rate limits on auth, copilot, payments, invites, business creation, export/import (see security-findings §3a).
6. Export/import gated at `settings:manage` + OWNER-only import; 25 MB cap (413).
7. CSV formula-injection guard (`src/lib/csv.ts`) protecting anyone opening exported Sensitive data.
8. Append-only `AuditLog` with IP/user-agent for every critical mutation.

## 7. Retention & deletion posture (summary)

- Financial + party rows: soft delete only; **no purge job exists** — rows persist until business deletion (cascade).
- `AuditLog`: never edited or exposed for deletion; retained for business lifetime.
- User account deletion: **not implemented** (scorecard #20) — a user's rows (memberships, transcripts, audit actor refs) persist; this is a known pre-launch gap, not a compliance claim in either direction.
- Invites: expire and revoke; accepted-invite linkage persists for auditability.
