# Platform Admin Security — Prompt 28

Status: IMPLEMENTED (internal control plane). This document describes what
the platform layer actually does today. It makes no compliance claims and
no promises beyond the implemented behavior.

## 1. Tenant / platform separation (§3)

Two completely separate authority domains:

| Domain | Identity | Roles | Audit |
| --- | --- | --- | --- |
| TENANT | User + BusinessMember | OWNER/ADMIN/MANAGER/STAFF/ACCOUNTANT/VIEWER (`src/lib/rbac.ts`) | `AuditLog` (tenant, business-scoped) |
| PLATFORM | User + PlatformOperator | PLATFORM_SUPER_ADMIN/SUPPORT/BILLING/AI_COST/SECURITY/READONLY (`src/lib/platform/rbac.ts`) | `PlatformAuditLog` (platform-wide) |

- A BUSINESS OWNER is NOT a platform operator. No tenant role grants any
  platform permission, and no platform role grants any tenant permission.
- The two role sets share no identifiers; the platform permission catalog
  (`platform:*`) never collides with tenant permissions (`data:*` etc.).
- Platform audit deliberately has NO business foreign key: entries survive
  business deletion (target ids are plain indexed strings).

## 2. Authentication

- The platform console uses the SAME NextAuth session as the tenant app
  (JWT strategy, `sv` = `User.sessionVersion` stamped at sign-in).
- Every platform request re-derives authorization server-side
  (`getPlatformContext`, `src/lib/platform/auth.ts`):
  session → userId → User row → sessionVersion comparison →
  PlatformOperator row → active check → role + permissions.
- An invalidated session (password change/reset or a security invalidation)
  fails every platform API with `401 SESSION_INVALIDATED`.

## 3. Authorization errors (§12/§86)

| Caller | Result |
| --- | --- |
| Anonymous | `401 PLATFORM_UNAUTHENTICATED` |
| Authenticated user without an operator row | `403 PLATFORM_FORBIDDEN` (no information about the platform layer is leaked) |
| Deactivated operator | `403 PLATFORM_OPERATOR_INACTIVE` |
| Invalidated session | `401 SESSION_INVALIDATED` |
| Operator without the required permission | `403 PLATFORM_PERMISSION_DENIED` |

## 4. Roles and permissions (§4-§6)

Roles: `PLATFORM_SUPER_ADMIN`, `PLATFORM_SUPPORT`, `PLATFORM_BILLING`,
`PLATFORM_AI_COST`, `PLATFORM_SECURITY`, `PLATFORM_READONLY`. The
role → permission matrix lives in `src/lib/platform/rbac.ts` and is the
single source of truth. There is NO wildcard permission. `PLATFORM_READONLY`
holds read permissions only — every mutation permission is absent, and the
server (not the UI) enforces that.

## 5. Role tampering is structurally impossible (§79/§132)

Authorization is derived exclusively from the database (PlatformOperator
row). No request source — body, query, header (`x-platform-role`), cookie
or localStorage — can grant a role or permission. The Prompt 28 static
scanner (`scripts/prompt28-platform-check.mjs`, section J) fails the build
if a route reads a role from client input.

## 6. Reauthentication (§56)

High-risk mutations require the operator's CURRENT PASSWORD, verified
against the existing `User.passwordHash` with bcrypt. There is no second
credential store. Passwords are never logged, never audited, never echoed.
The failure code is `PLATFORM_REAUTH_REQUIRED` (missing) /
`PLATFORM_REAUTH_FAILED` (wrong). Operations requiring reauthentication:
subscription pause/resume, operator plan change, trial operations, payment
reverify, payment investigation, price-book create/activate, AI rate
create/verify/deactivate, AI reconciliation apply, session invalidation,
operator create/role change/activate/deactivate.

## 7. Rate limiting (§57)

Sensitive platform mutations use in-memory sliding-window limits keyed
`platform:<operatorId>:<action>` — deliberately separate from tenant rate
limit keys. Exceeding a limit yields structured `429` errors.

## 8. Audit (§9/§10/§34/§53/§73/§135)

- Every sensitive platform mutation writes a `PlatformAuditLog` row via
  `platformAudit()` (`src/lib/platform/audit.ts`) — inside the domain
  transaction where the architecture allows it (session invalidation,
  operator management, investigation records, anomaly acknowledgment), or
  immediately after the domain mutation commits (billing flows whose
  service already writes the tenant-audit row transactionally).
