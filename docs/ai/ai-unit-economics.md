# AI Unit Economics — Prompt 26

> Status: **IMPLEMENTED**. Source of truth:
> `src/lib/ai/cost/economics.ts` (health, aggregations, plan economics),
> `src/lib/ai/cost/config.ts` (thresholds). Read-only layer over
> `AiCostRecord` — it never mutates cost state.

## Coverage formulas (explicit denominators, §47/§48)

**Cost coverage** — the honest top-line of `getAiCostHealth(windowDays)`:

```
costCoverageBps = knownCostRecords / attributableCostRecords × 10,000
attributableCostRecords = knownRecords + unknownRecords
```

The denominator is **documented and fixed**: every accepted AI request has
exactly one attributable cost record (the ledger is a 1:1 projection of
committed `AI_REQUESTS` usage events). Records that are not attributable
(e.g. released/failed operations → `NO_USAGE_EVENT`) are outside both
sides of the ratio. Computed in integer basis points, ROUND_HALF_UP — no
floats.

**Token coverage** (a separate metric, never mixed with cost coverage):

```
tokenCoverageBps = completeTokenUsageEvents / aiUsageEvents × 10,000
```

`aiUsageEvents` = committed `AI_REQUESTS` usage events in the window;
`completeTokenUsageEvents` = cost records with `tokenStatus = COMPLETE`.
The equivalence (records with complete token metadata ↔ usage events with
complete provider-reported token data) is documented in
`economics.ts` and holds because the ledger is the 1:1 projection.

## Multi-currency separation (§62)

Currencies are **never summed across codes**. Every total is a
per-currency map — `knownCostNanoMinorByCurrency: Record<string,string>`
with BigInt values serialized as strings. "EUR known cost + USD known
cost" as a single figure is impossible by construction: aggregation
queries group by `(dimension, currency, costStatus)` and recombination
keeps currency keys separate. The same rule applies to anomaly
comparison (`SPIKE_COST` is per currency) and to the guard ceilings.

## Plan economics (§50–§57/§114–§116)

`getPlanAiEconomics(planCode, billingPeriod, { windowDays?, currency? })`
returns a status-gated DTO. The window is 30 days for `MONTHLY`, 365 for
`YEARLY` (override per call).

### Gate order (§114) — evaluation stops at the first failing gate

| Order | Status | Condition |
|---|---|---|
| 1 | `PRICE_UNKNOWN` | price not resolvable via PricingService (no purchasable/active price book row for plan+period+currency) |
| 2 | `INSUFFICIENT_SAMPLE` | `sampleSize < MIN_ECONOMICS_SAMPLE_SIZE` (default 30) |
| 3 | `COST_UNKNOWN` | `costCoverageBps < MIN_COST_COVERAGE_FOR_ECONOMICS` (default 8,000 bps = 80%) — known-cost figures are still reported, but explicitly flagged untrustworthy |
| 4 | `NOT_COMPARABLE_CURRENCY` | the known-cost side is not exactly **one** currency equal to the price currency (§167) |
| 5 | `COMPARABLE` | all gates passed — contribution numerics released |

Non-comparable results keep the non-misleading fields (price,
per-currency known cost, `sampleSize`, `costCoverageBps`) and set every
contribution numeric to `null` (§52/§155). A misleading number is never
displayed just because some numbers exist; there is no fake 0%/100%
rendering for tiny samples (§53/§54).

The price side **always** comes from PricingService `resolvePrice()` —
real stored `PlanPrice` rows from the active price book (§56/§57), never
hard-coded constants, never derived from AI cost.

## The AI CONTRIBUTION definition (§51/§115/§167)

```
contribution = customer platform price − known attributable AI cost
               (both in the SAME currency; price converted to nano-minor
                exactly: priceMinor × 1,000,000)
contributionMarginBps = contribution / price × 10,000   (integer, half-up)
```

- The DTO label is a literal `label: "AI_CONTRIBUTION"`. **It is never
  "net profit"** — callers must display "AI contribution".
- It deliberately **excludes**: salaries, server/infrastructure costs,
  support, tax, marketing, FX effects and payment-processing fees. None
  of these are modeled; none may be smuggled in later under the same
  label. Any broader profitability figure needs a different name and a
  different document.
- `contributionMinor` may be negative; the margin keeps its sign. The
  nano-minor → minor conversion for display uses the documented
  ROUND_HALF_UP integer policy.
- Rationale: this metric answers one bounded question — "does the plan
  price cover the AI provider cost it induces?" — with data the system
  actually has (verified rates + provider-reported tokens).

### Negative contribution (§116)

`negativeContribution: true` is an **operator signal only**. It appears in
the internal economics DTO; no automatic action follows (no plan change,
no throttling, no tenant-visible effect — consistent with the
no-automatic-suspension principle in `ai-cost-governance.md`).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MIN_ECONOMICS_SAMPLE_SIZE` | 30 (1–1,000,000) | minimum attributable records per plan+window before numerics may be trusted |
| `MIN_COST_COVERAGE_FOR_ECONOMICS` | 8,000 bps (≤10,000) | minimum cost coverage; also drives the `HIGH_UNKNOWN_RATIO` anomaly threshold |

Both are read only in `src/lib/ai/cost/config.ts`, server-validated (no
NaN/Infinity/negative/out-of-range — §182) with documented fallbacks, and
share the 15-second config cache. `getAiCostHealth` additionally reports
`guardStatus: "DISABLED" | "ENABLED"` — a configuration state, never a
monetary value.

## Other read-only aggregations (§46/§58–§61/§49)

- `getAiCostBreakdown(windowDays)` — per-dimension aggregates
  (`byProvider`, `byModel`, `byPlan`, `byBusiness`): known/unknown record
  counts, per-currency known totals, request counts, token sums,
  per-dimension coverage bps. Sorted by request volume; every scan is
  window-bounded.
- `getUnknownCostGroups(windowDays)` — grouped UNKNOWN diagnostic
  (provider, model, reason, plan, business), top 200 by count. This is
  the primary tool for driving the reconciliation workflow in
  `ai-provider-cost-rates.md`.

## Data classification — INTERNAL/SENSITIVE (§10/§171)

Provider rates, AI cost records and contribution margins are **operator
commercial data** in the sense of `docs/security/data-classification.md`
(INTERNAL aggregate data with SENSITIVE commercial impact). They must
**never** appear in:

- tenant-facing APIs (no route in `src/app/api/v1` exposes them),
- public pricing pages or plan catalogs,
- copilot answers or grounding data,
- customer data exports (CSV or otherwise),
- billing receipts or payment artifacts,
- marketing material.

Concretely: nothing in `src/lib/ai/cost` is exported through tenant APIs
(`src/lib/ai/cost/index.ts` states this as code law); the only sanctioned
consumers are server-internal operators behind the authorization boundary
(`assertInternalOperator` / `assertInternalServiceCall` — see
`ai-cost-governance.md`). Prompt 28 (Platform Admin) will provide the
governed UI surface; until then the data is accessible only to
in-process scripts and harnesses.

## Current state (honest)

With zero configured rates, every copilot record is `UNKNOWN`, cost
coverage is 0%, and every plan economics result is gated
(`INSUFFICIENT_SAMPLE` / `COST_UNKNOWN`). That is the system working as
designed: it refuses to manufacture economics from honest unknowns. The
`COMPARABLE` path activates automatically once verified rates produce
sufficient KNOWN records in a single currency matching the plan's price
currency.
