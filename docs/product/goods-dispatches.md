# Goods Dispatch (Outbound Inventory) — Prompt 44

Physical outbound workflow: a dedicated, auditable document that records
goods physically leaving stock (to a customer, a branch, a sample
recipient) and **decrements inventory atomically**.

> SEMANTIC LAW: a GoodsDispatch is a PHYSICAL INVENTORY OUTFLOW. It is NOT
> an invoice, NOT a sale record, NOT a payment, NOT a receivable, NOT an
> accounting entry. A dispatch document contains NO money at all. Posting
> says exactly: "the business physically sent these quantities out of
> stock" — inventory quantities only. Financial balances (Sales,
> Receivables, Expenses, Payments) are provably unchanged by a dispatch.

## Purpose

A business stocks goods (Prompt 42 receipt), may correct inflows (Prompt 43
returns), and routinely sends goods OUT — customer deliveries, samples,
branch transfers. Until P44 those outbound movements had no document. The
dispatch must:

- decrease `Product.stockQty` atomically, never below zero;
- create one NEGATIVE `InventoryAdjustment` per line (`delta = -qty`);
- be traceable end-to-end (dispatch → stock movement → adjustment history → audit);
- freeze historical identity (customer name + product name/SKU/unit
  snapshots at write time — renames/deletions never rewrite history).

## Hierarchy

```
PRODUCT STOCK → GOODS DISPATCH → INVENTORY ADJUSTMENT HISTORY
                     ↕ (optional link)
                 CUSTOMER (360 history)
```

Unlike P43 returns (anchored to a POSTED receipt), a dispatch is NOT
chained to a purchase-order document — the PRODUCT and its CURRENT
aggregate stock are the quantity authority at POST time (no lot/batch
provenance — the same documented aggregate-stock trade-off as
P40/P42/P43).

## Lifecycle

```
DRAFT ──post──▶ POSTED (immutable)
  └──cancel──▶ CANCELLED (terminal)
```

- **DRAFT** — preparation only: header edit (reference/notes), line
  add/edit/remove. NO stock effect whatsoever. Line-add runs an ADVISORY
  availability check (stock may change before posting — only POST is
  authoritative).
- **POSTED** — one atomic transaction: every line's `Product.stockQty`
  decremented (exact integer math, never negative), exactly ONE negative
  `InventoryAdjustment` per line
  (`reason = "Goods dispatch <REF>: inventory dispatched out of stock"`),
  `postedAt` server-generated, ONE audit row in the SAME transaction.
  Immutable afterwards — no edit, no cancel, no reversal (corrections
  happen through new documents / authorized adjustments).
- **CANCELLED** — terminal, read-only. A cancelled draft never touched
  stock, so there is nothing to reverse.

## Line law

- `qty`: safe integer 1..1,000,000 whole units (zero is INVALID persisted
  state and is rejected at every row-materializing path);
- at most ONE line per product per dispatch
  (`@@unique([goodsDispatchId, productId])` — duplicates → 409);
- closed reason vocabulary: `SALE | GIFT_SAMPLE | TRANSFER_OUT | OTHER`
  (unknown persisted codes are corruption → controlled 500, never
  silently rendered as OTHER);
- snapshots (`productNameAtDispatch/skuAtDispatch/unitAtDispatch`) frozen
  at add time from the tenant-scoped Product row.

## Hardening laws (inherited from the audited P43 finalization)

- **Safe integers everywhere** — unsafe integers can never be
  authoritative quantities.
- **Zero-qty rejection** — a persisted line with qty 0 fails detail /
  list / export / post with `GOODS_DISPATCH_CORRUPT_HISTORY` (500);
  aggregates stay exact while corrupt; full recovery after repair.
- **Line-set completeness invariant** — every bounded read fetches
  `cap+1` rows and enforces THREE explicit invariants (fetched ≤ cap,
  counted ≤ cap, counted === fetched). A count mismatch BELOW the cap
  never passes — a subset total must never masquerade as complete
  (`GOODS_DISPATCH_LINE_CAP_INVARIANT`, 500).
- **Cap classification split** — a legitimately full draft (lineCount ===
  cap) is the ordinary 422 `GOODS_DISPATCH_LINE_LIMIT_REACHED`; an
  ALREADY-corrupted over-cap document is a 500
  `GOODS_DISPATCH_LINE_CAP_INVARIANT` on every path (detail / list /
  post / line-add) with ZERO mutation.
- **Business-timezone date filters** — list `from/to` interpret in the
  AUTHENTICATED business timezone (inclusive local start of `from`,
  EXCLUSIVE local start of the next day; never 23:59:59.999); a 00:15
  local record belongs to its LOCAL calendar date; invalid calendar
  dates 422 (never rolled over); client timezone input is structurally
  ignored.
