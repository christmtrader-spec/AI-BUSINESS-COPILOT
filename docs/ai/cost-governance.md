# AI Cost Governance — Prompt 26

> Status: IMPLEMENTED. Anomaly detection: minimal-but-real (documented
> §97). Cost guard / circuit breaker: IMPLEMENTED, **DISABLED by default**
> (§46) — enabling it is an explicit operator act.

## 1. Anomaly detection (§97/§98)

`detectAiCostAnomalies()` — read-only, lightweight, SQLite-friendly:

| Check | Trigger | Result |
| --- | --- | --- |
| Volume spike | 7-day requests ≥ 10× previous 7 days (baseline ≥ 10 requests) | flag `REVIEW` |
| Unknown-cost rise | > 50% UNKNOWN records in the window (≥ 10 records) | flag `REVIEW` |
| Insufficient history | no baseline for the business | status `UNKNOWN` — no false baseline |

Anomalies NEVER suspend or block a customer (§97/§102). They surface in
operator reports and are input for human review.

## 2. Cost guard / circuit breaker (§46/§47/§48/§100)

Optional platform-level safeguard, evaluated per UTC day over KNOWN cost in
an explicit currency:

```
AI_COST_CIRCUIT_BREAKER_ENABLED=true|false   (default false → DISABLED)
AI_DAILY_COST_LIMIT_NANO=1200000             (exact integer nano-minor)
AI_COST_LIMIT_CURRENCY=USD                   (explicit; no assumptions)
AI_DAILY_COST_ALERT_THRESHOLD_NANO=900000    (§99 — flag/log only)
```

Statuses (§47/§48):

| Status | Meaning |
| --- | --- |
| `DISABLED` | flag off — the default; zero behavior change |
| `ACTIVE` | enabled + configured + KNOWN cost under the limit |
| `TRIGGERED` | enabled + configured + reliable data + KNOWN cost ≥ limit |
| `UNKNOWN` | cost data too incomplete for a reliable monetary decision (≥ 50% UNKNOWN records, or no records) — never a false trigger |
| `UNAVAILABLE` | enabled but limit/currency not fully configured |

UNKNOWN cost never counts as zero and never triggers the breaker (§48/§100).

## 3. Enforcement semantics (§101/§102)

- The copilot routes call `assertAiCostGuard()` before metering. It throws
  `503 AI_COST_GUARD_TRIGGERED` ONLY on a reliable TRIGGERED evaluation.
- Guard-internal failures are fail-open (availability first): monitoring
  problems never deny legitimate usage — UsageService remains the ONLY
  quota authority.
- UNKNOWN cost never blocks a customer (§102): cost monitoring and
  entitlement enforcement are separate domains by construction.

## 4. Daily alert threshold (§99)

`AI_DAILY_COST_ALERT_THRESHOLD_NANO` — when today's KNOWN cost in the limit
currency reaches it, evaluations flag `alertTriggered` (log/report only).
No automatic shutdown unless the breaker is explicitly enabled AND data is
reliable (§99/§100).

## 5. Observability (§96)

`getAiCostObservability(window)` returns metric-safe aggregates:
`ai_requests`, `ai_messages`, `ai_tokens_known`, `ai_tokens_unknown`,
`ai_cost_known` (per currency), `ai_cost_unknown_records`, and
`cost_coverage`. No sensitive business data in any label.

## 6. Operator runbook

1. Inspect: `PRISMA_QUIET=1 bun scripts/ai-cost-report.ts --period 7d --economics EUR`
2. Gaps: `PRISMA_QUIET=1 bun scripts/ai-cost-gap-report.ts`
3. Integrity: `PRISMA_QUIET=1 bun scripts/ai-cost-consistency.ts`
4. Backfill review: `PRISMA_QUIET=1 bun scripts/ai-cost-reconcile.ts` (dry
   run) → `--apply --confirm RECONCILE` only after review (§71/§133).
5. Enable protection (explicit operator act): set the three breaker env
   vars; verify status via the report; keep the alert threshold below the
   hard limit.
