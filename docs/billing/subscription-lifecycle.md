# Subscription Lifecycle — statuses, transitions, and guarantees

**Document ID:** BILLING-LIFECYCLE-v1.0
**Phase:** Prompt 20 (billing foundation) — **STATUS: IMPLEMENTED** (this document describes shipped code)
**Source of truth:** `src/lib/billing/state-machine.ts` (pure, unit-tested) + `src/lib/billing/service.ts` (transactional mutations)
**Companion docs:** `docs/billing/entitlements.md`, `docs/billing/plan-catalog.md`

SQLite has no enums, so statuses, billing periods, and event types are stored
as strings and validated at every boundary against the sets in
`state-machine.ts`. One **current** subscription per business
(`Subscription.businessId` is `@unique`, §79); history lives in
`SubscriptionEvent` rows; ended subscriptions are never deleted (§81).

---

## 1. Statuses

Exact semantics from `STATUS_SEMANTICS`:

| Status | Semantics (verbatim intent) | Set by Prompt 20 code? |
|---|---|---|
| `TRIALING` | Temporary valid subscription (trial of the plan's features). Entitled until `trialEnd`. | Yes — `startTrial` (operator-gated, §6) |
| `ACTIVE` | Fully entitled to the plan's features. | Yes — default; `changePlan`, `reactivateSubscription`, `endTrial` |
| `PAST_DUE` | Payment issue state — **RESERVED for the future payment phase**; keeps grace-period access. **Nothing sets it yet** (§17: no payment assumptions). | No |
| `CANCELED` | Canceled but access continues until `currentPeriodEnd` (`cancelAtPeriodEnd` semantics, §44). | Yes — `cancelSubscription` |
| `EXPIRED` | No longer entitled to the paid plan — the business **falls back to FREE-level entitlements** (§13) without touching its data. | Yes — lazy expiry (§5) |
| `PAUSED` | Temporarily restricted — **RESERVED for future administrative workflows; nothing sets it yet.** | No |

## 2. Transition table

Exact contents of `VALID_TRANSITIONS` (§46). Arbitrary state hopping is
forbidden; every mutation asserts its transition and otherwise throws
`409 INVALID_SUBSCRIPTION_STATE`.

| From → To | `ACTIVE` | `TRIALING` | `PAST_DUE` | `CANCELED` | `EXPIRED` | `PAUSED` |
|---|---|---|---|---|---|---|
| `TRIALING` | ✅ | — | — | ✅ | ✅ | — |
| `ACTIVE` | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| `PAST_DUE` | ✅ | — | — | ✅ | ✅ | — |
| `CANCELED` | ✅ | — | — | — | ✅ | — |
| `EXPIRED` | ✅ | — | — | — | — | — |
| `PAUSED` | ✅ | — | — | ✅ | — | — |

Notes from the source (§46):

- `CANCELED → ACTIVE` is the **reactivation** path (undo `cancelAtPeriodEnd`
  while the period is still running).
- `EXPIRED → ACTIVE` exists **only** through the explicit internal change-plan
  tool (a deliberate renewal decision) — it can never happen automatically
  without a payment mechanism (§45).
- `PAUSED` is reachable from `ACTIVE` and leaves via `ACTIVE` (resume) or
  `CANCELED`. Nothing sets or leaves `PAUSED` in this phase.

### 2.1 Which transitions are actually produced today

Honest map of code paths (the table above is the *rule*; this is what ships):

| Transition | Produced by |
|---|---|
| `ACTIVE → TRIALING` | `startTrial` (BILLING_TRIALS_ENABLED only) |
| `TRIALING → ACTIVE` | `endTrial` |
| `TRIALING → EXPIRED` | Lazy expiry when `trialEnd` has passed |
| `ACTIVE → CANCELED` | `cancelSubscription` |
| `ACTIVE → EXPIRED` | Allowed by the table, but **nothing sets it in this phase** (a payment-phase renewal failure would; today only TRIALING-past-due and CANCELED grace-over paths expire) |
| `ACTIVE → PAST_DUE` / `ACTIVE → PAUSED` | Allowed by the table, **nothing sets them** (reserved) |
| `CANCELED → ACTIVE` | `reactivateSubscription`; also `changePlan` (which doubles as reactivation) |
| `CANCELED → EXPIRED` | Lazy expiry when the period-end grace has passed |
| `EXPIRED → ACTIVE` | `changePlan` only (explicit renewal) |

## 3. Cancellation semantics

`POST /api/v1/billing/cancel` (permission `settings:manage` = OWNER/ADMIN,
rate limit 10/min/user):

1. Sets `status = CANCELED`, `cancelAtPeriodEnd = true`, `canceledAt = now`.
2. **Access continues until `currentPeriodEnd`** — `decidePlan` keeps the
   subscription's own plan while the grace window is open.
3. After the period end passes, the next billing-context read performs lazy
   expiry (§5): status → `EXPIRED`, `endedAt` stamped, FREE fallback applies.
4. Idempotent: a second cancel while `CANCELED && cancelAtPeriodEnd` is a
   **no-op** — no duplicate event (§48; harness I2).
5. Data is never touched (§91).

A `CANCELED` subscription whose `cancelAtPeriodEnd` is `false` or whose
`currentPeriodEnd` is missing/past is *already* grace-over for decision
purposes (see `decidePlan`).

## 4. Reactivation rules

`POST /api/v1/billing/reactivate` (permission `settings:manage`, rate limit
10/min/user):

- **Only `CANCELED → ACTIVE`.** Clears `cancelAtPeriodEnd`, `canceledAt`,
  `endedAt`; writes a `REACTIVATED` event + `billing.subscription_reactivated`
  audit row.
- **`EXPIRED` cannot be reactivated.** The endpoint returns
  `409 INVALID_SUBSCRIPTION_STATE` ("This subscription state cannot be
  reactivated. Use a plan change to renew.") — an expired subscription
  renews **only** via `POST /api/v1/billing/change-plan`, a deliberate,
  authorized renewal decision (§45; harness I6/I9).
- **`PAUSED` cannot be reactivated** either — it would resume through a
  dedicated admin flow that does not exist yet.
- Reactivating an `ACTIVE` subscription is a no-op (`changed: false`).

## 5. Lazy expiry

There is **no cron job**. Expiry happens on read:

- Every fresh entitlement lookup (`getEntitlementContextFresh`) runs
  `expireSubscriptionIfDue`: when `decidePlan` flags the row as
  `expired`, a `Serializable` transaction re-loads the row, **re-checks** the
  decision, then sets `status = EXPIRED` + `endedAt`, writes an `EXPIRED`
  `SubscriptionEvent` and a `billing.subscription_expired` audit row, and
  invalidates the 15 s cache.
- The re-check inside the transaction makes the transition race-safe: a
  concurrent `changePlan`/`reactivateSubscription` wins and the expiry is
  skipped.

## 6. FREE fallback policy on `EXPIRED` / `PAUSED`

When the effective plan resolves to the FREE fallback (§13):

- `decidePlan` returns `{ kind: "fallback-free", entitled: true }` — the
  **FREE plan's entitlements apply**: the core app stays fully usable,
  paid features (e.g. `ADVANCED_REPORTS`) turn off, and **tenant data is
  untouched** (§42/§65 — downgrade caps future growth, never deletes; harness
  I7/I8). The `entitled: true` here means "a valid plan's entitlements apply"
  (FREE), not that paid features continue.
- The `SubscriptionDto.effectivePlanCode` field exposes `"FREE"` while
  `plan.code` still shows the subscribed plan — the UI uses
  `effectivePlanCode` for what actually applies.
- Downgrades never delete user data; over-limit rows remain, creation is
  blocked at the gate (see entitlements doc §6.1).

## 7. Effective-plan decision logic (`decidePlan`)

Pure policy in `state-machine.ts` (injectable `now` for tests; unit-tested 38/38
in `scripts/prompt20-state-machine.test.ts`). The service resolves which plan
*object* applies ("own plan" vs the FREE fallback from the catalog).

| Condition | Decision | Entitled | Effective plan |
|---|---|---|---|
| `status = EXPIRED` | `fallback-free` | `true` | FREE plan |
| `status = PAUSED` | `fallback-free` | `true` | FREE plan |
| `status = TRIALING` and `trialEnd ≤ now` | `fallback-free`, `expired: true` | `false` | FREE (lazy expiry moves the row to `EXPIRED`) |
| `status = CANCELED` and grace over — i.e. `cancelAtPeriodEnd = false`, **or** `currentPeriodEnd` is null, **or** `currentPeriodEnd ≤ now` | `fallback-free`, `expired: true` | `false` | FREE (lazy expiry moves the row to `EXPIRED`) |
| `status = CANCELED` with grace remaining | `own-plan` | `true` | Subscription's own plan |
| `status = TRIALING` with `trialEnd` in the future | `own-plan` | `true` | Subscription's own plan |
| `status = ACTIVE` | `own-plan` | `true` | Subscription's own plan |
| `status = PAST_DUE` | `own-plan` | `true` | Subscription's own plan (reserved state) |

## 8. Trial capability

The **domain capability** exists; the **business policy does not** (§19):

- Service methods `startTrial(businessId, days)` and `endTrial(businessId)`
  are transactional, evented (`TRIAL_STARTED` / `TRIAL_ENDED`), and audited
  (`billing.trial_started` / `billing.trial_ended`).
- The API endpoint `POST /api/v1/billing/trial` (`{ action: "start" | "end", days }`,
  `days` integer 1–90, default 14) is **disabled unless the operator explicitly
  sets `BILLING_TRIALS_ENABLED=1`** — otherwise it returns
  `422 BUSINESS_NOT_ELIGIBLE` ("Trials are not enabled for this deployment.").
  No automatic trials, no self-service UI (harness J1/J2).
- **One trial per business, ever**: `startTrial` refuses when `trialStart` is
  already set (`422 BUSINESS_NOT_ELIGIBLE`, "This business has already used
  its trial.").
- A trial that runs past `trialEnd` falls back to FREE and lazily expires
  (§7) — there is no automatic transition, the fallback applies on read.

## 9. Idempotency guarantees

Mutations are idempotent where repetition is plausible (§48) — repeated calls
never write contradictory event histories:

| Scenario | Behavior |
|---|---|
| `changePlan` to the plan already on | No-op: `changed: false`, **no event, no mutation** (harness D4/D6) |
| `cancelSubscription` while already `CANCELED && cancelAtPeriodEnd` | No-op: no duplicate event (harness I2) |
| `reactivateSubscription` while `ACTIVE` | No-op |
| Everything else | Guarded by the transition table (§2) — invalid transitions throw `409` |

All subscription mutations are **transactional and write the matching
`SubscriptionEvent` in the SAME transaction** (§47), plus an `AuditLog` row
(§61). Server state is authoritative; nothing reads client input except
validated plan codes (§23/§24).

### 9.1 Plan-change semantics (`changePlan`)

- Validates the target plan exists and is `active` — otherwise
  `422 INVALID_PLAN` (§80: retired plans are rejected).
- Any plan change **re-engages the subscription**: `status → ACTIVE`,
  `cancelAtPeriodEnd → false`, `canceledAt/endedAt → null`. When the source
  status was `CANCELED`/`EXPIRED`/`PAUSED`, a `REACTIVATED` event is written
  **before** the `PLAN_CHANGED` event (§82).
- Period handling: if `currentPeriodEnd` is still in the future, the running
  period is kept unchanged; otherwise a fresh period starts now
  (`periodEnd(now, billingPeriod)`).
- **No money changes hands and nothing is labeled as payment** (§83).
- `periodEnd()` uses UTC date-component arithmetic with month-end clamping
  (Jan 31 + 1 month = Feb 28/29, never Mar 2/3; §70/§71).

## 10. `SubscriptionEvent` types (9)

`SUBSCRIPTION_EVENT_TYPES` — **no payment events exist in this phase** (§20):

| Type | Written by | Notes |
|---|---|---|
| `CREATED` | `ensureSubscription` (business creation, seed backfill, lazy backfill) | `toStatus: ACTIVE`, `toPlanCode` (FREE), `dataJson.source` (`ensure`/`seed-backfill`/….) |
| `PLAN_CHANGED` | `changePlan` (only when the plan actually changes) | from/to plan codes; `dataJson.source` (`settings`/`api`/…) |
| `TRIAL_STARTED` | `startTrial` | `dataJson: { days, source }` |
| `TRIAL_ENDED` | `endTrial` | → `ACTIVE`, plan kept (no payment policy yet) |
| `CANCELED` | `cancelSubscription` | `cancelAtPeriodEnd: true` recorded in the audit row |
| `REACTIVATED` | `reactivateSubscription`; also `changePlan` when it doubles as reactivation | from-status records the reactivated state |
| `EXPIRED` | Lazy expiry | `endedAt` stamped on the subscription |
| `PAUSED` | **Reserved — nothing emits it yet** | |
| `RESUMED` | **Reserved — nothing emits it yet** | |

Event rows carry `fromStatus`/`toStatus`/`fromPlanCode`/`toPlanCode`, a small
`dataJson` payload (never payment data — §17: the core relationships are
relational, not JSON), and `actorId` (nullable; `ON DELETE SET NULL` on user
deletion). History is exposed tenant-scoped and paginated via
`GET /api/v1/billing/events` (default page size 20, max 100).

## 11. Error codes

From `src/lib/billing/errors.ts` — structured domain failures, never generic
errors:

| HTTP | Code | Meaning |
|---|---|---|
| 403 | `ENTITLEMENT_NOT_AVAILABLE` | Feature boolean is false on the effective plan (§26/§34) |
| 422 | `ENTITLEMENT_LIMIT_REACHED` | Usage would exceed a LIMIT, details `{ feature, limit, current, upgradeAvailable }` (§28) |
| 422 | `INVALID_PLAN` | Unknown or inactive plan code (§80) |
| 422 | `BUSINESS_NOT_ELIGIBLE` | Trial/eligibility policy violation (trials disabled, trial already used) |
| 404 | `SUBSCRIPTION_NOT_FOUND` | No subscription row for the business (defensive — `ensureSubscription` normally prevents this) |
| 409 | `INVALID_SUBSCRIPTION_STATE` | Transition not allowed by the state machine; details include `{ from, to, allowed }` (§45/§46) |
| 503 | `BILLING_UNAVAILABLE` | Billing lookup **failed** — fail-closed, retryable, never mapped to unlimited access (§68/§93) |

Mutation endpoints additionally enforce `settings:manage` (403 for STAFF/VIEWER,
harness D1/D2/I3/J2) and per-user rate limits (10/min for change-plan, cancel,
reactivate; 5/min for trial → `429 RATE_LIMITED`).
