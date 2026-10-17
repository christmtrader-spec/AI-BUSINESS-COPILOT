# ADR 0051 — Detailed Inventory Valuation & Cost Data Quality Report

**Status:** Accepted (Prompt 51)
**Context:** The Reports module (Phases 04/06, hardened by Prompt 50) shows a
single inventory KPI — an *operational estimate* computed as
`Product.stockQty × Product.costPriceMinor` (`summary.inventory.valueMinor`).
Prompt 51 makes that estimate transparent: a detailed, searchable, paginated,
exportable valuation report with explicit cost-quality semantics. This phase
is deliberately **read-only reporting** over existing Product data.

## Decision

1. **Valuation basis (§3.1)** — for every included product the report
   computes `operationalEstimatedValueMinor = safeMul(stockQty, costPriceMinor)`
   using the shared safe-integer helpers (`src/lib/report-periods.ts`).
   This is a **current operational estimate** built from two *current mutable
   fields*. It is NOT a historical valuation, NOT a balance-sheet asset value,
   NOT FIFO/LIFO/weighted-average, NOT COGS, NOT gross/net profit, and NOT a
   ledger posting. Every user-facing surface labels it "operational estimate"
   (EN) / "برآورد عملیاتی" (FA).

2. **Historical-cost limitation (§3.2)** — `Product.costPriceMinor` is a
   mutable current field with no history. Changing a product's current cost
   changes the operational estimate even when stock has not moved, so the
   report **cannot** answer "what was inventory worth on date X". No "as of"
   selector is offered; past unit costs are never reconstructed from
   purchases, bills, sale prices, or heuristics. A cost-history/valuation
   layer would require a separate design decision and is out of scope.

