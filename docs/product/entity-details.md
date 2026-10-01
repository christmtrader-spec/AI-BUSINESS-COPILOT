# Entity Details & Deep Links (Prompt 34)

> Record discovery + record detail experience: every searchable or listable
> tenant record has a deep-linkable detail page with related-record
> navigation. Read-mostly; never an authority layer.

## 1. Entity types (closed vocabulary)

Exactly six tenant entity types are routable — defined once in
`src/lib/entity-routes.ts`:

| EntityType  | Hash route            | API                       |
| ----------- | --------------------- | ------------------------- |
| `customer`  | `#/customers/<id>`    | `GET /api/v1/customers/:id` |
| `supplier`  | `#/suppliers/<id>`    | `GET /api/v1/suppliers/:id` |
| `product`   | `#/products/<id>`     | `GET /api/v1/products/:id`  |
| `sale`      | `#/sales/<id>`        | `GET /api/v1/sales/:id`     |
| `expense`   | `#/expenses/<id>`     | `GET /api/v1/expenses/:id`  |
| `payment`   | `#/payments/<id>`     | `GET /api/v1/payments/:id`  |

Users, businesses, audit, security, platform, AI-cost, notification,
portability, payment-processor and chat concepts are **not** routable
entities. Unknown first hash segments fall back to the dashboard; ids are
charset-validated (`[A-Za-z0-9_-]{1,64}`) and percent-decoded safely.

## 2. Deep-link navigation flow

```
LIST / SEARCH / COMMAND PALETTE
  → exact entity detail (#/customers/<id>)
    → related records (invoices, payments, supplier, …)
      → related entity detail
```

- Search Results Center (`#/search`) and the Command Palette (Ctrl/Cmd+K)
  open the **exact entity** (type+id resolve through the closed
  `SEARCH_TYPE_TO_ENTITY` map). "View all search results" still opens
  `#/search?q=…`.
- All six list pages support row click **and keyboard activation**
  (Enter/Space) to open the detail; action buttons inside rows keep their
  own semantics (edit stays edit, delete stays delete).
- Browser back/forward and page refresh on a deep link work; malformed
  ids degrade to the dashboard, unknown/deleted/foreign ids render the
  localized not-found state.

## 3. Detail structure

Every detail page shares one shell (`src/modules/entities/`):
back button + breadcrumb, entity icon/avatar, title, type/status badge,
metric strip, contact/field cards, and related-record lists.

- **Customer 360** — Total sales / Paid / Receivable / Invoices
  (open count hint), contact card, recent invoices (≤10), recent
  payments (≤10).
- **Supplier 360** — Total expenses / Paid / Payable / Bills
  (open count hint), contact card, recent bills (≤10), recent
  payments (≤10).
- **Product** — Sale/Cost price, Stock, Low-stock threshold, stock
  state (`OUT_OF_STOCK | LOW_STOCK | HEALTHY`, reusing the established
  thresholds), recent adjustments (≤10, static rows), recent unique
  sales (≤10 via SaleItem→Sale).
- **Sale** — Invoice header (INV number, customer, status), subtotal /
  discount / total / paid / balance, items table (product rows navigate
  to the product detail), payments list (navigate to payment detail).
- **Expense** — Amount / Paid / Balance, clickable supplier, read-only
  note, payments list (≤20).
- **Payment** — Amount / direction / method / date / note and exactly one
  related document (sale or expense). Reversal is surfaced only for
  `finance:manage` holders and reuses the existing DELETE endpoint.

Edit/delete/reverse actions reuse the EXISTING endpoints and dialogs
(`PartyFormDialog`, `ProductFormDialog`, `ExpenseFormDialog`,
`StockDialog` — all extracted, not duplicated).

## 4. Customer/Supplier 360 semantics

- All values are **integer minor units**; the server is authoritative.
- `receivableMinor = Σ(sale.totalMinor − sale.paidMinor)` over same-business,
  non-deleted sales of that customer (one `groupBy(status)` aggregate — no
  N+1, no full-history loads). `payableMinor` mirrors this over expenses.
- Counts bucket by the stored `status` column, which is written exclusively
  through `statusOf(totalMinor, paidMinor)` — no second status definition.
- Related rows never bypass tenant scope and are bounded (≤10 / ≤20).

## 5. Cache & business switching

- Query keys: `["entities", businessId, entity, id]` (`entityKeys`) — the
  business id is part of every key so cached details can never cross
  businesses.
- On business switch the entity domain is invalidated and the mounted view
  re-resolves against the new business; a record belonging to the previous
  business renders the not-found state (never stale data).
- Mutations invalidate targeted keys only (the mutated entity detail, the
  affected counterparty detail, and the existing list/report keys).

## 6. Related navigation matrix (§34)

| From    | To                                        |
| ------- | ----------------------------------------- |
| Customer | Sales, Payments                           |
| Supplier | Expenses, Payments                        |
| Product | Sales (product rows)                      |
| Sale    | Customer, Products (items), Payments      |
| Expense | Supplier, Payments                        |
| Payment | Sale **or** Expense (then its counterparty) |

No arbitrary cross-module links exist; every row navigates through
`navigateToEntity` over the closed route map.

## 7. Current limitations (honest)

- Recent lists are capped (10/10/10/20); older history stays in the lists
  (paginated) — the detail page is a bounded window, not an archive.
- Product "recent sales" dedupes SaleItem rows into ≤10 unique sales; if a
  product sells in more than 10 recent sales, older ones are not shown.
- No search inside detail pages, no "recently viewed" tracking, no saved
  views (explicitly out of scope for Prompt 34).
- All roles currently hold `data:read`, so a role-gated 403 is reachable
  only at the membership layer (verified) — same as Prompt 33.