- Stored fields: operatorId, operatorRole snapshot, action, entityType/
  entityId, targetUserId/targetBusinessId (plain strings — no FK), reason
  (≤500 chars), sanitized before/after JSON, requestId, ip, userAgent.
- Payload sanitization: keys matching password/token/secret/api key/
  credential/prompt/response/signature/database URL patterns are stripped
  recursively; values are truncated; each serialized payload is bounded
  (8,000 chars).
- NEVER recorded: passwords, password hashes, reset/session tokens, API
  keys, merchant secrets, AI provider secrets, full AI prompts or
  responses, payment credentials.
- Failure policy: `platformAudit` never breaks the primary operation; when
  a mutation + audit can be wrapped in one transaction (the default for
  platform-native mutations), an audit failure rolls the mutation back.
  For flows whose domain service owns its own transactional audit
  (billing services), the platform audit row is best-effort with a loud
  server-side error log — the operation itself remains correct and the
  tenant-audit trail (transactional inside the billing service) still
  exists. This is the exact, documented policy (§135).
- Audit RETENTION: CURRENTLY NOT EXPLICITLY CONFIGURED. No automatic
  deletion or archival exists.

## 9. No impersonation (§23)

There is no "login as user", no view-as-user, no act-as-user flow anywhere
in the platform layer. Support works through controlled metadata only:
business/user detail views and the session-invalidation tool. The static
scanner fails on impersonation-shaped endpoints.

## 10. Bootstrap (§61/§62)

The ONLY way to create the first operator is the offline CLI:

```
bun scripts/platform-operator.ts list
bun scripts/platform-operator.ts bootstrap --email <email> --role <PLATFORM_ROLE> [--yes]
bun scripts/platform-operator.ts set-role|activate|deactivate --email <email> ...
```

- Requires an EXISTING user, a valid platform role, and explicit
  confirmation (interactive `YES` or `--yes`).
- There is no default admin, no hard-coded password, no default secret,
  and no automatic super-admin creation at startup. There is no public
  HTTP bootstrap route.

## 11. Last-super-admin protection (§55)

Deactivating or demoting the last ACTIVE super admin is rejected
server-side with `409 PLATFORM_LAST_ADMIN_PROTECTED` (API and CLI both
enforce it). The platform can never lock itself out of operator management.

## 12. Secret handling (§84/§85)

- Platform APIs and UI never serialize: passwordHash, tokens, provider
  credentials, merchant secrets, `DATABASE_URL`, `NEXTAUTH_SECRET`.
- The system view reports STATUSES only (READY / NOT_CONFIGURED / BLOCKED /
  DISABLED). `process.env` is never dumped wholesale.
- Responses use explicit DTO allowlists (`src/lib/platform/serializers.ts`);
  raw Prisma objects are never returned to operator clients (§37/§70).

## 13. Risk register (§126)

| Risk | Mitigation in place |
| --- | --- |
| Operator privilege escalation | Server-derived roles; permission catalog without wildcards; mutation gates per permission; static scan |
| Operator account takeover | Session-version invalidation tool; reauthentication on high-risk ops; rate limiting; no impersonation |
| Audit tampering | Audit rows are append-oriented (no update/delete paths exist in code); operator role snapshotted; tenant audit separate |
| Manual payment abuse | Provider remains authoritative; no result-setting endpoint exists; reverify + investigation only; static scan for bypass endpoints |
| Pricing misconfiguration | Books created INACTIVE; activation validates rows/currency/window/overlap; amounts immutable; audited; reversible only via another version |
| AI rate misconfiguration | PRODUCTION rates require sourceReference + verifiedBy with server-stamped verifiedAt; TEST/PRODUCTION separated; deactivation never deletion |
| Support overexposure | READONLY role; per-permission gating; read scopes separated; cost values restricted to ai-cost roles |

## 14. Deletion interactions (§8/§121)

- Deleting a User CASCADES the PlatformOperator row — no orphaned
  privileged access can survive account deletion.
- An operator who owns a business follows the NORMAL owner deletion rules
  (business deletion requires the standard owner flow). There is no hidden
  deletion bypass.
- Deactivating an operator never touches the user's tenant memberships.
