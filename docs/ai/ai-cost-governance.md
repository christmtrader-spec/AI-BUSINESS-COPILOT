# AI Cost Governance — Prompt 26

> Status: **IMPLEMENTED**. Source of truth:
> `src/lib/ai/cost/governance.ts` (anomalies + guard),
> `src/lib/ai/cost/config.ts` (all thresholds),
> `src/lib/ai/cost/internal.ts` (operator boundary). Data model:
> `AiCostAnomaly` in `prisma/schema.prisma`.

## Non-negotiables

1. **UNKNOWN cost is neither 0 nor ∞.** It can never trigger a guard
   block — only a governance alert (§68). Blocking on "we don't know the
   cost" would punish the system's own honesty.
2. **The guard is OFF by default** (§66) and may only decide with
   verified, known cost data — never with fabricated thresholds.
3. **Fail-open on monitoring failure** (§69/§124): an economics query
   error must never become an AI-wide outage (default; can be flipped only
   by explicit configuration).
4. **No automatic suspension, ever** (§121/§180): anomalies are operator
   signals. No code path suspends a user, business or subscription because
   of cost.
5. **All scans are bounded** by windows and limits (§189) — no all-time
   table scans inside a request path.

## Anomaly detection

`detectAiCostAnomalies(windowDays?)` compares the current window against
the **previous comparable window** (§118). It is conservative by design.

### Anomaly types (`AiCostAnomaly.type`)

| Type | Metric compared | Notes |
|---|---|---|
| `SPIKE_USAGE` | committed `AI_REQUESTS` usage events, current vs previous window | |
| `SPIKE_TOKENS` | committed `AI_TOKENS` quantity sums | |
| `SPIKE_COST` | known cost per **currency** (never mixed) | one anomaly per currency |
| `HIGH_UNKNOWN_RATIO` | share of UNKNOWN cost records in the window | WARNING only; alert, never a block |
| `RATE_MISSING` | declared in the schema/type union | **not yet emitted** by the detector (future work) |
| `BUSINESS_CONCENTRATION` | declared in the schema/type union | **not yet emitted** by the detector (future work) |

A spike fires only when `current > baseline + baseline × spikeMarginBps`
(`AI_COST_SPIKE_MARGIN_BPS`, default 10,000 bps = +100%). Currencies are
never summed across codes in any comparison (§62). `HIGH_UNKNOWN_RATIO`
fires when the unknown share exceeds `10,000 − MIN_COST_COVERAGE_FOR_
ECONOMICS` bps (default 8,000 → >20% unknown) and the window holds at
least `AI_COST_ANOMALY_MIN_BASELINE` attributable records.

### Severity ladder (§121)

`severityFor(current, baseline)` computes the margin over baseline in
integer basis points:

| Margin over baseline | Severity |
|---|---|
| ≥ 40,000 bps (**≥ 5×**) | `CRITICAL` |
| ≥ 10,000 bps (**≥ 2×**) | `WARNING` |
| below the spike margin | `INFO` |

Emission is idempotent: `@@unique([type, dedupeKey])` where
`dedupeKey = businessId|provider|model|windowStart|windowEnd` (day
precision). A re-detected anomaly **updates** severity/values but never
reopens an `ACKNOWLEDGED`/`RESOLVED` row — the operator's decision stands.
Statuses: `OPEN` → `ACKNOWLEDGED` → `RESOLVED`.

### INSUFFICIENT_HISTORY — the baseline is never fabricated (§117)

If the previous window holds fewer than `AI_COST_ANOMALY_MIN_BASELINE`
committed `AI_REQUESTS` events (default 50), the report returns
`baselineInsufficient: true` and **stops**: no spike is claimed, no
synthetic baseline is manufactured, nothing is inferred from silence.
Fewer data points means "we don't know", not "everything is normal".

## The request-level cost guard

`assertAiCostGuard({ businessId?, estimatedRequestCostNanoMinor?,
currency? })` is the ONLY sanctioned request-level cost gate.

- **Default state: `DISABLED`** — enabled only when
  `AI_COST_GUARD_ENABLED=true`. When disabled it returns `ALLOW`
  immediately, without a single query.
- **Ceilings (all configuration-driven, nano-minor BigInt):**
  `AI_COST_GUARD_MAX_PERIOD_COST_NANO_MINOR` (global per-currency period
  total and per-business period total),
  `AI_COST_GUARD_MAX_REQUEST_COST_NANO_MINOR` (pre-flight estimate). The
  estimate path is contractually usable only with a **VERIFIED** rate (§71)
  — callers must not feed invented numbers. Block reasons are structured:
  `PERIOD_COST_CEILING:<currency>:<total>`, `BUSINESS_COST_CEILING:<total>`,
  `REQUEST_COST_CEILING:<currency>:<estimate>`.
