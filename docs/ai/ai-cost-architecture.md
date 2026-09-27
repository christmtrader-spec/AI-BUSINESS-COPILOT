# AI Cost Architecture — Prompt 26

> Status: **IMPLEMENTED** (Prompt 26). Source of truth:
> `src/lib/ai/cost/*` (money, rates, ledger, economics, governance, config,
> internal) and the Prompt 26 models at the bottom of
> `prisma/schema.prisma`. This document describes the shipped design.
> Companion docs: `ai-cost-governance.md`, `ai-provider-cost-rates.md`,
> `ai-unit-economics.md`.

## What this covers

Server-side **provider cost accounting** for the AI copilot: every accepted
AI operation gets exactly one honest cost record — either an exact cost
computed from a verified provider rate, or an explicit, reasoned
`UNKNOWN`. Nothing is estimated, interpolated or invented.

## The cardinal separation

```
CUSTOMER PRICE  (Plan / PlanPrice / PricingService — Prompt 24)
        !=
AI PROVIDER COST (AiCostRate / AiCostRecord — Prompt 26)
```

Neither side is ever inferred from the other. There is **no FX conversion,
no estimated cost, no mark-up derivation** anywhere in `src/lib/ai/cost`.
The customer pays the platform subscription (settlement currency of the
active price book); the AI provider charges us its own published rate in
its own pricing currency. They meet only in the deliberately-bounded
contribution analysis (`ai-unit-economics.md`), which requires the two
amounts to be in the *same* currency before anything is subtracted.

## Conceptual flow

```
AI Request
  → Copilot route (guard check → usage metering: Prompt 21)
  → AIProvider adapter (z-ai, server-only)
  → Provider response + usage metadata (input/output/total tokens, model)
  → Usage Ledger          — AI_REQUESTS / AI_TOKENS UsageEvents (Prompt 21,
                            remains the SOLE quota authority)
  → Cost Attribution      — attributeAiCost() resolves THE rate and computes
  → Cost Ledger           — AiCostRecord (KNOWN or reasoned UNKNOWN)
  → Economics             — read-only aggregations + contribution (internal)
  → Governance            — anomaly detection + optional request-level guard
```

Attribution runs **after** a successful provider response and **never
throws into the AI response path** (`src/lib/ai/cost/ledger.ts` §29/§30):
a failure is logged, the usage stays recorded, and reconciliation
(`reconcileAiCosts`) may visit the record later.

## Data model (3 tables)

| Model | Role | Key constraints |
|---|---|---|
| `AiCostRate` | The only source of provider-cost truth | `@@unique([provider, model, currency, version, environment])`; verification evidence triple; effective window |
| `AiCostRecord` | One row per accepted AI request | `usageEventId @unique`; `@@unique([businessId, requestId])`; status + snapshot fields |
| `AiCostAnomaly` | Governance signal ledger | `@@unique([type, dedupeKey])`; status `OPEN/ACKNOWLEDGED/RESOLVED` |

### Nano-minor representation (§21)

All rate and cost money is a **BigInt nano-minor** integer:

```
1 currency MINOR unit = 1,000,000 NANO-MINOR units
(EUR: 1 nano-minor = 1e-6 cents = 1e-8 euro; IRR: 1 nano-minor = 1e-6 Rial)
```

- Implemented in `src/lib/ai/cost/money.ts`. The module accepts and
  returns `bigint` only — floats and `Number` money are structurally
  impossible.
- Cost arithmetic: `cost = roundHalfUp(rate × tokens / 1000)` computed
  entirely in BigInt (`multiplyRateByTokens`); rounding is `ROUND_HALF_UP`,
  applied **once at the very end**, never mid-calculation (§20). Every
  result is reproducible from `(tokens, rateVersion, rate values, rounding
  mode)`.
- Non-negative invariant: every helper rejects negative operands
  (`toBigIntSafe`, `addNanoMinor`).
