# Business Reports — Financial Semantics, Windows, and Exports

**Status:** Prompt 50 + Prompt 51 · **Authority:** implementation (code is the law)
**Scope:** `/api/v1/reports/*` (summary, export, monthly, aging, performance,
inventory-valuation), `src/lib/reports.ts`, `src/lib/reports-advanced.ts`,
`src/lib/report-performance.ts`, `src/lib/report-periods.ts`,
`src/lib/inventory-valuation-report.ts`, `src/modules/reports/*`,
`src/lib/ai/snapshot.ts`.

---

## 0. The one-paragraph honest summary

Every figure in the Reports module is computed by the SERVER from recorded
transactions, in integer minor units, inside business-local date windows.
Revenue means **issued invoices on their issue date**. Cash means **actual
Payment rows on their payment date**. Expenses mean **recorded Expense rows
on their spentAt date**. Inventory value is an **operational current-cost
estimate** (quantity × current product cost price). `netAccrualMinor` is
**issued revenue minus recorded expenses** — it is NOT net profit, not a
P&L, and includes no COGS. The AI copilot receives these figures
pre-formatted and may narrate them, never compute them.

## 1. Metric authorities (unchanged from the financial-semantics audit)

| Metric | Authority | Basis date | Never is |
|---|---|---|---|
| Revenue issued | `SUM(Sale.totalMinor)`, non-deleted, in window | `issueDate` (business-local day) | cash received; a SalesOrder; a SalesQuotation |
| Cash collected | `SUM(Payment.amountMinor WHERE direction=IN)` in window | `paidAt` | derived from invoice totals; `Sale.paidMinor` |
| Cash paid out | `SUM(Payment.amountMinor WHERE direction=OUT)` in window | `paidAt` | derived from expense totals; `Expense.paidMinor` |
| Net cash flow | collected − paid out | — | accrual anything |
| Expenses recorded | `SUM(Expense.amountMinor)` non-deleted, in window | `spentAt` | cash paid; a second count of a posted SupplierBill |
| Revenue less recorded expenses | `netAccrualMinor` (field preserved) | — | net profit / P&L / gross margin / COGS |
| Receivables / payables | Sale / Expense authority (open statuses) | — | SupplierBill as a second payable |
| Inventory value | `Σ Product.stockQty × Product.costPriceMinor` | current | accounting asset value; FIFO/LIFO/WAC; COGS |

A posted SupplierBill produces **one** linked Expense; that Expense is the
sole financial row the reports count. Goods Dispatch/Receipt/Return rows are
never revenue, expense, or payment.

## 2. Reporting windows (Prompt 50 — `lib/report-periods.ts`)

**The one date authority.** Every report window comes from
`src/lib/report-periods.ts`:

- **L1 — local keys**: a business-local date is exactly `YYYY-MM-DD`
  (strict; real calendar dates only; 2000–2100). User-facing `from`/`to`
  are INCLUSIVE local dates.
- **L2 — exact instants**: database queries use `gte` = the start of
  `from`'s local day and exclusive `lt` = the start of the local day AFTER
  `to`. Local-day instants come from Intl offset arithmetic with a verified
  fixpoint (`zonedDayStartUtc`) — a local day may be 23h, 24h, or 25h
  (DST); fixed-millisecond stepping is never used.
- **L3 — no client timezone**: the timezone is the authenticated
  business's persisted `timezone`. The browser is never an authority.
- **L4 — future exclusion**: rolling windows end on the CURRENT
  business-local date; future-dated records can never enter a report
  (KPIs, timeline, monthly buckets, drill-downs). A custom range ending in
  the future clamps its effective end to today; a wholly-future range is
  rejected (422 `INVALID_REPORT_RANGE`).
- **L5 — comparison windows**: the previous period is the N business-local
  dates immediately before the current window — exactly N dates, no
  overlap, no gap, verified across month/year boundaries and DST
  transitions (unit harness §5).
- **L6 — custom-range cap**: newly introduced custom-range advanced
  reports accept at most **366 local calendar days** (`from ≤ to`).

### Preserved endpoint parameters

- `GET /api/v1/reports/summary?days=7|30|90` — unchanged; invalid values
  still normalize to 30.
- `GET /api/v1/reports/monthly?months=3|6|12` — unchanged; month keys are
  business-local calendar months, ordered oldest → newest; the current
  (partially elapsed) month is included and ends at end-of-today.
- `GET /api/v1/reports/monthly/[month]` — `YYYY-MM` strict (2000-01..2100-12).

## 3. Reconciliation laws (Gates)

