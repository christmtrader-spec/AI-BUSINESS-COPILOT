# Global Search Security (Prompt 33)

Status: IMPLEMENTED + TESTED (76/76 E2E, 64/64 unit, 67/67 static scan).

The search subsystem is a **read-only discovery layer**. It is never an
authority layer and can never become a data-exfiltration shortcut beyond what
the module pages already expose.

## 1. Authentication and membership verification

- `GET /api/v1/search` requires a valid session (`getAuthContext`): 401 when
  unauthenticated, 400 when no business context header is present, 403 when
  the session has NO membership row for the requested business.
- Session-version and per-device session-registry checks run inside
  `getAuthContext` exactly as on every other tenant API — an invalidated
  session cannot search.
- The business scope ALWAYS comes from the server-verified membership, never
  from the client: `req.query.businessId`, `body.businessId`,
  `cookie.businessId` are never read. The route reads exactly three query
  params: `q`, `types`, `limit` (static-scan enforced).

## 2. RBAC

- Required permission: `data:read` (`requirePermission(ctx, "data:read")`).
- In the current RBAC matrix every role (OWNER/ADMIN/MANAGER/STAFF/
  ACCOUNTANT/VIEWER) holds `data:read`; a 403 on search therefore comes from
  missing membership, not from role. The matrix was NOT changed for search.

## 3. Tenant isolation (absolute)

- Every entity WHERE clause contains `businessId: ctx.businessId`
  (server-derived). Verified per query block by
  `scripts/search-static-scan.mjs` and per response by the E2E harness
  (two businesses, cross-probes in both directions).
- Client-supplied identity params (`userId`, `tenantId`, `ownerId`,
  `businessId`) are ignored — harness-proven (`?businessId=<other>` cannot
  cross tenants).

## 4. Soft-delete rules

- `deletedAt: null` is mandatory for Customer, Supplier, Product, Sale,
  Expense (static-scan enforced per query block).
- Payment has no soft delete; it is scoped by `businessId` only.
- Inactive products are NOT deleted: `isActive=false` stays searchable and is
  marked `INACTIVE` (inactive ≠ deleted; documented in global-search.md §2).

## 5. Data minimization (explicit DTO)

Results never serialize Prisma rows. The item shape is exactly:
`{ id, type, title, subtitle, destination, status, date, direction, method }`
— enforced by the E2E harness (exact key set). Never present:

- password hashes, MFA secrets, recovery codes, reset/verification tokens,
  session records, security-event internals, IP/User-Agent
- AI cost tables (`AiCostRate`/`AiCostRecord`/`AiCostAnomaly`), usage event
  internals, provider/model rates
- platform tables (`PlatformOperator`, `PlatformAuditLog`), commercial
  analytics (`CommercialEvent`), checkout sessions, platform
  `PaymentTransaction`, webhook data, gateway/provider metadata
- raw import/export storage keys, audit before/after JSON
- amounts/prices of any kind (no `amountMinor`, `costPriceMinor`, …)
- notes and addresses as returned text (they are only matchable fields;
  arbitrary note content is never surfaced by v1 global search)

The destination is a closed vocabulary (`customers…payments`) — the server
can never return arbitrary URLs, and the client maps destinations to views
through one helper (no `javascript:`/`data:`/HTML injection surface).

## 6. Forbidden domains (separation)

- Audit search: OUT OF SCOPE (the Audit page remains the audit surface).
- Platform search: OUT OF SCOPE.
- Cross-business search: OUT OF SCOPE.
- AI Copilot chat contents: NOT searched.
- Notifications (Prompt 32): NOT searched; no second notification-search
  implementation.
- Export/import jobs: NOT searched.

## 7. No query logging

Search strings may contain emails, phone numbers, invoice numbers and private
business terms. Therefore neither the raw `q`, nor `normalizedQuery`, nor the
variants, nor result contents are ever logged. The only observability signal
is the fixed-vocabulary event `search.executed` (DEBUG level) with
counts/duration only (`resultCount`, `groupCount`, `truncated`,
`durationMs`). Search history is not stored anywhere; no user profiling.

## 8. Rate limiting

- Dedicated limiter: **30 requests / 60 s per user+business** (key
  `search:<userId>:<businessId>` — never IP-only; IP is also spoofable via
  `X-Forwarded-For`).
- On limit: `429 RATE_LIMITED` with the project's standard envelope and
  `retryAfterMs` metadata. The existing in-memory limiter is reused — no
  second framework.

## 9. Cache policy

- Response header: `Cache-Control: private, no-store` (harness-proven). No
  CDN/public caching; results never cached across users.
- Client TanStack Query caching is short (staleTime 15 s) and its keys ALWAYS
  include `businessId` + `query` + `types`; the business switcher invalidates
  all queries on switch.

## 10. Input hygiene

- `q`: control characters/null bytes stripped, whitespace collapsed, 2–64
  Unicode characters, NFKC-normalized; no Prisma field names can enter via
  params; `types` is a closed allowlist with rejection of unknowns; `limit`
  clamped into [6, 30].
- No raw SQL anywhere in the subsystem; no `$queryRaw`/`$executeRaw`.
- No `dangerouslySetInnerHTML`; all result text rendered as React text nodes;
  `dir="auto"` on user-data spans for mixed LTR/RTL content.

## 11. Security tests

| Suite | Coverage |
| --- | --- |
| `scripts/search-static-scan.mjs` (67 checks) | identity params never authority · businessId/deletedAt/select/take on every query · forbidden models never referenced · no query logging · no raw SQL · no arbitrary redirect/`dangerouslySetInnerHTML` · allowlist/clamp bounds · rate-limit key · no-store header · closed destinations · hash `q` sanitization |
| `scripts/prompt33-search-check.mjs` (76 assertions) | 401/400/403 · tenant isolation both directions + `?businessId` bypass attempt · identity params ignored · soft-delete exclusion · inactive-product visibility · invalid `types` (PlatformOperator/AiCostRecord/NotificationDelivery) → 422 · exact DTO key set · no amounts/internal fields in responses · no-store header · rate-limit 429 · cross-business isolation |
| `scripts/prompt33-unit.ts` (64 assertions) | normalization (NFKC, Persian/Arabic, digits, zero-width) · variants bound · invoice extraction bounds · q/types/limit validation · rank ordering · deterministic tie-breaks · dedupe · grouping |

## 12. Known limitations (honest)

- In-memory rate limiter: single-process scope (documented ADR path for
  multi-node deployments — same class as the shared limiter).
- Substring search performance is bounded by candidate caps, not by indexes;
  FTS5 is a future, measured-only option.
- No existence-leak protection differences: search simply cannot return rows
  outside the caller's business (the WHERE clause is the boundary).
