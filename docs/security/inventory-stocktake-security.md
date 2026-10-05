# Inventory Stocktake — Security Notes

**Prompt 40** · Scope: `/api/v1/inventory/stocktakes/**`, `src/lib/inventory/stocktake/` (service, schema, types, dto), `#/inventory/stocktakes` views.

---

## 1. Authentication & tenant derivation

- Every route requires a valid **NextAuth session** through
  `getAuthContext()` (`src/lib/tenant.ts`): session → `userId` → membership
  lookup → server-resolved `businessId`. A session without a verified
  membership can never read or write stocktake data.
- The tenant scope (`businessId`) is **never accepted from the client** — no
  header, body field or query parameter can influence it. It is passed to the
  service exclusively from the auth context.

## 2. RBAC

- Reads (`GET` list, `GET` detail): `data:read`.
- Every mutation (create, PATCH edit, add/remove line, count, and all five
  lifecycle transitions): `data:write`.
- **No new permission was introduced, and the feature deliberately does NOT
  use `finance:manage`** — a stocktake is an operational inventory workflow,
  not a financial-administration action. Role → permission mapping is the
  existing platform matrix, unchanged.

## 3. Tenant isolation

- Every stocktake load is `findFirst({ where: { id, businessId } })` — a
  stocktake from another business is **404** (identical to an unknown or
  malformed id: `isValidEntityId` rejects bad shapes before any query, so
  there is no existence leak).
- Every product lookup carries `businessId` in the `where` clause (add line,
  count line, finalize stale-check batch): a foreign product id resolves to
  **404**, never to data from another tenant.
- The export fetchers in `src/lib/data-portability/export-catalog.ts` scope
  `inventory_stocktakes` by `businessId` and `inventory_stocktake_lines` by
  `stocktake.businessId` — there is no code path that reads lines without the
  tenant predicate.

## 4. Product validation

- **Deleted** product at add or count time → **404** (`NOT_FOUND`), exactly
  like a foreign product.
- **Inactive** product → **422 `STOCKTAKE_PRODUCT_INACTIVE`** (documented,
  distinct code so the UI can explain why the row is unusable).
- Finalization re-verifies both properties per line and classifies the
  blockers (`STALE` / `INACTIVE` / `DELETED`) in the error payload — limited
  to the caller's own products only.

## 5. Stale-count protection as a security property

- `systemQtyAtCount` is always the **server-read** `Product.stockQty` at
  count time; the client supplies only `countedQty` (integer 0..1e9, zod
  enforced). A client can never forge a "system" baseline to steer the
  reconciliation.
- At finalize, the snapshot is re-checked against the **current** quantity
  inside the finalization transaction; any drift → **409
  `STOCKTAKE_STALE_COUNT`** with the affected-product list, no auto-rebase.
  This is a data-integrity control: without it, a finalized count could
  **silently overwrite legitimate stock movements** (sales, corrections) that
  happened between counting and finalizing.

## 6. Transactionality & concurrency

- Every mutation runs in a single `db.$transaction`; finalization is one
  transaction spanning verify → stale-check → adjustments → status → audit.
  **No partial application is possible** (SQLite single-writer; no partial
  commit path exists).
- **Concurrent finalize:** one succeeds; the other fails cleanly — `422
  INVALID_STOCKTAKE_TRANSITION` (status already terminal) or `409
  STOCKTAKE_STALE_COUNT` (quantities moved). A double adjustment is
  unrepresentable.
- **Concurrent count:** last successful write wins per line
  (`countedByUserId`/`countedAt` always reflect the last committed count) and
  every write is audited (`count` or `recount` with before/after quantities) —
  no blind overwrite; the audit trail shows who counted what, when.
- **Concurrent add-line:** the DB unique constraint `@@unique([stocktakeId,
  productId])` is the final protection; the losing insert surfaces as Prisma
  `P2002` → **409 `DUPLICATE_STOCKTAKE_PRODUCT`**.

## 7. DTO minimization

