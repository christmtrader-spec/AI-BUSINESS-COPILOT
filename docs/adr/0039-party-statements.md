# ADR 0039 — Party Statements as a Derived Transaction View

- **Status:** Accepted
- **Date:** 2026-10 (Prompt 39)
- **Deciders:** Product/engineering (single implementer, ratified spec)

## Context

Small-business users need to answer "what happened between my business and
this customer/supplier?" — an account-statement view with opening balance,
movements and running balance, filterable by date range and exportable to CSV.

The repository already records the underlying facts:

- `Sale` (totalMinor, issueDate, customer) — invoiced sales;
- `Expense` (amountMinor, spentAt, supplier) — supplier bills;
- `Payment` (amountMinor, paidAt, saleId XOR expenseId) — money movements.

The product explicitly does NOT have double-entry accounting (no chart of
accounts, no journal, no ledger). Prompt 39 must therefore decide how
statement balances are produced WITHOUT becoming an accounting system.

## Decision

Implement **derived party statements** computed at read time from
`Sale` + `Expense` + `Payment`:

- Customer statement balance = Σ(Sale.totalMinor) − Σ(Payment.amountMinor)
- Supplier statement balance = Σ(Expense.amountMinor) − Σ(Payment.amountMinor)

`buildStatement()` in `src/lib/statements/engine.ts` is the single source of
calculation used by the API, the UI DTO and the CSV export. Balances are
integer minor units throughout; pagination uses bounded per-source windows and
a signed opaque cursor; summary totals come from complete DB aggregates so
they are independent of pagination.

## Alternatives rejected

### Alternative A — persistent account balance (e.g. `Customer.balanceMinor`)

Rejected because it:

- creates a **second source of truth** that must be reconciled with the
  transactions it summarizes (drift becomes inevitable);
- increases mutation complexity — every sale/payment/expense write path (and
  every historical correction/deletion) would need transactional balance
  maintenance;
- cannot retro-fix: seeding it for existing history would require a
  backfill migration with all the same drift risks.

The derived view is always exactly consistent by construction.

### Alternative B — general ledger

Rejected because it is outside the product's scope and requires a formal
accounting design (chart of accounts, journal entries, debits/credits,
periods). Prompt 39 deliberately implements NO accounting model: the UI says
Increase/Decrease (never Debit/Credit), and docs never call this a ledger.

### Alternative C — statement event persistence / snapshot table

Rejected: a `StatementEvent` or `StatementSnapshot` table would duplicate the
transactions it is derived from, introduce its own consistency problem, and
create a new backup/privacy surface for zero product gain. Statement events
are pure in-memory structures; nothing about a statement is persisted, and no
new Prisma model or migration exists.

## Consequences

- (+) Zero schema/migration impact; no new financial source of truth.
- (+) Reconciliation with receivables/payables is exact by construction
  (same rows, same filters), and is enforced by tests.
- (−) Historical statements depend on recorded history: opening balances are
  only as complete as the recorded data (documented honestly — nothing is
  invented).
- (−) Large ranges rely on bounded pagination rather than precomputed
  balances; performance is protected by aggregate queries and O(limit) page
  windows instead of denormalized caches.
- Cursor signing uses `STATEMENT_CURSOR_SECRET` (fallback `NEXTAUTH_SECRET`);
  a dedicated secret should be configured in production (single-node
  deployment; stateless cursor, no expiry table).