| Law | Statement |
|---|---|
| Gate B | Future-dated rows are excluded from every completed window (verified with future Sale/Expense/Payment fixtures). |
| Gate C | `SUM(timeline.revenueMinor) == kpis.revenueMinor`, and likewise for expenses/collected/paidOut — same window, same bucketing. |
| Gate D | Comparison windows contain exactly N local dates each; `previous.toKey == current.fromKey − 1 day`. |
| Gate E | Products aggregate by **stable productId**. Two catalog products with identical display names never merge; a rename never splits one product (live name is reported; SaleItem snapshots stay intact for history). Unlinked lines (`productId` null) are a separate `kind: "unlinked"` aggregate keyed by the historical snapshot name — never merged into catalog identities, never dropped. |
| Gate F | Customers aggregate by **customerId**. Same-name customers stay distinct; drill-downs navigate by id (`#/customers/<id>`). |
| Gate G | The category donut shows the top 6 categories **plus a server-computed "Other" bucket**: `SUM(top categories + Other) == kpis.expensesMinor` exactly, so every displayed percentage is a share of ALL expenses in range. |
| Gate H | The monthly dialog shows a bounded, DISCLOSED preview (`preview.sales/expenses = {totalCount, displayedCount, hasMore}`); the monthly CSV exports ALL qualifying rows (bounded keyset chunks) or REJECTS with 413 `EXPORT_TOO_LARGE` — never a silent 25-row prefix. |
| Gate K | One Payment row = one cash movement. Cash-flow rows are actual `Payment` records (date, direction, amount, method, safe sale/expense reference); `paidMinor` summaries are never added on top; the cash-flow page NEVER computes its totals (DB aggregates over the whole window). |
| Gate L | A SupplierBill-linked Expense is counted once. |
| Gate M | SalesOrders and SalesQuotations are never issued revenue. |
| Gate O | All aggregation arithmetic guards the safe-integer range (`safeAdd`/`safeMul`/BigInt allocation); corrupt money raises a controlled integrity error (500 envelope) instead of a silently wrong figure. |

## 4. Product discount allocation (advanced performance report)

`Sale.totalMinor` may differ from `Σ SaleItem.lineTotalMinor` by the
document-level discount. The sales performance report (`groupBy=product`)
reports BOTH bases, explicitly:

- `lineValueMinor` — line value **before** the invoice-level discount.
- `netValueMinor` — exact proportional allocation of `Sale.totalMinor`
  across lines: BigInt largest-remainder, ties resolved by stable
  `SaleItem.id` ascending. Per invoice: all allocated values are
  non-negative integers and **sum exactly to `Sale.totalMinor`**.
- Corrupt invoices (negative line/total, zero-line non-zero-total,
  non-integer money) raise `ReportIntegrityError` — the API fails with a
  500 envelope; nothing is silently normalized.
- `discountBasis: "net_allocated"` documents the law in the DTO and CSV.

## 5. Performance report endpoints (ADVANCED_REPORTS)

```
GET /api/v1/reports/performance?kind=sales|expenses|cashflow
        &from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=<closed>&limit=&cursor=&direction=
GET /api/v1/reports/performance/export?kind=&from=&to=&groupBy=
```

- **Entitlements (server-side, both routes):** `data:read` permission AND
  `ADVANCED_REPORTS`. The export additionally enforces `CSV_EXPORT`
  (the single established CSV entitlement — no new ones).
- **Closed groupings:** sales → `product | customer | day | month`;
  expenses → `category | supplier | day | month`. Any other value → 422.
- **Bounded law:** source scans take ≤ `PERFORMANCE_ROW_CAP` (20,000) rows
  (+1 to detect overflow); when the cap trips, JSON responses carry
  `truncated: true` and totals cover only the scanned subset (labeled);
  the CSV **rejects** (`413 EXPORT_INCOMPLETE`). Group rows cap at
  `PERFORMANCE_GROUP_CAP` (500) with `groupTruncated: true`. Caps are
  env-tunable (P49 `envCap` convention) for harnesses only.
- **Cash-flow pages:** keyset pagination on `(paidAt DESC, id DESC)` with
  an HMAC-signed opaque cursor bound to tenant+kind+range+direction. A
  foreign/tampered/garbage cursor → 422. `nextCursor: null` = end.
- **Range:** strict custom local dates, ≤ 366 days, from ≤ to,
  future-only rejected (422 `INVALID_REPORT_RANGE`).
- **Responses:** private, `Cache-Control: no-store`, standard envelope.

## 6. Exports (complete or reject)

All report CSV routes: shared `csvCell` escaping (formula-injection
protection), UTF-8 BOM, CRLF, stable column order, `no-store`, safe
`content-disposition` filenames, `CSV_EXPORT` entitlement, 10/5min rate
limit, `data.export` audit, tenant scope, minor→decimal conversion only at
serialization.

| Route | Completeness contract |
|---|---|
| `/api/v1/reports/export` | Aggregate sections only (summary is the detail scope). |
| `/api/v1/reports/monthly/[month]/export` | ALL month rows via `buildMonthDetailComplete` (keyset chunks of ≤400, cap `MONTH_EXPORT_MAX_ROWS` = 5,000/section → 413). KPI block reconciles with its own rows. |
| `/api/v1/reports/performance/export` | Group rows within `PERFORMANCE_EXPORT_MAX_ROWS` (5,000) → 413 beyond; truncated scans → 413. |
| `/api/v1/reports/aging/*` | Prompt 49 law unchanged. |

## 7. AI grounding compatibility

