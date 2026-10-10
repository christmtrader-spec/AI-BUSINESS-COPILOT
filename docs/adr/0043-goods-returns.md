# ADR 0043 — Goods Returns (Physical Return-to-Supplier)

- Status: ACCEPTED (Prompt 43 CLOSED)
- Date: 2026-10-10
- Context: Prompts 41 (Purchase Orders) and 42 (Goods Receipts) are CLOSED.
  Businesses need to send previously received goods back to suppliers
  (damage, wrong item, excess delivery) while preserving immutable receiving
  history.

## Decision

1. **Separate document, never a receipt rewrite.** A `GoodsReturn` (header +
   lines) references exactly one POSTED `GoodsReceipt`. The receipt keeps
   its status, quantities and snapshots forever; returned quantities live
   only in `GoodsReturnLine`. No `PARTIALLY_RETURNED` / `RETURNED` receipt
   status is introduced (the receipt/PO status vocabularies stay closed).
2. **Posting = physical inventory outflow.** `DRAFT → POSTED` atomically
   decrements `Product.stockQty`, writes one NEGATIVE `InventoryAdjustment`
   per line and one audit row inside ONE shared write transaction.
   `POSTED` and `CANCELLED` are terminal. Drafts and cancels never touch
   stock.
3. **Two independent guards.** The cumulative return cap
   (`SUM(POSTED returned) ≤ receivedQty`, DB aggregate) protects receiving
   history; the current-stock check (`Product.stockQty ≥ returnedQty`)
   protects aggregate stock. Without lot/batch provenance neither alone is
   sufficient — both are mandatory and neither is clamped or bypassable.
4. **Net receiving is derived, never stored.** `gross − returned = net`;
   `ordered − net = remaining`. The P42 over-receipt law now runs on net
   quantities through ONE canonical shared aggregate, enabling replacement
   receipts after valid returns while still rejecting over-receipt.
   `receivedQty` keeps its gross meaning for API compatibility.
5. **Financial silence.** GoodsReturn has no money fields and creates no
   financial rows — it is not a credit note/refund/payment/expense. Supplier
   settlement stays out of scope until an explicit prompt.
6. **Export-only portability.** Return datasets export (CONFIDENTIAL,
   lines implied) but never import — an import could replay stock
   decrements.

## Alternatives considered

- *Mutating `GoodsReceiptLine.receivedQty`*: destroys immutable receiving
  evidence and corrupts PO gross history — rejected (§8).
- *Negative `GoodsReceipt` ("reversal receipt")*: pollutes gross receiving
  history and double-counts net math — rejected.
- *Credit note as the correction vehicle*: mixes physical and financial
  domains; the prompt explicitly separates them — rejected.
- *Reusing InventoryAdjustment alone (no document)*: loses supplier/receipt
  traceability, reasons, and the reviewed lifecycle — rejected.

## Consequences

- Returns are auditable end-to-end; PO receiving summaries stay truthful
  after returns.
- Correction of an arbitrary historical stock error still requires the
  authorized inventory-adjustment process — a GoodsReturn only documents
  genuine physical supplier returns (see docs/product/goods-receipts.md
  correction wording).
- One additive migration (`20261008090000_prompt43_goods_returns`): 22 → 23
  migrations, SQLite-safe DDL only.
