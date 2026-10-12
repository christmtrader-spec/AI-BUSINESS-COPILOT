# ADR 0045 — Sales Orders, Fulfillment and Invoice Integration

Status: ACCEPTED (Prompt 45)
Date: 2026-10-11

## Context

Before Prompt 45 the application had two sales-side concepts:

1. **Sale** — the sales invoice + financial receivable document. Its
   creation path decremented `Product.stockQty` for product-backed lines.
2. **GoodsDispatch** (P44) — a physical inventory-outflow document whose
   POST also decremented stock.

Businesses need a customer-order workflow: record the commitment, ship in
partial deliveries, then invoice. Naively combining the existing flows
would double-decrement stock (dispatch POST + invoice creation both
touching `Product.stockQty`).

## Decision

1. **New `SalesOrder`/`SalesOrderLine` models** — a commercial document
   with the lifecycle DRAFT → CONFIRMED → COMPLETED (+ CANCELLED). It
   carries the agreed quantities/prices and frozen customer/product/
   currency snapshots, and holds NO money-of-record and NO stock effects.
2. **Two explicit, never-mixed sales paths.**
   - PATH A (legacy, untouched): direct Sale creation decrements stock.
   - PATH B (new): SalesOrder → linked GoodsDispatch POST (the ONLY
     decrement) → ONE linked Sale invoice (receivable authority, no
     second decrement).
3. **Fulfillment link**: optional `GoodsDispatch.salesOrderId` +
   `GoodsDispatchLine.salesOrderLineId` (both NOT unique — one order is
   fulfilled by many dispatches). Linked lines derive product + snapshots
   + the SALE reason from the order line; the client cannot inject them.
4. **One invoice per order**: nullable unique `Sale.salesOrderId` plus an
   in-transaction existence check; issuance requires CONFIRMED status and
   full dispatch, creates Sale/SaleItems/audit and flips the order to
   COMPLETED atomically. No partial invoicing in this phase.
5. **Linked-invoice delete guard**: user-facing deletion of a linked Sale
   is rejected (`SALE_LINKED_TO_SALES_ORDER`) because the legacy delete
   path restores stock that the dispatch already owns. Invoice voiding
   remains future work.
6. **Hardening laws inherited from P41–P44**: shared write transaction,
   cap+1 read completeness (three-check invariant), 422/500 cap
   classification split, safe-integer canonical totals with overflow
   rejection, strict persisted-status parsing (unknown ≠ DRAFT),
   business-timezone date windows, frozen snapshots, tenant-scoped 404s,
   strict input schemas, explicit DTO allowlists.

## Consequences

- The stock-decrement authority question now has a documented answer per
  path: PATH A = Sale creation; PATH B = linked dispatch POST. The
  `Sale.salesOrderId` relation (never notes text) is the discriminator.
- No stock reservation exists: confirmation records intent only; only
  POST checks physical availability. This is intentional and explained in
  the UI copy.
- Cancellation of a CONFIRMED order is possible only with zero posted
  fulfillment and no invoice — stock that left can never be "uncancelled"
  (return/reversal is a separate future workflow).
- Business export gained `sales_orders`/`sales_order_lines`; import stays
  blocked for operational documents (same law as P42–P44).
- Migration is additive-only (two new tables + nullable link columns);
  25 baseline migrations + 2 legacy duplicates applied, 0 pending.

## Alternatives considered

- **Reserving stock at confirmation** — rejected: invents a reservation
  model, complicates availability semantics, and conflicts with the
  "current physical stock" display law.
- **Partial invoicing** — rejected for this phase: allocating one order
  across multiple invoices interacts with discounts/payments and would
  need its own design.
- **Reusing Sale.status for orders** — rejected: Sale.status is the
  payment status (UNPAID/PARTIAL/PAID); conflating it with the commercial
  lifecycle would corrupt both meanings.
- **Detecting linked sales via notes/reference text** — rejected as
  fragile; the relation column is the authority.
