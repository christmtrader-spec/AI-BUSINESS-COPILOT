# Party Statements — Customer & Supplier Transaction Statements

**Prompt 39** · Status: implemented · Scope: `src/lib/statements/`, `/api/v1/{customers,suppliers}/[id]/statement(+/export)`, `#/statements` view.

---

## 1. What a statement IS — and what it is NOT

A Party Statement is a **derived transaction view** over the records that
already exist for one party (a customer or a supplier):

| Statement | Increases the balance | Decreases the balance | Balance meaning |
|---|---|---|---|
| **Customer Statement** | Sales (`Sale.totalMinor` at `issueDate`) | Payments received (`Payment.amountMinor` at `paidAt`) | how much the customer owes |
| **Supplier Statement** | Bills/Expenses (`Expense.amountMinor` at `spentAt`) | Payments made (`Payment.amountMinor` at `paidAt`) | how much the business owes the supplier |

```
statement balance = sales (or bills) − payments
```

It answers *"what happened between my business and this customer/supplier?"*
It does **NOT** answer *"what is the business's accounting profit or formal
liability ledger?"*

**It is NOT a general ledger.** There is no double-entry accounting, no chart
of accounts, no journal entries, no debits/credits, no trial balance, no
balance sheet, no tax or accrual accounting, and no period closing anywhere in
this feature. UI columns say **Increase / Decrease**, never Debit/Credit. Do
not market this feature as an accounting system — it is a *customer/supplier
transaction statement*.

## 2. Event definitions (closed vocabulary)

