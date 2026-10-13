# Data Export — Customer Reference (Prompt 31 §137)

> The Data Portability center lives at **`#/data`** (Business settings →
> Data portability). Only business **owners and admins** can create or
> download exports. This document matches the implementation
> (`src/lib/data-portability/`) as of Prompt 31.

## What an export is

An export is a **portable copy of your business data** — a documented
dataset you can open in a spreadsheet, archive, or hand to another tool.
It is **not a database backup** and not a restore point: exporting never
deletes or modifies any data.

## Formats

| Format | What you get | Best for |
| --- | --- | --- |
| **JSON** | one `.json` file: `{ manifest, datasets }` — amounts as exact integer minor units | systems, archiving, lossless relationships |
| **CSV** | a `.zip` package: `manifest.json` + one CSV per dataset — amounts as exact decimal strings | spreadsheets, human review |

CSV files are UTF-8 (with BOM) and formula-injection-safe: values that
spreadsheet applications could execute as formulas are prefixed with `'`
so they stay plain text.

## Datasets (exportSchemaVersion **1**)

| Dataset key | Contains | Sensitivity |
| --- | --- | --- |
| `business` | name, slug, currency, precision, locale, timezone, createdAt | Public business |
| `members` | member email, name, role, status, joinedAt | Confidential |
| `customers` | id, name, phone, email, address, note, deletedAt, timestamps | Confidential |
| `suppliers` | same shape as customers | Confidential |
| `products` | id, name, sku, unit, sale/cost price (minor units / decimals), stockQty, lowStockAt, isActive, timestamps | Confidential |
| `inventory` | recorded stock adjustments (productId, delta, reason, createdAt) | Confidential |
| `sales` | invoice number, customer reference, subtotal/discount/total/paid (minor), status, dates | Confidential |
| `sale_items` | line items (saleId, productId, name, unit, qty, unit price, line total) — **auto-included with sales** | Confidential |
| `expenses` | supplier reference, category, amount/paid (minor), status, spentAt | Confidential |
| `payments` | tenant finance payments (sale/expense reference, direction, amount, method, paidAt) | Confidential |
| `crm_leads` | CRM leads (Prompt 35 §86): contact, source, status, note, assignee/customer ids, convertedAt, deletedAt | Confidential |
| `crm_opportunities` | CRM opportunities (Prompt 35 §86): stage, probabilityPct, expectedValue (minor), currency, links, lost/won metadata, deletedAt | Confidential |
| `crm_activities` | CRM activities (Prompt 36 §62): type, title, description, occurredAt, durationMinutes, context ids, createdBy, deletedAt | Confidential |
| `crm_tasks` | CRM tasks (Prompt 36 §62): status, priority, dueAt, completedAt, reminder configuration (reminderEnabled, reminderMinutesBefore, overdueAlertEnabled — Prompt 37 §151), context ids, assignee, createdBy, deletedAt | Confidential |
| `inventory_stocktakes` | stocktake sessions (Prompt 40): id, reference, status, countType, notes, createdByUserId, startedAt/reviewedAt/finalizedAt/canceledAt, timestamps | Confidential |
| `inventory_stocktake_lines` | count lines (Prompt 40): stocktake + product references, count-time snapshot metadata (productNameAtCount, skuAtCount, unitAtCount), systemQtyAtCount, countedQty, varianceQty, countedAt, countedByUserId, timestamps — **auto-included with inventory_stocktakes** | Confidential |
| `purchase_orders` | purchase orders (Prompt 41): id, reference, status, supplier reference, order/expected dates, notes, write-time snapshots (supplierNameAtOrder, currencyCodeAtOrder/SymbolAtOrder/decimalPrecisionAtOrder), creator + lifecycle timestamps — **auto-includes purchase_order_lines** | Confidential |
| `purchase_order_lines` | purchase order lines (Prompt 41): order + product references, write-time snapshot metadata (productNameAtOrder, skuAtOrder, unitAtOrder), orderedQty, unitPriceMinor, timestamps | Confidential |
| `sales_orders` | sales orders (Prompt 45): reference, status, customer snapshot, order/expected dates, discount, notes, currency snapshots, creator + lifecycle timestamps — **auto-includes sales_order_lines; export-only (import blocked)** | Confidential |
| `sales_order_lines` | sales order lines (Prompt 45): order + product references, write-time snapshot metadata, orderedQty, unitPriceMinor, timestamps | Confidential |
| `sales_quotations` | sales quotations (Prompt 47): reference, persisted status, customer snapshot, quotation/valid-until/expected-delivery dates, discountMinor, customerNotes, currency snapshots, creator + lifecycle timestamps — **auto-includes sales_quotation_lines; export-only (import blocked); internalNotes NEVER exported** | Confidential |
| `sales_quotation_lines` | sales quotation lines (Prompt 47): quotation + product references, write-time snapshot metadata (productNameAtQuotation, skuAtQuotation, unitAtQuotation), qty, unitPriceMinor, timestamps | Confidential |
| `supplier_bills` | supplier bills (Prompt 48): reference, supplier invoice reference, supplier snapshot, PO reference snapshot, persisted status, bill/due dates, currency snapshots, subtotal/discount/total (integer minor units), creator + lifecycle timestamps, `expense_id` (the linked payable relationship) — **auto-includes supplier_bill_lines; export-only (import blocked); internalNotes NEVER exported** | Confidential |
| `supplier_bill_lines` | supplier bill lines (Prompt 48): bill + PO-line + product references, write-time snapshot metadata (productNameAtBill, skuAtBill, unitAtBill), billedQty, unitPriceMinor, purchaseOrderUnitPriceMinor (variance evidence), lineTotalMinor, timestamps | Confidential |
| `subscription_summary` | plan code/name, status, billing period, trial, cancel flags — customer-visible state only | Confidential |
| `usage_summary` | current-period usage facts (metric, used, limit, remaining) — the same numbers the Usage page shows | Confidential |

