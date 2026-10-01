# CRM Security — Prompt 35

**Scope:** `/api/v1/crm/*` (leads, opportunities, summary) and the CRM UI
surface (`#/crm`, `#/leads/<id>`, `#/opportunities/<id>`).

## Authority chain (unchanged)

```
session → getAuthContext → verified membership → ctx.businessId → RBAC
```

- `401 UNAUTHENTICATED` without a valid session (also for session-version
  mismatches — the CRM routes ride the same gate as every other v1 route).
- `403 FORBIDDEN` when the caller is not a member of the X-Business-Id
  business.
- `400 NO_BUSINESS_CONTEXT` when no business header is supplied.
- `data:read` for all CRM reads; `data:write` for all CRM writes (create /
  update / delete / status / stage / convert / assignment). **No new
  permissions were introduced** (§17).

## Tenant isolation

- The business key is ALWAYS the server-derived `ctx.businessId`; body/query
  `businessId/tenantId/ownerId/userId` are never read (statically scanned —
  `scripts/crm-static-scan.mjs` rule 2).
- Every CRM Prisma query is scoped by `businessId` and, where soft delete
  applies, `deletedAt: null` (rules 1/9).
- Foreign-tenant and deleted records resolve to **404 NOT_FOUND** — the same
  observable behavior as an unknown id, so existence never leaks across
  tenants (E2E §C/§T of `scripts/prompt35-crm-check.mjs`).

## Closed vocabularies

- `LEAD_STATUSES`, `LEAD_SOURCES`, `OPPORTUNITY_STAGES` are closed TS sets.
- Zod schemas reject unknown status/source/stage values (`422
  VALIDATION_ERROR`); unknown FILTER tokens are also rejected, not ignored.
- The browser cannot invent stages; the pipeline is code-defined (no
  PipelineStage table).

## Relation validation (same-business only)

- `assertAssigneeInBusiness` — assignee must be a current member of the
  caller's business (422 otherwise).
- `assertCustomerInBusiness` / `assertLeadInBusiness` — customer/lead links
  must exist in the same business and not be soft-deleted.
- WON stage re-validates the customer at transition time (server-side; not
  trusted from the client).
- Conversion validates the EXISTING_CUSTOMER target the same way.

## Conversion safety

- One serializable transaction: customer create/link + lead CONVERTED +
  optional opportunity — atomic (§26). Entitlement `CUSTOMERS_MAX` is
  enforced INSIDE the transaction via the existing
  `getEntitlementContextTx`/`assertWithinLimitIn` gates; exhaustion → `422`
  and the lead stays unchanged (E2E §N).
- Conversion never creates sales/payments and never modifies the customer
  row beyond linking.

## Data minimization (DTOs)

- Explicit allowlist mappers only (`src/lib/crm/dto.ts`); raw Prisma rows are
  never serialized (E2E §AD asserts exact top-level key sets).
- Customer refs: id/name/phone/email only. Assignee refs: id/name/email/role
  (role = the assignee's role in THIS business). `businessId`,
  `assignedToUserId`, and every secret-shaped field are absent from
  responses (E2E §V).
- Notes/descriptions participate in search matching as secondary fields but
  are never surfaced as titles; forecast amounts are never in the search DTO.

## Audit & logging

- Nine audit actions (`crm.lead.create/update/status_change/convert/delete`,
  `crm.opportunity.create/update/stage_change/delete`) written through the
  standard `audit()` helper with explicit safe before/after payloads — never
  raw request bodies, never secrets (E2E §AE asserts all nine + payload
  hygiene).
- No CRM search terms, names, emails, phones, notes or forecast details are
  logged; the raw query is never logged (§131).
- `SecurityEvent` is NOT used for CRM (account-security-only, §132).

## Web safety

- No arbitrary redirects, no `dangerouslySetInnerHTML`, no raw SQL in the
  CRM surface (static scans rules 10/17/18).
- Deep links are built ONLY through `entityToHash`/`parseEntityRoute`
  (charset-bounded ids); `#/crm/leads/<id>` is deliberately not a route.
- Responses carry no Cache-Control for reads consistent with the rest of the
  app; the search endpoint remains `private, no-store`.

## Enforcement tooling

| Tool | Coverage |
|---|---|
| `scripts/crm-static-scan.mjs` | 20 deterministic rules (§78): scoping, closed vocabularies, relation checks, DTO discipline, bounded queries, raw SQL, secrets, WON finance-separation, redirects, innerHTML, query logging, forecast/report separation. |
| `scripts/search-static-scan.mjs` | Updated for 8 searchable entities; Prompt 33 invariants preserved. |
| `scripts/entity-detail-static-scan.mjs` | Extended to the CRM detail routes/services + shared-component reuse (rules 19/20). |
| `scripts/prompt35-crm-check.mjs` | 148 live-HTTP checks: auth/RBAC/isolation, transitions, conversion atomicity + entitlement, financial non-interference, DTO shape, audit, export. |
| `scripts/prompt35-unit.ts` | 104 assertions on vocabularies, transitions, weighted integer math, DTO allowlists, query-key isolation. |

## Known limitations (honest)

- Rate limiting follows the existing convention (read GETs unthrottled, like
  every other tenant read; the search route keeps its 30/60s limiter).
- Single-process in-memory limiter (documented ADR path for multi-node).
- CRM is not yet in AI grounding, notifications, or billing gating — each is
  a deliberate deferral (§72/§73/§74).
