# Sales Orders (Prompt 45)

Commercial customer orders: commitment → fulfillment → invoicing.

## What a SalesOrder is — and is NOT

A `SalesOrder` records **what the customer committed to buy, at which
quantities and prices**. It is a COMMERCIAL document:

- it is **NOT revenue**;
- it is **NOT an invoice** (that is the linked `Sale`);
- it is **NOT a payment**;
- it is **NOT an inventory adjustment** and moves **no stock**;
- confirming it creates **no reservation** (there is no stock-reservation
  model — availability stays "current physical stock").

## The two sales paths (both explicit, never mixed)

### PATH A — Legacy direct sale (unchanged)

`POST /api/v1/sales` → Sale + SaleItems → **Product.stockQty decrement** +
one negative InventoryAdjustment, exactly as before Prompt 45. Deleting an
UNLINKED sale still restores stock through the existing reversal path.

### PATH B — Order-based sale (new)

```
SalesOrder (commercial commitment — no stock, no money)
    ↓ Confirm (read-only commitment — still no stock, no invoice)
GoodsDispatch POST (the ONLY stock decrement, exactly once per line)
    ↓ all ordered quantities dispatched
Linked Sale invoice (receivable authority — NO second stock decrement)
    ↓
Payment (existing pipeline, attached to the Sale)
```

**Which document owns the stock decrement?** In PATH B the linked
GoodsDispatch POST owns it — exactly once. The linked invoice NEVER
decrements stock and NEVER creates an InventoryAdjustment; the
authoritative distinction is the `Sale.salesOrderId` relation, never a
notes/reference heuristic. Users must not record one physical outbound
movement through both paths.

## Lifecycle

| Status | Meaning | Allowed transitions |
|---|---|---|
| `DRAFT` | preparation; header + lines editable | CONFIRMED, CANCELLED |
| `CONFIRMED` | read-only customer commitment | COMPLETED, CANCELLED* |
| `COMPLETED` | fully dispatched AND invoiced (terminal) | — |
| `CANCELLED` | terminal | — |

`*` CONFIRMED → CANCELLED only while **no posted linked dispatch
quantity** and **no linked invoice** exist (checked inside the write
transaction). Stock that has left the business is never reversed by a
cancel.

`COMPLETED` says nothing about payment: the linked Sale follows the
existing `UNPAID → PARTIAL → PAID` payment pipeline independently.

## Fulfillment law

Per line: `dispatchedQty = Σ POSTED linked GoodsDispatchLine.qty`
(draft/cancelled dispatches never count). `dispatchedQty ≤ orderedQty` is
a hard invariant — no over-dispatch, no tolerance, no clamp. Remaining is
computed exactly, never zero-clamped; corrupt history is a controlled 500
(`SALES_ORDER_OVER_DISPATCH`).

Partial fulfillment is required and expected: one order line may be
fulfilled across many dispatches; one dispatch may cover many lines.

## Quantities, prices, totals

- `orderedQty`: whole integer 1..1,000,000 (safe integers only).
- `unitPriceMinor`: integer minor units 0..9,000,000,000; defaults from
  `Product.salePriceMinor` but is persisted as the AGREED order price —
  later product price changes never rewrite it.
- `discountMinor`: integer 0..subtotal (enforced on every write).
- Totals are always recomputed server-side with exact integer math;
  overflow is rejected (`SALES_ORDER_TOTAL_OVERFLOW`), never rounded.
- Snapshots (`customerNameAtOrder`, `productNameAtOrder`, `skuAtOrder`,
  `unitAtOrder`, currency triple) freeze at write time and are never
  rewritten by renames, deletions or later edits.

## API surface

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/sales-orders` | create draft |
| `GET /api/v1/sales-orders` | bounded list (filters: q, status, customerId, from/to, pageSize ≤ 100) |
| `GET /api/v1/sales-orders/[id]` | detail (order + summary + lines + fulfillment + linked invoice + dispatch history) |
| `PATCH /api/v1/sales-orders/[id]` | DRAFT-only header patch |
| `POST …/lines` · `PATCH …/lines/[lineId]` · `DELETE …/lines/[lineId]` | DRAFT-only line management |
| `POST …/confirm` | DRAFT → CONFIRMED (no side effects) |
| `POST …/cancel` | guarded cancellation |
| `POST …/dispatches` | create linked DRAFT GoodsDispatch |
| `POST …/invoice` | issue the ONE linked Sale (full dispatch required) |
| `GET …/export?locale=en\|fa` | per-order CSV |

Linked dispatch lines are added through the existing P44 endpoint
`POST /api/v1/inventory/goods-dispatches/[id]/lines` with
`{ salesOrderLineId, qty }` — the product, snapshots and the `SALE`
reason derive from the order; injecting `productId`/`reasonCode` is
rejected.

## UI

`#/sales-orders` (list) and `#/sales-orders/<id>` (detail deep link).
Actions follow status: DRAFT → Confirm/Cancel/edit; CONFIRMED → Record
Dispatch (while remaining > 0) / Issue Invoice (when fully dispatched
with no invoice) / Cancel (server re-validates); COMPLETED → linked
invoice card + dispatch history; CANCELLED → read-only. Confirmation and
posting dialogs state the inventory/financial consequences verbatim.

## Error vocabulary

`SALES_ORDER_DUPLICATE_REFERENCE`, `SALES_ORDER_INVALID_STATUS`,
`SALES_ORDER_EMPTY`, `SALES_ORDER_LINE_LIMIT_REACHED`,
`SALES_ORDER_LINE_CAP_INVARIANT` (500 integrity),
`SALES_ORDER_DUPLICATE_PRODUCT`, `SALES_ORDER_INVALID_TRANSITION`,
`SALES_ORDER_HAS_FULFILLMENT`, `SALES_ORDER_NOT_FULLY_DISPATCHED`,
`SALES_ORDER_ALREADY_INVOICED`,
`SALES_ORDER_DISPATCH_EXCEEDS_REMAINING`, `SALES_ORDER_TOTAL_OVERFLOW`,
`SALES_ORDER_INVALID_PERSISTED_STATUS` (500),
`SALES_ORDER_IMMUTABLE`, `SALE_LINKED_TO_SALES_ORDER`,
`SALES_ORDER_FOREIGN_ENTITY`.

## Integrations

- **Global search**: `SALES_ORDER` group (reference + customer + product/
  SKU snapshots; no amounts) → `#/sales-orders/<id>`.
- **Customer 360**: ≤ 10 recent orders with dispatched progress and
  invoice presence (order-currency totals; never added to receivables).
- **Product detail**: ≤ 10 recent order lines with fulfillment numbers.
- **CSV export**: per-order (fulfillment + invoice columns), full
  security stack (entitlement, rate limit, BOM, CRLF, formula guard).
- **Business export**: `sales_orders` + `sales_order_lines` (CONFIDENTIAL,
  parent implies child). **Import stays blocked** — importing operational
  orders could create dispatch/invoice inconsistencies.
- **Backup/restore**: restore-drill probes `SalesOrder` + `SalesOrderLine`.

## Known limitations (intentional)

- No invoice voiding/credit notes: a linked invoice cannot be deleted
  (`409 SALE_LINKED_TO_SALES_ORDER`) — the GoodsDispatch already owns the
  stock movement and a legacy-style deletion would fabricate stock.
- No partial invoicing: one order → at most one invoice, only after full
  dispatch.
- No stock reservation: confirmation does not reserve availability.
- Confirmed orders are immutable; corrections are future work.
