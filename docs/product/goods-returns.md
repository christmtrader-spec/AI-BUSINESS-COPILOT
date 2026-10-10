# Goods Returns (Supplier Returns) — Prompt 43

Physical return-to-supplier workflow: a dedicated, auditable document that
safely reverses a portion of a previously POSTED goods receipt **without
mutating the historical receipt**.

> SEMANTIC LAW: a GoodsReturn is a PHYSICAL INVENTORY OUTFLOW. It is NOT a
> credit note, NOT an expense, NOT a payment, NOT a refund, NOT a supplier
> balance adjustment, NOT an accounting entry. A return document contains
> NO money at all. Posting says exactly: "the business physically returned
> these quantities to the supplier" — inventory quantities only.

## Purpose

A business receives goods (Prompt 42 GoodsReceipt), later discovers damaged
/ wrong / excess items, and sends them back. The return must:

- keep the original receipt immutable (§8 — status, receivedQty, snapshots,
  lines are frozen forever);
- decrease `Product.stockQty` atomically;
- create one NEGATIVE `InventoryAdjustment` per line (`delta = -returnedQty`);
- be traceable end-to-end (source receipt → return → stock movement → audit).

## Hierarchy

```
PURCHASE ORDER → GOODS RECEIPT → GOODS RETURN → PRODUCT STOCK → INVENTORY ADJUSTMENT HISTORY
```

`GoodsReturn` is the third concept. It never rewrites the first two.

## Lifecycle (closed vocabulary, §9)

| From      | To        | Allowed |
| --------- | --------- | ------- |
| DRAFT     | POSTED    | ✔ (dedicated `POST /post` endpoint) |
| DRAFT     | CANCELLED | ✔ (dedicated `POST /cancel` endpoint) |
| POSTED    | *         | ✘ — immutable historical evidence |
| CANCELLED | *         | ✘ — terminal, readable, never deletable via UI |

- **DRAFT** — preparation only. Zero effect on stock, adjustments,
  receipts, POs, financials (§10).
- **POSTED** — completed physical inventory outflow. Lines read-only, no
  second posting, no reversal, no user-facing hard delete (§11).
- **CANCELLED** — never changed stock; terminal; remains readable (§12).

## Source rules

- Every return references exactly ONE source `GoodsReceipt`
  (`goodsReceiptId`, §13/§14). The receipt must be **POSTED** at create and
  re-verified inside the post transaction. A return from a DRAFT/CANCELLED
  receipt is rejected with `422 GOODS_RETURN_SOURCE_NOT_POSTED`.
- Returns are allowed even when the associated PurchaseOrder has since been
  CLOSED (§15) — physical goods can go back after administrative closure.
  The PO status is NEVER changed by a return (§127); a CLOSED PO still
  cannot receive new receipts (§129).
- Snapshots are frozen at creation **from the receipt's already-frozen
  snapshot columns** (§16/§17/§18/§30/§64):
  - `supplierNameAtReturn` ← `GoodsReceipt.supplierNameAtReceipt`
  - `goodsReceiptReferenceAtReturn` ← `GoodsReceipt.reference`
  - `purchaseOrderReferenceAtReturn` ← `GoodsReceipt.purchaseOrderReferenceAtReceipt`
  - per line: `productNameAtReturn` / `skuAtReturn` / `unitAtReturn` ←
    `GoodsReceiptLine.productNameAtReceipt` / `skuAtReceipt` / `unitAtReceipt`
  Renames and soft-deletes never rewrite return history (§31).

## Reference (§19-§21)

- Business-local unique, DB-enforced `@@unique([businessId, reference])`.
- Normalization: trim, reject control characters / NUL / newline injection,
  collapse whitespace, preserve Unicode, 2–80 visible chars.
- Blank → server-generated `RET-<YYYYMMDD>-<6 unambiguous chars>` (secure
  random; never `MAX(reference)+1`; client uniqueness never trusted).
- Duplicate → `409 GOODS_RETURN_DUPLICATE_REFERENCE` (race-safe: the DB
  constraint is authoritative).

## Return reasons (§23)

Closed vocabulary, localized in EN/FA: `DAMAGED`, `WRONG_ITEM`,
`QUALITY_ISSUE`, `EXCESS`, `OTHER`. No arbitrary unbounded reason strings.

## Quantity laws

- `returnedQty`: integer 1..1,000,000 (§32). 0 / -1 / 1.5 / NaN / Infinity
  are rejected at the zod boundary and re-validated in the domain.
