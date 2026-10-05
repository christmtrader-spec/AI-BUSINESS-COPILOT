# Inventory Stocktake — Physical Count Sessions

**Prompt 40** · Status: implemented · Scope: `src/lib/inventory/stocktake/`, `/api/v1/inventory/stocktakes/**`, `#/inventory/stocktakes` views, `docs/adr/0040-inventory-stocktake.md`.

---

## 1. What a stocktake IS — and what it is NOT

A stocktake is a **controlled physical inventory count session**: pick a set of
products, count what is physically on the shelf, compare it against the system
quantity, and (on finalization) reconcile the system to the physical count.

**It is NOT a general ledger, not double-entry, and not COGS/valuation.**
There is no journal entry, no chart of accounts, no inventory cost layer, no
valuation history, and no expense/revenue posting anywhere in this feature.
Finalization changes physical inventory quantities ONLY through the existing
`InventoryAdjustment` semantics (`Product.stockQty` + an adjustment row with a
signed delta and a stated reason) — the same mechanism the manual
"adjust stock" flow has always used. No `Sale`, `Expense`, `Payment`,
`Statement` or report row is created, and the variance itself is not booked as
expense, revenue or profit. Inventory *value* may move only because
`stockQty` moves, under the existing `stockQty × costPriceMinor` convention
(see `docs/audit/financial-semantics.md`).

## 2. Lifecycle

Five statuses with a closed, server-authoritative transition table
(`src/lib/inventory/stocktake/types.ts`). Every transition is a **dedicated
endpoint** (`/start`, `/review`, `/reopen`, `/finalize`, `/cancel`); there is
no generic PATCH for status. An invalid transition fails with
`422 INVALID_STOCKTAKE_TRANSITION`.

| From | Allowed transitions | Via |
|---|---|---|
| `DRAFT` | `COUNTING`, `CANCELLED` | start (requires ≥ 1 line), cancel |
| `COUNTING` | `REVIEW`, `CANCELLED` | review (requires every line counted), cancel |
| `REVIEW` | `COUNTING`, `FINALIZED`, `CANCELLED` | reopen, finalize, cancel |
| `FINALIZED` | — (terminal, immutable) | — |
| `CANCELLED` | — (terminal, immutable) | — |

`REVIEW → COUNTING` (reopen) is deliberate: review exists to inspect variances
and send lines back for recount, not to be a trap.

## 3. Count type

The count-type vocabulary is **closed and currently contains exactly one
value: `SELECTED`** — the operator picks which products to count. The
vocabulary is extensible in code (`STOCKTAKE_COUNT_TYPES`), but no other count
type exists in Prompt 40; `countType` in the create request may be omitted
(→ `SELECTED`) or explicitly `"SELECTED"`, anything else is rejected.

## 4. Lines — one product per stocktake

- A line is `(stocktake, product)`; a product can appear **once** per
  stocktake. The DB enforces it (`@@unique([stocktakeId, productId])`); a
  duplicate add fails with `409 DUPLICATE_STOCKTAKE_PRODUCT`.
- Lines are added/removed **only while `DRAFT`** — they are preparation data.
  Once counting begins, the line set is frozen (no removal; recounts replace
  values in place).
- A freshly added line carries zero placeholders until it is counted
  (`countedQty`/`varianceQty` render as null in the API while pending).
- Line cap: `INVENTORY_STOCKTAKE_MAX_LINES` (default **1000**, clamped to the
  range **100–5000**). Reaching the cap fails with
  `422 STOCKTAKE_LINE_LIMIT_REACHED` and the UI surfaces the `lines/max`
  budget. The cap bounds transaction size and is an abuse bound, not a
  performance feature.

**Product eligibility (server-verified at add and count time):** the product
must belong to the same business, not be soft-deleted (foreign or deleted →
`404`, no existence leak), and be active (inactive →
`422 STOCKTAKE_PRODUCT_INACTIVE`).

## 5. The count snapshot — server-side, never client-supplied

Recording a count (`POST …/lines/[lineId]/count`) is one server transaction:

1. Load the stocktake → status must be `COUNTING` or `REVIEW` (recount
   support).
2. Load the line → verify its product (tenant, not deleted, active).
3. Read the product's **CURRENT `stockQty` from the database** — this is the
   `systemQtyAtCount` snapshot. The client sends **only `countedQty`**
   (integer 0..1,000,000,000); it can never supply the system quantity.
4. Derive variance server-side and snapshot product metadata onto the line
   (`productNameAtCount`, `skuAtCount`, `unitAtCount`) so the line stays
   historically interpretable even if the product is renamed later.
5. Record `countedAt` + `countedByUserId`.

**Variance = counted − system. The sign is meaningful** (positive = physical
surplus, negative = shortage); it is never `abs()`-ed and never clamped.
Recounting the same line replaces it in place (new snapshot, new variance,
new counter) and is audited as `inventory.stocktake.recount` with the
previous quantities in the audit `before` payload.

## 6. Review summary