3. **Cost-quality semantics (§3.3)** — rows carry closed-vocabulary states:
   - `stockState`: `POSITIVE_STOCK` (> 0) · `LOW_STOCK` (0 < qty ≤ lowStockAt)
     · `ZERO_STOCK` (= 0) · `NEGATIVE_STOCK` (< 0, a truthful data-quality
     state for negative recorded stock — never silently clamped to zero).
   - `costState`: `POSITIVE_COST` (> 0) · `ZERO_COST` (= 0).
   A **zero current cost is NOT treated as an error**: zero may be a free
   sample, promotional stock, or an intentional configuration. The report
   counts `zeroCostPositiveStockCount` ("positive stock with zero current
   cost") and surfaces a neutral review notice. It never rewrites costs,
   never infers reasons, and never manufactures a purchase price.

4. **Excluded forever (§3.4)** — historical cost layers, FIFO/LIFO/WAC,
   COGS, formal P&L, general ledger, double-entry, inventory asset
   recognition, automatic cost correction, automatic expense creation,
   automatic supplier-bill/payment mutation. None of these exist after
   Prompt 51 and nothing in the UI/API implies they do.

5. **No schema migration (§3.5)** — the report is a projection of existing
   columns. No new tables, columns, indexes, or migration were needed.

6. **Product inclusion rules (§5.4)** — identical to the existing summary
   (the reconciliation authority, `src/lib/reports.ts`): scope
   `businessId` + `deletedAt: null`, **including inactive products**.
   Rationale: an inactive product can still hold stock; silently omitting
   it would understate the operational estimate. The `activity` filter
   (ALL | ACTIVE | INACTIVE) defaults to ALL, so the unfiltered report
   total reconciles **exactly** with `summary.inventory.valueMinor`
   (Gate D). Soft-deleted products are excluded everywhere; inactive rows
   carry `isActive: false` so their state is visible.

7. **API (§5)** — `GET /api/v1/reports/inventory-valuation` and
   `GET /api/v1/reports/inventory-valuation/export`, inside the existing
   Reports route family. Closed-vocabulary, server-validated filters:
   `q` (≤ 80 chars, name OR SKU, case-insensitive), `costState`
   (ALL | POSITIVE_COST | ZERO_COST), `stockState`
   (ALL | POSITIVE_STOCK | ZERO_STOCK | LOW_STOCK), `activity`
   (ALL | ACTIVE | INACTIVE), `sort` (VALUE_DESC default | VALUE_ASC |
   NAME_ASC | NAME_DESC | QUANTITY_DESC | QUANTITY_ASC | COST_DESC),
   `page` (≥ 1), `pageSize` (1..100, default 25). Malformed/out-of-range
   values → 422 VALIDATION_ERROR. `businessId` is never accepted from the
   client — scope comes from `getAuthContext()` membership resolution.
   Authorization: `data:read` (a basic-report drill-down — the summary KPI
   it explains has no ADVANCED_REPORTS gate, so neither does this detail;
   no new entitlement is created). The export enforces the existing
   `CSV_EXPORT` entitlement server-side.

8. **Bounded complete scan, not cursor pagination (§6)** — the whole
   matching product set is scanned in bounded id-ordered chunks and held
   up to `INVENTORY_SCAN_CAP` (envCap default 50,000, clamped). Aggregates
   are computed over the complete scanned set; sorting happens server-side
   over that set with the stable `id` tie-break; the JSON page is a slice.
   Over-cap businesses receive a controlled 413 `REPORT_TOO_LARGE` — never
   an apparently-complete partial total. HMAC cursors are NOT used here:
   there is no resumable scan to anchor (the complete set is read inside
   one request), so page-number pagination over the deterministic sorted
   set is strictly safer against dup/skip. `INVENTORY_EXPORT_MAX_ROWS`
   (envCap default 10,000) bounds exports; an over-cap export is REJECTED
   with 413 `EXPORT_TOO_LARGE` — complete-or-reject, never a prefix file.

9. **No cross-unit quantity totals (§4.3)** — products use pieces, kg,
   meters, hours… A grand "total quantity" across incompatible units is
   meaningless and is NOT shown. Quantities appear per row (and per unit
   group if ever needed); the value KPI is money and is always summed.

10. **Rate limits / caching / audit (§5.6)** — JSON 30/min/user+business;
    export 10/5min/user (the shared `report-export:` limiter). Both
    responses are `private, no-store`. The export audits `data.export`
    like every other CSV route. CSV conventions preserved: UTF-8 BOM,
    CRLF, `csvCell` formula-injection guard, safe attachment filename,
    stable column order, and a summary section that reconciles with the
    exported rows only (labeled as the current operational estimate).

11. **Read-only law (§10/§11)** — the report and its export contain no
    mutations: no stock changes, no cost updates, no adjustments, no
    financial documents. Verified by before/after DB snapshots in the
    integration suite.

12. **AI compatibility (§12)** — the AI snapshot already carries the
    inventory estimate with the Prompt 50 anti-mislabeling rule
    ("operational current-cost estimate, not an accounting asset value").
    No snapshot change was needed; no new quota source; UsageService
    untouched.

## Consequences

- The single summary KPI becomes explainable row-by-row, filterable, and
  exportable, with the summary/detail reconciliation as a tested contract.
- Zero-cost stock becomes *visible* without being criminalized — the
  report distinguishes "measured zero" from "unknown history" and never
  recommends inventing costs.
- Product identity is stable (`id`): duplicate names never merge, renames
  never split; navigation uses entity routes, never display names.
- Large catalogs stay safe: bounded scans, controlled over-cap errors,
  and honest export rejection replace silent truncation.

## Verification (executed this round — real commands, real counts)

- Unit (`bun scripts/prompt51-inventory-valuation-unit.ts`): **120 passed /
  0 failed** — row states, all filter combinations, all 7 sorts with
  id tie-breaks, exact aggregates + reconciliation, overflow integrity,
  query parsing bounds, EN/FA parity incl. anti-P&L/valuation wording.
- E2E (`bun scripts/prompt51-inventory-valuation-check.mjs`): **71 passed /
  0 failed** — auth 401, exact totals (17,100 fixture), counts, row/total +
  summary reconciliation (Gate D), identity, inactive inclusion, zero-cost
  honesty, negative honesty, no-store, every filter, 422 validation probes,
  all sorts, pagination no-dup/skip, complete CSV bytes (BOM/CRLF/guard),
  CSV_EXPORT=false → 403 while JSON stays 200, read-only before/after
  snapshots, cross-tenant isolation (both directions, JSON + CSV),
  teardown to zero residue.
- Cap (`INVENTORY_SCAN_CAP=100 INVENTORY_EXPORT_MAX_ROWS=10 bun
  scripts/prompt51-inventory-valuation-cap-check.ts`): **18 passed /
  0 failed** — over-scan controlled rejection, at-cap completeness,
  export cap reject/complete, pagination no-dup/skip at the cap, envCap
  clamps.
- Static (`bun scripts/prompt51-inventory-valuation-static-scan.mjs`):
  **44 passed / 0 failed** — tenant scope, safe money, single calculation,
  entitlement (only CSV_EXPORT in the export route), complete-or-reject,
  no mutations, no accounting claims, closed vocabularies, no-store,
  rate limits + audit, no new billing surface, bounded reads,
  projection hygiene, stable-id navigation, deep-link guards.
- i18n audit: 2,816 key usages, 0 missing, 0 parity gaps.
- Real browser QA (agent-browser): 9 screenshots —
  qa-p51-inventory-en-light (1920×1080), qa-p51-inventory-en-dark (1920),
  qa-p51-inventory-en-light-1366 (1366×768), qa-p51-inventory-fa-rtl-light,
  qa-p51-inventory-fa-rtl-dark, qa-p51-inventory-mobile-fa-dark (390×844),
  qa-p51-inventory-mobile-en (412×915), qa-p51-inventory-mobile-en-360
  (360×800). Interactions verified: deep link `#/reports?inventory=1`,
  entry button, back button, search (2 alphas + "Cards reflect the
  current filters"), no-match + Clear filters reset, pagination 1→2
  (27 products), complete CSV download (27 rows, BOM, formula guard,
  reconciling summary), CSV_EXPORT=false → live 403 (network-verified)
  with the localized toast, product drill-down by stable id to
  `#/products/<id>`, business switching → tenant-scoped refetch
  ($462.55/27 ↔ $0.00/0), zero console errors, zero horizontal overflow
  at 1920/1366/412/390/360.
- Platform: `bunx tsc --noEmit` 0 errors; `bun run lint` 0 problems;
  `prisma validate` OK; migrations 29/29 (unchanged — NO new migration);
  SQLite `quick_check` ok; `foreign_key_check` 0 violations.
- Regression (all executed this round): P50 unit 148/0 · P50 check 93/0 ·
  P50 cap 12/0 · P50 static 49/0 · P49 unit 71/0 (server-only shim
  preload) · P49 check 108/0 · P48 check 212/0 · P39 statement 117/117 ·
  payables-aging 39/0 · e2e-smoke 90/90.
