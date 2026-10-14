# Aging Details — Open-Item Drill-Down (Prompt 49)

Status: **IMPLEMENTED & VERIFIED** (2026-10-14) — additive enhancement to the
existing statement and aging architecture. No migration, no new persisted
financial state, no second engine.

## 1. What this adds

The aggregate aging (`GET /api/v1/reports/aging`, the AgingCard) answers
*"how much is outstanding and how old is it?"*. This enhancement answers the
next question every operator asks: **"which documents make up that number?"**

- **Detailed aging API** — `GET /api/v1/reports/aging/items`
  (`side=receivables|payables`, optional `partyId`, `bucket`,
  `pastDue=true` (payables only), `limit` 10..100, signed `cursor`).
- **Detailed aging CSV** — `GET /api/v1/reports/aging/items/export`
  (same query contract; complete-scope-or-reject).
- **Detailed aging view** — `#/reports/aging-details?side=…&party=…&bucket=…&pastDue=1`
  with canonical-filter deep links, bucket chips, past-due toggle,
  signed-cursor pagination and the CSV action.
- **AgingCard drill-down** — bucket rows, top-party rows (by authoritative
  party id) and the payables past-due chip navigate into the filtered view.
- **Customer 360 / Supplier 360 aging panels** — bounded per-party overview
  (`receivablesAging` / `payablesAging` DTO fields) with bucket tiles and
  one-click paths to the detailed view and the party statement.
- **Statement source navigation** — statement rows now carry `sourceType` +
  `sourceId`; each row offers the authorized source document
  (SALE → sale detail, PAYMENT_IN/PAYMENT_OUT → payment detail, BILL →
  expense detail). Rows without a route stay read-only.

## 2. Authorities (unchanged)

| Question | Authority |
| --- | --- |
| Statement transactions / balances | `src/lib/statements/*` (Prompt 39 engine) |
| Aggregate aging buckets/totals | `src/lib/aging.ts` + `src/lib/aging-report.ts` |
| **Detailed open items, ages, buckets, past-due** | `src/lib/aging-details.ts` (reuses `localDayIndex`, `agingBucketForAge`, the open-item guard — no second bucket law) |
| Per-party 360 overview | `src/lib/party-aging.ts` (reuses `buildAgingSide`) |
| Receivable balances | `Sale.totalMinor − Sale.paidMinor` |
| Payable balances | `Expense.amountMinor − Expense.paidMinor` |

## 3. Source documents (what can appear)

- **Receivables** = open **Sale invoices** of the tenant (`status ≠ PAID`,
  not deleted, positive outstanding). SalesOrders and SalesQuotations are
  separate tables and can **never** appear (verified by test §21-19/20).
- **Payables** = open **Expense payables** of the tenant. A posted
  SupplierBill is **never** a second item: its reference may appear only as
  supplemental document metadata (`supplierBillReference`, POSTED bills
  only) and adds no balance and no movement (verified §21-17/18).

## 4. Honest semantics

- **Receivables carry NO due date.** The row shows "Invoice age"
  (عمر فاکتور) — a distribution measure. No overdue count or overdue
  balance is ever derived from invoice age (no authoritative customer
  payment-term field exists in the MVP model). `pastDue` is always `false`
  and `dueDate` always `null` on receivable rows.
- **Payables past-due law** (verbatim Prompt-49 §9): an Expense is past due
  only when it HAS a stated `dueDate`, today's **business-local** day is
  strictly AFTER the due day, and the balance is positive. Due today is not
  past due; no due date is never past due.
- Buckets are the fixed engine ranges 0–30 / 31–60 / 61–90 / 90+ whole
  business-local calendar days (Asia/Tehran for a Tehran business, never the
  browser timezone).
- Money is integer minor units end-to-end; the CSV serializes exact decimals
  once at the business precision.

## 5. Party identity (Prompt 49 §6)

Aging parties group by the **authoritative party id**
(`Sale.customerId` / `Expense.supplierId`), never by display name. Two
parties with identical names stay two groups with their own totals, oldest
ages and drill-down destinations; unlinked items form one explicit
"unassigned" group and never construct a fake destination. Verified by
same-name unit fixtures and live E2E (§21-1..6).

