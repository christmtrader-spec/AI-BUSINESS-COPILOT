# Sales Quotations (Prompt 47)

Formal commercial offers: propose → send → accept → convert to an order.

## What a SalesQuotation is — and is NOT

A `SalesQuotation` records **a formal offer made to a prospective or
existing customer: which products, at which quantities and prices, valid
until which date**. It is a pre-commitment COMMERCIAL document:

- it is **NOT an order** (that is the converted `SalesOrder`);
- it is **NOT revenue** (revenue exists only when a `Sale` invoice is
  issued through the existing pipeline);
- it is **NOT an invoice** (`Sale`), **NOT a payment**, **NOT a
  receivable**;
- it is **NOT an inventory movement** — it never writes an
  `InventoryAdjustment` and never touches `Product.stockQty`;
- it is **NOT a stock reservation** (there is no reservation model —
  availability stays "current physical stock");
- it is **NOT an accounting entry** (no ledger, no journal — the product
  has no accounting system of record).

Creating, editing, marking sent, accepting, rejecting, cancelling,
expiring or converting a quotation never directly alters inventory and
never creates a financial transaction. The ONLY permitted downstream
effect of conversion is **one legitimate linked `SalesOrder`** through
the existing Prompt 45 order workflow — dispatch, invoicing, payments
and receivables stay owned by `GoodsDispatch` / `Sale` / `Payment`.

## Lifecycle

The canonical transition matrix lives in
`src/lib/sales-quotations/types.ts` (`SALES_QUOTATION_TRANSITIONS`) —
server-authoritative and exhaustive; no route or UI duplicates it.

| Status | Meaning | Allowed transitions |
|---|---|---|
| `DRAFT` | preparation; header + lines editable | SENT, CANCELLED |
| `SENT` | offer declared sent to the customer; terms immutable | ACCEPTED, REJECTED, CANCELLED, EXPIRED* |
| `ACCEPTED` | customer acceptance declared; immutable | CONVERTED, CANCELLED† |
| `REJECTED` | terminal (customer declined) | — |
| `EXPIRED` | terminal (validity passed) | — |
| `CANCELLED` | terminal | — |
| `CONVERTED` | terminal (exactly one order exists) | — |

`*` SENT → EXPIRED is legal only when the offer is **actually past** its
validity date (guarded inside the write transaction).

`†` ACCEPTED → CANCELLED is legal only **before** conversion — the
documented cancel-before-conversion policy. Once CONVERTED, the order is
the commercial commitment and the quotation is a read-only source
document; an accepted offer that was never converted can still be
cancelled by an authorized user.

`DRAFT` requires no lines; **marking sent requires ≥ 1 line**
(`SALES_QUOTATION_EMPTY`). Everything after DRAFT is read-only
(`SALES_QUOTATION_IMMUTABLE` on edit/line attempts).

## MANUAL DECLARATION semantics (what SENT and ACCEPTED actually record)

- **SENT** = an internal user's declaration that the offer was sent to
  the customer **OUTSIDE the application** (email, print, phone — any
  channel). `sentAt` is set by the server inside the transaction. There
  is **NO email delivery** in the product; the app never claims it sent
  anything.
- **ACCEPTED** = an authorized internal user's declaration that the
  customer accepted the offer. `acceptedAt` is a bookkeeping stamp,
  **NOT a verified portal signature**.

There is deliberately **no public quotation endpoint, no customer
portal, no acceptance token and no email delivery** in this phase. The
printable offer (below) is the only customer-facing artifact, produced
by the staff user, not delivered by the system.

## Validity & expiration (derived, never scheduled)

- The offer is valid **THROUGH `validUntilDate` INCLUSIVE** in the
  **business timezone**; it is expired when the current business-local
  calendar date is **after** `validUntilDate`. The server is the time
  authority (never the browser clock); calendar dates are computed with
  the established `Intl` en-CA business-local formatting, and invalid
  calendar dates (`2026-02-30`) are rejected, never rolled over.
- `validUntilDate` earlier than `quotationDate` is rejected
  (`SALES_QUOTATION_INVALID_DATE_RANGE`).
