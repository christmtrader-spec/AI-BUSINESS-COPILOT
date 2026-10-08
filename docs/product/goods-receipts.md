# Goods Receipts (Prompt 42)

## Purpose

A **Goods Receipt** answers exactly one question: *"How many units physically arrived against this confirmed purchase order?"*

It is the second concept in the procurement/inventory hierarchy:

```
PURCHASE ORDER  (commercial commitment — what we intend to buy)
      ↓
GOODS RECEIPT   (physical receiving — what actually arrived)
      ↓
PRODUCT STOCK   (Product.stockQty — operational current quantity)
      ↓
INVENTORY ADJUSTMENT HISTORY (InventoryAdjustment — the audit trail of every movement)
```

A receipt is **inventory evidence, not money**. It contains NO prices, NO totals, NO expense, NO payment, NO supplier-statement movement, NO payable, and NO accounting entry. Posting a receipt changes exactly two things: `Product.stockQty` (increase) and one positive `InventoryAdjustment` row per received line.

## Lifecycle (closed vocabulary)

| Status | Meaning | Allowed transitions |
|---|---|---|
| `DRAFT` | Preparation only. No stock, no adjustments, no statements. | → `POSTED`, → `CANCELLED` |
| `POSTED` | Physical stock moved. Immutable historical inventory evidence. | *(terminal)* |
| `CANCELLED` | Prepared but never posted. No mutation of any kind. | *(terminal)* |

There is deliberately **no `POSTED → CANCELLED`**: reversing a posted receipt would require a stock-reversal workflow, which is intentionally out of scope. A posted receipt can never be edited, re-posted, cancelled, or deleted through the product. The only hard-delete path is business-level deletion (tenant offboarding), which cascades.

## Partial receiving

A purchase order line may be received across MANY receipts:

- PO line ordered 100 → receipt 1: 30 → receipt 2: 20 → receipt 3: 50 → remaining 0.
- No single receipt must receive the full quantity.
- `receivedQty` and `remainingQty` on the PO are **derived** from POSTED receipt lines only (draft/cancelled receipts never count) — the PO status vocabulary is never extended with RECEIVED/FULFILLED states (§293/§294 of the P42 spec).

## Over-receipt law (hard invariant)

```
SUM(posted received quantities for a PO line) + new quantity ≤ PurchaseOrderLine.orderedQty
```

- Violations → `409 GOODS_RECEIPT_EXCEEDS_REMAINING`.
- No tolerance percentage, no automatic overage, no manager bypass, no hidden override.
- The check runs at line-add (advisory) and **authoritatively inside the post transaction**; a stale draft whose lines over-allocate after another receipt posted is rejected at post time (`GOODS_RECEIPT_EXCEEDS_REMAINING`) with zero stock mutation.
- Received quantity itself: integer `1..1_000_000`. Zero, negative, fractional, NaN and Infinity are all rejected at the boundary.

## Stock mutation (posting)

Posting runs in **one atomic transaction** (shared `withWriteTransaction` FIFO-serialized SQLite wrapper):

1. Re-load the receipt inside the transaction; status must still be `DRAFT` (never trust an earlier read).
2. Re-verify the purchase order is still `CONFIRMED` (a closed/cancelled PO can never be posted against).
3. For every line: re-verify the PO line, product existence, POSTED received sum, remaining quantity, current stock (`stockQty ≥ 0`, corrupt negative stock → controlled `500 GOODS_RECEIPT_INVALID_PERSISTED_STOCK`), and Int32 headroom (`422 GOODS_RECEIPT_STOCK_OVERFLOW`).
4. `Product.stockQty += receivedQty` (exact integer arithmetic).
5. One `InventoryAdjustment` per line: `delta = receivedQty` (always positive), reason `Goods receipt <reference>`, actor/business derived from the authenticated context.
6. Receipt → `POSTED` with server-generated `postedAt`.
7. One `goods_receipt.post` audit record, written in the SAME transaction (an audit failure rolls the entire posting back).