- `formatNanoMinor` / `convertToMinorDisplayOnly` are **display/debug
  only**; the latter returns a `hasSubMinorResidue` flag so a caller can
  never silently pretend precision it lacks. Accounting never converts
  down — the ledger stores nano-minor end-to-end.
- Ratios (coverage, margins, severity) are integer **basis points**
  (1 bp = 0.01%) computed half-up in BigInt — never floats.

### Rate snapshot on cost records (§13)

Every `AiCostRecord` snapshots the resolved rate at attribution time:
`currency`, `rateId`, `rateVersion`, `environment`,
`inputRateNanoMinorPer1K`, `outputRateNanoMinorPer1K`. The calculation
remains reconstructable even if the rate row is later **deactivated**
(rates are never deleted — §12). Null snapshot fields are the signature of
an `UNKNOWN` record that never found a rate.

### Usage-period association

`usagePeriodId` is copied from the anchored committed `AI_REQUESTS`
UsageEvent (or passed explicitly), linking cost to the Prompt 21 billing
period. Plan economics keys off `planCodeAtUsage` — the plan **snapshot at
usage time** (§25): later plan changes never rewrite historical cost
attribution. The plan snapshot resolves through the subscription with the
lazy-trial rule (a `TRIALING` row past `trialEnd` honestly reports
`FREE`).

### Idempotency (§15/§31)

- `AiCostRecord.usageEventId` is `@unique` — one cost record per accepted
  AI operation, ever.
- `@@unique([businessId, requestId])` — the Prompt 21 client-supplied
  `requestId` (a UUID) makes retries safe end-to-end.
- `attributeAiCost` checks the idempotency gate **first**: a replayed
  attribution returns `ALREADY_KNOWN` / `ALREADY_UNKNOWN` without any
  mutation. Concurrent duplicate creation is decided by the constraint,
  never by read-then-write races.

### Indexes

- `AiCostRate`: `(provider, model, environment, active, effectiveFrom,
  effectiveTo)` serves time-aware resolution; `(currency, environment,
  active)` serves currency-scoped lookups.
- `AiCostRecord`: `(businessId, createdAt)`,
  `(provider, model, createdAt)`, `(costStatus, createdAt)`, `(rateId)`,
  `(usagePeriodId)` — every aggregation and reconciliation scan is
  window-bounded and index-served (no unbounded `findMany`, §95/§96).
- `AiCostAnomaly`: `(status, createdAt)`, `(businessId, createdAt)`.

## The honest UNKNOWN state (§163)

```
KNOWN   → costNanoMinor = exact BigInt value, rate snapshot filled
UNKNOWN → costNanoMinor = NULL + costStatus="UNKNOWN" + unknownReason
```

`UNKNOWN` is **never 0** and never an estimate. A zero would silently
understate cost; a fabricated estimate would poison every economics
figure downstream. The stable `unknownReason` vocabulary (§18):
`RATE_NOT_FOUND`, `MODEL_UNKNOWN`, `TOKENS_MISSING`, `PARTIAL_TOKEN_DATA`,
`CURRENCY_NOT_CONFIGURED`, `PROVIDER_NOT_CONFIGURED`,
`ENVIRONMENT_MISMATCH`, `RATE_NOT_VERIFIED`, `AMBIGUOUS_RATE`.

Token metadata has its own honesty ladder (§16): `COMPLETE` (input+output
present — the only status that can ever be priced), `PARTIAL` (one side
only — never interpolated), `TOTAL_ONLY` (a total without split), `NONE`
(no provider-reported usage). Only provider-reported values enter the
ledger; missing splits are never derived from totals.

## Current state (honest)

`AiCostRate`, `AiCostRecord`, `AiCostAnomaly` all exist and the pipeline is
wired into both copilot routes (`/api/v1/copilot` and
`/api/v1/copilot/stream`). As of Prompt 26 no production commercial rate
has been configured for the `z-ai` provider (deliberately — see
`ai-provider-cost-rates.md`), therefore all historical cost is `UNKNOWN`
with a recorded reason. The attribution/UNKNOWN machinery is exercised on
every copilot request; the KNOWN path activates the moment a verified rate
exists.
