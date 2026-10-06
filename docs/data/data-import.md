# Data Import — Customer Reference (Prompt 31 §138)

> Data Portability center → **Import** tab (`#/data`). Only business
> **owners and admins** can import. This document matches the
> implementation (`src/lib/data-portability/`) as of Prompt 31.

## The seven steps

```
1 Dataset → 2 Upload → 3 Mapping → 4 Validate → 5 Dry run → 6 Commit → 7 Result
```

Nothing is written until step 6. Validate and dry run never change data.
Commit requires: typed confirmation **`IMPORT DATA`**, your password (and
two-factor code if MFA is enabled), and a fresh owner/admin check.

## Supported datasets and fields (importSchemaVersion **1**)

### customers / suppliers

| Field | Type | Required | Max length | Notes |
| --- | --- | --- | --- | --- |
| `name` | text | **yes** | 200 | |
| `phone` | phone | no | 40 | digits, spaces, `+ - ( ) .` |
| `email` | email | no | 200 | format-validated; NOT uniqueness-enforced |
| `address` | text | no | 500 | |
| `note` | text | no | 1000 | |

### products

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | text | **yes** | max 200 |
| `sku` | text | no | max 60 |
| `unit` | text | no | max 20 |
| `sale_price` | money | no | exact decimal string, e.g. `12.50` → 1250 minor units |
| `cost_price` | money | no | same rule |
| `stock_qty` | integer | no | ≥ 0 |
| `low_stock_at` | integer | no | ≥ 0 |
| `is_active` | boolean | no | `true` / `false` |

**Generated server-side (never imported):** `id`, `businessId`,
`createdAt`, `updatedAt`, soft-delete fields. A `businessId` column in
your file is ignored — imported records always belong to the CURRENT
business, whatever any column claims.

**Not importable in Prompt 31:** sales, expenses, payments, receivables,
payables (financial history needs reconciliation semantics — intentionally
out of scope), team members, users, credentials, billing or subscription
state.

## Money rules

- CSV carries **exact decimal strings** (`12.50`), consistent with the
  business currency precision. Import converts to integer minor units with
  exact arithmetic — no floating point.
- Currency is always the **current business currency**; imports cannot
  switch it and no FX conversion is performed.
- More decimals than the business precision → `ROW_INVALID_AMOUNT`.

## Empty values

One uniform rule: an **empty field = null** (optional field left empty).
A required field left empty is the error `ROW_REQUIRED_FIELD_MISSING`.

## Dates

The Prompt 31 import datasets contain no importable date fields — created
timestamps are server-generated. Templates document ISO 8601 for any
future timestamp field.

## Duplicate policy (deterministic — never fuzzy/AI)

Match keys, in priority order (first present value wins):

| Dataset | 1st key | 2nd key | 3rd key |
| --- | --- | --- | --- |
| customers / suppliers | email | phone | name |
| products | sku | name | — |

Matching normalizes case, whitespace and phone punctuation. Two modes:

- **SKIP** (default): duplicate rows are not created; nothing existing is
  modified. Ever.
- **REJECT**: duplicate rows are reported as `ROW_DUPLICATE` errors and
  block the commit.

**UPDATE mode is not offered** in Prompt 31: imports create records, they
never modify existing ones.

## Error codes

| Code | Meaning |
| --- | --- |
| `ROW_REQUIRED_FIELD_MISSING` | A required field is empty. |
| `ROW_INVALID_EMAIL` / `ROW_INVALID_PHONE` | Bad format. |
| `ROW_INVALID_AMOUNT` | Not an exact decimal / too many decimals. |
| `ROW_INVALID_NUMBER` | Expected a whole number. |
| `ROW_INVALID_BOOLEAN` | Use `true` or `false`. |
| `ROW_VALUE_TOO_LONG` | Over the field's length cap. |
| `ROW_DUPLICATE` | Duplicate (REJECT mode). |
| `ROW_UNSUPPORTED_FIELD` | Field is not importable. |

The review screen shows the top errors and a downloadable bounded CSV
report (`row_number, field, error_code, message`) — never raw row values.

## Job states