- All responses go through explicit allowlist mappers
  (`src/lib/inventory/stocktake/dto.ts`) — **never raw Prisma objects**.
  Dates are ISO-8601 UTC strings; product name/SKU/unit come from the line's
  count-time snapshot.
- List items expose only id/reference/status/countType/counts/net
  variance/creator; detail adds notes + paginated lines + summary. No
  password/MFA/session, IP, user-agent, platform (subscription/checkout/AI
  cost) or audit-payload fields exist anywhere in the DTO surface.
- Request schemas are closed: `countType` accepts only omitted/`SELECTED`;
  **`status` is never client input**; `countedQty` is the only client
  quantity; list/detail queries are bounded (pageSize max 100).

## 8. Audit

- All mutations write through the single sanctioned `audit()` helper **inside
  the same transaction**, `entityType: "InventoryStocktake"`, actions:
  `inventory.stocktake.create`, `.start`, `.line_add`, `.line_remove`,
  `.count`, `.recount`, `.review`, `.reopen`, `.finalize`, `.cancel`,
  `.edit` (11 actions). Reads produce no audit rows.
- Payloads carry **safe metadata only**: reference, status, countType,
  lineId/productId, quantities (system/counted/variance), lineCount,
  adjustedLineCount, previous reference. **Notes content never enters audit**;
  `before` is written only where a before-state exists (recount quantities,
  edit reference). The stocktake service never passes IP/user-agent to the
  audit helper, so those AuditLog columns stay null — no IP/UA in
  `before`/`after` either.
- Reads are audit-silent (platform law: no audit on reads).

## 9. Sensitive-data exclusion

- `notes` (optional free text, ≤ 2000 chars) is stored for the business but
  **never logged, never audited, never sent to AI** — and the list search
  (`q`) matches the reference only, so notes are not a search/leak surface.
- Stocktakes are **not** in Global Search, the command palette, AI Copilot
  grounding, or the notification system (no new notification types; finalize
  triggers no direct low-stock alert — the scheduled Prompt 38 processor
  remains the authority).

## 10. Line cap as an abuse bound

- `INVENTORY_STOCKTAKE_MAX_LINES` (default 1000, clamped 100–5000) caps lines
  per session with `422 STOCKTAKE_LINE_LIMIT_REACHED`, bounding transaction
  size, list/detail payloads and the write amplification any single member
  can cause. The cap is checked inside the add transaction (no
  check-then-act gap across requests).

## 11. Error contract

Standard `ApiError` envelope (`{ ok: false, error: { code, message } }`),
mapped by the central route wrapper:

| Status | Codes |
|---|---|
| 401 | unauthenticated session (platform) |
| 403 | `FORBIDDEN` — role lacks `data:read`/`data:write` |
| 404 | `NOT_FOUND` — unknown/malformed stocktake or line id; foreign or deleted product (no existence leak) |
| 409 | `DUPLICATE_REFERENCE` (per-business unique), `DUPLICATE_STOCKTAKE_PRODUCT`, `STOCKTAKE_STALE_COUNT` (finalize) |
| 422 | `VALIDATION_ERROR`, `INVALID_STOCKTAKE_TRANSITION`, `STOCKTAKE_PRODUCT_INACTIVE`, `STOCKTAKE_LINE_LIMIT_REACHED` |
| 429 | `RATE_LIMITED` — the platform limiter convention on routes that opt in |

The five stocktake-specific codes are `INVALID_STOCKTAKE_TRANSITION`,
`DUPLICATE_STOCKTAKE_PRODUCT`, `STOCKTAKE_STALE_COUNT`,
`STOCKTAKE_PRODUCT_INACTIVE`, `STOCKTAKE_LINE_LIMIT_REACHED`. Honest note:
the stocktake routes add **no dedicated rate limiter** of their own (the
write surface is bounded by the transition gates, DRAFT-only line
preparation and the line cap); `RATE_LIMITED`/429 remains the platform-wide
error contract for limiter-bearing routes.

## 12. Caching

- Every stocktake route exports `dynamic = "force-dynamic"` — tenant-scoped
  data is never statically rendered, cached at the framework layer, or
  served from a shared cache.
