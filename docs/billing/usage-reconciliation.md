# Usage Reconciliation — Prompt 21

> Status: **IMPLEMENTED** (lightweight integrity audit — an audit tool, not
> a repair tool, §50/§92). Full reconciliation platform: NOT IMPLEMENTED
> (deliberately out of scope).

## Tool

`scripts/audit-usage-consistency.mjs` (node/bun, read-only):

```bash
node scripts/audit-usage-consistency.mjs
# exit 0 → consistent · exit 1 → discrepancies printed
```

It loads every UsagePeriod / UsageCounter / UsageEvent and verifies:

| Check | Meaning |
|---|---|
| `MISMATCH` | `counter.used ≠ Σ(quantity of COMMITTED events)` for that (period, metric) |
| `MISSING_COUNTER` | committed events exist but no counter row |
| `ORPHAN_COUNTER` | counter row without a period |
| `ORPHAN_EVENT` | event whose period is missing or cross-tenant |
| `NEGATIVE` | counter below zero (guarded updates make this impossible) |

`RELEASED` events are excluded from the expected sum by design — they
represent reservations that were reconciled back.

## Invariants being checked

1. **Counter ↔ event equality** — every counter unit is backed by exactly
   one COMMITTED event, and vice versa. Both write paths (metering bump and
   release) run inside the same transaction as the event insert/update, so
   drift requires an infrastructure anomaly — which is exactly what this
   tool is for detecting (§50).
2. **Tenant integrity** — events must belong to the same business as their
   period.
3. **Non-negativity** — releases are guarded (`max(0, used - quantity)`).

The tool never modifies data (§92). On discrepancy: investigate the reported
(business, period, metric) triple in the `UsageEvent` rows; corrections are
manual operator decisions, not automated repairs.

## Operational notes

- Safe to run against the live database (read-only queries only).
- Exit code is CI/script friendly: `0` consistent, `1` problems.
- Current verified state: `CONSISTENT` across all periods/counters/events
  (checked after the full Prompt 21 harness run, including the 10-way burst
  and release tests).

## Observability (§103)

- Metering failures log `[usage] metering failed:` and fail closed with
  `BILLING_UNAVAILABLE` — they never unlock premium usage.
- Release failures log `[usage] release failed (counter may be over-stated):`
  — the original user-facing error takes precedence; the audit trail
  (`usage.ai_released` audit rows) plus this tool expose the discrepancy.
- Integrity anomalies (counter missing during release) log loudly and are
  reported by the audit tool; nothing is silently "fixed".

Never logged: passwords, tokens, session secrets, provider API keys, full
AI prompts or responses (§103). Usage events store only provider/model
identifiers and authoritative token counts.
