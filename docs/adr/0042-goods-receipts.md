# ADR 0042 — Goods Receipts / Inventory Receiving

Date: 2026-10-08
Status: Accepted (Prompt 42 CLOSED)
Supersedes: none
Related: ADR 0041 (Purchase Orders), ADR 0040 (Inventory Stocktake)

## Context

Prompt 41 delivered procurement commitments (Purchase Orders) with the explicit law that a PO never mutates inventory or money. The missing operational link is **physical receiving**: the moment goods actually arrive and current stock increases. The system already has two inventory authorities — `Product.stockQty` (current quantity) and `InventoryAdjustment` (movement history) — plus the P40 stocktake for physical reconciliation. Prompt 42 must add receiving WITHOUT a second stock authority, WITHOUT financial posting, and WITHOUT violating the single-writer SQLite concurrency model P41 hardened.

## Decision

1. **One new document type** — `GoodsReceipt` (+ `GoodsReceiptLine`) with the closed lifecycle `DRAFT → POSTED | CANCELLED`, nothing else. `POSTED` is immutable: it is historical inventory evidence; reversal is a separate future workflow.
2. **Hierarchy, not a second authority** — `PURCHASE ORDER → GOODS RECEIPT → PRODUCT STOCK → INVENTORY ADJUSTMENT HISTORY`. Posting a receipt is the ONLY receipt state that mutates stock: one positive `InventoryAdjustment` per line (`delta = receivedQty`, reason `Goods receipt <reference>`) and `Product.stockQty += receivedQty` in one atomic transaction.
3. **No money** — a receipt carries no price columns at all. It never creates Expense, Payment, Sale, supplier-statement movement, payable/aging row, or any accounting entry. "Inventory value" derived from `stockQty × costPriceMinor` remains operational stock value only, never asset recognition.
4. **Over-receipt law** — `SUM(POSTED received) + new ≤ orderedQty`, one pure function (`exceedsRemaining`), enforced at line-add (advisory) and authoritatively inside the post transaction. `409 GOODS_RECEIPT_EXCEEDS_REMAINING`; no tolerance, no bypass.
5. **Partial receiving is first-class** — a PO line may appear in many receipts (at most once per receipt, DB-enforced); received/remaining/fullyReceived are DERIVED from POSTED lines; no new PO statuses.
6. **Only CONFIRMED POs are receivable** — DRAFT/SENT/CLOSED/CANCELLED → 422. A PO with posted receipts can never be cancelled (`PURCHASE_ORDER_HAS_POSTED_RECEIPTS`); close remains possible with an explicit UI warning.
7. **Concurrency** — the P41 FIFO-serialized + bounded-retry SQLite write mechanism is extracted into the shared `src/lib/db/write-transaction.ts`; both P41 and P42 post through it. Concurrent posts of competing receipts serialize; the loser gets the stable 409; stock arithmetic matches persisted receipts exactly (proven with 20-way concurrency).
8. **Stocktake interaction** — receiving after a count snapshot triggers the existing `STOCKTAKE_STALE_COUNT` protection (no overwrite); a stocktake taken after receiving snapshots the new stock.
9. **Snapshots** — supplier name, PO reference and product name/SKU/unit are copied from the ALREADY-FROZEN PO data at write time; receipt history stays readable after renames and soft deletes.
10. **Export-only portability** — receipts + lines are exportable (CONFIDENTIAL) but NOT importable: replaying posted receipts from import would bypass the transactional receiving process and corrupt stock.

## Alternatives considered

- **Auto-reversal on PO cancel** — rejected: silent inventory reversal would hide physical reality; cancellation is blocked instead.
- **Receiving against DRAFT/SENT POs** — rejected: physical receiving belongs after commercial confirmation; keeping the gate simple makes the state machine auditable.
- **Storing receivedQty on the PO line** — rejected: a denormalized counter invites drift; derived aggregation from POSTED lines (grouped queries) is always consistent and powers the PO receiving summary without N+1.
- **A separate receipt-quantity authority table** — rejected: `InventoryAdjustment` already is the movement history; a second authority would desync.
- **Per-line independent transactions for posting** — rejected: a mid-document failure must roll back EVERYTHING (§40); one transaction is the only honest guarantee on SQLite.
- **Manager override for over-receipt** — rejected by spec: no tolerance, no bypass; a genuine over-delivery is a PO amendment workflow (future).

## Consequences

- Two write paths (P41/P42) now share one serialization utility; behavior of P41 is unchanged (regression suite re-run).
- Posted receipts are immutable. A legitimate physical return uses a GoodsReturn document (Prompt 43). Other inventory corrections must use the established authorized inventory-adjustment process — a positive receipt cannot compensate for a stock overstatement (wording updated by Prompt 43 §178).
- Receiving progress on the PO is derived data, recomputed with grouped aggregates — always consistent, no counters to maintain.
- Corruption policy: unknown statuses, negative stock and over-received history surface controlled 500s — never silently repaired.

## Future extension path

Goods returns / debit notes (the missing reversal workflow), purchase invoices, lot/serial/expiry tracking, warehouse locations, inventory valuation layers, and accounts-payable posting are explicitly OUT OF SCOPE and belong to separate future prompts. The receipt document was shaped (snapshots, immutable POSTED state, no money) so those layers can attach without breaking the current contract.

## Finalization decision record (P42-F)

Two real hardening defects were found in the audit and fixed without changing any domain law:

1. **In-memory received-quantity sums (replaced).** `sumPostedQtyForPoLine` loaded every historical POSTED receipt line for a PO line and summed in application memory — an unbounded read on the hottest path. Replaced with a database `aggregate(_sum)` plus integer/≥ 0 re-validation. Remaining checks (line-add advisory, line-update, post-time authoritative) keep identical semantics; corruption of the aggregate still surfaces as `GOODS_RECEIPT_CORRUPT_RECEIVED`.
2. **Silent read truncation (eliminated).** Read paths used `take: cap` and trusted that the cap invariant held. All read paths (receipt detail, receipt list rows, post transaction, PO receiving summary — now correctly using the purchase-order line cap family — and the PO/product/supplier recent-receipt widgets) fetch `cap + 1` rows and fail with the new stable `GOODS_RECEIPT_LINE_CAP_INVARIANT` (500) when the proof fails. The receipt list additionally cross-checks `_count.lines` against each row slice, so a partial total is structurally impossible.

Test-harness synchronization (no product behavior change): the P34 entity-shape suite was updated for the sanctioned additive `recentGoodsReceipts` sections (§62/§63); the P41 static scan's prohibited-scope rule now bans receipt WRITE operations precisely, allowing the sanctioned read-only receiving integration (§98/§146); env-repair's ledger baseline includes the P42 migration so a sandbox revert can never leave it pending (§107).
