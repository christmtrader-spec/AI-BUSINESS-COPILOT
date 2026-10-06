# ADR 0041 — Supplier Purchase Orders: a PROCUREMENT COMMITMENT document

- **Status:** Accepted (implemented; finalized + hardened by Prompt 41-F)
- **Date:** 2026-10-06
- **Scope:** `prisma/schema.prisma` (PurchaseOrder, PurchaseOrderLine), `src/lib/purchase-orders/**`, `/api/v1/purchase-orders/**`, `src/modules/purchase-orders/**`, search / entity-detail / data-portability integrations.

## Context

Prompts 17–40 delivered sales, expenses, payments, inventory control and
reporting. Procurement intent had no home: a business that wants to record
"we committed to buy these goods from this supplier" had only side channels
(notes, external documents). The obvious trap is to model purchase orders as
financial events — but the platform's financial authorities (Expense,
Payment, Sale, InventoryAdjustment, statements, aging) are deliberately
simple and cash/transaction-based. Conflating commitment with posting would
corrupt every existing number.

## Decision

1. **A purchase order is a PROCUREMENT COMMITMENT DOCUMENT** — never an
   expense, payment, inventory receipt, payable, or accounting entry. No
   lifecycle transition writes any financial or inventory authority. This is
   enforced three ways: domain law (no such write exists), static scan rules
   32–40 (forbidden-write scan), and live snapshot tests (financial
   non-mutation before/after full lifecycle).
2. **Two tables only.** `PurchaseOrder` (header: tenant, supplier, unique
   reference per business, status, currency snapshot, dates, supplier name
   snapshot, creator, lifecycle timestamps) and `PurchaseOrderLine` (order,
   product, qty, price, product snapshots). One additive migration
   (`20261006090000_prompt41_purchase_orders`); no edits to existing tables.
3. **Closed lifecycle, dedicated endpoints.** DRAFT → SENT → CONFIRMED →
   CLOSED, CANCELLED from the first three; terminal states never transition.
   No generic status PATCH; status re-checked inside the transaction.
4. **Immutable history via snapshots.** Supplier/product names, SKU, unit and
   the business currency are frozen at write time and never re-interpreted
   from live data. Live names are navigation metadata only.
5. **Server-authoritative money.** Integer minor units; totals derived with
   one canonical BigInt function shared by create/list/detail/export/supplier
   history; safe-integer overflow → 422; client totals ignored. The unit
   price bound (0..1e9) matches what `Int` money columns can actually store.
6. **One centralized status-integrity policy.** Unknown persisted status
   throws; it is never coerced to DRAFT anywhere (DTOs, list, detail, export,
   search, entity sections).
7. **SQLite concurrency discipline.** Write transactions serialize in-process
   (single-writer database) with a bounded transient retry; the line cap is
   re-checked after insert inside the transaction so races can never exceed
   it.
8. **Search & surfaces are consumers, not authorities.** Global search,
   Supplier 360, and product history read bounded, tenant-scoped,
   money-free views. Data-portability gains read-only datasets; import stays
   unsupported for purchase orders.

## Consequences

- Procurement intent is auditable and searchable without touching financial
  truth — the correct prerequisite for any future Goods Receipt feature (a
  separate, explicit decision that would finally connect commitments to
  inventory through the existing InventoryAdjustment semantics).
- Snapshot columns duplicate live names; accepted — history is the point.
- No automatic reordering, goods receipt, valuation or double entry — those
  require their own prompts and are explicitly out of scope (§127/§130).
