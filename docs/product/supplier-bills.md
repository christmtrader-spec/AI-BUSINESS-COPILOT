# Supplier Bills (Accounts Payable Documents) — Prompt 48

The supplier invoice document: "the supplier invoiced these product
quantities at these unit prices against this purchase order." It connects
the procurement chain (Purchase Order → Goods Receipt → Goods Return) to the
existing accounts-payable workflow (Expense → Payment → Statement → Aging).

> SEMANTIC LAW: a SupplierBill is a PROCUREMENT INVOICE DOCUMENT. It is NOT
> a GoodsReceipt (physical receipt authority), NOT a PurchaseOrder
> (procurement commitment), NOT a GoodsReturn (physical return authority),
> NOT a Payment (settlement authority), and NOT an Expense category in
> disguise. The bill is the DOCUMENT authority; the linked Expense is the
> SOLE financial payable authority. Posting says exactly: "this invoice
> became one payable through the existing Expense."

## The critical invariant

```
ONE POSTED SUPPLIER BILL
    = ONE LINKED EXPENSE PAYABLE
    = ONE PAYABLE MOVEMENT IN FINANCIAL REPORTS
```

The SupplierBill is NEVER an additional payable movement while its linked
Expense already represents it. The data model enforces this at the database
level: `SupplierBill.expenseId` is nullable AND unique
(`SupplierBill_expenseId_key`) — a bill has AT MOST one Expense, an Expense
has AT MOST one bill.

Posting a bill does NOT:

- change `Product.stockQty`;
- create an `InventoryAdjustment`;
- create a `Payment`;
- create a `Sale` or receivable;
- mutate the purchase order (status, ordered quantities, lifecycle).

The existing Payment workflow remains the ONLY settlement authority.

## Authority map (§4)

| Concept            | Authority over                                   |
| ------------------ | ------------------------------------------------ |
| PurchaseOrder      | procurement intent and terms                     |
| GoodsReceipt       | physical quantities received (POSTED only)       |
| GoodsReturn        | physical quantities returned (POSTED only)       |
| SupplierBill       | quantities and prices the supplier INVOICED      |
| Expense            | payable amount, due date, paid, payment status   |
| Payment            | actual payment transactions                      |
| Supplier statement | DERIVED view of authoritative Expense/Payments   |
| Payables aging     | DERIVED from Expense balances and due-date rules |

No component silently substitutes another's authority. The bill detail page
READS payment state from the live linked Expense — it never stores a
duplicate paid/outstanding field.

## Document structure

- Header: server-generated or user reference (`SB-YYYYMMDD-6base32` when
  blank), supplier invoice reference (unique per business + supplier,
  SQLite multi-NULL semantics keep invoice-less bills conflict-free),
  frozen supplier/PO/currency snapshots, `billDate` + optional `dueDate`
  (strict `YYYY-MM-DD`, normalized to UTC-midnoon — Prompt-35 §84 law),
  discount, internal notes (≤2000, never audited/searched/exported).
- Lines: exactly one per PO line (unique `supplierBillId +
  purchaseOrderLineId`), `billedQty` 1..1,000,000 whole units,
  `unitPriceMinor` 0..1,000,000,000 (zero = free line, P41 §29 law), the
  PO unit-price snapshot for variance evidence, and the product snapshot.

## Lifecycle (closed vocabulary, §10)

| From      | To        | Allowed |
| --------- | --------- | ------- |
| DRAFT     | POSTED    | ✔ (the atomic posting transaction) |
| DRAFT     | CANCELLED | ✔ (pure document transition — no payable) |
| POSTED    | *         | ✘ — immutable (edit/cancel/re-post all rejected) |
| CANCELLED | *         | ✘ — terminal |

- **DRAFT** — preparation only. Creates no Expense, no Payment, no
  statement movement, no aging entry, no stock anything (§10). Lines and
  header freely editable; availability checks are advisory.
