# Goods Receipts — Security Review (Prompt 42)

Scope: `src/lib/inventory/goods-receipt/*`, `src/app/api/v1/inventory/goods-receipts/**`, `src/modules/inventory/goods-receipts/*`, migration `20261007090000_prompt42_goods_receipts`.

## 1. Tenant isolation

- Every read and write is scoped by `businessId` derived ONLY from `getAuthContext` (membership-verified). The client cannot submit a business id: the create/patch schemas have no such field, and the service ignores everything but the authenticated context.
- Receipt → PO → PO-line → product chains are validated inside tenant-scoped queries (`purchaseOrderLine.findFirst({ where: { id, purchaseOrderId: header.purchaseOrderId } })`, product re-checked with `businessId`). A foreign tenant's PO, PO line or receipt is indistinguishable from an unknown id → `404`, no existence leak, verified in BOTH directions by the E2E suite.

## 2. ID validation

- Every `[id]`/`[lineId]` route parameter passes `isValidEntityId` before any database read; malformed ids resolve to `404` without touching the DB (no leak, no error-based probing).
- List filters (`purchaseOrderId`) are tenant-scoped; a foreign PO id yields an EMPTY list, never another tenant's rows.

## 3. RBAC

- Reads: `requirePermission(ctx, "data:read")` on list/detail/export.
- Writes: `requirePermission(ctx, "data:write")` on create/patch/lines/post/cancel.
- No new permission code was introduced (§93).

## 4. Input validation

- All bodies parse through the zod schemas in `schema.ts` (`parseBody` + `route` conventions). The line-create schema is `.strict()`: a client-supplied `productId` (authoritative-field injection) is rejected outright (§36) — product identity is always derived from the tenant-scoped PO line.
- `receivedQty`: integer `1..1_000_000`; zero/negative/fractional/NaN/Infinity/above-max all rejected at the boundary.
- References: normalized (trim, whitespace collapse), control characters rejected, bounded 2..80; duplicates → `409` with DB uniqueness as the final authority (race-safe).
- Notes: optional, ≤ 2000 chars, document data only — never logged to audit bodies, never sent to AI, never indexed into search results.

## 5. Status machine integrity

- Closed vocabulary `DRAFT | POSTED | CANCELLED`; transitions only through the dedicated `post`/`cancel` endpoints. There is no generic status PATCH route.
- The current status is re-checked INSIDE the write transaction before every transition (§73), so concurrent posts/cancels cannot double-apply (`at most one` winner — proven by the concurrency suite).
- A corrupted persisted status is NEVER interpreted as DRAFT: `parseGoodsReceiptStatus` throws the pure integrity error, mapped to a controlled `500 GOODS_RECEIPT_INVALID_PERSISTED_STATUS` on detail/list-omission/export/post/cancel (§96/§97/§284).

## 6. Quantity & stock integrity

- The over-receipt law (`exceedsRemaining`) is ONE pure function consulted at line-add (advisory) and authoritatively inside the post transaction. Posted-only sums (`status = POSTED`) — drafts never inflate the authority, and staleness is rejected at post with no mutation (§67/§204).
- `remaining = ordered − received` via `computeRemainingQty`; over-received history is a controlled `500 GOODS_RECEIPT_CORRUPT_RECEIVED`, never silently clamped (§100/§283).
- Stock arithmetic is exact integers; the post-mutation value must stay within Int32 (`422 GOODS_RECEIPT_STOCK_OVERFLOW`); negative persisted stock is surfaced (`500 GOODS_RECEIPT_INVALID_PERSISTED_STOCK`), never repaired in passing (§46/§47).

## 7. Transactionality & concurrency

- All multi-write paths run through the shared `withWriteTransaction` (FIFO in-process serialization + bounded transient retry P2034/P2024/SQLITE_BUSY; domain errors never retried) — the SAME law the P41 procurement path uses, extracted to `src/lib/db/write-transaction.ts` (§52-§54).
- Posting is ONE transaction: stock updates, adjustments, status, `postedAt`, and the audit row commit or roll back together (§39/§72/§154). The failed-post drill proves zero residue after a mid-transaction rejection.
- DB-enforced constraints as final authority: `@@unique([businessId, reference])` (duplicate reference → 409), `@@unique([goodsReceiptId, purchaseOrderLineId])` (duplicate line → 409). Concurrent-same-reference / concurrent-duplicate-line / concurrent-over-receipt / concurrent-same-receipt-post are all covered by the isolated concurrency suite.

## 8. CSV export

- `CSV_EXPORT` entitlement gate → 10-per-5-minute per-user rate limit → strict `locale=en|fa` → malformed/foreign id safe 404 → build.
- `Cache-Control: no-store`, `Content-Disposition: attachment`, BOM + CRLF via the shared `toCsv` (OWASP formula-injection guard on every cell), snapshot-only values, zero money columns, `data.export` audit with counts only.
- Export completeness is provable: `take: cap + 1` over a document that cannot exceed its own cap.

## 9. Audit

- `goods_receipt.create/update/line_add/line_update/line_remove/post/cancel` written inside the same transaction as each mutation (§154). Metadata is allowlisted: references, ids, quantities, counts, status transition — never notes content, never secrets (§155/§156).

## 10. Soft deletes & deletion policy

- Receipt lines reference Product with `onDelete: Restrict` — soft-deleted products keep full history; a hard product delete can never silently destroy receiving evidence.
- Receipts cascade only through the business (tenant deletion). A PO containing posted receipts is not user-cancellable (`PURCHASE_ORDER_HAS_POSTED_RECEIPTS`); there is no user-facing receipt delete at all.

## 11. Prohibited scope (verified by static scan)

No expense/payment/sale/statement/aging/payable writes, no double-entry vocabulary, no warehouse/barcode/lot/serial fields, no new notification types, no AI tools, no client-trusted totals — enforced by `scripts/prompt42-goods-receipt-static-scan.mjs` (177 rules).