- **Expiration is DERIVED**: a persisted `SENT` offer past its validity
  renders with `effectiveStatus: EXPIRED` while its `persistedStatus`
  remains `SENT` — the DTO exposes **both** fields explicitly and the
  database is never silently pretended to be mutated. There is **no
  `expiredAt` column and no background scheduler**.
- An **explicit expire transition** (`POST …/expire`) exists for a SENT
  offer already past validity: it is atomic (re-checks actual expiry
  inside the write transaction) and audited. Expiring an offer still
  within validity is rejected (`SALES_QUOTATION_NOT_EXPIRED`); accepting
  or rejecting an expired offer is rejected
  (`SALES_QUOTATION_EXPIRED`).
- **ACCEPTED never expires after the fact**: acceptance is already
  recorded, so a later-passing validity date never changes an ACCEPTED
  quotation's status or its convertibility.

## Snapshot freezing

- `customerNameAtQuotation` and per-line `productNameAtQuotation` /
  `skuAtQuotation` / `unitAtQuotation` are frozen **server-side at write
  time** from verified tenant-scoped rows; the client never submits
  snapshot values (strict zod rejects them).
- Later customer/product renames (or soft-deletes) **never rewrite
  history**.
- Conversion copies the **FROZEN** values into the sales order — it
  never re-prices or re-names from live `Products`.

## Quantities, prices, totals

- `qty`: whole safe integer 1..1,000,000 per line.
- `unitPriceMinor`: integer minor units 0..9,000,000,000; defaults from
  `Product.salePriceMinor` at line creation but persists as the OFFERED
  price.
- `discountMinor`: integer 0..subtotal, enforced on every write
  (`INVALID_DISCOUNT`). No tax engine, no shipping, no payment fields.
- Totals are always recomputed **server-side** with exact integer math:
  `lineTotal = qty × unitPriceMinor`, `subtotal = Σ lineTotals`,
  `total = subtotal − discount`. Overflow is **rejected**
  (`SALES_QUOTATION_TOTAL_OVERFLOW`), never rounded or truncated;
  client-submitted totals are never trusted.
- Line cap: `SALES_QUOTATION_MAX_LINES` (20..500, default 200) —
  malformed/empty values fall back to the default, never unbounded.

## Conversion — exactly ONE order per accepted quotation

`POST …/convert` (ACCEPTED only) runs inside the shared write
transaction:

1. tenant-scoped reload inside the transaction;
2. already-converted guard **before** the status gate (every loser —
   including a retry after the winner committed — gets the one stable
   `SALES_QUOTATION_ALREADY_CONVERTED` conflict);
3. ACCEPTED-only status law (corrupted status → controlled 500);
4. complete, materially valid line set (cap+1 completeness invariant);
5. canonical totals recomputed from persisted lines;
6. every snapshot validated;
7. **ONE** `SalesOrder` created **CONFIRMED**: customer snapshot,
   currency snapshot, expected delivery date, discount copied EXACTLY;
   `orderDate` = current business-local date (midnoon rule);
   **`internalNotes` → `SalesOrder.notes`** (staff continuity on the
   order — never the customer print view);
8. **ONE** `SalesOrderLine` per quotation line with the frozen
   snapshots and exact qty/`unitPriceMinor` — never re-priced from live
   products;
9. quotation → `CONVERTED` + `convertedAt`;
10. two audits (`sales_order.create` + `sales_quotation.convert`)
    written in the SAME transaction.

The **DB-unique `SalesOrder.sourceQuotationId`** is the race authority:
a concurrent second conversion is a constraint violation, never a second
order. Conversion creates **NO Sale, NO Payment, NO receivable, NO
InventoryAdjustment, NO stock change** — a converted order enters the
normal Prompt 45 flow (dispatch → invoice → payment) exactly like a
manually confirmed order. The quotation is never a second authority over
the order; the ORDER remains the fulfillment/financial document.

## The printable offer

