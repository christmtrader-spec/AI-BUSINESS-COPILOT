# ADR 0050 — Advanced Business Reporting, KPI Correctness, Timezone-Safe Comparisons

**Status:** Accepted (Prompt 50)
**Context:** the final phase of the Supplier Bills (48) → Statements/Aging
(49) → Advanced Reporting (50) sequence. The reports module existed since
Phase 04/06 with an advanced insights block from Prompt 20; this ADR
records the Prompt 50 hardening decisions.

## Decision

1. **One date authority** — `src/lib/report-periods.ts` is the ONLY module
   that converts business-local calendar semantics into UTC instants.
   Engines must not derive their own windows. Local-day instants are
   resolved by Intl offset arithmetic with a verification fixpoint
   (23/24/25h days), never fixed-millisecond steps.
2. **Both bounds, always** — every report window query is bounded with
   `gte` AND exclusive `lt`; the rolling window ends at the end of the
   current business-local day. Future-dated records can never enter a
   completed window. (Fixes D50-A: the old KPI predicate checked only the
   lower bound.)
3. **Comparison windows are exact local calendars** — the previous period
   is the N local dates immediately before the current window (no
   overlap/gap). (Fixes D50-B: the old code anchored windows at
   `Date(local+"T00:00:00Z")` and stepped fixed 86,400,000 ms — wrong for
   every non-UTC zone and across DST.)
4. **Stable identity aggregation** — products group by `productId`
   (nullable → a separate, truthfully-labeled unlinked aggregate); the
   live tenant-scoped product name is reported; SaleItem snapshots stay
   untouched for history. Customers group by `customerId`; every name
   resolution carries the tenant scope. (Fixes D50-C/D50-D.)
5. **Honest denominators** — the category chart gains a server-computed
   "Other" bucket so displayed shares are shares of ALL expenses
   (Gate G). The concentration view exposes unassigned revenue instead of
   redistributing it.
6. **Disclosed previews, complete exports** — bounded JSON previews carry
   `totalCount/displayedCount/hasMore`; CSV exports are complete (keyset
   chunks) or rejected with a stable 413 — never a silent prefix.
   (Fixes D50-E.)
7. **One CSV entitlement** — the monthly and performance exports enforce
   the SAME `CSV_EXPORT` entitlement as the main export; no second
   entitlement is introduced. (Fixes D50-F.)
8. **Net product performance allocates invoice discounts exactly** —
   BigInt largest-remainder per invoice, stable `SaleItem.id` tie-break,
   per-invoice reconciliation to `Sale.totalMinor`; corrupt invoices fail
   loudly. The gross basis is always labeled "line value before
   invoice-level discount".
9. **Safe integer arithmetic everywhere** — `safeAdd/safeMul` guards in
   the engines; overflow raises a controlled integrity error (Gate O).
10. **Truthful labels over convenient ones** — `netAccrualMinor` stays in
    the API (compat) while every user-facing surface says "revenue less
    recorded expenses"; the AI snapshot key was renamed to
    `revenueLessRecordedExpensesIssuedBasis` with an explicit anti-profit
    framing rule; inventory wording states "operational estimate".
11. **The advanced performance report lives INSIDE the Reports module** —
    no second dashboard; `GET /api/v1/reports/performance[/export]`
    behind `ADVANCED_REPORTS` (+ `CSV_EXPORT` for the export), closed
    grouping enums, bounded scans, signed keyset cursors for the
    cash-flow detail.

## Consequences

- Reports from different surfaces (dashboard, drill-down, MoM table, CSV,
  AI copilot) cannot drift: one window service, one aggregation per
  metric, CSV rendered from the same builders as JSON.
- DST/off-by-one bugs are structurally prevented (pure calendar
  enumeration + verified instants) and regression-tested across 10
  timezones including ±14h, ±30min and 45-minute offsets and both US DST
  transitions.
- The JSON preview / complete CSV split is now an explicit, documented
  contract instead of an accident.
- No schema migration was required (no new columns/tables); no new
  entitlements or billing plans were introduced.

## Verification

- Unit: 148 assertions (windows, DST exactness, allocation, parsing,
  cursors, EN/FA parity).
- E2E: 93 checks on the live server (windows, identity, entitlements,
  monthly completeness, performance, validation, isolation).
- Cap: 12 assertions with small env caps (truncation/rejection laws).
- Static: 49 assertions (bounds, tenant scope, gates, money law,
  labeling).
- Browser QA: 13 screenshots across 6 viewport/locale/theme combinations,
  zero console errors, zero horizontal overflow.