`buildCopilotGrounding` consumes `buildReportSummary` and keeps the
existing section names. Prompt 50 changes are additive only:

- `topProducts[]` rows gain `productId/kind/unit/sku/invoiceCount`
  (name/qty/revenueMinor preserved).
- New `expensesByCategoryOther`, `expensesByCategoryTotalMinor`,
  `expensesCategoryCount` fields.
- The AI snapshot key `profitIssuedBasis` was RENAMED to
  `revenueLessRecordedExpensesIssuedBasis` with an explicit rule (6b)
  forbidding profit/P&L framing and inventory-valuation claims.

## 8. Known limitations (honest)

- No COGS, no gross margin, no formal P&L, no ledger. Inventory value is
  an operational estimate at CURRENT cost prices.
- Performance source scans cap at 20k rows per report (truthful
  `truncated` marker + CSV rejection) — a business would need ~55
  invoices/day for 366 days to reach it.
- Category labels are the CURRENT persisted `Expense.category` values;
  there are no historical category snapshots (a renamed category
  re-buckets history under its current label — documented, not invented).
- The monthly CSV KPI block derives collected/paidOut from Payment
  aggregates (never invoice totals) so the two bases stay labeled and
  separate.

## 9. Detailed inventory valuation report (Prompt 51)

`GET /api/v1/reports/inventory-valuation` and
`GET /api/v1/reports/inventory-valuation/export` — the row-level truth
behind the summary's `inventory.valueMinor` KPI. ADR 0051 is the design
record; the operative laws:

- **Valuation basis (the only one this report may claim):**
  `operationalEstimatedValueMinor = stockQty × costPriceMinor` per product
  via `safeMul`, summed via `safeAdd`. A **current operational estimate**
  built from two current, mutable fields — NOT a historical valuation,
  NOT a balance-sheet asset value, NOT FIFO/LIFO/weighted-average,
  NOT COGS, NOT profit. The cost price is mutable with no history, so the
  report offers NO "as of" selector and never reconstructs past costs.
- **Product inclusion (the reconciliation contract):** `businessId` +
  `deletedAt: null`, INCLUDING inactive products (they can still hold
  stock). With default filters the report total reconciles EXACTLY with
  `summary.inventory.valueMinor` (verified live, Gate D).
- **Cost-quality semantics:** zero current cost is a MEASURED state
  (free samples/promotional/intentional zeros are valid) — the report
  counts "positive stock with zero current cost" and surfaces a neutral
  review notice; it never rewrites costs, infers reasons, or suggests a
  purchase price. Negative stock is a truthful `NEGATIVE_STOCK` row with
  a (possibly negative) honest value and a data-quality count. A negative
  cost price is financial corruption → controlled integrity error.
- **Closed filters (422 on anything else):** `q` (≤80 chars, name OR SKU,
  case-insensitive), `costState=ALL|POSITIVE_COST|ZERO_COST`,
  `stockState=ALL|POSITIVE_STOCK|ZERO_STOCK|LOW_STOCK` (LOW = 0 < qty ≤
  lowStockAt, matching the low-stock alert convention),
  `activity=ALL|ACTIVE|INACTIVE`,
  `sort=VALUE_DESC(default)|VALUE_ASC|NAME_ASC|NAME_DESC|QUANTITY_DESC|QUANTITY_ASC|COST_DESC`,
  `page ≥ 1`, `pageSize 1..100` (default 25). `businessId` is NEVER a
  client parameter — scope comes from `getAuthContext()`.
- **Bounded complete scan:** the whole matching set is read in id-ordered
  chunks of ≤500 up to `INVENTORY_SCAN_CAP` (50,000, envClamped);
  over-cap → 413 `REPORT_TOO_LARGE` (never a partial total posing as
  complete). Sorting/aggregation happen server-side over the complete
  set with the stable `id` tie-break; JSON pages are slices. Page-number
  pagination is used (no cursor): the complete set is scanned inside one
  request, so there is no resumable scan for a cursor to anchor.
- **No cross-unit quantity totals:** products use pieces/kg/meters/hours;
  the UI sums MONEY only, quantities stay per-row.
- **Authorization:** `data:read` (a drill-down of the BASIC summary KPI —
  no `ADVANCED_REPORTS` gate; no new entitlement). The export enforces
  the existing `CSV_EXPORT` server-side, uses the shared 10/5min export
  limiter + `data.export` audit, and is complete-or-reject:
  `INVENTORY_EXPORT_MAX_ROWS` (10,000, envClamped) → 413
  `EXPORT_TOO_LARGE` beyond. CSV columns include product id/name/sku/
  unit/qty/unit-cost/estimated-value/active/cost-state/stock-state, a
  meta block (basis + limitation), and a summary section reconciling
  with the exported rows only.
- **UI:** Reports → Inventory health → "Detailed valuation"
  (`#/reports?inventory=1`, deep-linkable, back/forward safe). Server
  sorts (no client-side page sorting), stable-id product navigation
  (`#/products/<id>`), summary cards labeled as reflecting the current
  filters, valuation-basis disclosure always visible, EN/FA + RTL +
  light/dark + responsive.