## 6. Pagination law (§7)

- Deterministic keyset order: Sale `issueDate`+`id`; Expense `spentAt`+`id`.
- The signed opaque cursor (HMAC-SHA256, statement-cursor conventions) is
  bound to businessId + side + party + bucket + pastDue + version; a cursor
  reused across any of those → canonical 422 (never a fallback page).
- The cursor tracks the **last scanned row**, not the last displayed row, so
  bucket/past-due post-filtering can never skip or repeat a document.
- Every scan is chunked and bounded (`AGING_DETAIL_SCAN_CAP`, default 5000
  per request; env-tunable with sane clamps). When a page request hits the
  cap the response carries `pageTruncated: true` plus a valid next cursor —
  a partial page is never presented as complete. The summary carries its own
  `truncated` flag.

## 7. CSV export law (§14)

- A DEDICATED detailed file — the existing summary aging CSV is untouched.
- Same engine as the JSON (one calculation source; no CSV-only math).
- Approved fields only: source type, reference, party name, document date,
  anchor date, due date, age days, bucket, total, paid, outstanding
  (+ payables-only `past_due`, `supplier_bill`). No notes, no profile data,
  no payment metadata, no raw Prisma rows.
- Filename is ASCII and PII-free:
  `aging-<side>-detail-YYYYMMDD.csv` (party-scoped: `aging-<side>-party-…`).
- UTF-8 BOM + CRLF, RFC 4180 escaping + formula-injection guard, `no-store`,
  CSV_EXPORT entitlement gate, 10/5-min rate limit, `data.export` audit
  (counts only, no party data).
- **Complete-or-reject**: the export covers the whole declared scope; when
  the scope exceeds `AGING_DETAIL_EXPORT_MAX_ROWS` (default 5000) — or the
  scan budget exhausts before the scope is proven complete — it rejects with
  `AGING_EXPORT_TOO_LARGE` (422). A partial CSV with success status is
  impossible by construction.

## 8. Reconciliation (§12)

For the same scope the detail summary exposes:
- `totalOutstandingMinor` / `openItemCount` — the FULL filtered scope
  (side + party + pastDue; bucket not applied) — the number that must equal
  the aggregate aging for that scope;
- `buckets` — the full-scope four-bucket distribution;
- `filteredTotalOutstandingMinor` / `filteredOpenItemCount` — with the
  bucket filter applied.
E2E proves: statement closing balance == party open-item total (§21-16),
summary totals == Σ items == aggregate report, partial/full payments move
open aging exactly once, and SupplierBill never double counts.

## 9. Timezone and as-of

`asOf` is the server-derived business-local calendar day; there is no client
timezone authority and **no historical as-of parameter** — this is a
snapshot of current open source records (deletion/reversal semantics make
arbitrary point-in-time reconstruction out of scope; see party-statements
limitations).

## 10. Tests and evidence

| Suite | Result |
| --- | --- |
| `scripts/prompt49-aging-details-unit.ts` | 71/0 |
| `scripts/prompt49-aging-details-static-scan.mjs` | 21/21 |
| `scripts/prompt49-aging-details-cap-check.ts` (own env) | 32/0 |
| `scripts/prompt49-aging-details-check.mjs` (§21 scenarios 1–29) | 108/0 |
| `scripts/aging-unit.ts` (extended for §6) | 41/0 |
| Browser QA (agent-browser, real UI) | 12 screenshots, 5 viewports, EN/FA × light/dark, 0 console errors |

## 11. Known limitations (honest)

- The per-request scan cap means a bucket-filtered page that must skip more
  than `AGING_DETAIL_SCAN_CAP` non-matching rows reports `pageTruncated`;
  users continue with Next (cursor), exactly like the aggregate report's
  honest truncation.
- The export cap default (5000 matching rows) rejects larger scopes; narrow
  with filters (party/bucket) — the error message says so.
- Receivables aging is invoice AGE only; a future customer payment-terms
  feature must be a separate, explicitly specified data-model change.
- Export-failure toasts (rate limit / too large) are covered by unit + E2E
  mappings; the browser QA exercised the success path and rate-limit wording
  is the same component path as every other CSV export.