- Line cap `GOODS_RETURN_MAX_LINES` (default 200, clamp [20, 500], §33)
  applies at add, post, detail/list reads and export completeness.
- **Cumulative return cap (§35/§36)** — for every source receipt line:

  ```
  returnedQtyForReceiptLine = SUM(POSTED GoodsReturnLine.returnedQty)   -- DB aggregate
  returnableQty             = receivedQty - returnedQtyForReceiptLine
  ```

  `SUM(POSTED) + new ≤ receivedQty` is a hard invariant: no tolerance, no
  manager override, no rounding, no clamp. `returned > received` is data
  corruption → `500 GOODS_RETURN_CORRUPT_HISTORY` (§38) — never silently
  repaired.
- **Current stock check (§39)** — posting requires
  `Product.stockQty ≥ returnedQty`; otherwise
  `409 GOODS_RETURN_INSUFFICIENT_STOCK`, no partial decrement.
  Both checks are mandatory (§40): the source cap proves the return does not
  exceed the original receipt; the stock check proves aggregate stock never
  goes negative. The application has no lot/batch-level stock provenance —
  it cannot prove a specific physical unit is still part of the original
  receipt (documented limitation, §197).
- **No negative stock (§41)** — already-negative persisted stock is
  corruption → `500 GOODS_RETURN_INVALID_PERSISTED_STOCK`, never silently
  zeroed (§164 test).
- Exact integer arithmetic only (§42) — no floats, no `Math.round`.

## Posting (§43) — ONE atomic transaction

Within `withWriteTransaction` (the shared FIFO-serialized SQLite writer
shared with P41/P42, §50):

1. reload the return (tenant-scoped) and re-parse its persisted status;
2. require DRAFT (concurrent posts serialize; exactly one wins §53);
3. reload the source receipt — must still be POSTED (corrupt receipt status
   never becomes POSTED, §66);
4. load lines with `take: cap+1` (over-cap → `500
   GOODS_RETURN_LINE_CAP_INVARIANT`, §76);
5. empty → `422 GOODS_RETURN_EMPTY` (§61);
6. per line: verify the source receipt line belongs to this receipt,
   aggregate prior POSTED returns (grouped DB query), enforce the cumulative
   cap, load the product, validate stock, compute `newStock`,
   decrement `Product.stockQty`, create ONE negative InventoryAdjustment
   (`delta = -returnedQty`, reason `Goods return <reference>: inventory
   returned to supplier`, actor/business server-derived §45-§47);
7. set `status=POSTED`, `postedAt` server-side;
8. write ONE `goods_return.post` audit row **in the same transaction** —
   audit failure rolls back everything (§48/§133).

Any failure rolls back ALL writes (§52): no stock change, no adjustment, no
status, no audit.

## Net receiving reconciliation (§77-§85)

For every PurchaseOrderLine:

```
grossReceivedQty = SUM(POSTED GoodsReceiptLine.receivedQty)   (unchanged meaning §78)
returnedQty      = SUM(POSTED GoodsReturnLine.returnedQty)
netReceivedQty   = grossReceivedQty − returnedQty
remainingQty     = orderedQty − netReceivedQty
```

- `receivedQty` KEEPS its gross meaning in existing APIs (compatibility,
  §78); `returnedQty` and `netReceivedQty` are ADDITIVE fields.
- The P42 over-receipt law is now RETURN-AWARE (§80/§125): the remaining
  check subtracts posted returns via the ONE canonical shared aggregate
  (`sumPostedReturnedQtyForPoLine`). Replacement receipts after a valid
  return are accepted (§81); receiving more than the net remainder still
  fails with `409 GOODS_RECEIPT_EXCEEDS_REMAINING` (§82).
- `fullyReceived` is NET-based: `netReceivedQty === orderedQty` (§84).
- A CLOSED PO shows a derived remaining quantity after a return but stays
  closed — the UI explains that receiving is unavailable (§85).
- No new PO/receipt statuses exist (no PARTIALLY_RETURNED / RETURNED /
  REOPENED — §130). PO status never changes automatically (§127); a PO with
  posted receipts still cannot be cancelled (§128).

## API surface (§55)