If ANY step fails, everything rolls back — no partial stock, no orphan adjustments, no audit.

## Snapshots (historical, immutable)

| Field | Copied from | Survives |
|---|---|---|
| `supplierNameAtReceipt` | PO's frozen `supplierNameAtOrder` | supplier rename / soft delete |
| `purchaseOrderReferenceAtReceipt` | PO reference | future reference-policy changes |
| `productNameAtReceipt` / `skuAtReceipt` / `unitAtReceipt` | PO line's frozen snapshot | product rename / soft delete |

Receiving against a soft-deleted product or a soft-deleted supplier remains possible while the PO is CONFIRMED — the physical goods did arrive. New *procurement selection* of deleted products is a separate, out-of-scope concern.

## Purchase order interaction

- Only `CONFIRMED` orders accept new receipts. `DRAFT`/`SENT`/`CLOSED`/`CANCELLED` → `422 GOODS_RECEIPT_PURCHASE_ORDER_NOT_RECEIVABLE`.
- Closing a PO is allowed with unreceived quantities; the UI warns that closing prevents further receiving and creates no payable.
- **A PO with POSTED receipts can never be cancelled** (`409 PURCHASE_ORDER_HAS_POSTED_RECEIPTS`) — there is no reversal workflow.
- Posting a receipt never changes the PO status; receiving progress stays derived.

## Stocktake interaction

- Receipt posted **after** a stocktake count snapshot → finalization detects the stale count (`STOCKTAKE_STALE_COUNT`); the count never overwrites receiving.
- Stocktake taken **after** posting → `systemQtyAtCount` equals the new stock; finalization with the true count yields zero variance.

## Stock overflow & corruption policy

- `Product.stockQty` is a 4-byte signed integer; posting past `2_147_483_647` → `422 GOODS_RECEIPT_STOCK_OVERFLOW`, no partial writes.
- Corrupt persisted stock (negative) → `500 GOODS_RECEIPT_INVALID_PERSISTED_STOCK` — never silently repaired.
- Corrupt persisted receipt status (unknown value) → `500 GOODS_RECEIPT_INVALID_PERSISTED_STATUS` — never interpreted as DRAFT, never editable/postable/cancellable, never rendered as "Draft" in search.
- Corrupted received history (posted > ordered) → `500 GOODS_RECEIPT_CORRUPT_RECEIVED` — never clamped to zero.

## Tenant isolation & RBAC

Every query and mutation is scoped by `businessId` from the authenticated membership; foreign PO / PO-line / receipt ids resolve to a safe `404` with no existence leak, in both directions. Reads require `data:read`; writes require `data:write`. No new permission was introduced.

## Export

`GET /api/v1/inventory/goods-receipts/[id]/export?locale=en|fa` — one CSV row per receipt line, snapshot values only, NO money columns, BOM + CRLF + OWASP formula-injection guard via the shared `toCsv`, EN/FA localized headers, `Cache-Control: no-store`, attachment disposition, `CSV_EXPORT` entitlement gate, 10-per-5-minute rate limit, `data.export` audit.

## Data portability

- `inventory_goods_receipts` + `inventory_goods_receipt_lines` are exportable datasets (CONFIDENTIAL); receipts always carry their lines.
- **Import is intentionally NOT implemented** (export-only): replaying a posted receipt from import would bypass the transactional receiving process and double-count stock. The import catalog is structurally closed to customers/suppliers/products.

## Limitations (intentional)

- No receipt reversal / returns / debit notes (future prompts).
- No lot / serial / expiry / barcode / warehouse / bin tracking.
- No inventory valuation layers (FIFO/LIFO/weighted average) — the operational stock value derived from `stockQty × costPriceMinor` is NOT an accounting asset.
- No financial posting of any kind; supplier statements and payables aging are untouched by receipts.
- PO receiving progress is derived data only — no new PO statuses.
