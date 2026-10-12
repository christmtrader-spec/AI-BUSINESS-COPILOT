# Sales Orders — Security Review (Prompt 45)

Scope: `src/lib/sales-orders/**`, `src/app/api/v1/sales-orders/**`,
the goods-dispatch fulfillment link, the Sale-delete guard, search,
entity histories, export/import and backup surfaces.

## Authentication / authorization

- Every endpoint requires the existing session (`getAuthContext`);
  reads demand `data:read`, writes demand `data:write`. **No new
  permissions were introduced.**
- Unauthenticated → 401; unauthorized → 403; foreign/unknown ids → 404
  (indistinguishable — no existence leak), malformed ids → 404 before any
  data access (`isValidEntityId`).

## Tenant isolation

- `businessId` comes ONLY from the auth context (`ctx.businessId`) —
  never from body, query or headers. Every read/write is scoped
  `where: { id, businessId }` (or equivalent).
- Cross-tenant probes (verified in E2E §17): detail, patch, lines,
  confirm, cancel, dispatch-create, invoice, export, dispatch line-add
  and search all refuse foreign ids with 404 / empty results.
- Child resources resolve THROUGH their tenant-scoped parent
  (order lines via `salesOrderId`, linked dispatch lines via the
  dispatch's `salesOrderId`), so a foreign parent id can never be
  grafted onto another tenant's document.

## Input authority (§112)

Strict zod schemas (`.strict()`) reject every authority field at the
boundary: `status`, `businessId`, customer/product snapshots, currency
snapshot, `createdByUserId`, lifecycle timestamps, computed totals,
`dispatchedQty`, `remainingToDispatchQty`, `salesOrderId` (on the generic
legacy sale create — stripped/ignored there and never honored).
References are normalized server-side (trim, control-char rejection,
bounds, NUL/newline injection rejected, Unicode preserved).

## Stock & money integrity

- **Single decrement authority**: only the linked GoodsDispatch POST
  decrements `Product.stockQty` (existing P44 algorithm, shared write
  transaction). The sales-order service contains no stock writes and no
  InventoryAdjustment creation; the linked invoice creates neither.
- **Over-fulfillment**: `dispatchedQty ≤ orderedQty` re-validated inside
  the post transaction (advisory at draft time). Concurrent dispatches
  serialize on the shared FIFO write transaction; the loser gets the
  stable `SALES_ORDER_DISPATCH_EXCEEDS_REMAINING` 409.
- **One invoice per order**: unique `Sale.salesOrderId` + in-transaction
  existence check; concurrent issuance → exactly one winner, stable
  `SALES_ORDER_ALREADY_INVOICED` 409, no duplicate items/audits.
- **Safe integers everywhere**: totals recomputed server-side; overflow
  → `SALES_ORDER_TOTAL_OVERFLOW` (input) / controlled 500 (persisted
  corruption). No floats, no `parseFloat`, no silent rounding.
- **Status corruption**: unknown persisted statuses parse to a controlled
  500 (`SALES_ORDER_INVALID_PERSISTED_STATUS`) — never to DRAFT — on
  detail, list, confirm, cancel, dispatch create/post, invoice and export.

## Financial non-mutation guarantees

Creating/confirming an order mutates NOTHING besides the order + audit
(no Sale, Payment, Expense, receivable, statement, aging, stock,
adjustment). Verified against NON-ZERO baselines in E2E (§95/§124).

## Linked-invoice deletion guard

`DELETE /api/v1/sales/[id]` rejects linked invoices with
`409 SALE_LINKED_TO_SALES_ORDER` BEFORE any restock mutation, so the
legacy delete-with-restock path can never fabricate inventory for an
order-linked invoice. Legacy (unlinked) sales keep the existing
payments-guard + restock behavior.

## CSV export

Reuses the established stack: `CSV_EXPORT` entitlement gate, 10/5min
per-user rate limit, strict `locale=en|fa`, UTF-8 BOM + CRLF via the
shared `toCsv` (OWASP formula-injection guard on every cell),
`Cache-Control: no-store`, attachment Content-Disposition, `data.export`
audit with counts only, tenant-scoped 404 before reads.

## Data portability & backup

- Business export adds `sales_orders` + `sales_order_lines`
  (CONFIDENTIAL; parent implies child). Import remains structurally
  blocked for both datasets (rejection verified before any mutation).
- `restore-drill.mjs` probes both tables; `env-repair.mjs` baselines the
  P45 migration so a sandbox revert can never leave it falsely pending.

## Audit

All mutations write audit INSIDE the same transaction
(`sales_order.create/update/line_add/line_update/line_remove/confirm/
cancel/dispatch_create/invoice`, plus `goods_dispatch.create` on the
dispatch side and `sale.create` for the invoice). Audit metadata carries
ids/quantities only — never notes content.