**Not exported (by design):** passwords, MFA secrets, session/security
data, platform audit logs, AI provider costs and rates, merchant
credentials, AI chat transcripts, and the tenant audit trail.
Receivables/payables are derived views — the same facts are inside the
sales/expense datasets.

## Manifest

Every export carries a manifest with: `exportSchemaVersion`, `appVersion`,
`createdAt`, business name/timezone/currency/precision, the dataset list
with record counts, the format, and an integrity block.

- `manifest.integrity` — SHA-256 over the dataset payload (for JSON:
  the exact serialized `datasets` fragment; for CSV: the concatenated CSV
  file bytes in dataset-key order). Verification recipe: parse the file,
  re-serialize the payload exactly as described, hash it, compare.
- The download system also verifies a whole-file SHA-256 on every download.

## Lifecycle

1. **Create** — pick datasets + format. Generation runs immediately
   (bounded: default caps 100 000 records / 50 MB / 12 datasets; exceeding
   a bound fails the job honestly with `EXPORT_LIMIT_EXCEEDED` — you never
   get a partial file labeled complete).
2. **Download** — available while `COMPLETED` and unexpired. Files are
   served as attachments with no caching.
3. **Expiry** — files expire after the operational TTL (default **72 h**,
   `EXPORT_FILE_TTL_HOURS`). Expired downloads are rejected. This is
   operational cleanup, not a legal retention policy.
4. **Cleanup** — an operator script (`scripts/prune-expired-exports.mjs`)
   removes expired artifacts (dry-run by default).

## Failure codes

| Code | Meaning |
| --- | --- |
| `EXPORT_LIMIT_EXCEEDED` | The selection exceeds the configured record/size/dataset caps. |
| `EXPORT_GENERATION_FAILED` | Generation failed — safe to retry. |
| `EXPORT_EXPIRED` | The file expired (or was cleaned up). Create a new export. |
| `EXPORT_NOT_FOUND` | Unknown job id, or a job that belongs to another business. |
| `EXPORT_UNAUTHORIZED` | Only owners/admins may export. |
| `RATE_LIMITED` | Too many requests — wait a few minutes. |

