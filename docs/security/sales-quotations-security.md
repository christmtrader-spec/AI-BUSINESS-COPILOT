# Sales Quotations — Security Review (Prompt 47)

Scope: `src/lib/sales-quotations/**`, `src/app/api/v1/sales-quotations/**`,
search, entity histories, export/import, the print surface and the
conversion link into `SalesOrder`.

## Authentication / authorization

- Every endpoint requires the existing session (`getAuthContext`);
  reads demand `data:read`, writes demand `data:write`. **No new
  permissions were introduced** — the viewer role stays read-only.
- Unauthenticated → 401; unauthorized → 403; foreign/unknown ids → 404
  (indistinguishable — no existence leak), malformed ids → 404 before
  any data access (`isValidEntityId`).
- The print route carries the same auth + tenant gates as the detail
  route — the reduced customer-facing payload is only reachable through
  an authorized staff session (there is no public/unauthenticated
  quotation surface of any kind).

## Tenant isolation

- `businessId` comes ONLY from the auth context (`ctx.businessId`) —
  never from body, query or headers. Every read/write is scoped
  `where: { id, businessId }` (or equivalent); line and lifecycle
  operations resolve the line THROUGH the tenant-scoped parent
  quotation, so a foreign parent/line id can never be grafted onto
  another tenant's document.
- Cross-tenant probes (verified in E2E §17): detail, patch, lines,
  mark-sent, accept, reject, cancel, expire, convert, export, print and
  search all refuse foreign ids with 404 / empty results — tested in
  BOTH directions.

## Input authority (§112)

Strict zod schemas (`.strict()`) reject every authority field at the
boundary: `status`, `businessId`, `createdByUserId`, customer/product
snapshots, the currency snapshot triple, lifecycle timestamps
(`sentAt`/`acceptedAt`/`rejectedAt`/`cancelledAt`/`convertedAt`) and
computed totals are all server-derived. References are normalized
server-side (trim, control-char rejection, 2..80 bounds, Unicode
preserved); blank references are server-generated
(`QT-<date>-<6 unambiguous chars>` — a DISTINCT sequence from orders).

## Concurrency

- **One writer**: every mutation runs through the shared
  `withWriteTransaction` (FIFO-serialized SQLite writes) — line edits,
  lifecycle transitions and conversion cannot interleave.
- **DB unique constraints are the race authority**:
  `@@unique([businessId, reference])` on the quotation,
  `@@unique([sourceQuotationId])` on `SalesOrder` (one order per
  quotation), `@@unique([salesQuotationId, productId])` on lines.
- **Every transition is re-checked INSIDE the transaction** — the
  status, validity and expiry guards read the row inside the same write
  transaction that commits the transition, so a stale client view can
  never drive a state change.
- Race results are stable codes, never crashes: a losing conversion
  (including a retry after the winner committed) gets
  `409 SALES_QUOTATION_ALREADY_CONVERTED`; a losing duplicate line gets
  `409 SALES_QUOTATION_DUPLICATE_PRODUCT`; a losing duplicate reference
  gets `409 SALES_QUOTATION_DUPLICATE_REFERENCE`; accept-vs-reject and
  accept-vs-expire races end with exactly one winner and one audit row.
- Conversion failure rolls back EVERYTHING (order, line copies, status,
  `convertedAt`, audits) — the cap suite verifies a corrupted-discount
  conversion leaves zero residue, then succeeds after repair with
  exactly-once audits.

## Integrity (closed persisted vocabulary)

- Unknown persisted statuses parse to a controlled **500
  `SALES_QUOTATION_INVALID_PERSISTED_STATUS`** — never to DRAFT — on
  detail, list, export, print, line writes and every lifecycle action
  (a fabricated DRAFT would expose editing on unknown state).
- **Cap+1 completeness invariant (three checks)**: reads fetch cap+1
  rows and prove `fetched ≤ cap`, `counted ≤ cap` and
  `counted === fetched`; any violation is a 500
  `SALES_QUOTATION_LINE_CAP_INVARIANT` (a subset total must never
  masquerade as complete) on detail, list, export, line-add, mark-sent
  and conversion.
- Corrupted quantities/prices/missing snapshots are **integrity
  failures (500 `SALES_QUOTATION_CORRUPT_HISTORY`)**, not user errors:
  corrupt operands throw, persisted totals that leave the safe integer
  range throw — nothing is silently repaired, clamped or substituted
  with live values. Input-time overflow (before anything persists) is
  the 422 `SALES_QUOTATION_TOTAL_OVERFLOW` validation rejection; the
  same condition in PERSISTED data is the 500.

## Notes privacy

- `customerNotes` and `internalNotes` NEVER appear in audit payloads
  (audit metadata carries the changed-flag and ids only), are NEVER
  indexed into global search, and `internalNotes` is NEVER exported
  (no export column) and NEVER rendered on the print view.
- `customerNotes` is customer-visible document content: it appears in
  the detail DTO and the print payload and exports with the dataset —
  by design, but never inside audit/search payloads.

## Audit

