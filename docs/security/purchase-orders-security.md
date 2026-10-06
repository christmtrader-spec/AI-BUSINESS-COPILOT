# Purchase Orders — Security Review

**Prompt 41 (finalized by 41-F)** · Scope: `src/lib/purchase-orders/**`,
`/api/v1/purchase-orders/**`, search/entity/export integrations.

---

## 1. Authority chain

Every request: session → `getAuthContext(req)` → verified membership →
`ctx.businessId` / `ctx.userId` → `requirePermission` (`data:read` /
`data:write`). Tenant scope **always** comes from the auth context; a client
`businessId` is structurally impossible to submit (not read from body, query
or headers). `createdByUserId` is always `ctx.userId`.

## 2. Tenant isolation

- Every domain query is scoped by `ctx.businessId`; foreign ids resolve to
  `404 NOT_FOUND` — indistinguishable from nonexistent (no existence leak).
- Line routes scope through the parent order
  (`where: { id: lineId, purchaseOrderId: header.id }`).
- The detail read resolves the live supplier with an explicit
  `where: { id, businessId }` probe — a foreign tenant's supplier row is
  unreachable even by internal id.
- Live-verified: cross-tenant detail/PATCH/line/export/search all 404/empty.

## 3. DTO allowlist (no raw Prisma serialization)

Responses are built by explicit mappers (`dto.ts`, entity mappers). Verified
response keys: detail exposes exactly
`id/reference/status/orderedAt/expectedDate/notes/supplier{id,nameAtOrder,name,stillExists}/currency/lifecycle/createdBy{id,name}/createdAt/updatedAt/summary/lines[]`.
`createdBy` carries only `{id, name}` — never password hashes, MFA secrets,
sessions, reset tokens, billing or AI-cost data. Search candidates carry no
monetary fields by design.

## 4. Client input authority

The client submits ONLY: `supplierId`, `reference?`, `orderedAt?`,
`expectedDate?`, `notes?` (create/patch) and `productId`, `orderedQty`,
`unitPriceMinor` (lines). Structurally rejected (zod strips unknown keys):
`businessId`, `status`, totals, snapshots, creator. Hostile-payload test
(submitting businessId/status/totalMinor/snapshots) verifies the server
values win.

## 5. Status integrity (corruption policy)

Unknown persisted status ≠ DRAFT. `parsePurchaseOrderStatus()` throws the
pure `PurchaseOrderStatusIntegrityError`; the server maps it to `500
PURCHASE_ORDER_INVALID_PERSISTED_STATUS` (stable code, fixed value-free
message, no DB details). Applies to detail, list, export, transitions,
Supplier 360 and product history; search never displays a corrupted row as
any valid status. Live-verified end-to-end (E2E group 21).

## 6. Lifecycle authorization

Transitions exist as dedicated endpoints only; no generic status PATCH
(structurally absent from the patch schema). Status is re-checked inside the
mutation transaction; audit is written in the same transaction (atomic — a
failed write rolls back its audit and vice versa). DRAFT-only editing is
enforced server-side (`409 PURCHASE_ORDER_IMMUTABLE`); CLOSED/CANCELLED
reject everything (verified for all 8 mutation shapes).

## 7. Money safety

Integer minor units only; quantities 1..1,000,000; unit price
0..1,000,000,000 (zero allowed, negative rejected). The price bound is the
maximum representable by the project's `Int` money columns — the API never
accepts a value it cannot persist. Totals are server-derived with BigInt and
guarded to the safe-integer range (`422 PURCHASE_ORDER_TOTAL_OVERFLOW`);
client totals are ignored. No `parseFloat`, no floats, no scientific notation.

## 8. CSV export security

Order of checks: authentication → `data:read` → `CSV_EXPORT` entitlement
(billing gate, fresh read) → rate limit (10 / 5 min / user → `429`) →
malformed-id 404 → tenant-scoped fetch. Response: `Cache-Control: no-store`,
`Content-Disposition: attachment`, BOM + CRLF, shared `csvCell()` OWASP
formula-injection guard on every cell (live-proven with `=1+1`, `@cmd`
payloads). Audit `data.export` records counts only — no names, no totals, no
ids. Locale is strict `en|fa` (anything else → 422).

## 9. Concurrency hardening (SQLite single-writer)

P41 write transactions serialize through an in-process FIFO queue plus a
bounded transient-failure retry (P2034/P2024/expired-transaction). Live
proofs: 24-way parallel line-adds never exceed the cap and every loser gets
the stable `422 PURCHASE_ORDER_LINE_LIMIT_REACHED`; parallel duplicate-product
adds → exactly one line, losers `409`; parallel same-reference creates →
exactly one order, losers `409`; 5-way transition storms → exactly one
winner + one audit row each, all losers stable 4xx (no generic 500).

## 10. Data minimization & audit

Audit bodies carry references, ids, status transitions and line counts —
never notes content, tokens, secrets or supplier personal data (verified by
source scan rule 77 and live audit inspection). The static scan
(145 rules) additionally forbids forbidden-scope implementations (warehouse,
barcode, valuation, double-entry, goods receipt…), external-integration
claims (email/SMS/EDI/OCR/webhook sends), and unrelated infrastructure
dependencies inside the P41 surface.

## 11. Residual risks (honest)

- Export CSVs contain procurement data; they are entitled, rate-limited and
  `no-store`, but a user with `CSV_EXPORT` can exfiltrate their own tenant's
  data — accepted by design.
- `PURCHASE_ORDER_MAX_LINES` is env-tunable within 20..500; a raised cap
  raises per-request work proportionally (bounded, still safe).
- SQLite single-writer serialization is process-local; a second writer
  process sharing the DB file relies on the bounded retry (verified in the
  isolated cap process running alongside the dev server).
