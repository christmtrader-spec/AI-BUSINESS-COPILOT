# Entity Detail Security (Prompt 34)

> Security boundaries of the six entity-detail GET endpoints and the
> `#/…/<id>` deep-link layer. Complements `global-search-security.md`
> (Prompt 33) and `docs/audit/financial-semantics.md`.

## 1. Authentication & membership

Every detail GET follows the established pipeline — no exceptions:

1. `getAuthContext(req)` — NextAuth session (401 `UNAUTHENTICATED` /
   `SESSION_INVALIDATED`), `x-business-id` header required
   (400 `NO_BUSINESS_CONTEXT`), membership row loaded
   (403 `FORBIDDEN`), session-version + registry checks.
2. `requirePermission(ctx, "data:read")` — 403 `PERMISSION_DENIED`.
3. The route id identifies the **RECORD only**; the tenant is ALWAYS the
   server-derived `ctx.businessId`. No endpoint ever trusts `businessId`,
   `userId`, `tenantId` or `ownerId` from query/body/headers beyond the
   membership-verified `x-business-id` context header.

## 2. Tenant isolation & 404 behavior

- Reads are scoped `where: { id, businessId: ctx.businessId, deletedAt: null }`
  (soft-deletable models; Payment has no soft delete).
- A record of ANOTHER business — valid id or not — returns **404
  `NOT_FOUND`**, identical to an unknown id. The API never returns 403 for
  a foreign record (that would reveal its existence). Verified for all six
  entity types in both directions (harness sections I / AJ).
- Deleted records also 404; a reversed payment 404s on refresh. The shared
  not-found UI never discloses whether an id belonged to another tenant.

## 3. DTO minimization

Responses are produced exclusively by explicit mappers
(`src/lib/entities/*.ts`). Contract properties:

- Explicit field allowlists — no Prisma model objects, no spreads.
- No secrets/credentials: `passwordHash`, MFA secrets, tokens,
  `sessionVersion`, provider secrets, webhook signatures are unreachable
  by construction (static scan §50.5–7).
- No audit internals (`ip`, `userAgent`) and no AI-cost or platform fields.
- `businessId` and `deletedAt` are excluded from every DTO — the tenant is
  implicit and deletion state is expressed by the 404 itself.
- Related records carry names/ids only (e.g. `supplierName`), never the
  related object; payments expose only tenant `Payment` data — the platform
  `PaymentTransaction` domain is unreachable (§69).

## 4. Bounded queries

- Customer/Supplier: 1 `groupBy` aggregate + 2 `findMany(take: 10)` with
  deterministic `orderBy` (`field desc, id desc`).
- Product: 2 `findMany` (`take: 10`; sale-items pre-take 35 then JS-dedupe
  to ≤10 unique sales).
- Expense: 1 record + `findMany(take: 20)` payments.
- Payment: 1 record + at most ONE related document fetch.
- No raw SQL, no N+1 loops, no unbounded relation loads
  (`scripts/entity-detail-static-scan.mjs` enforces this).

## 5. Route validation (hash layer)

- Closed vocabulary: the first segment must be one of the six list segments.
- Id charset `[A-Za-z0-9_-]{1,64}` after safe percent-decoding — rejects
  `/ ? #`, control characters, whitespace, unicode, and over-long payloads.
- Malformed routes fall back to the dashboard; route data is never
  executed, never injected into HTML (no `dangerouslySetInnerHTML`), and
  never used to construct redirect URLs. Hash producers percent-encode ids
  via `entityToHash`.

## 6. Cache isolation

- TanStack keys embed the business id: `["entities", businessId, entity, id]`.
- Business switch invalidates the entity domain and re-resolves the mounted
  view; cross-business cached details are unreachable.
- Mutations use targeted invalidations (§37 of the prompt) — no blind cache
  clears.

## 7. Logging & observability

- Detail endpoints add no new logging; no detail payloads, customer names,
  notes or contact data are logged (follows the observability never-log law).
- Viewing a detail performs NO audit write and NO notification (read-only;
  existing update/delete/audit behavior is unchanged).

## 8. Rate limiting & authorization for mutations

- Detail GETs add no second limiter framework; read navigation stays
  unthrottled by design (search retains its dedicated limiter).
- Mutations keep the EXISTING permissions: `data:write` for
  customer/supplier/product/expense update+delete, `finance:manage` for
  payment reversal (which retains its dedicated 30/60s limiter).
- No new roles/permissions were introduced.

## 9. Test matrix

| Layer | Evidence |
| --- | --- |
| Static | `entity-detail-static-scan.mjs` 18/18 |
| Unit | `prompt34-unit.ts` 133 assertions |
| E2E | `prompt34-entity-check.mjs` 109/109 (auth, RBAC, tenant 404s, DTO keys, forbidden fields, integer money, 360 consistency, stock states, payment relations, cross-business leakage) |
| Browser | agent-browser QA (deep links, search/palette navigation, RTL/LTR, dark, mobile, keyboard, 404 UI) |

## 10. Limitations

- Single-process in-memory limiter (unchanged; documented ADR path).
- All 6 roles hold `data:read` today, so a permission 403 is not reachable
  with the current role matrix (membership 403 is verified).
- The hash layer is client-side; hostile hashes degrade to dashboard/404
  states — they can never reach data the session is not entitled to.