## Report-level CSV exports (report surface)

Beyond the job-based portability exports above, three report surfaces serve
accountant-friendly CSVs directly from the SAME engines that render their
UI (single source of calculation — never a second one). All of them share
one convention set: authentication + `data:read`, the `CSV_EXPORT` billing
entitlement gate (server-side reject — UI hiding is never the enforcement),
a rate limit of 10 exports / 5 min / user, a `data.export` audit record,
UTF-8 with BOM (Persian text survives Excel), OWASP formula-injection
guards on every cell, and `no-store` attachments.

| Export | Endpoint | Coverage |
| --- | --- | --- |
| Stocktake lines | `GET /api/v1/inventory/stocktakes/[id]/export?locale=en\|fa` | ALL lines of the stocktake (never one page — bounded by the stocktake line cap, provably complete). Columns: reference, status, product, sku, unit, system_qty, counted_qty, variance, counted_at, counted_by. Uncounted (draft preparation) lines export BLANK counted/variance — honest absence, never a fake zero. No monetary values. |
| Aging (receivables / payables) | `GET /api/v1/reports/aging/export?side=receivables\|payables&locale=en\|fa` | Rows rendered from `buildAgingReport()` — the exact engine the UI JSON uses. One table: `total` row, always 4 `bucket` rows, the payables `past_due` row when present, and the top-party rows (≤ 8, balance desc). Money = exact decimal strings at the business precision. |
| Purchase order (per order) | `GET /api/v1/purchase-orders/[id]/export?locale=en\|fa` | ALL lines of the purchase order (never one page — bounded by the P41 line cap, provably complete via a cap+1 fetch). Columns: reference, status, supplier, product, sku, unit, ordered_qty, unit_price_minor, line_total_minor, order_total_minor, currency_at_order, ordered_at, expected_date. Historical SNAPSHOT values only (never live names); money is raw integer minor units; the total is a procurement DOCUMENT total, not a payable. EN machine-form headers / FA Persian headers. |
| Inventory adjustments | `GET /api/v1/inventory/adjustments?format=csv&locale=en\|fa` (+ optional `direction`, `productId`, `q`, `from`/`to` filters) | ALL matching rows up to 1,000 (mirrors `AGING_SCAN_CAP` / the stocktake line cap); truncation is recorded honestly in the audit record. Columns: created_at, product, sku, unit, direction, quantity, reason, by. The JSON feed itself is DTO-allowlisted with server-side pagination (`page`/`pageSize`, cap 100) — legacy `take` stays supported as a page-1 alias. |
| Goods receipt (per receipt) | `GET /api/v1/inventory/goods-receipts/[id]/export?locale=en\|fa` | ALL lines of the receipt (never one page — bounded by the P42 receipt line cap, provably complete via a cap+1 fetch). Columns: reference, status, purchase_order_reference, supplier, product, sku, unit, received_qty, posted_at. Historical SNAPSHOT values only; **NO money columns exist in this domain** (§37/§126). EN machine-form headers / FA Persian headers; entitlement + rate limit + no-store + audit as every other CSV. |

`locale` switches the CSV header row (and, for adjustments, the direction
labels) between English (`reference,status,…`) and Persian
(`شناسه,وضعیت,…`) — the same law as the statement CSV. The UI exposes each
export next to the data it mirrors: the stocktake detail header, both aging
cards, and the inventory adjustment-history card (whose filters are exactly
the CSV filters).


## Goods Receipt datasets (Prompt 42)


### Prompt 43 — goods returns (§179)

