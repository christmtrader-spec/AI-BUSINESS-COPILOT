# ADR 0040 — Inventory Stocktake as a Controlled Count Session over Existing Adjustment Semantics

- **Status:** Accepted
- **Date:** 2026-10 (Prompt 40)
- **Deciders:** Product/engineering (single implementer, ratified spec)

## Context

Small businesses need to periodically verify that recorded stock
(`Product.stockQty`) matches the physical shelf and correct it when it does
not. The repository already has the ingredients: a per-business product
catalog with a single `stockQty` integer, an `InventoryAdjustment` row type
(signed `delta` + `reason` + `actorId`) as the sanctioned way quantities
change outside sales, and a strict "not an accounting system" product law —
no ledger, no journal, no valuation layers (ADR 0039, Prompt 17 audit).

The feature must therefore decide how a physical count is modeled, how the
count-time baseline is captured, and how reconciliation happens **without**
becoming an inventory-valuation or accounting subsystem.

## Decision

1. **Two-model design:** `InventoryStocktake` (one count session: reference
   2–80 unique per business, closed status, closed countType, optional notes
   ≤ 2000, lifecycle timestamps) + `InventoryStocktakeLine` (one product
   counted within the session; `@@unique([stocktakeId, productId])`; count
   snapshot, counted value, derived variance, counter identity, count-time
   product metadata snapshot). A DB-level migration adds both additively.
2. **Count snapshot at count time, server-side:** `systemQtyAtCount` is
   ALWAYS the server-read `Product.stockQty` at the moment the count is
   recorded. The client supplies only `countedQty` (integer 0..1e9); variance
   is server-derived (`counted − system`, sign meaningful). Lines are
   DRAFT-only preparation until counting starts; counts are allowed in
   `COUNTING` and `REVIEW` (recount replaces the line in place, audited with
   before/after).
3. **Server-authoritative lifecycle:** `DRAFT → COUNTING → REVIEW →
   FINALIZED/CANCELLED` with `REVIEW → COUNTING` reopen; every transition is
   a dedicated endpoint (start/review/reopen/finalize/cancel); invalid
   transitions fail 422. `FINALIZED`/`CANCELLED` are terminal and immutable.
4. **Stale-count rejection, never auto-rebase:** finalize re-checks every
   line's snapshot against the CURRENT `stockQty` (and product active/not
   deleted) inside the finalization transaction; any drift rejects the whole
   finalization with 409 `STOCKTAKE_STALE_COUNT` and lists the affected
   products for recount. The variance is never silently rebased to absorb
   post-count movements.
5. **Atomic finalization through existing `InventoryAdjustment`
   semantics:** one transaction — verify → stale-check → for each non-zero
   variance create an `InventoryAdjustment` (`delta = varianceQty`, reason
   `Stocktake <reference>: physical count reconciliation`) and set
   `stockQty` to the counted value; zero-variance lines create no adjustment;
   mark `FINALIZED`; one workflow-level audit row (the adjustment ledger is
   the per-line quantity history). No partial finalization is representable.
6. **Selected-product scope only:** the closed `STOCKTAKE_COUNT_TYPES`
   vocabulary contains exactly `SELECTED`; a per-session line cap
   (`INVENTORY_STOCKTAKE_MAX_LINES`, default 1000, clamped 100–5000) bounds
   session size.
7. **No accounting postings:** no ledger/journal/double-entry, no COGS, no
   inventory valuation history or cost layers, no expense/revenue/profit
   booking of the variance. Inventory *value* moves only because `stockQty`
   moves (existing `stockQty × costPriceMinor` convention).
8. **No notification type:** finalize creates no notification and triggers no
   direct low-stock alert; the scheduled Prompt 38 processor remains the sole
   low-stock authority. The notification catalog is unchanged.
9. **No warehouse/location model:** the product's single `stockQty` is the
   only quantity that exists; no warehouse/bin/batch dimensions are added.
10. **No finalized-stocktake import:** stocktake datasets are export-only
    (CONFIDENTIAL, lines auto-included with their session); importing a
    physical reconciliation would replay stock mutations. Backup/restore is
    the system-level recovery path.
11. **Backup/restore/verify coverage:** the models live in the single SQLite
    file (covered by `backup-db.mjs` + verification by construction), and
    `restore-drill.mjs`'s read-only smoke entity list includes
    `InventoryStocktake` + `InventoryStocktakeLine` (13 entities; older
    backups are reported honestly, never a drill failure).

## Alternatives rejected

### Alternative A — a persistent stock-balance snapshot table

A dedicated "stock balance history" table maintained alongside
`Product.stockQty` was rejected: it creates a **second source of truth** that
must be reconciled with every existing quantity mutation (sales, adjustments,
import), drift becomes inevitable, and every write path would need
transactional maintenance. The line's `systemQtyAtCount` is a frozen
count-time *fact*, not a maintained balance — exactly the snapshot semantics a
stocktake needs, with zero ongoing consistency cost.

### Alternative B — full-inventory forced counts

A count type that sweeps every product in the business was rejected: the line
cap exists to bound transaction size and abuse, and operationally a
shelf-by-shelf partial count is how small businesses actually count. Full
coverage can be expressed as successive `SELECTED` sessions.

### Alternative C — auto-rebase of variance at finalize

Adjusting each variance by the stock movements that happened after counting
(rebase) was rejected: it would **silently overwrite legitimate post-count
movements** — e.g. a recount with snapshot 10 and current 19 would book a
variance against 19 without anyone counting 19. Rejection + forced recount
keeps every applied number traceable to an actual human count.

### Alternative D — a generic PATCH status endpoint

`PATCH /stocktakes/[id] { status: … }` was rejected: status transitions carry
side conditions (start requires ≥ 1 line; review requires every line counted;
finalize requires REVIEW + stale-check + reconciliation). A generic endpoint
invites client-driven state, split validation, and non-atomic application.
Dedicated transition endpoints keep the server the only authority.

### Alternative E — direct low-stock notification from finalize

Emitting low-stock alerts synchronously during finalization was rejected: the
Prompt 38 processor owns notification identity, deduplication and budgets; a
parallel inline path would bypass that idempotency and duplicate the alert
type. Finalize writes quantities; the next scheduled run reports them.

## Consequences

- (+) Quantity truth remains single-source (`Product.stockQty`), with the
  existing `InventoryAdjustment` ledger explaining every change — a stocktake
  is auditable with zero new financial semantics.
- (+) The stale-check makes "count and finalize" safe on a live business:
  racing sales are caught, not clobbered.
- (+) Additive migration only; no new permission, no new notification type,
  no AI/search integration.
- (−) A drifted count cannot be force-finalized: the operator must recount
  the affected lines (deliberate friction).
- (−) Single-location only; multi-warehouse counting would need a location
  dimension on both products and lines (out of scope).
- (−) No count-sheet printing, barcode scanning, or blind-count mode; the
  UI assumes online data entry.
