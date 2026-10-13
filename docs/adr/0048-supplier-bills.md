# ADR 0048 — Supplier Bills & Accounts Payable Documents

- Status: ACCEPTED (implemented, Prompt 48; completion hardening Prompt 48-C)
- Date: 2026-10-13
- Deciders: procurement/payables workstream (Prompt 41→48 chain)

## Context

The procurement chain (Prompt 41 Purchase Orders, Prompt 42 Goods Receipts,
Prompt 43 Goods Returns) ends at physical inventory; the financial payable
side is owned by the pre-existing Expense + Payment workflow (Prompts
34/22, statements/aging in Prompt 39 and the payables-aging round).
Real-world procurement needs the missing middle document: the supplier's
INVOICE, recording which quantities and prices the supplier actually
billed — which can differ from both what was ordered and what was received.

The risk this ADR guards against: turning the bill into a second payable
authority (double-counted liabilities in statements/aging), a payment
mechanism (bypassing Payment), or an inventory mutation (bypassing
GoodsReceipt as the physical authority).

## Decision

1. **SupplierBill is a document authority.** It records invoiced
   quantities and prices against exactly one PO. It owns no money
   movement, no stock movement, and no settlement semantics.

2. **Expense remains the SOLE financial payable authority.** Posting a
   DRAFT bill runs ONE transaction that: validates the frozen document
   (PO billable CONFIRMED|CLOSED, currency match, three-way quantity
   match, server-derived totals > 0), creates EXACTLY ONE linked Expense
   (`amountMinor = bill total`, `paidMinor = 0`, UNPAID,
   `spentAt = billDate`, `reference = supplierInvoiceReference`,
   category "Supplier bill"), and flips the bill to POSTED with
   server `postedAt`. The `SupplierBill.expenseId` UNIQUE constraint
   makes one-payable-per-bill a database law.

3. **One = one = one.** One posted bill → one linked Expense → one
   payable movement in the supplier statement and payables aging. The
   statement and aging engines were NOT changed: they already read the
   Expense, so the bill adds no second movement by construction.

4. **Three-way quantity matching is one pure law** shared by draft
   advisories, the posting transaction, and the PO detail page:
   `available = received(POSTED) − returned(POSTED) − billed(POSTED)`.
   Corruption (inconsistent aggregates) is a controlled 500 — never
   clamped. Returns join through the authoritative receipt-line relation.
   Drafts never reserve quantity; concurrency resolves inside the posting
   transaction (loser gets a stable controlled error).

5. **Price variance is evidence, not error.** Every line freezes the PO
   unit price next to the invoiced price; the variance is displayed and
   exported but never normalized, never blocked, never tolerated by an
   invented rule.

6. **Zero-total bills cannot post** (`SUPPLIER_BILL_ZERO_TOTAL`) because
   the payable store requires `amountMinor ≥ 1`. Free LINES are allowed
   (P41 §29 law) as long as the document total is positive.

7. **POSTED is immutable; CANCELLED is terminal.** No generic status
   PATCH — only dedicated post/cancel endpoints re-validating inside the
   transaction. Corrupted persisted statuses are integrity 500s, never
   silently Draft.

8. **Expense/Payment protection.** A bill-linked Expense cannot be
   deleted or materially edited through generic endpoints (note edits
   stay allowed); Payments remain the only settlement authority; the bill
   detail always reads the LIVE Expense (no copied balances).

9. **Portability.** Two export-only datasets (`supplier_bills`,
   `supplier_bill_lines`); imports remain closed for them; the backup
   round-trip VALIDATES the sections but never re-imports them — the
   posting transaction is the only sanctioned origin of a bill, so a
   restore can never fabricate payables or claim relations.

10. **Strict audit for posting.** Both posting audits
    (`supplier_bill.post`, `expense.create`) use `auditStrict` inside the
    transaction — an audit failure rolls back the entire posting.

## Consequences

- The bill detail page shows document + lines + the LIVE payable
  (amount/paid/outstanding/status) + payments recorded through the
  existing workflow — no second balance field exists anywhere.
- Multiple bills per PO are natural (partial invoicing); `CLOSED` POs
  still accept bills for already-received quantities (invoices arrive
  after procurement closes); PO lifecycle is untouched by billing.
- Search gains `SUPPLIER_BILL` with metadata-only DTOs (no money, no
  notes).
- Backup/import semantics stay conservative: accepted-not-imported
  sections, consistent with the members/auditTrail precedent.
- Reversal (credit notes / bill cancellation after posting) is
  deliberately out of scope; the documented path is the immutable posted
  bill plus downstream corrections via returns and payments.

## Verification

- Unit laws: `scripts/prompt48-unit.ts` (286 assertions).
- E2E chain incl. statement/aging no-double-count, payment flows,
  protection, search, export/import, backup: `scripts/
  prompt48-supplier-bill-check.mjs` (212 assertions, teardown to zero).
- Cap + concurrency + rollback: `scripts/prompt48-supplier-bill-cap-check.ts`
  (58 assertions, incl. SQLite-trigger audit-failure and mid-transaction
  rollback proofs).
- Structural/security scan: `scripts/prompt48-supplier-bill-static-scan.mjs`
  (20 rules).
- Migration: additive two-table CREATE
  (`20261013090000_prompt48_supplier_bills`), no existing table altered;
  verified via migrate status, ledger, quick_check, foreign_key_check.

## References

- Prompt 48 specification (§0–§30), Prompt 48-C completion directive.
- ADR 0041 (PO), ADR 0042 (receipts), ADR 0043 (returns), ADR 0039
  (statements), payables-aging round (Expense terms).
- `docs/product/supplier-bills.md`, `docs/security/supplier-bills-security.md`.