`inventory_goods_returns` and `inventory_goods_return_lines` join the export
catalog as CONFIDENTIAL datasets (the return always implies its lines, so a
`inventory_goods_returns` selection exports both). Rows carry the historical
snapshots verbatim (`supplier_name_at_return`,
`goods_receipt_reference_at_return`, `purchase_order_reference_at_return`,
`product_name_at_return`, `sku_at_return`, `unit_at_return`, `reason_code`)
and there are NO money columns — a return records physical quantity only.
`inventory_goods_receipts` and `inventory_goods_receipt_lines` join the export
catalog as CONFIDENTIAL datasets; the receipts dataset always implies its lines
(§137). Rows carry historical snapshots verbatim (`supplierNameAtReceipt`,
`purchaseOrderReferenceAtReceipt`, `productNameAtReceipt`, `skuAtReceipt`,
`unitAtReceipt`) and physical quantities only — there is no money in this
domain, so no minor-unit conversion applies anywhere. **Import is intentionally
NOT implemented** (see data-import.md); restore from backup is the sanctioned
recovery path for receiving documents.

### Prompt 45 — sales orders (§116)

`sales_orders` and `sales_order_lines` join the export catalog as
CONFIDENTIAL datasets; the orders dataset always implies its lines (parent
→ child implication, §116). Rows carry the frozen historical snapshots
verbatim (`customer_name_at_order`, currency triple,
`product_name_at_order`, `sku_at_order`, `unit_at_order`) and the agreed
money columns as integer minor units (`discount_minor`,
`unit_price_minor`) — the commercial contract, never re-derived from live
product prices. Lifecycle columns (`confirmed_at`, `completed_at`,
`cancelled_at`) export as recorded. **Import remains intentionally NOT
implemented** (§117): importing confirmed/completed operational orders
could create dispatch-eligibility or invoice/fulfillment inconsistencies
— restore from backup is the sanctioned recovery path.

### Prompt 47 — sales quotations

`sales_quotations` and `sales_quotation_lines` join the export catalog
as CONFIDENTIAL datasets; the quotations dataset always implies its
lines (parent → child implication). Rows carry the frozen historical
snapshots verbatim (`customer_name_at_quotation`, currency triple,
`product_name_at_quotation`, `sku_at_quotation`, `unit_at_quotation`)
and the offered money as integer minor units (`discount_minor`,
`unit_price_minor`) — the offer as made, never re-derived from live
product prices. Quotation lifecycle columns (`sent_at`, `accepted_at`,
`rejected_at`, `cancelled_at`, `converted_at`) export as recorded.
**`internalNotes` is never exported** (staff-only content has no
column); `customerNotes` exports as ordinary customer-visible document
content. **Import remains intentionally NOT implemented**: importing
quotations would bypass snapshot freezing, reference generation and the
conversion state machine — the datasets are export-only, and the
importer's allowlist rejects them BEFORE any database write. Restore
from backup is the sanctioned recovery path.

### Prompt 48 — supplier bills

`supplier_bills` and `supplier_bill_lines` join the export catalog as
CONFIDENTIAL datasets; the bills dataset always implies its lines
(parent → child implication). Rows carry the frozen historical snapshots
verbatim (`supplier_name_at_bill`, `purchase_order_reference_at_bill`,
currency triple, `product_name_at_bill`, `sku_at_bill`, `unit_at_bill`)
and the invoiced money as integer minor units (`subtotal_minor`,
`discount_minor`, `total_minor`, `unit_price_minor`,
`purchase_order_unit_price_minor` as the PO-vs-invoice variance
evidence, `line_total_minor`). The linked payable travels as
`expense_id` (a stable relationship identifier) — the PAYABLE ITSELF
lives in the authoritative `expenses` dataset, so the two are never
double-counted. **`internalNotes` is never exported** (no column).
**Import remains intentionally NOT implemented**: replaying bills through
a generic importer could fabricate payable history or claim a
SupplierBill↔Expense relation outside the atomic posting transaction —
the importer's allowlist rejects both dataset names BEFORE any database
write (no DataImportJob row). Restore from backup is the sanctioned
recovery path.
