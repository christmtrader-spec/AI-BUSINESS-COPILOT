# ADR 0047 — Sales Quotations and Conversion into Sales Orders

Status: ACCEPTED (Prompt 47)
Date: 2026-10-12

## Context

Prompt 45 gave the product a commercial commitment document (SalesOrder)
whose lifecycle starts at the moment the customer has committed. In real
quotation-driven selling, however, the commitment is established by the
CUSTOMER'S ACCEPTANCE of a formal offer — before that, the business
needs to record what was offered, at which prices, with which validity,
and track the offer lifecycle (sent / accepted / rejected / expired)
without any stock or financial effect.

Naively reusing the existing documents would corrupt their meanings:

- a `Sale` invoice is revenue + receivable authority — issuing one for a
  mere offer would fabricate revenue;
- a `SalesOrder` is a commitment — creating one before acceptance would
  let a document the customer never agreed to drive dispatch and
  invoicing;
- the order lifecycle has no offer-specific states (validity window,
  rejection, expiration) and adding them would overload it.

At the same time, a quotation must never become a SECOND authority: no
parallel invoicing path, no second stock semantics, no floating
"accepted offers" that bypass the order workflow.

## Decision

1. **A separate quotation domain.** New `SalesQuotation` /
   `SalesQuotationLine` models with the lifecycle
   DRAFT → SENT → ACCEPTED → CONVERTED (+ REJECTED/EXPIRED/CANCELLED
   terminals), frozen customer/product/currency snapshots, canonical
   safe-integer money, the P41–P45 hardening laws (shared write
   transaction, cap+1 completeness, strict persisted-status parsing,
   business-timezone calendar dates, tenant-scoped 404s, strict input
   schemas, explicit DTO allowlists). A quotation is NOT revenue,
   NOT an invoice/payment/receivable, NOT an inventory movement, NOT a
   stock reservation, NOT an accounting entry.
2. **Conversion creates ONE CONFIRMED `SalesOrder`.** The rationale:
   **customer acceptance establishes the commercial commitment** — so
   conversion is a legitimate, normal entry into the existing order
   workflow, not a bypass of it. Exactly-once is enforced by the DB
   (unique `SalesOrder.sourceQuotationId`) plus the in-transaction
   already-converted guard; every conversion loser gets the one stable
   409. Conversion copies the FROZEN snapshots and the agreed
   qty/prices (never re-priced from live Products), copies
   `internalNotes` into `SalesOrder.notes` for staff continuity, and
   creates NO Sale/Payment/receivable/InventoryAdjustment/stock change —
   the converted order is a normal order dispatched, invoiced and paid
   through the unchanged Prompt 45 path.
3. **Derived expiration with an explicit atomic transition — no
   scheduler.** Validity is inclusive of `validUntilDate` in the
   business timezone; a SENT offer past validity renders as
   `effectiveStatus: EXPIRED` while its persisted status stays SENT
   (persisted vs effective status are explicit, separate DTO fields).
   An explicit, audited `expire` transition exists for users who want
   the persisted record closed, and it re-verifies actual expiry inside
   the write transaction. The server is the only time authority.
4. **No `expiredAt` column.** Expiration is a derived predicate over
   `validUntilDate`, so a persisted timestamp would either duplicate the
   derivation or fake a mutation that never happened. The audited
   expire transition is the persisted record of a human/authorized
   closure, not of clock passage.
5. **ACCEPTED → CANCELLED is permitted before conversion**, as a
   documented policy: acceptance may need to be withdrawn (customer
   changed their mind before the order was cut). After conversion the
   quotation is terminal — the order, not the quotation, is then the
   commitment and follows the order's own cancellation rules.
6. **Products are mandatory on quotation lines.** A quotation line must
   reference a tenant `Product` (Restrict) so that conversion can
   always produce legitimate `SalesOrderLine`s — snapshots freeze
   identity at write time, but the line always has a real product
   anchor; the alternative (free-text offer items) would make
   conversion impossible without inventing products.
7. **`SetNull` on `SalesOrder.sourceQuotationId`.** Business deletion
   cascades BOTH sides (quotation and order are tenant rows), so the
   relation only ever detaches in the one scenario where the whole
   chain is being destroyed together; no order is ever destroyed by the
   quotation domain, and the quotation domain offers no delete API.

## Consequences

- Revenue/receivable semantics are untouched: an offer is not revenue;
  conversion creates no financial record; the ORDER remains the
  fulfillment/financial authority and the quotation is never a second
  authority over it.
- Expiration needs no infrastructure: no cron, no queue, no midnight
  job; the cost is that "EXPIRED" is a display verdict on SENT rows
  until someone runs the explicit transition (documented, audited).
- ACCEPTED offers can be cancelled by an authorized user before
  conversion — this is intentional and stated in the UI copy; after
  conversion, correction flows belong to the order domain.
- Business export gained `sales_quotations`/`sales_quotation_lines`
  (export-only, no internalNotes); import stays blocked for
  operational documents (same law as P41–P45).
- Migration is additive-only (two new tables + nullable
  `SalesOrder.sourceQuotationId` + unique index + 7 indexes);
  baseline 28 migrations applied, 0 pending.

## Alternatives considered

- **Public acceptance portal / acceptance tokens** — rejected: a
  customer-facing surface is a whole new trust boundary (public
  endpoints, anonymous access, signature verification) out of scope;
  ACCEPTED is honestly documented as an internal user's declaration.
- **Email delivery of offers** — rejected: production email is not
  configured anywhere in the product; SENT is a manual declaration that
  the offer was sent outside the application. Fake "the app emailed
  your customer" claims are a trust violation.
- **Reserving stock at acceptance** — rejected for the same reason as
  in ADR 0045: there is no reservation model; availability stays
  "current physical stock", checked only at POST time.
- **Sharing the order reference sequence (or reusing SalesOrder with a
  `QUOTATION` kind)** — rejected: a quotation is not an order and must
  never look like one (printable artifacts, dispatch/invoice surfaces,
  fulfillment fields); references are `QT-…` in their own sequence, and
  the separate domain keeps the transition matrices small and
  auditable.
- **A background scheduler flipping SENT → EXPIRED** — rejected:
  silently mutating history at midnight adds infrastructure and a new
  failure class for zero user value; derived status + explicit atomic
  transition covers both display and record closure.
