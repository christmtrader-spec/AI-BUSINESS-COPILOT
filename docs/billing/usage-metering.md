# Usage Metering — Prompt 21

> Status: **IMPLEMENTED** (Prompt 21). This document describes the shipped
> usage metering architecture. Resource limits (Prompt 20) are covered in
> `entitlements.md` — the two concepts are deliberately separate.

## What this covers

Server-side **consumption metering** for metered SaaS metrics. The system
answers: how much has this business consumed, over which period, against
which limit, and may the requested operation proceed?

**Core law:** the client is NEVER the source of truth for usage (§3).
Quantities are decided by the server, counters live in the database, and
every enforcement path runs inside a Serializable transaction.

## Metrics (IMPLEMENTED)

| Metric | Unit | Semantics | Enforced |
|---|---|---|---|
| `AI_REQUESTS` | REQUESTS | One accepted Copilot execution reaching the AI orchestration layer (one per user question) | YES — hard limit via `AI_REQUESTS_MAX` |
| `AI_MESSAGES` | MESSAGES | One user message entering the Copilot pipeline (metered together with the request under the same idempotency key) | YES — hard limit via `AI_MESSAGES_MAX` |
| `AI_TOKENS` | TOKENS | Provider-reported token usage, recorded ONLY when the provider genuinely exposes it (integer storage; split kept in event metadata) | NO — recorded, not quota-enforced |

NOT IMPLEMENTED (explicitly): `EXPORTS` (CSV export stays a boolean gate),
`FILE_STORAGE_BYTES` (file uploads do not exist yet — no fake counter).

## Architecture

```
UsagePeriod (1 per business per billing period, lazy + race-safe)
   ├── UsageCounter (1 per metric: AI_REQUESTS / AI_MESSAGES / AI_TOKENS)
   └── UsageEvent   (per metered operation, idempotency-gated)
```

- **UsagePeriod** — identity `(businessId, start)` UNIQUE. Boundaries mirror
  the subscription's billing period (see `usage-periods.md`).
- **UsageCounter** — `(usagePeriodId, metric)` UNIQUE; integer `used` that
  only moves through guarded atomic updates (`used < limit` predicate for
  enforced metrics; unconditional for unlimited/unenforced metrics).
  Never negative; never floats (§28/§29/§30).
- **UsageEvent** — `(businessId, metric, idempotencyKey)` UNIQUE;
  `status ∈ {COMMITTED, RELEASED}`; `requestId` correlates the logical user
  operation; `metaJson` holds provider/model identifiers + authoritative
  token splits — NEVER prompts or responses (§60/§103).

## Counting policy — what is ONE AI request (§12/§13/§45/§46/§47)

Counted:
- one user Copilot message that passes auth → permission → billing gate →
  rate limit → validation → quota check and reaches the provider call.

NOT counted:
- page views, opening the Copilot UI, typing, refreshing the chat page;
- stream chunks (a 500-chunk answer is still ONE metered request);
- internal snapshot/tool computations (they are server DB reads, not
  provider calls);
- loading existing ChatSession / ChatMessage history;
- validation/authorization/quota rejections (no usage consumed).

## Strategy — count-before + release-on-failure (§20/§21)

Adapted to this codebase (single provider call per user question):

```
authorize (AI_COPILOT boolean gate)
   → rate limit
   → meter  (atomic; quota-checked; idempotency-gated)   ← charge
   → call provider
   → success: charge stands (record tokens when reported)
   → failure BEFORE provider acceptance: release (reconcile back)
```

Streaming: the reservation is RELEASED when the stream ends with NO deltas
(provider failure / abort before any content). Any delivered delta means the
provider accepted the operation — the charge stands (user abort included;
partial content was delivered).

## Idempotency (§17/§18)

Every logical operation carries a `requestId` (server-generated UUID, or a
client-supplied UUID validated by schema — arbitrary strings rejected). The
UsageEvent uniqueness on `(businessId, metric, idempotencyKey)` where
`idempotencyKey = requestId:metric` guarantees:

- retry with the SAME requestId after success → proceeds unmetered (the
  original already paid; bounded by per-user rate limits);
- retry after a RELEASED failure → re-meters (the replacement execution
  actually runs; released again if it also fails);
- cross-tenant key collisions are impossible (business is part of the key).

## Concurrency (§19/§82)

Single-node SQLite is the documented concurrency boundary (Prompt 20 §112).
Metering SERIALIZES per business through an in-process queue
(`withBusinessLock`) — parallel interactive transactions racing for the
SQLite write lock degrade catastrophically (~55s under a 10-way burst,
measured), while the queue keeps every transaction short and resolves bursts
in milliseconds. The §82 invariant (never exceed the quota) holds
deterministically; cross-process access still relies on guarded atomic
updates. Multi-node deployments require a real RDBMS — out of scope.

Verified: limit 10, used 9, 10 simultaneous meters → exactly 1 accepted,
9 × structured 422, counter ends at exactly 10.

## Quota enforcement (§23/§49)

Hard limits only (soft limits NOT activated). When an enforced quota is
exhausted the metering throws a structured 422:

```json
{ "code": "USAGE_LIMIT_REACHED",
  "details": { "metric": "AI_REQUESTS", "limit": 25, "used": 25,
               "remaining": 0, "periodEnd": "…", "upgradeAvailable": true } }
```

Never a 500, never DB internals. A rejected attempt consumes NOTHING.

## Fail-safe behavior (§24/§68)

If usage state cannot be read/written, metered premium AI operations fail
CLOSED (`503 BILLING_UNAVAILABLE`, retryable) — they never degrade into
unlimited access. Core (non-metered) business features never touch this
service and keep working.

## Where enforcement lives

- `POST /api/v1/copilot` — full pipeline (meter → call → release/finalize)
- `POST /api/v1/copilot/stream` — same pipeline, stream-aware release
  (BUG FIX: this endpoint previously skipped the `AI_COPILOT` gate that the
  chat endpoint had; both transports now enforce the identical pipeline)

## UI (§52-§54)

Settings → Subscription → "AI usage" card: current period dates, per-metric
used/limit/remaining with progress bars and server-computed levels
(`ok | warning ≥75% | critical ≥90% | reached 100%` — thresholds centralized
in `src/lib/billing/usage.ts`, never hard-coded in components). `AI_TOKENS`
is shown only when real provider data exists, and never as a quota.
At limit: honest notice ("renews on {date} — you can also switch plan") +
a Switch-plan shortcut. No payment claims anywhere.

## What is deliberately NOT here (§109-§112/§123)

No overage billing, no auto-upgrade/downgrade, no grace policy, no cost
computation, no data deletion on limits. See
`platform-billing-vs-business-finance.md` for the money separation law.
