# ADR 0044 — Goods Dispatch (Outbound Inventory)

- **Status**: Accepted
- **Date**: 2026-10-10
- **Prompt**: 44
- **Supersedes**: none
- **Depends on**: ADR 0040 (stocktake), ADR 0041 (purchase orders), ADR 0042
  (goods receipts), ADR 0043 (goods returns)

## Context

After P42 (inbound receipts) and P43 (returns to supplier) the inventory
ledger had no OUTBOUND document. Sales invoices record money, not
physical movement; manual adjustments are corrections, not shipments. A
business cannot answer "where did these units go?" for customer
deliveries, samples, or branch transfers.

## Decision

Introduce `GoodsDispatch` + `GoodsDispatchLine` as the outbound mirror of
the receiving/return documents, under the SAME audited law set:

1. **Physical, not financial.** Posting decrements `Product.stockQty` and
   writes exactly ONE negative `InventoryAdjustment` per line. The
   document contains NO money. Sales/Receivables/Expenses/Payments are
   provably untouched (E2E-enforced with NON-ZERO before/after snapshots).
2. **The product is the source.** Outbound flows are not chained to a
   purchase-order document; the tenant-scoped Product row and its CURRENT
   aggregate stock are the quantity authority at POST time (aggregate-stock
   trade-off, documented as in P40/P42/P43 — no lot/batch provenance).
3. **DRAFT → POSTED (immutable) / DRAFT → CANCELLED (terminal).** Drafts
   mutate nothing. POSTED is final — corrections happen through new
   documents or authorized adjustments, never by rewriting history.
4. **Optional customer link with `ON DELETE SET NULL`** plus a frozen
   `customerNameAtDispatch` snapshot — deleting or renaming a customer
   never rewrites dispatch history.
5. **One line per product per dispatch** (DB-enforced unique constraint) —
   duplicate attempts are a 409, and the winning row is authoritative.
6. **All P43 hardening laws from day one** (not retrofitted):
   - safe-integer arithmetic everywhere; stored qty 0 is corruption;
   - `cap+1` read completeness with the THREE-invariant validator
     (count mismatch below the cap NEVER passes);
   - 422 (legitimately full draft) vs 500 `*_LINE_CAP_INVARIANT`
     (already-corrupted document) classification split on every path;
   - availability re-verified INSIDE the post transaction; negative
     persisted stock is corruption (500), not "insufficient" (409);
   - business-timezone day windows composed from the ESTABLISHED helpers;
   - unknown persisted statuses/reason codes are NEVER silently mapped.
7. **One shared write transaction.** Dispatch writes run through the same
   FIFO-serialized `withWriteTransaction` as P40/P41/P42/P43 — no lost
   updates against receipts, returns, manual adjustments or stocktake
   finalization (proven live by the isolated concurrency suite).
8. **Export-ONLY data portability.** The business-export covers both
   datasets (CONFIDENTIAL); import is intentionally blocked — a generic
   import could replay negative inventory movements (the P42/P43 law).

## Consequences

- The inventory movement ledger is now complete: receipts in, returns to
  suppliers out, dispatches out to customers, stocktakes verify, manual
  adjustments correct.
- Product and Customer 360 surfaces gain bounded, money-free dispatch
  history.
- Low-stock signals now cover the outbound path (a dispatch can push a
  product below its threshold; the established processor surfaces it).
- Still intentionally OUT of scope (unchanged platform boundaries): sales
  orders / fulfillment pipelines, lot/serial/expiry provenance, multi-
  warehouse/bin transfers, valuation layers, financial posting of any
  kind.
- New stable error codes join the documented API contract
  (`GOODS_DISPATCH_*` family).

## Verification

- Unit: 256 pure-law assertions (quantities, sums, completeness
  invariant, availability, stock arithmetic + classification split,
  timezone windows, zod boundaries, i18n parity, export/DTO shapes).
- E2E: 158 live checks (RBAC, tenant isolation both directions, full
  lifecycle, exact decrement + ONE adjustment, atomic rollback,
  stale-draft gate, financial non-mutation with NON-ZERO fixtures,
  corruption → 500 with recovery, timezone filters, widgets, search,
  CSV EN/FA + injection + entitlement, business export + import
  rejection, teardown to ZERO).
- Isolated concurrency (GOODS_DISPATCH_MAX_LINES=20): 40 checks —
  20-line cap, over-cap corruption 500 with zero mutation, 8-way
  duplicate-line race, 70+70 over-dispatch race (one winner, exact −70,
  never negative), 6-way same-post race (one transition/audit/adjustment),
  same-reference race, dispatch + manual-adjustment interleave exact
  arithmetic, domain errors never retried.
- Static scan: 150 rules over the whole surface (all green).
- Browser QA: full EN light + FA RTL dark lifecycle at 1920/390
  (create → picker → qty → post confirm → posted → stock 60→48→1 exact →
  widgets → CSV), zero console errors, no horizontal overflow, teardown
  to zero residue.