`UPLOADED → PARSING → MAPPING_REQUIRED → VALIDATING → READY → COMMITTING →
COMPLETED` — plus `FAILED`, `EXPIRED`, `CANCELED`. Statuses are
server-owned; a failed validation marks the job FAILED (fix the file or
mapping, upload again). Staged files and finished jobs expire after the
operational TTL (default 72 h, `IMPORT_FILE_TTL_HOURS`) — an expired job
cannot commit.

## Safety properties

- **All-or-nothing commit**: validation runs fresh at commit time; any
  invalid row aborts the whole import with no partial data.
- **Idempotent**: re-sending the same commit returns the recorded result —
  never a second import.
- **Audited**: create/validate/dry-run/commit/failure are recorded with
  counts and the operator identity — never row contents.
- **Isolated**: uploads are stored outside the public web root with
  server-generated names; the file's SHA-256 is re-verified at commit.

## Templates

Download `Customer.csv`, `Supplier.csv`, `Product.csv` from the Templates
tab. Each has the exact machine headers plus one synthetic example row
("Example Customer" — never real data). The template our app generates is
always accepted by our importer. Machine headers stay stable across
languages; only the surrounding documentation is localized.


## CRM datasets (Prompt 35)

- **CRM Lead import: NOT IMPLEMENTED.**
- **CRM Opportunity import: NOT IMPLEMENTED.**

Reason: opportunity relationships (lead/customer/assignee) require safe
tenant-local reference resolution plus stage/forecast validation, and the
conversion bookkeeping must never be fabricated by an importer. CRM export
(`crm_leads`, `crm_opportunities` JSON/CSV datasets) is fully supported. A
future prompt may implement CRM import with explicit reference mapping.
- **CRM Activity import: NOT IMPLEMENTED** (Prompt 36). Reason: every
  activity row requires exactly-one same-business context resolution
  (customer XOR lead XOR opportunity) plus an immutable creator identity;
  fabricating those links from a file would risk cross-referencing errors
  that break timeline semantics.
- **CRM Task import: NOT IMPLEMENTED** (Prompt 36). Same context rule plus
  server-owned status/completedAt bookkeeping; an importer could silently
  violate the state machine. Export of both datasets is fully supported.
- **CRM Task reminder configuration import: NOT IMPLEMENTED** (Prompt 37).
  `reminderEnabled` / `reminderMinutesBefore` / `overdueAlertEnabled` are
  exported as business configuration, but they are not importable: their
  validity is stateful (reminder requires the CURRENT `dueAt`, offsets are
  a closed vocabulary validated server-side, and `dueAt = null` resets the
  whole configuration). Importing them without re-deriving the task's live
  state could persist invalid reminder configurations that the scheduled
  processor would then trust. Re-enable reminders per task in the UI after
  any future import; notification history itself is not business data and
  stays outside the export/import catalog.

## Inventory Stocktake datasets (Prompt 40)

**Finalized stocktake import: NOT IMPLEMENTED** — deliberately. Importing a
physical count reconciliation would replay stock mutations
(`InventoryAdjustment` rows + `stockQty` overwrites) outside the stocktake's
server-side snapshot/stale-check/finalization state machine, fabricating
quantity history no one actually counted. The stocktake datasets
(`inventory_stocktakes`, `inventory_stocktake_lines`) are therefore
**export-only**; the importer's allowlist (customers / suppliers / products)
already rejects them. Backup/restore remains the system-level recovery
mechanism for count sessions and every other dataset.

## Purchase Order datasets (Prompt 41)

**Purchase order import: NOT IMPLEMENTED** — deliberately, and unchanged by
Prompt 41-F. Procurement documents are commitment records with server-frozen
historical snapshots (supplier/product identity, currency), a DB-unique
reference per business, and a lifecycle state machine. Importing them would
either bypass snapshot freezing (fabricating false history) or duplicate the
entire write path (supplier validation, reference generation, line-cap and
overflow laws) outside the API — with no user story that needs it. The
`purchase_orders` / `purchase_order_lines` datasets are therefore
**export-only**; the importer's allowlist (customers / suppliers / products)
rejects both (negative test: an import attempt naming a purchase-order
dataset is rejected as unsupported and creates nothing). Restore from backup
is the sanctioned recovery path for procurement documents.
