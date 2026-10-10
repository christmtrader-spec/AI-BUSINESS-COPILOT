# Goods Returns — Security Notes (Prompt 43)

Scope: the GoodsReturn domain added by Prompt 43. Companion to
`docs/product/goods-returns.md` and the P42 security document.

## Threat model summary

The return domain is a WRITE-heavy inventory authority. The dangerous
failure modes are: cross-tenant access, over-returning beyond the original
receipt, driving stock negative, double-posting under concurrency, corrupt
persisted state being silently normalized, financial contamination, and
export leakage. Each is closed below.

## Tenant isolation (§67/§68/§102/§166)

- Every service query filters by `ctx.businessId`; the client can never
  supply a businessId (zod schemas structurally omit it).
- Foreign GoodsReceipt / GoodsReceiptLine / GoodsReturn / GoodsReturnLine
  ids are indistinguishable from unknown ids: stable `404 NOT_FOUND`, no
  existence leak, no tenant wording in messages.
- Verified in both directions with live fixtures (E2E §25/§102): A cannot
  view/edit/cancel/post/export B's return; B cannot discover A's return via
  global search.

## RBAC (§69)

- Reads: `data:read`; writes (create/patch/lines/post/cancel/export): the
  established permission set — no new permission invented. Anonymous → 401;
  MEMBER write → 403 (proven in E2E).

## Source-receipt integrity (§13/§66)

- The source receipt must be tenant-local AND status POSTED. Persisted
  statuses are parsed by the centralized parser; a corrupted receipt status
  surfaces P42's stable `GOODS_RECEIPT_INVALID_PERSISTED_STATUS` 500 — a
  corrupt state is NEVER interpreted as POSTED (and a corrupt return status
  is never interpreted as DRAFT, §65).

## Quantity & stock integrity (§32-§42/§76/§140)

- returnedQty: integer 1..1,000,000 at the zod boundary AND re-validated by
  the pure domain law before any arithmetic.
- Cumulative cap enforced by ONE pure function at line-add (advisory) and
  authoritatively inside the post transaction.
- All historical sums are DATABASE aggregates (`aggregate`/`groupBy _sum`)
  re-validated as exact non-negative integers — no unbounded history reads,
  no in-memory summation of unbounded sets (§37).
- Read paths fetch `cap+1` rows to PROVE completeness; a document over its
  own cap fails with `GOODS_RETURN_LINE_CAP_INVARIANT` (500) instead of
  rendering a truncated total (§76).
- Stock arithmetic: exact integers; corrupt/negative persisted stock →
  controlled 500, never clamped or zeroed; new stock < 0 impossible.

## Concurrency (§49-§53/§158/§159)

- ALL writes run through the shared `withWriteTransaction` helper
  (in-process FIFO serialization + bounded transient retry shared with
  P41/P42). Domain errors (ApiError / over-return / insufficient stock /
  invalid state / tenant violation) are NEVER retried.
- Proven by the isolated cap/concurrency suite: concurrent over-return
  (70+70 vs received 100 → exactly 70 persisted), concurrent same-return
  posts (exactly one transition, one audit, one adjustment set), concurrent
  duplicate line adds (DB unique → 409), concurrent same-reference creates
  (DB unique → 409), return + manual adjustment (no lost update).

## Audit (§131-§133)

- Actions: `goods_return.create|update|line_add|line_update|line_remove|
  post|cancel` — written INSIDE the same transaction as the mutation
  (audit failure ⇒ full rollback).
- Metadata: references, ids, line counts, quantities, status transitions —
  NEVER notes content, secrets, tokens, or session data (§22/§132).

## Financial non-mutation (§7)

- The return path creates NO Expense, Payment, Sale, statement movement,
  payable/aging row, credit note, journal or accounting entry. E2E asserts
  zero rows in every financial table before/after posting.

## CSV export (§103-§111)

- `CSV_EXPORT` entitlement gate → rate limit (10/5min/user) → strict locale
  (en|fa) → safe 404 for malformed/foreign ids BEFORE any data read →
  shared `toCsv` serializer (UTF-8 BOM, CRLF, quoting, formula-injection
  guard) → `no-store` + attachment disposition → `data.export` audit with
  counts only.
- Formula injection (`=1+1`, `+cmd`, `@cmd`, `-tab`) is neutralized by the
  shared cell sanitizer (E2E §26.12).

## Import policy (§114/§115)

Export-only. The return datasets are NOT in the import catalog — a generic
import is rejected before any write (importing a POSTED return could replay
stock decrements).

## Prohibited scope guards

No credit notes, supplier invoices, payments, payables posting, accounting
entries, valuation layers, warehouses/bins/lots/serials/barcodes, shipping
or email integrations, notifications, AI tooling, Redis/queues/workers —
enforced by the static scan (scripts/prompt43-goods-return-static-scan.mjs,
175 rules).
