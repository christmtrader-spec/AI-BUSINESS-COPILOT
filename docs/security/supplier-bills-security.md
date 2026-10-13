# Supplier Bills — Security Reference

> Prompt 48 · Supplier Bills & Accounts Payable Documents.
> Status: **IMPLEMENTED & TESTED** (unit 286/286, E2E 212/212,
> cap/concurrency 58/58, static scan 20/20). Every claim below maps to
> source files.

## 1. Threat model summary

The bill is a financial document feeding the payable ledger. The security
goals are: (a) tenant isolation of every read/write, (b) server authority
over every financial field, (c) exactly-one-payable semantics that no
client action can duplicate, (d) no sensitive data leakage through search,
export, backup or audit, (e) atomic, audited posting.

## 2. Implementation source of truth

| Concern | File |
| --- | --- |
| Domain laws (pure, client-safe) | `src/lib/supplier-bills/types.ts` |
| Zod request boundaries | `src/lib/supplier-bills/schema.ts` |
| DTO allowlists | `src/lib/supplier-bills/dto.ts` |
| Service + posting transaction | `src/lib/supplier-bills/service.ts` |
| Per-bill CSV | `src/lib/supplier-bills/export.ts` |
| API routes (7) | `src/app/api/v1/supplier-bills/**` |
| Linked-Expense guards | `src/app/api/v1/expenses/[id]/route.ts` |
| Search registration | `src/lib/search/{types,query,dto}.ts` |
| Export catalog datasets | `src/lib/data-portability/export-catalog.ts` |
| Backup schema | `src/lib/backup-schema.ts` |
| Strict audit | `src/lib/audit.ts` (`auditStrict`) |

## 3. Tenant isolation (A01/A02)

- Every service query filters by `businessId` derived from
  `getAuthContext` — client-supplied business ids are never read.
- Foreign or malformed ids resolve to 404 with the SAME code as a missing
  row (`SUPPLIER_BILL_NOT_FOUND`) — no existence leak. Verified in both
  directions by the E2E suite (tenant A's bill invisible to tenant B and
  vice versa; global search cannot discover foreign bills).
- The linked payable is read with an explicit tenant-scoped Expense query;
  a corrupted link degrades to "no payable card", never a cross-tenant
  leak.

## 4. Server authority over financial fields (§15/§16)

The zod schemas are `.strict()`. Status, currency/supplier/PO snapshots,
totals (`lineTotalMinor`, `subtotalMinor`, `totalMinor`), `expenseId`,
`postedAt`, `cancelledAt`, `createdByUserId` and `productId` are
structurally ABSENT from every client schema; injected authority fields
are rejected with 422 at the boundary (E2E §3.1 exercises exactly this).
Totals are always recomputed server-side from stored lines inside the
same transaction as the mutation.

## 5. Exactly-one-payable enforcement

Defense in depth:

1. In-transaction reload + status/link guard before any write;
2. `SupplierBill.expenseId` UNIQUE index (a second link is a P2002 mapped
   to 409 `SUPPLIER_BILL_ALREADY_LINKED` — never a raw Prisma error);
3. posting creates the Expense inside the SAME transaction that flips the
   status (verified: two concurrent posts → exactly one Expense; an
   exception after Expense creation rolls it back — SQLite-trigger tests
   in the cap suite).

## 6. Duplicate-reference abuse

- `reference` unique per business; generated references (`SB-…`) retry on
  the astronomically unlikely collision, user-supplied duplicates are a
  hard 409.
- `supplierInvoiceReference` unique per (business, supplier); SQLite
  multi-NULL semantics let invoice-less bills coexist. P2002 maps to 409
  `SUPPLIER_BILL_DUPLICATE_INVOICE_REFERENCE`.
- One PO line per bill (composite unique) → 409 `DUPLICATE_PO_LINE`.
No raw P2002 or Prisma metadata ever reaches the client.

## 7. Data-minimization

- `internalNotes` (≤2000) NEVER enter: audit bodies (the audit input
  allowlist carries facts only), search (not indexed, not selected), the
  per-bill CSV, the canonical export datasets, or the backup sections.
- Search DTOs expose no amounts, no paid/outstanding state, no payment
  notes, no actor emails (asserted byte-level by the E2E suite).
- The bill detail DTO exposes `internalNotes` only to the authorized staff
  detail view (data:read on the tenant).
- Per-bill CSV export is audited with COUNTS only (reference + line
  count), never row data.

## 8. Export/import surface

- Per-bill CSV: `CSV_EXPORT` entitlement gate BEFORE any data read,
  10/5min/user rate limit, strict locale (en|fa → else 422), `no-store`,
  attachment headers, ASCII filename (a Persian prefix is an invalid
  ByteString header — fixed this round), OWASP CSV formula guard via the
  shared `toCsv` cell escaper (injection probe verified).
- Canonical datasets `supplier_bills`/`supplier_bill_lines` are
  CONFIDENTIAL, export-ONLY: the import allowlist is closed at
  customers/suppliers/products, so both names are rejected before any
  mutation (no DataImportJob row is created — asserted).
- Backup sections validate (bounded arrays, lifecycle invariants,
  integer math) but are never imported — a restore can neither fabricate
  a payable nor claim a bill↔Expense relation.

## 9. RBAC

| Action | Permission |
| --- | --- |
| List / detail / per-bill CSV | `data:read` (+ CSV_EXPORT for CSV) |
| Create / header patch / lines / post / cancel | `data:write` |
| Backup export/import | OWNER only (existing `settings:manage` + OWNER gate) |

Viewer roles read; only writers mutate; posting is a writer action audited
with actor identity.

## 10. Audit atomicity (A09 + §14-F)

All mutations write their audit inside the same transaction. The posting
uses `auditStrict` for BOTH records (bill transition + expense creation):
an audit insertion failure aborts the whole posting. Proven by a real
database trigger that blocks `AuditLog` inserts for the fixture business —
the bill stays DRAFT, no Expense row exists, no partial audit rows remain,
and a retry after removing the trigger posts cleanly.

## 11. Rate limits and replay safety

- Posting is idempotent-hostile: a post retry after success is the stable
  409 `ALREADY_LINKED`/`ALREADY_POSTED`; concurrent double-posts produce
  exactly one payable.
- Over-billing is impossible by construction: the final three-way match
  runs inside the posting transaction against live aggregates; concurrent
  competitors for the last quantity resolve to at-most-one winner with a
  stable controlled error for the loser (cap suite §6).
- Per-bill export rate limit 10/5min/user; `no-store` prevents cached
  financial artifacts.

## 12. Privacy inventory deltas

New personal/financial data surfaces: bill snapshots (supplier name), PO
references, invoice references, integer amounts. All are tenant-scoped
business records within the existing classification (CONFIDENTIAL
business data); none are platform or authentication secrets. The search
surface deliberately excludes every money field; the export surface
documents them as authoritative document data per the portability policy.