- **Availability** — negative persisted stock is stock corruption (500,
  never "insufficient"); the availability gate re-verifies INSIDE the
  post transaction (stale drafts 409 with zero mutation).

## API surface

| Route | Method | Permission |
|---|---|---|
| `/api/v1/inventory/goods-dispatches` | POST | data:write |
| `/api/v1/inventory/goods-dispatches` | GET | data:read |
| `/api/v1/inventory/goods-dispatches/[id]` | GET / PATCH | data:read / data:write |
| `/api/v1/inventory/goods-dispatches/[id]/lines` | POST | data:write |
| `/api/v1/inventory/goods-dispatches/[id]/lines/[lineId]` | PATCH / DELETE | data:write |
| `/api/v1/inventory/goods-dispatches/[id]/post` | POST | data:write |
| `/api/v1/inventory/goods-dispatches/[id]/cancel` | POST | data:write |
| `/api/v1/inventory/goods-dispatches/[id]/export` | GET | data:read + CSV_EXPORT |

Stable error codes: `GOODS_DISPATCH_DUPLICATE_REFERENCE`,
`GOODS_DISPATCH_DUPLICATE_LINE`, `GOODS_DISPATCH_EMPTY`,
`GOODS_DISPATCH_LINE_LIMIT_REACHED` (422),
`GOODS_DISPATCH_LINE_CAP_INVARIANT` (500),
`GOODS_DISPATCH_INSUFFICIENT_STOCK` (409),
`GOODS_DISPATCH_INVALID_TRANSITION` (409), `GOODS_DISPATCH_IMMUTABLE`
(409), `GOODS_DISPATCH_PRODUCT_NOT_FOUND` (404),
`GOODS_DISPATCH_CUSTOMER_NOT_FOUND` (404),
`GOODS_DISPATCH_CORRUPT_HISTORY` (500),
`GOODS_DISPATCH_INVALID_PERSISTED_STATUS` (500),
`GOODS_DISPATCH_INVALID_PERSISTED_STOCK` (500).

## Integrations

- **Global search** — `GOODS_DISPATCH` entity type; searchable by
  reference, customer snapshot and product name/SKU snapshots
  (tenant-safe both directions; deep-links to
  `#/inventory/goods-dispatches/<id>`).
- **Product detail** — bounded "Recent goods dispatches" (≤10 rows with
  exact quantities + reasons, NO money).
- **Customer 360** — bounded dispatch history section (≤10 rows).
- **CSV export** — per-dispatch EN/FA with the full security stack
  (entitlement, rate limit, injection-safe cells, cap+1 completeness,
  quantity-only — NO money columns).
- **Business export** — `inventory_goods_dispatches` +
  `inventory_goods_dispatch_lines` datasets (CONFIDENTIAL, export-ONLY:
  a generic import could replay negative inventory movements, so import
  is intentionally blocked — the same law as P42/P43).
- **Restore drill** — probes `rows:GoodsDispatch` and
  `rows:GoodsDispatchLine` in every restored backup.
- **Low stock** — dispatches that push a product below its threshold are
  surfaced by the established low-stock processor (no duplicate
  mechanism).

## Environment

- `GOODS_DISPATCH_MAX_LINES` (default 200, clamp 20..500) — document
  line cap. NEVER change the project default for tests; isolated suites
  run with their own value.


## Order fulfillment linkage (Prompt 45)

A dispatch can optionally fulfill a SalesOrder (`salesOrderId` +
per-line `salesOrderLineId`, both nullable — standalone P44 dispatches
keep them NULL). The two paths stay explicit:

- **Standalone dispatch** — the product IS the source; snapshots copy
  from the Product row at line-add time (unchanged P44 behavior).
- **Order-linked dispatch** — created from the order context
  (`POST /api/v1/sales-orders/[id]/dispatches`); the customer context
  derives from the ORDER's frozen snapshot; lines are added with
  `{ salesOrderLineId, qty }` only (product/snapshots/`SALE` reason
  derive from the order line; `productId`/`reasonCode` injection is
  rejected); the dispatch keeps its OWN business-unique reference plus
  the `salesOrderReferenceAtDispatch` snapshot.

POST re-validates inside the transaction that the linked order is still
CONFIRMED and that the requested quantities fit the remaining order
quantities (the authoritative over-dispatch gate). A CANCELLED order's
stale draft can never post; a COMPLETED order accepts no new dispatches.
The dispatch detail exposes the linked order (§89); the order detail
lists recent linked dispatches (≤ 10).
