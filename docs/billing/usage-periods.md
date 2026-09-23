# Usage Periods — Prompt 21

> Status: **IMPLEMENTED** (aligned with the subscription billing period;
> lazy + race-safe creation; NO cron-based resets).

## Model

```
UsagePeriod
  id             (cuid)
  businessId     → Business (Cascade)
  subscriptionId (soft link to the aligning subscription)
  start          (UTC) — unique per business
  end            (UTC, mirrors the subscription's currentPeriodEnd)
  createdAt
```

Identity is deterministic: `(businessId, start)` UNIQUE (§8). One counter
row per `(usagePeriodId, metric)`; events reference their period directly.

## Alignment rule (§7/§37/§42)

Usage periods are aligned with the business subscription's billing period —
the SAME boundaries the subscription already maintains
(`currentPeriodStart` / `currentPeriodEnd`). There is no independent
"usage month" and no server-local-timezone dependence: all boundaries are
UTC instants derived through the existing billing state machine
(`periodEnd`, month-end clamped: Jan 31 → Feb 28/29).

The current period is resolved in ONE place — `usagePeriodBounds()` in
`src/lib/billing/usage.ts` (§42: no per-module recalculation):

1. If `currentPeriodEnd > now` → the usage period IS the billing period.
2. If the period has ended (EXPIRED / grace passed → the FREE fallback) →
   the billing cadence rolls forward deterministically from the stored end
   (`periodEnd` stepping, cycle-guarded at 240 months) until the window
   contains `now`. Metering under the fallback plan therefore still lands
   in a bounded, sensible period WITHOUT inventing cron jobs (§10/§43).

## Lazy creation (§76)

No usage rows exist before the first metered operation for a business
(zero usage = zero rows). The first metering transaction find-or-creates the
period; two concurrent creators collide on the unique index and the loser
refetches (race-safe). Reads (usage summary) never create rows — they
compute the bounds and report zeros.

## Period rollover (§88)

When the subscription enters a new billing period (changePlan renewal or
lazy expiry + fallback), the next metered operation simply resolves to a NEW
UsagePeriod row. Historical periods are RETAINED with their counters and
events (§101) — nothing is deleted, nothing is reset by a job. There is no
`resetUsage()` anywhere (§43).

Verified: metering twice in period P1, rolling the subscription into P2,
metering again → second period row, fresh counter = 1, P1 counters untouched.

## Plan changes during a period (§38/§39/§77)

- Usage remains associated with the EXISTING period (the period identity
  does not move when only the plan changes).
- The new plan's quotas apply from the point of change: `limit - used` is
  recomputed on every evaluation.
- Downgrade below current usage: usage is preserved, remaining is floored
  at 0, the level reports `reached`, new consumption is blocked with the
  structured 422 — and NO data is ever deleted (§89/§112).
- Upgrade: usage preserved, remaining becomes `limit - used` (§90).
- Cancellation (`cancelAtPeriodEnd`): entitlements keep applying until the
  period end (Prompt 20 lifecycle); usage keeps accumulating in the SAME
  period until it rolls over. Expiry → FREE fallback quotas apply; historical
  usage is never erased (§40/§41).

## Retention (§101)

- UsagePeriod: retained indefinitely (historical summaries).
- UsageCounter: retained with their period.
- UsageEvent: retained; retention/archival strategy is a future decision —
  nothing deletes usage automatically in this phase. Growth is bounded by
  the metrics' nature (a few events per user question; no UI noise is ever
  metered, §26).

## Timezone policy (§37)

Everything is UTC. The UI formats period boundaries with the user's locale
(Jalali calendar for `fa`) — display only; the server never uses local time
for period math.