All mutations write audit INSIDE the same transaction:
`sales_quotation.create / update / line_add / line_update / line_remove
/ mark_sent / accept / reject / cancel / expire / convert` (11 actions —
statically asserted complete), plus `sales_order.create` on the
conversion side and `data.export` (counts only) on CSV export. Audit
metadata carries ids/references/quantities — never notes content.

## Financial non-mutation guarantees

Creating, editing, marking sent, accepting, rejecting, cancelling,
expiring or converting a quotation mutates NOTHING beyond the quotation
(+ the converted order) and audit: no Sale, Payment, receivable,
statement, aging, stock, InventoryAdjustment, reservation. Verified
against NON-ZERO baselines in E2E (§draft/§accept/§conversion stock and
finance deltas are byte-identical), and statically: the service and
export modules contain no stock/finance vocabulary.

## CSV export

Reuses the established stack: `CSV_EXPORT` entitlement gate, 10/5min
per-user rate limit, strict `locale=en|fa` (anything else → 422),
UTF-8 BOM + CRLF via the shared `toCsv` (OWASP formula-injection guard
on every cell), `Cache-Control: no-store`, attachment
Content-Disposition, `data.export` audit with counts only, tenant-scoped
404 before reads, and completeness enforced by the line cap (a
truncated export is never returned as valid).

## Error contract (22 stable codes)

Routes never duplicate literals — every code is referenced from
`SALES_QUOTATION_ERROR_CODES`; responses use the standard no-stack-trace
envelope (stable `code` + fixed, value-free message).

| Code | HTTP | Class |
|---|---|---|
| `SALES_QUOTATION_NOT_FOUND` | 404 | unknown/foreign id |
| `SALES_QUOTATION_FOREIGN_ENTITY` | 404 | cross-tenant child reference |
| `SALES_QUOTATION_CUSTOMER_NOT_FOUND` | 404 | unknown/foreign customer |
| `SALES_QUOTATION_PRODUCT_NOT_FOUND` | 404 | unknown/foreign product |
| `SALES_QUOTATION_LINE_NOT_FOUND` | 404 | unknown/foreign line |
| `SALES_QUOTATION_DUPLICATE_REFERENCE` | 409 | unique `[businessId, reference]` |
| `SALES_QUOTATION_IMMUTABLE` | 409 | edit/line write after DRAFT |
| `SALES_QUOTATION_INVALID_STATUS` | 409 | valid-but-wrong status for the action |
| `SALES_QUOTATION_INVALID_TRANSITION` | 409 | transition outside the matrix |
| `SALES_QUOTATION_EXPIRED` | 409 | accept/reject past validity |
| `SALES_QUOTATION_NOT_EXPIRED` | 409 | explicit expire on a valid offer |
| `SALES_QUOTATION_ALREADY_CONVERTED` | 409 | second conversion (incl. races) |
| `SALES_QUOTATION_NOT_ACCEPTED` | 409 | convert of REJECTED/EXPIRED/CANCELLED |
| `SALES_QUOTATION_DUPLICATE_PRODUCT` | 409 | unique `[quotation, product]` |
| `SALES_QUOTATION_EMPTY` | 422 | mark-sent with zero lines |
| `SALES_QUOTATION_LINE_LIMIT_REACHED` | 422 | write over the configured cap |
| `SALES_QUOTATION_TOTAL_OVERFLOW` | 422 | input math leaves the safe range |
| `SALES_QUOTATION_INVALID_DATE_RANGE` | 422 | `validUntilDate < quotationDate` / bad calendar date |
| `INVALID_DISCOUNT` | 422 | discount < 0 or > subtotal |
| `SALES_QUOTATION_INVALID_PERSISTED_STATUS` | **500** | corrupted persisted status |
| `SALES_QUOTATION_CORRUPT_HISTORY` | **500** | corrupt qty/price/snapshot/discount/empty-accepted |
| `SALES_QUOTATION_LINE_CAP_INVARIANT` | **500** | over-cap/missing-line read corruption |

Adjacent surfaces: 401/403 auth (`AUTHENTICATION_REQUIRED`,
`FORBIDDEN`), `403 ENTITLEMENT_NOT_AVAILABLE` (CSV export without the
`CSV_EXPORT` plan feature), `429 RATE_LIMITED` (export rate limit),
`422 VALIDATION_ERROR` (zod boundary / export locale).

## Data portability & backup

- Business export adds `sales_quotations` + `sales_quotation_lines`
  (CONFIDENTIAL; parent implies child; **no internalNotes column**).
  Import remains structurally blocked for both datasets — the allowlist
  rejects them BEFORE any `DataImportJob` row or business write
  (rejection verified in E2E).
- `restore-drill.mjs` probes both tables; `env-repair.mjs` baselines
  the P47 migration so a sandbox revert can never leave it falsely
  pending.

## Known limits (honest)

- SENT/ACCEPTED are manual declarations: the system records who declared
  what when, and cannot verify an external send or a customer's
  identity — this is documented product semantics, not a control gap.
- The print endpoint serves authorized staff only; there is no
  shareable public link, so nothing public can leak quotation data.
- Export rate limiting is per-user in-process (same law as every other
  CSV surface); multi-instance deployments inherit the documented
  in-process rate-limit caveat of the shared limiter.
