# AI Unit Economics — Prompt 26

> Status: IMPLEMENTED (service-level; operator scripts only — §50/§131).
> With no configured provider rate every margin status is honestly
> COST_UNKNOWN / INSUFFICIENT_SAMPLE; this is the designed pre-rate state.

## 1. Definitions (§36–§39)

- **Cost coverage** (§37): `knownCostRequests / AIRequests`. The unknown
  remainder is NEVER zero-filled: with 100 requests and 80 KNOWN, coverage
  is 80% and 20 requests stay honestly unpriced.
- **observedKnownCostPerRequest** (§38): KNOWN cost sum ÷ KNOWN request
  count, per currency. Deliberately NOT called "average cost" — coverage
  gaps make it an observation, not a truth.
- **observedKnownCostPer1KTokens** (§39): computed ONLY from KNOWN records.

All amounts are exact BigInt nano-minor; per-request/per-token figures are
exact BigInt divisions (documented truncation at nano resolution).

## 2. Revenue source (§34/§35)

Revenue comes ONLY from the authoritative PriceBook via PricingService
(`resolvePrice`) — the same server-authoritative path as checkout. Never
the browser, frontend state, or marketing text. Revenue currency is the
book currency; the FREE plan is price-known at 0; ENTERPRISE has no
self-service price → PRICE_UNKNOWN (§84).

## 3. getPlanUnitEconomics(planCode, billingPeriod, currency) (§40)

Returns price facts, KNOWN/UNKNOWN request counts, coverage, KNOWN AI cost
in the revenue currency (same-currency subset only), observed
known-cost-per-request, AI contribution, AI contribution margin percent, and
a margin status (§41):

| Status | Meaning |
| --- | --- |
| `COMPARABLE` | same currency + KNOWN cost + sample ≥ minimum → margin numbers present |
| `NOT_COMPARABLE_CURRENCY` | cost recorded in another currency — NO automatic FX (§32/§85) |
| `COST_UNKNOWN` | no KNOWN cost in the window (all UNKNOWN / no data) |
| `PRICE_UNKNOWN` | plan not purchasable / not priced (ENTERPRISE, §84) |
| `INSUFFICIENT_SAMPLE` | KNOWN sample < MIN_KNOWN_COST_REQUESTS_FOR_MARGIN (§82) |

`MIN_KNOWN_COST_REQUESTS_FOR_MARGIN` (default 30) is an internal ANALYTIC
threshold — documented and configurable, not a financial fact (§82).

## 4. AI contribution margin — the ONLY margin we publish (§43/§87)

```
aiContributionNano        = revenue − known AI cost        (exact BigInt)
aiContributionMarginPpm   = (revenue − cost) × 1,000,000 / revenue
```

- Label: **"AI contribution margin (AI-only; excludes all other operating
  costs)"** — hosting, database, email, support, marketing, payment fees,
  tax, salary, and storage are excluded. NEVER call it net profit.
- FREE plan (§83): revenue = 0 → margin percent is N/A (no divide-by-zero);
  AI contribution = −known AI cost.
- Costs in other currencies are reported separately (never converted).

## 5. Plan economics report (§81) & exposure (§44/§106)

`getPlanEconomicsReport(currency)` returns, per plan: price, AI
request/message limits (authoritative entitlements), observed
known-cost/request, coverage, contribution, and status.

`getPlanCostExposure(planCode)` = the plan's maximum configured AI cost
envelope — computed ONLY when ALL exist: a finite `AI_REQUESTS_MAX`, an
operator-configured `AI_MAX_TOKENS_PER_REQUEST` ceiling policy, and a
verified production rate. Otherwise exposure = UNKNOWN with the reason
(§44 — no invented worst case).

## 6. Simulation (§103/§104/§105) — ANALYTICAL SCENARIO

`simulatePlanScenario({revenueMinor, currency, aiRequests, tokensPerRequest,
inputSharePpm, inputRate, outputRate})` is a PURE function: it computes the
scenario AI cost, AI contribution, margin, and the AI-only breakeven
(= revenue; the maximum AI cost per customer before the AI contribution
reaches zero). Scenario values are clearly labeled `ANALYTICAL SCENARIO —
SIMULATION ONLY, not financial advice` and are NEVER written to production
cost records.

## 7. Precision & display (§107/§108/§109)

Storage is exact nano-minor. Operator display uses explicit currency codes
(`EUR 0.002341`) with 4–6 decimals — never a consumer currency format that
hides magnitude, never implied precision beyond the source data.

## 8. Period semantics (§57/§58/§59/§60)

Windows are UTC (`today` / `7d` / `30d` / calendar month / previous month /
custom `--from`/`--to`). Calendar month ≠ subscription billing period; both
concepts exist (UsagePeriod rows carry the subscription-aligned window;
reports default to calendar windows). Plan economics group by
`planCodeAtUsage` — historical usage is never reclassified.