The detail endpoint derives a summary server-side over ALL lines
(`computeStocktakeSummary`): `lineCount`, `countedLineCount`,
`pendingLineCount`, `positiveVarianceLineCount`,
`negativeVarianceLineCount`, `zeroVarianceLineCount`,
`increaseVarianceUnits`, `decreaseVarianceUnits` (reported as a positive
magnitude), and `netVarianceUnits` (increase − decrease). Review exists to
inspect these numbers and recount suspicious lines before finalizing;
`review` requires every line counted, and `finalize` requires `REVIEW`.

## 7. Stale-count protection — no auto-rebase

Inventory is live: sales, expenses-adjustments and manual corrections move
`stockQty` while a count is in flight. At **finalize**, every line's
`systemQtyAtCount` is re-checked against the product's **current** `stockQty`
inside the finalization transaction. Any mismatch (or a product that became
deleted/inactive after counting) rejects the whole finalization with
**`409 STOCKTAKE_STALE_COUNT`** (or `STOCKTAKE_PRODUCT_INACTIVE` when an
inactive product is the trigger) and a payload listing the affected products
(lineId, productId, name, snapshot qty, current qty, kind).

Example: a line was counted when the system stock was **10**; stock later
becomes **19** (e.g. two sales). Finalization is **rejected** — the operator
must recount that line, which re-snapshots the current quantity. The system
**never rebases the variance** to absorb the drift: silently overwriting
legitimate post-count stock movements is exactly what this protection exists
to prevent.

## 8. Atomic finalization

`finalize` is **one transaction**: verify status + completeness → stale-check
→ reconcile → mark `FINALIZED` → write the finalize audit row. There is no
partial finalization: either every non-zero variance is applied and the
session closes, or nothing changes.

Reconciliation reuses the **existing `InventoryAdjustment` semantics**:

- `delta = varianceQty` (signed) and reason
  `Stocktake <reference>: physical count reconciliation`;
- `Product.stockQty` becomes the counted value;
- **zero-variance lines create no adjustment row** — the `InventoryAdjustment`
  ledger carries the per-line quantity history, so the finalize audit records
  only the workflow event once (`lineCount`, `adjustedLineCount`).

Concurrency: two simultaneous finalizations cannot double-apply — one
commits; the other fails (`422` invalid transition from `FINALIZED`, or `409`
stale count if stock moved). A concurrent count during finalization either
lands before (counted values participate) or after (the finalize stale-check
sees the new quantity and rejects).

## 9. Cancel, immutability, editing

- **Cancel** is allowed from `DRAFT`, `COUNTING` and `REVIEW`; it changes no
  stock and creates no adjustment. It is the only way a started session
  "ends" without reconciliation.
- **`FINALIZED` and `CANCELLED` are immutable and terminal.** No line edits,
  no re-open, no PATCH — editing reference/notes is DRAFT-only (`422`
  otherwise). A wrong finalized count is corrected by a *new* stocktake, not
  by mutation. Stocktake records have no user-facing hard delete.

## 10. Notifications — deliberately none

Finalization sends **no notification and triggers no low-stock check
directly**. The scheduled Prompt 38 processor
(`scripts/process-inventory-low-stock.mjs`) remains the single authority for
low-stock alerts and will pick up any newly-low product on its next run. No
new notification types were added for stocktake (the notification catalog is
unchanged).

## 11. Product detail history

Product Detail (360) shows a bounded **stocktake history (≤ 10 entries)**
with reference, date and status, deep-linked to the session
(`#/inventory/stocktakes/<id>`). Stocktakes are **not** entity-router records:
they never appear in Global Search, the command palette or AI Copilot
grounding, and produce no notifications.

## 12. UI entry points

- **Inventory → Stocktakes**: a Stocktakes card on the Inventory screen (with
  an "open sessions" metric over `DRAFT`/`COUNTING`/`REVIEW`) and the full
  list at `#/inventory/stocktakes` (filter by reference substring — never
  notes — status, created-from/to; pagination default 25, max 100).
- **Detail deep link** `#/inventory/stocktakes/<id>`: header + lifecycle
  actions, the derived summary, and paginated lines (default 50, max 100) with
  count/recount dialogs and a finalize confirmation that surfaces the
  counted/reconciled picture. Unknown ids fall back safely; refresh and
  back/forward work.

## 13. Known limitations (honest)

- **Single location.** There is no warehouse, bin, shelf or batch model — a
  stocktake reconciles the business's single stock quantity.
- **No import of finalized stocktakes.** Count sessions are export-only
  datasets; importing a physical reconciliation would replay stock mutations
  (see `docs/data/data-import.md`). Backup/restore is the system-level
  recovery path.
- **Count-type vocabulary is extensible but only `SELECTED` exists** (no
  full-inventory "ALL" session type, no blind-count mode).
- A stale finalization requires manual recounts — by design; nothing is
  auto-rebased and nothing is force-finalized.
- No PDF/print sheet generation and no barcode scanning; counting is manual
  data entry.