- **Window bounds:** `AI_COST_GUARD_WINDOW_DAYS` (default 30, 1–365) and
  `AI_COST_GUARD_MAX_CURRENCY_GROUPS` (default 8) keep the check bounded.
- **UNKNOWN never blocks:** only `costStatus = "KNOWN"` rows participate
  in ceilings. High unknown ratios surface as `HIGH_UNKNOWN_RATIO` alerts
  instead.
- **Fail-open by default:** on internal failure the guard returns
  `ALLOW` with `failOpenTriggered: true` and logs loudly. Fail-closed is
  possible only via explicit `AI_COST_GUARD_FAIL_OPEN=false` (§69).
  Blocked requests surface as HTTP 429 `AI_COST_GUARD_BLOCKED` with the
  structured reasons.

### Where the guard integrates

At the **AI execution boundary**, server-side only, before metering:

- `src/app/api/v1/copilot/route.ts`
- `src/app/api/v1/copilot/stream/route.ts`

Never in React, never in client code (§70). The client cannot see,
configure or bypass the guard; it experiences a uniform 429 at most.

## No automatic suspension

Nothing in `src/lib/ai/cost` mutates subscriptions, entitlements or
business status. Even a `CRITICAL` anomaly is only a persisted row plus a
log line. Suspension would be a deliberate human (or future, explicitly
specified) decision — never a side effect of cost accounting.

## Operational logging rules (§74/§89)

Permitted in structured logs around cost operations:
`requestId`, `businessId`, `provider`, `model`, `tokenStatus`,
`costStatus`, `rateVersion`, integer/serialized nano-minor values
(`serializeNanoMinor`), guard reason codes.

**NEVER logged:** full prompts or assistant responses, tenant business
content, provider API keys, the `AI_COST_OPERATOR_TOKEN`, or any
secret-bearing configuration. BigInt values cross log/JSON boundaries only
as strings (`serializeNanoMinor`), never as lossy floats.

## Internal authorization boundary (§170–§171)

`src/lib/ai/cost/internal.ts` draws the operator boundary:

- **`assertInternalOperator(token)`** — every present-or-future HTTP
  exposure of cost mutations/reads must call this first. Compares the
  presented token to `AI_COST_OPERATOR_TOKEN` in **constant time** (SHA-256
  digest + `timingSafeEqual`); the token is never logged. If no token is
  configured, every HTTP caller is rejected — fail-closed.
- **`assertInternalServiceCall()`** — a greppable marker for trusted
  in-process callers (harnesses, cron, future admin services). It must
  never be reachable from a request handler without
  `assertInternalOperator()` first.
- **Deliberately NO tenant-facing endpoints exist** for rate listing, cost
  records, margins, anomalies or reconciliation. `src/lib/ai/cost/index.ts`
  states it in code: nothing in the folder is exported through tenant APIs.

Prompt 28 (Platform Admin) will map this boundary onto platform
permissions; until then the token check is the temporary mechanism, and
"module boundary = authorization" applies to server-internal scripts only.

## Environment variables (all read ONLY in `config.ts`)

| Variable | Default | Meaning |
|---|---|---|
| `AI_COST_GUARD_ENABLED` | `false` | master guard switch |
| `AI_COST_GUARD_FAIL_OPEN` | `true` | monitoring failure policy |
| `AI_COST_GUARD_MAX_PERIOD_COST_NANO_MINOR` | unset (no ceiling) | period ceiling per currency / per business |
| `AI_COST_GUARD_MAX_REQUEST_COST_NANO_MINOR` | unset | per-request estimate ceiling |
| `AI_COST_GUARD_WINDOW_DAYS` | 30 (1–365) | guard rolling window |
| `AI_COST_GUARD_MAX_CURRENCY_GROUPS` | 8 (1–64) | bounded currency groups evaluated |
| `AI_COST_SPIKE_MARGIN_BPS` | 10,000 | spike margin (+100%) |
| `AI_COST_ANOMALY_WINDOW_DAYS` | 7 (1–90) | detection window |
| `AI_COST_ANOMALY_MIN_BASELINE` | 50 | minimum baseline events |
| `MIN_ECONOMICS_SAMPLE_SIZE` / `MIN_COST_COVERAGE_FOR_ECONOMICS` | see `ai-unit-economics.md` | shared with economics |
| `AI_COST_ENVIRONMENT` | `NODE_ENV`-derived | `TEST`/`PRODUCTION` attribution domain |
| `AI_COST_OPERATOR_TOKEN` | unset (fail-closed) | internal operator credential |

Values are server-side validated (no NaN/Infinity/negative/out-of-range —
§182); invalid input falls back to the documented default. The config is
cached for 15 s (`resetAiCostConfigCache()` is the harness test seam).