- **POSTED** — the document is frozen. Server `postedAt`, exactly one
  linked Expense. Immutable in this phase (reversal workflow out of scope).
- **CANCELLED** — terminal; nothing financial ever existed for it.

An unknown PERSISTED status is a data-integrity error
(`SUPPLIER_BILL_INVALID_PERSISTED_STATUS`, HTTP 500) — never silently
treated as DRAFT. There is no generic status PATCH: only the dedicated
`/post` and `/cancel` endpoints transition state.

## Three-way quantity matching (§7)

```
availableBillableQty = receivedQty(POSTED GoodsReceiptLine)
                     − returnedQty(POSTED GoodsReturnLine, joined through
                       the source receipt line → PO line)
                     − previouslyBilledQty(POSTED SupplierBillLine)
```

- DRAFT/CANCELLED receipts, returns and bills never participate.
- Goods Dispatch never participates (supplier matching is inbound only).
- Every source line must belong to the bill's exact purchase order —
  wrong-PO lines are rejected with `SUPPLIER_BILL_FOREIGN_ENTITY`.
- Draft bills do not reserve quantity; concurrent competition for the last
  quantity resolves inside the posting transaction (the loser gets the
  stable controlled error, the final DB state is always consistent).
- Corrupted history (received > ordered, returned > received,
  previouslyBilled > net received) is a controlled 500
  (`SUPPLIER_BILL_CORRUPT_HISTORY`) — NEVER clamped to zero and never
  discarded. The PO detail and posting paths share THE ONE pure law
  (`computeAvailableBillableQty`).

## Price and totals (§8/§9)

- `lineTotalMinor = billedQty × unitPriceMinor` — BigInt intermediate,
  safe-integer result; overflow → `SUPPLIER_BILL_PRICE_OVERFLOW`.
- `subtotalMinor = Σ lineTotalMinor`; `totalMinor = subtotal − discount`.
- The price variance (`invoiced unit price − PO unit price`) is RECORDED
  AND DISPLAYED, never silently normalized, never blocked (no invented
  tolerance rule). The PO price snapshot travels on every line.
- Currency snapshot must match the PO at posting
  (`SUPPLIER_BILL_CURRENCY_MISMATCH`) — no FX conversion, no tax engine.
- A zero-TOTAL bill cannot post (`SUPPLIER_BILL_ZERO_TOTAL`): the existing
  payable store requires `amountMinor ≥ 1`. This is an explicit policy.
- All client totals are structurally rejected at the zod boundary
  (`.strict()`); the server derives every amount from stored lines.

## Posting transaction (§11)

`POST /api/v1/supplier-bills/[id]/post` runs the ENTIRE posting inside the
shared `withWriteTransaction` (FIFO-serialized, transient-retry):

1. reload the bill inside the transaction (never trust an earlier GET);
2. guard: already-linked → 409 `SUPPLIER_BILL_ALREADY_LINKED`;
   only DRAFT → 409 `ALREADY_POSTED`/`INVALID_TRANSITION`;
3. validate the PO (tenant, billable status CONFIRMED|CLOSED, supplier
   match, currency match);
4. reload all lines with cap+1 completeness (over-cap → 500 invariant);
5. per-PO-line three-way matching (final authority);
6. recompute line totals + header totals from stored values;
7. create exactly ONE Expense (supplier, `amountMinor = totalMinor`,
   `paidMinor = 0`, UNPAID status, `spentAt = billDate` midnoon,
   `dueDate`, `reference = supplierInvoiceReference`,
   category "Supplier bill");
8. set bill `status=POSTED`, `postedAt`, `expenseId`, canonical totals;
9. write BOTH audits (`supplier_bill.post` + `expense.create`) with the
   STRICT audit variant INSIDE the transaction — an audit failure rolls
   back the entire posting (no bill transition, no Expense, no partial
   payable — proven by the cap-check suite with real SQLite triggers).

## Expense and Payment protection (§12)

