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
