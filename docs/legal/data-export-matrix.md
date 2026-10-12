# Data Export Matrix

**Document ID:** LEGAL-EXPORT-v1 · **Created:** 2026-09-25 (Prompt 27 §63)
**Rule:** based on the actual export surfaces in the code. The system is NOT
called "full data export" in public copy (§22/§63) — because not every
category below is exportable.

| Data | Export available? | Format | Scope | Authorization | Pagination / limits | Notes |
|---|---|---|---|---|---|---|
| Whole business (customers, suppliers, products, inventory, sales, expenses, payments, audit trail, members-as-ids) | ✅ | JSON (schema-annotated, portable) | Active business only | `settings:manage` (OWNER/ADMIN) + tenant check | Rate limit 4 / 5 min / user; 25 MB restore cap on import path | Member emails/password hashes reduced to ids/names — hashes never leave the server |
| Reports summary (7/30/90 days) | ✅ | CSV | Active business aggregates | `data:read` + `CSV_EXPORT` entitlement (server-enforced) | Rate limit 10 / 5 min / user | Same deterministic aggregates as the Reports view; money serialized from integer minor units |
| Monthly report (drill-down month) | ✅ | CSV | Active business, one month | Same as above | Same | `reports/monthly/[month]/export` |
| Audit log | ✅ | CSV (`?format=csv&take=N`) | Active business, audit:read roles | `audit:read` + `CSV_EXPORT` entitlement | Bounded `take` | Same rows the Audit view shows |
| Billing payments history (platform billing) | ✅ | CSV (`?format=csv`) | Active business subscription payments | Owner/billing roles | Bounded | `billing/payments?format=csv` |
| Customers / Suppliers / Products / Sales / Expenses lists | ✅ | CSV (client-side, from the loaded/filtered table) | Active business, current filter | Module role (`data:read`) | Explicit "exported first N of M rows" truncation notice — no silent truncation | Formula-injection guard (`src/lib/csv.ts`) applied to every cell |
| Sales quotations + lines (Prompt 47) | ✅ (export-only) | JSON / CSV dataset inside the business export (`sales_quotations`, auto-includes `sales_quotation_lines`) | Active business only | `settings:manage` (OWNER/ADMIN) + tenant check | Dataset record/size caps | CONFIDENTIAL commercial offer data — quotation totals are NOT revenue/receivable figures; `internalNotes` never exported; import blocked (datasets rejected before any write); no quotation delete API exists (terminal lifecycle states only) |
| AI conversations | ❌ | — | — | — | — | NOT exported (in-product deletion exists instead) |
| AI usage metadata | ✅ (in-app usage page only) | UI (not downloadable) | Own business | Member | — | Server-counted; no cost data exposed (§107) |
| Analytics events | ❌ | — | — | — | — | Internal operational data |
| Contact leads | ❌ | — | — | — | — | Internal operational data |
| Platform cost data (AiCostRate / AiCostRecord / margins) | ❌ NEVER | — | — | — | — | Internal financial records — no public/customer API returns them (§26/§107/§108) |

## Public wording (§22)

Allowed: "Export capabilities are provided for supported business data — a
complete JSON export for owners/admins and CSV exports for supported lists
and reports."

Forbidden: "Full data export" / "export everything" — because AI
conversations, analytics events and contact leads have no export path.