| Event | Source row | Movement | Occurs at |
|---|---|---|---|
| `SALE` | `Sale` (business, customer, not deleted) | `+totalMinor` | `issueDate` |
| `PAYMENT_RECEIVED` | `Payment` → target `Sale` (customer's, not deleted) | `−amountMinor` | `paidAt` |
| `BILL` | `Expense` (business, supplier, not deleted) | `+amountMinor` | `spentAt` |
| `PAYMENT_MADE` | `Payment` → target `Expense` (supplier's, not deleted) | `−amountMinor` | `paidAt` |

Laws:

- `Sale.paidMinor` / `Expense.paidMinor` are **never** used as statement
  movements — the Payment row creates the payment movement (no double
  counting: a sale contributes exactly one `SALE` event, a payment exactly one
  payment event).
- Payment party identity always comes from the **target relation**
  (`Payment → Sale → Customer`, `Payment → Expense → Supplier`) — never from
  the paying user (`actorId`) and never from a client-supplied direction.
- Soft-deleted Sales/Expenses never appear, and a payment whose target
  transaction is deleted disappears with it. A deleted payment row is removed
  entirely (payments are hard-deleted), so its movement disappears and the
  statement recomputes from the remaining rows.
- Private notes (`Sale.note`, `Expense.note`, `Payment.note`) are never part
  of statement rows.
- References: sales → `INV-0007` (shared `formatInvoiceNumber`); supplier
  bills → the stated `reference`, falling back to the category; payments → the
  related sale invoice number or the related expense reference/category.
- Internal event identity includes the **source type + source id**
  (`SALE:<id>`, `PAYMENT_IN:<id>`, `BILL:<id>`, `PAYMENT_OUT:<id>`), so the
  independent id sequences of two tables can never collide.

## 3. Opening / closing / running balance

- **Opening balance** — the party balance immediately before the period start,
  computed server-side with DB SUM aggregates over ALL earlier history
  (customer: Σsales − Σpayments before `from`; supplier: Σbills − Σpayments
  before `from`). Never client-computed, never invented: if older records were
  never recorded, the statement is correspondingly incomplete.
- **Period increase / decrease** — DB SUM aggregates inside the window.
- **Running balance** — each row carries `balanceAfterMinor` =
  previous balance + movement, computed **server-side** with exact integer
  math. The client only renders.
- **Closing balance** = opening + period increase − period decrease. May be
  0, positive, or (in corrupt historical states) negative — the engine never
  clamps, rounds, converts or estimates. The existing payment pipeline
  prevents overpayment, so valid current records do not produce negative
  outstanding balances.

**Reconciliation law.** When the statement range covers the party's complete
recorded history, the closing balance reconciles EXACTLY with the party's
receivable (customer) or payable (supplier) — `SUM(sales) − SUM(payments)`.
Any mismatch is a test failure, not a silent adjustment.

## 4. Date range

- Parameters `from` / `to` as `YYYY-MM-DD` business-calendar dates; strict
  validation rejects impossible dates (`2026-02-31`) and `from > to` (422)
  before any query runs.
- Boundaries are resolved in the **business timezone** (never the server's or
  browser's): the window is `[from 00:00 local, next-day 00:00 local)`, so an
  event at 00:00:00 on `from` and one at 23:59:59 on `to` are both included.
- Default (no params): the **current business calendar month**.
- No arbitrary short cap: historical statements may span years; large ranges
  are handled by bounded pagination, never by silently truncating dates.

## 5. Pagination

- `limit` — page size, default 50, validated 10..100. No unbounded list.
- The cursor is a **server-generated opaque signed token**
  (`base64url(payload).HMAC-SHA256`): it carries only stable IDs + ordering
  metadata (kind, businessId, partyId, from, to, last event key) — no PII, no
  names, no notes. It is bound to the exact statement query: reuse with
  different parameters → 422; tampering → 422.
- Each source (sales/expenses + payments) is fetched with `limit + 1` rows,
  merged chronologically (`occurredAt ASC → sourceId ASC → sourceType ASC`),
  and the first `limit` events form the page. Memory stays O(limit); the full
  history is never loaded.
- **Summary totals are page-independent**: opening, periodIncrease,
  periodDecrease, closing and `eventCount` come from complete DB aggregates.
  Changing the cursor never changes a total; pagination never truncates
  financial truth (`truncated` is always `false` for the API — the cursor
  walks the whole range).
- Pagination is read-time consistent, not historical snapshot-locked: if
  transactions change between pages, the server remains authoritative.

## 6. Export (CSV)

- `GET /api/v1/customers/[id]/statement/export?from&to` and the supplier
  equivalent export the **whole range** (chunk-by-chunk through the same
  statement engine — one source of calculation, never a second one).
- Columns: `date, reference, description, increase, decrease, balance`
  (localized headers; Persian-safe UTF-8 with BOM; CRLF).
- Money is an **exact decimal string** at the business precision (integer
  minor units underneath — no currency symbols in machine columns).
- Filename: `customer-statement-<from>_<to>.csv` (never the party name).
- Cells pass the shared OWASP formula-injection guard (`=`, `+`, `@`, tab/CR
  prefixes get a leading apostrophe; negative numbers stay numeric).
- Security identical to the statement itself (auth, membership, `data:read`,
  tenant scope) plus the existing CSV export conventions (CSV_EXPORT
  entitlement gate, 10 exports / 5 min / user, `data.export` audit record
  without party identity).
- The exported final balance reconciles exactly with the API closing balance.

## 7. UI

- `#/statements?type=customer&id=<id>` (and `supplier`) — closed type
  vocabulary, safe-ID validation; unknown type/id falls back to the dashboard;
  refresh and browser back/forward work.
- "Statement" actions on Customer Detail and Supplier Detail (visible to every
  role — statements need only `data:read`).
- Header: party name (resolved from the authenticated tenant-scoped API),
  period, timezone. Summary cards: opening / increases / decreases / closing.
- Desktop table (Date · Reference · Description · Increase · Decrease ·
  Balance) converts to card rows on mobile (360/390/412 widths, no horizontal
  overflow). Zero values render as `—`. Movement columns + icons carry the
  direction — never color alone.
- Date presets: This month · Last month · Last 30 days · Last 90 days · This
  year (business calendar), plus native from/to inputs with `from ≤ to`
  validation.
- Statements are NOT in Global Search, NOT in the command palette, NOT in AI
  Copilot grounding, and produce no notifications and no `statement.view`
  audit events (viewing/exporting is read-only).

## 8. Known limitations (honest)

- A statement covers **recorded** history only — unrecorded history produces
  a correspondingly incomplete opening balance (never invented).
- Statements are a per-party derived view; they do not allocate balances to
  aging buckets (see Receivables/Payables Aging for the age distribution) and
  do not alter Reports, cash flow, receivables or payables in any way.
- No PDF export; no email delivery of statements; no statement scheduling.
- Cross-currency statements are impossible by construction — every statement
  row belongs to one business, hence one currency; no FX conversion exists.

## 9. Prompt 49 additions (aging-details integration)

- **Row source navigation:** every statement row now carries its SERVER
  identity (`sourceType` + `sourceId`) alongside the composite event id, and
  the view offers the authorized source document (SALE → invoice detail,
  PAYMENT_RECEIVED/PAYMENT_MADE → payment detail, BILL → expense detail).
  Targets resolve through the closed entity-route vocabulary from actual ids
  — never from displayed reference text — and unsupported types remain
  read-only.
- **Reconciliation with aging:** the statement closing balance over full
  recorded history equals the party's canonical open-item total in the
  detailed aging (`/api/v1/reports/aging/items?partyId=…`), because both
  derive from the same authoritative records (sales − customer payments /
  expenses − supplier payments). The aging distribution, per-party
  drill-down and detailed CSV are documented in `docs/product/aging-details.md`
  and ADR 0049.