An Expense linked to a POSTED bill cannot be deleted or materially edited
through the generic Expense endpoints (amount, supplier, category, spentAt,
dueDate, reference → 422 `SUPPLIER_BILL_LINKED_EXPENSE_IMMUTABLE`). Note
edits stay allowed. Payment-authoritative updates to `paidMinor`/status are
untouched: partial payments make the payable PARTIAL (visible live on the
bill detail), full payments make it PAID and remove it from payables aging.
A failed payment never damages the bill or the payable.

## Statements and aging (§18)

The Prompt 39 statement engine and the payables aging read the linked
Expense only. A posted bill adds exactly ONE statement movement (the
Expense's BILL event) and ONE aging row; DRAFT/CANCELLED bills add none.
The statement/aging never double-count the bill — asserted by the E2E
suite against the live engines.

## Global search (§5)

Closed type `SUPPLIER_BILL`, destination `supplier-bills`. Searchable
metadata only: internal reference, supplier invoice reference, supplier
snapshot, PO reference snapshot, product/SKU snapshots. No internalNotes,
no amounts, no payment state in search DTOs. Tenant-scoped, bounded (line
snapshot text capped by the bill line cap), safe for corrupted persisted
statuses (token omitted, never faked as Draft).

## Data portability (§6)

- Two CONFIDENTIAL export-only datasets: `supplier_bills` +
  `supplier_bill_lines` (implication: requesting bills always carries the
  lines). Exact integer minor units, frozen snapshots, `expenseId` /
  `purchaseOrderId` as relationship identifiers, NO internalNotes column.
- Import stays closed (`IMPORT_DATASET_KEYS = customers/suppliers/products`):
  both dataset names are rejected before any database write, and a
  separately imported Expense can never claim a bill relation.
- Backup round-trip: `supplierBills`/`supplierBillLines` sections are
  VALIDATED (row schemas + lifecycle invariants + integer line math) but
  NEVER re-imported — the only sanctioned origin of a bill is the posting
  transaction. The linked Expense travels through the existing `expenses`
  section (the payable authority), so a backup restores the payable
  without duplicating it.
- Restore drill probes `SupplierBill`/`SupplierBillLine` (honest-absent
  rule for older backups).

## Permissions and isolation

Every route: authenticated session + business context + `data:read`/
`data:write` RBAC + tenant scope from auth context. Foreign/malformed ids
→ 404 with no existence leak. Per-bill CSV export additionally requires
the `CSV_EXPORT` entitlement and is rate limited (10 / 5 min / user).

## Bounds

| Bound                     | Value                                   |
| ------------------------- | --------------------------------------- |
| `SUPPLIER_BILL_MAX_LINES` | env, default 200, clamped 20..500       |
| billedQty                 | integer 1..1,000,000                    |
| unitPriceMinor            | integer 0..1,000,000,000                |
| reference                 | 2..80 visible chars, control-chars-free |
| supplierInvoiceReference  | ≤80 visible chars                       |
| internalNotes             | ≤2000 chars (never leaves staff view)   |

Every document read, posting calculation, export, PO summary and supplier
history follows the cap+1 completeness law: a stored bill exceeding its cap
is corruption → 500, never a partial document presented as complete.

## Verified behavior (test evidence)

- `scripts/prompt48-unit.ts` — 286/286 (pure laws, boundaries, DTOs, i18n).
- `scripts/prompt48-supplier-bill-check.mjs` — 212/212 E2E (full
  PO→receipt→return→bill→post→expense/statement/aging/payments/protection/
  search/export/import/backup chain + teardown to zero).
- `scripts/prompt48-supplier-bill-cap-check.ts` — 58/58 (cap clamp/limit/
  corruption; concurrent post ×2; competing bills; duplicate refs;
  audit-failure rollback; mid-transaction Expense rollback; audit
  atomicity).
- `scripts/prompt48-supplier-bill-static-scan.mjs` — 20/20 structural and
  security laws.