- `GET …/print` returns a **reduced customer-facing payload** (no
  database ids, no technical statuses, no audit metadata) and the UI
  opens the **browser print dialog** — no PDF library, no PDF
  generation.
- The print payload contains **NO `internalNotes`** (staff-only by
  construction) and **NO tax rows** (no tax engine exists).
- The sheet is clearly labelled as an **offer/quotation, not an
  invoice**; `customerNotes` (customer-visible notes) ARE included.

## Downstream compatibility

Converted orders are ordinary `SalesOrders`: every Prompt 45 law
applies unchanged (GoodsDispatch POST owns the single stock decrement,
the ONE linked Sale owns the receivable authority, payments follow the
existing pipeline). Legacy/direct orders keep `sourceQuotationId` NULL;
the optional source relation changes nothing about order behavior.

## API surface

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/sales-quotations` | create draft (reference auto-generated `QT-<date>-<token>` when blank) |
| `GET /api/v1/sales-quotations` | bounded list (filters: q, status, customerId, from/to on quotationDate, page/pageSize) |
| `GET /api/v1/sales-quotations/[id]` | detail (header + summary + lines + converted order) |
| `PATCH /api/v1/sales-quotations/[id]` | DRAFT-only header patch |
| `POST …/lines` | DRAFT-only line add (duplicate product → 409) |
| `PATCH …/lines/[lineId]` · `DELETE …/lines/[lineId]` | DRAFT-only line update/remove |
| `POST …/mark-sent` | DRAFT → SENT (≥ 1 line required; server sets `sentAt`) |
| `POST …/accept` | SENT → ACCEPTED (validity-checked; server sets `acceptedAt`) |
| `POST …/reject` | SENT → REJECTED (validity-checked) |
| `POST …/cancel` | guarded cancellation (DRAFT/SENT/ACCEPTED-before-conversion) |
| `POST …/expire` | SENT → EXPIRED (only when actually past validity) |
| `POST …/convert` | ACCEPTED → CONVERTED + the ONE CONFIRMED order |
| `GET …/export?locale=en\|fa` | per-quotation CSV (full security stack) |
| `GET …/print` | reduced customer-facing print payload |

## UI

`#/sales-quotations` (list: desktop table + mobile cards + filters) and
`#/sales-quotations/<id>` (detail deep link). Lifecycle actions are
gated on the **effective** status; a converted quotation shows the order
card with a deep link; internal notes are visually separated from
customer notes. The print overlay renders the reduced payload and opens
the browser print dialog.

## Integrations

- **Global search**: `SALES_QUOTATION` group (reference + customer +
  product/SKU; no amounts, never notes) → `#/sales-quotations/<id>`.
- **Customer 360**: ≤ 10 recent quotations (totals + converted order
  reference; quotation-currency figures, never added to receivables).
- **Product detail**: ≤ 10 recent quotation lines — **quantities only**
  (the same money-free law as order history on product detail).
- **CSV export**: per-quotation, with the `CSV_EXPORT` entitlement gate,
  10/5min rate limit, UTF-8 BOM, CRLF, OWASP formula-injection guard,
  `no-store` attachment and a `data.export` audit.

## Data portability

- **Business export**: `sales_quotations` + `sales_quotation_lines`
  (CONFIDENTIAL, export-only; selecting quotations implies lines). Rows
  carry the frozen snapshots verbatim and integer minor units;
  **`internalNotes` has no export column** (and `customerNotes` exports
  as ordinary document content).
- **Import**: stays structurally blocked — `sales_quotations` /
  `sales_quotation_lines` are rejected by the import allowlist BEFORE
  any database write. Restore from backup is the sanctioned recovery
  path.

## Known limitations (intentional)

- No email delivery — SENT is a manual declaration only.
- No PDF generation — the print view relies on the browser print dialog.
- No public acceptance — no portal, no token, no customer signature.
- No background scheduler — expiration is derived at read time plus the
  explicit audited expire transition; nothing flips statuses at midnight.
- No tax engine — offer math is subtotal − discount only.
- No quotation delete API — terminal documents are immutable records;
  discarding an offer is the CANCELLED lifecycle state.