| Method | Path | Notes |
| ------ | ---- | ----- |
| POST   | `/api/v1/inventory/goods-returns` | create draft (data:write) |
| GET    | `/api/v1/inventory/goods-receipts`… `/api/v1/inventory/goods-returns` | bounded list (q/status/goodsReceiptId/from/to/page/pageSize ≤ 100) |
| GET    | `/api/v1/inventory/goods-returns/[id]` | detail |
| PATCH  | `/api/v1/inventory/goods-returns/[id]` | DRAFT-only reference/notes |
| POST   | `/api/v1/inventory/goods-returns/[id]/lines` | add line |
| PATCH  | `/api/v1/inventory/goods-returns/[id]/lines/[lineId]` | update qty+reason (DRAFT) |
| DELETE | `/api/v1/inventory/goods-returns/[id]/lines/[lineId]` | remove line (DRAFT) |
| POST   | `/api/v1/inventory/goods-returns/[id]/post` | atomic posting |
| POST   | `/api/v1/inventory/goods-returns/[id]/cancel` | DRAFT-only terminal cancel |
| GET    | `/api/v1/inventory/goods-returns/[id]/export` | per-return CSV (en/fa) |

DTOs are explicit allowlists (§70/§71) — no raw Prisma records, no money
fields anywhere in the domain.

## Integrations (all ADDITIVE)

- **GoodsReceipt detail** (§86-§88): per-line `receivedQty / returnedQty /
  returnableQty` (received stays the immutable gross), a bounded ≤10 recent
  returns list, and the "Create Goods Return" CTA gated on
  `returns.returnable` (any line with returnableQty > 0, POSTED only).
- **PurchaseOrder detail** (§83): Gross Received · Returned to Supplier ·
  Net Received · Remaining — quantity labels only, never financial wording.
- **Product detail** (§99): ≤10 recent return lines (reference, source
  receipt, returnedQty, reason, date, status; no money).
- **Supplier 360** (§100): ≤10 recent returns using `supplierNameAtReturn`;
  never mixed into statement/payable calculations.
- **Global search** (§101/§102): `GOODS_RETURN` entity type; searches
  reference + receipt reference + PO reference snapshot + supplier snapshot
  + product snapshot names/SKUs; tenant-scoped; bounded; deep-links to
  `#/inventory/goods-returns/<id>`.
- **Low-stock processor**: untouched (§134). A return may naturally make a
  product low-stock; the existing processor remains the sole notification
  authority. No new notification types.
- **AI/Copilot**: no GoodsReturn AI tools, no notes in AI context (§135).

## CSV export (§103-§111)

One row per return line; columns: return reference, status, source receipt
reference, PO reference snapshot, supplier snapshot, product snapshot, SKU
snapshot, unit snapshot, returnedQty, reasonCode, postedAt. NO money
columns. Shared CSV serializer (UTF-8 BOM, CRLF, quoting, OWASP formula
injection guard), `Content-Disposition: attachment`, `Cache-Control:
no-store`, `CSV_EXPORT` entitlement (403 without), 10/5min rate limit,
`data.export` audit. Foreign id → safe 404.

## Data portability (§112-§115)

- Business export datasets: `inventory_goods_returns` +
  `inventory_goods_return_lines` (CONFIDENTIAL; the return implies its
  lines).
- **Import is intentionally unsupported** (export-only): a generic import
  could replay negative inventory movements and duplicate stock decrements.
  The datasets are absent from the import catalog → unknown-dataset
  rejection before any write.

## Backup / restore (§116/§181)

`scripts/restore-drill.mjs` probes `GoodsReturn` + `GoodsReturnLine`
(honest-absent rule for older backups).

## Stocktake & manual adjustment interaction (§121-§124)

- A posted return is a real inventory write: a stocktake whose
  `systemQtyAtCount` no longer matches current stock is rejected at
  finalization with the existing `STOCKTAKE_STALE_COUNT` behavior — the
  newer stock is never overwritten.
- A stocktake started AFTER a return snapshots the reduced stock.
- Manual adjustments and returns serialize through the same shared write
  transaction — exact integer arithmetic, no lost updates (e.g. +3 manual
  and −5 return → exact 18 from 20).

## Known limitations (§197)

- No credit note, no refund, no supplier financial settlement (out of scope;
  see docs/audit/financial-semantics.md).
- No lot/batch-level stock provenance — availability is enforced against
  aggregate `Product.stockQty`.
- No warehouse locations / bins / shelves / lots / serials / expiry /
  barcode scanning.
- No valuation layers (FIFO/LIFO/weighted-average).
- POSTED returns are immutable; corrections require a new return document
  or the authorized inventory-adjustment process.
