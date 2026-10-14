# ADR 0049 — Aging Details: Per-Party Open-Item Drill-Down, Detailed Exports, and Financial Reconciliation

Date: 2026-10-14 · Status: ACCEPTED · Supersedes: none · Extends: ADR 0039 (party statements), the ratified receivables/payables aging

## Context

The aggregate aging (ADR-era `reports/aging` + AgingCard) summarizes
outstanding balances into four fixed buckets and ≤ 8 top parties. Operators
can see *that* money is outstanding and *how old* it is, but not **which
documents** make up a bucket, a party balance or the past-due chip. Prompt 49
requires the open documents behind every summarized balance — without a
second statement engine, without a second aging engine, and without
persisting derived balances.

Two structural facts shaped the design:

1. The existing `buildAgingSide` aggregated parties by **display-name
   string**. Two customers/suppliers with identical names merged into one
   group, which makes reliable per-party drill-down impossible.
2. Any detailed view multiplies read volume; an unbounded "load all open
   invoices" query would violate the repository's bounded-read laws.

## Decision

1. **Party identity by authoritative id (additive).** `AgingItem` and
   `AgingParty` gain `partyId: string | null`; the aggregation map keys on
   the id (with an explicit unassigned group keyed `\u0000`). Names remain
   display-only. The aggregate API response gains `partyId` on `topParties`
   (additive — existing consumers unaffected). Same-name parties are
   distinct groups; the id is the drill-down key (never the name).
2. **One detailed-aging domain.** `src/lib/aging-details.ts` derives open
   items from the authoritative sources (open Sales / open Expenses),
   reusing `localDayIndex` + `agingBucketForAge` + the past-due law from
   `src/lib/aging.ts`. No React component or CSV route re-derives a bucket.
   `src/lib/party-aging.ts` reuses `buildAgingSide` for the bounded 360
   panels. There is exactly ONE bucket algorithm in the repository.
3. **Signed, filter-bound cursor pagination.** A dedicated
   `aging-details-cursor` mirrors the Prompt 39 statement cursor (HMAC-
   SHA256, constant-time compare, opaque ids only) and binds
   businessId + side + party + bucket + pastDue + version. The cursor
   tracks the LAST SCANNED row so post-query bucket filtering can neither
   skip nor repeat documents. Deterministic keyset order: Sale
   `issueDate,id`; Expense `spentAt,id`.
4. **Bounded scans with honest truncation.** Chunked keyset reads (≤ 400
   rows/read), per-request `AGING_DETAIL_SCAN_CAP` (5000, env-tunable with
   clamps), explicit `pageTruncated` / summary `truncated` flags. The
   aggregate report's cap and `truncated` signal are untouched.
5. **Complete-or-reject CSV.** The detailed export walks the declared scope
   with a larger documented scan budget and rejects with
   `AGING_EXPORT_TOO_LARGE` when the scope exceeds
   `AGING_DETAIL_EXPORT_MAX_ROWS` (5000) or completeness cannot be
   certified. A partial CSV with success status is impossible.
6. **Honest semantics preserved.** Receivables expose invoice AGE with no
   due date and no overdue claim (no authoritative customer due date exists
   — inventing one is a separate future data-model change). Payables
   past-due stays: stated dueDate AND strictly-after AND positive balance.
   No historical as-of parameter is added.
7. **Statement source navigation (additive DTO).** Statement rows carry
   `sourceType` + `sourceId`; the view maps them through the closed
   entity-route vocabulary (SALE→sale, BILL→expense, PAYMENT_*→payment).
   Rows without an existing route remain read-only — no invented routes.
8. **360 panels via one canonical helper.** `buildCustomerAgingSummary` /
   `buildSupplierAgingSummary` return bounded `PartyAgingSummary` objects
   (integer money, canonical buckets, payables-only past-due slice present /
   receivables keys absent — never null money).

## Consequences

- Operators can answer "which invoices/expenses make up this balance, which
  bucket, how overdue" and jump to the authorized source document or party
  statement in one click.
- The name-merge defect is fixed at the engine level, benefiting the
  aggregate card too (top-party rows carry ids and drill down).
- Two additive API surfaces require the standard security dossier and rate
  limits; both reuse the established gate stack (auth, data:read,
  CSV_EXPORT, limiter, audit, no-store).
- Trade-off: a heavily bucket-filtered page may stop early with an explicit
  truncation flag; the cursor lets the user keep walking. This mirrors the
  aggregate report's honesty law rather than hiding it.

## Verification highlights

Unit 71/0 · static scan 21/21 · cap 32/0 (own env) · E2E §21 scenarios
1–29: 108/0 (two isolated businesses, same-name identity, bucket totals,
payment lifecycles, statement reconciliation, SupplierBill single-count,
cursor binding, CSV completeness + injection guard, teardown to zero) ·
browser QA across 5 viewports and EN/FA × light/dark with 12 real
screenshots and 0 console errors.
