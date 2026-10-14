# Entitlements — catalog, enforcement, and counting policy

**Document ID:** BILLING-ENTITLEMENTS-v1.0
**Phase:** Prompt 20 (billing foundation) — **STATUS: IMPLEMENTED** (this document describes shipped code)
**Source of truth:** `src/lib/billing/catalog.ts` (initial seed) → `Plan` / `EntitlementDefinition` / `PlanEntitlement` tables (runtime authority)
**Companion docs:** `docs/billing/billing-architecture.md`, `docs/billing/subscription-lifecycle.md`, `docs/billing/plan-catalog.md`

Entitlements are the feature gates derived from a business's **effective plan**
(see `decidePlan` in `docs/billing/subscription-lifecycle.md`). They are
resolved **server-side only** — the client may display them, but it is never
the authority. Every gate is a check in the API route pipeline, after
`zod → authenticate → tenant resolve → RBAC`.

---

## 1. The 9 entitlements

Codes are **stable machine identifiers** (`ENTITLEMENT_CODES` in
`src/lib/billing/catalog.ts`, §72) — never scattered string literals, never
renamed after subscriptions exist. Types are `LIMIT` (numeric cap; `null` =
unlimited) or `BOOLEAN` (feature present or absent).

| Code | Type | Unit | Meaning |
|---|---|---|---|
| `CUSTOMERS_MAX` | LIMIT | `COUNT` | Maximum non-deleted customers in the business |
| `PRODUCTS_MAX` | LIMIT | `COUNT` | Maximum non-deleted products (active AND inactive count; deactivation is not deletion) |
| `TEAM_MEMBERS_MAX` | LIMIT | `USERS` | Maximum business members **including the owner** (§108); pending invites do NOT count (§31) |
| `BUSINESSES_MAX` | LIMIT | `BUSINESSES` | Maximum businesses a user **OWNS** (`ownerId = user`); staff memberships never count (§107) |
| `AI_REQUESTS_MAX` | LIMIT | `REQUESTS` | Maximum AI Copilot executions per usage period (**Prompt 21 — implemented**, see `usage-metering.md` / `ai-quotas.md`) |
| `AI_MESSAGES_MAX` | LIMIT | `MESSAGES` | Maximum user AI messages per usage period (**Prompt 21 — implemented**; metered together with the request under one idempotency key) |
| `AI_COPILOT` | BOOLEAN | — | AI Copilot availability (presence gate; quantity metering is enforced by the two LIMIT rows above) |
| `ADVANCED_REPORTS` | BOOLEAN | — | Advanced report insights (growth/concentration analytics) beyond the deterministic MVP reports |
| `CSV_EXPORT` | BOOLEAN | — | Server-side CSV export on EVERY report CSV route (`/api/v1/reports/export`, `/api/v1/reports/monthly/[month]/export`, `/api/v1/reports/aging/*` exports, `/api/v1/reports/performance/export` — Prompt 50 made the gate uniform) |

## 2. Value per plan

The matrix below is exactly what the idempotent seed writes
(`scripts/seed-billing.ts`) into `PlanEntitlement` rows — 5 plans × 9
entitlements = 45 mappings, verified complete by the seed and by harness
check A1–A4.

| Code | FREE | STARTER | BUSINESS | PRO | ENTERPRISE |
|---|---|---|---|---|---|
| `CUSTOMERS_MAX` | 50 | 500 | 2,500 | 25,000 | `null` = unlimited |
| `PRODUCTS_MAX` | 25 | 200 | 1,000 | 10,000 | `null` = unlimited |
| `TEAM_MEMBERS_MAX` | 2 | 5 | 15 | 50 | `null` = unlimited |
| `BUSINESSES_MAX` | 1 | 2 | 5 | 10 | `null` = unlimited |
| `AI_COPILOT` | `true` | `true` | `true` | `true` | `true` |
| `ADVANCED_REPORTS` | `false` | `true` | `true` | `true` | `true` |
| `CSV_EXPORT` | `true` | `true` | `true` | `true` | `true` |

Deliberate, documented decisions:

- **`CSV_EXPORT` stays `true` on FREE** (§65 backwards compatibility): the
  migration must never remove a capability businesses already rely on. The
  gate exists and is tested (harness H2 flips it via the DB and gets 403);
  a future business decision may flip it through seed data — not through code.
- **`ADVANCED_REPORTS` is the only boolean that differs** across plans:
  basic reports remain available to EVERY plan (§35); the advanced block is
  simply omitted from the response when not entitled.
- Once seeded, **the database is the runtime authority**. Editing
  `catalog.ts` values has no effect on existing rows (the seed's upserts use
  `update: {}` — see `docs/billing/plan-catalog.md` §3).

## 3. Enforcement points

Every enforcement point is an exact API route; none is client-side.

| Entitlement | Enforcement point | Mechanism |
|---|---|---|
| `CUSTOMERS_MAX` | `POST /api/v1/customers` | `getEntitlementContextTx` + `count` + `assertWithinLimitIn` **inside the same transaction** as the insert (race-safe, §112) |
| `PRODUCTS_MAX` | `POST /api/v1/products` | Same in-transaction count + check |
| `TEAM_MEMBERS_MAX` | `POST /api/v1/businesses/[id]/members` (member add) and `POST /api/v1/businesses/[id]/invites` (invite minting) | Same in-transaction count + check (both endpoints count active memberships; invites themselves never count) |
| `BUSINESSES_MAX` | `POST /api/v1/businesses` | `assertWithinBusinessesLimitTx(tx, userId)` inside the business-creation transaction (see §4.1) |
| `AI_COPILOT` | `POST /api/v1/copilot` | `assertFeatureAccess(businessId, "AI_COPILOT")` — fresh server-side read (§111) |
| `ADVANCED_REPORTS` | `GET /api/v1/reports/summary` | `hasEntitlement(..., "ADVANCED_REPORTS")`; when false the server **omits the `advanced` block entirely** and returns `advancedAvailable: false` (§26 — UI hiding is never the enforcement) |
| `CSV_EXPORT` | `GET /api/v1/reports/export` | `assertFeatureAccess(businessId, "CSV_EXPORT")`. Client-side CSV of already-fetched rows is plain UI, **not** an authorization surface (§34) |

Reading endpoints (`GET /api/v1/billing/subscription`, `/plan`, `/entitlements`,
`/plans`, `/events`) serve UI display; they never gate anything.

### 3.1 Context loaders and the 15 s cache

- `getEntitlementContextFresh(businessId)` — uncached; **always** used by
  feature gates (§111: premium gates verify against a fresh read). Also runs
  lazy expiry (see lifecycle doc §5) and lazily creates a FREE subscription
  if none exists (`source: "lazy-backfill"`).
- `getEntitlementContextTx(tx, businessId)` — same resolution **inside the
  caller's transaction**, so LIMIT count + check + insert are atomic (§112).
- `getEntitlementContext(businessId)` — 15 s in-memory TTL cache for UI read
  endpoints only (§67); invalidated on every billing mutation
  (`invalidateBillingCache`).

## 4. Counting policy

Usage is counted by the service (`countEntitlementUsage` for display; inline
`count()` for enforcement). The policies are fixed and documented — they are
part of the contract, not an implementation detail:

| Code | Counted | Query shape | Explicitly NOT counted |
|---|---|---|---|
| `CUSTOMERS_MAX` | Non-deleted customers of the business | `customer.count({ where: { businessId, deletedAt: null } })` | Soft-deleted customers (`deletedAt != null`) |
| `PRODUCTS_MAX` | Non-deleted products of the business | `product.count({ where: { businessId, deletedAt: null } })` | Soft-deleted products. **Deactivation (`isActive = false`) still counts** — deactivation is a catalog state, not deletion |
| `TEAM_MEMBERS_MAX` | Active memberships of the business, **owner included** (§108) | `businessMember.count({ where: { businessId } })` | Pending invites (§31); removed members |
| `BUSINESSES_MAX` | Businesses the user **OWNS** (`ownerId = user`, §107) | `business.count({ where: { ownerId } })` | Businesses the user merely belongs to as staff |
| `AI_COPILOT` / `ADVANCED_REPORTS` / `CSV_EXPORT` | Not counted (booleans) | — | — |

### 4.1 `BUSINESSES_MAX` — the user-level special case

`BUSINESSES_MAX` cannot be read from one business's subscription because it
caps how many businesses a **user** may own. Deterministic policy
(`assertWithinBusinessesLimitTx`):

1. Collect the subscriptions of the businesses the user already owns.
2. The **effective limit is the MAXIMUM `BUSINESSES_MAX` across those
   businesses' plans** — upgrading any owned business lifts the cap for all
   future business creation. If any owned business's plan is unlimited
   (`null`), the cap is lifted entirely.
3. Fail-closed contributions: a business without a subscription (mid-backfill)
   or a plan with a corrupt/missing `BUSINESSES_MAX` row contributes
   **nothing** (never a higher limit).
4. If the user owns no business with a valid subscription, the **FREE limit
   applies** (1).
5. Count + check run inside the caller's transaction (race-safe on SQLite,
   §112 — harness G4 proves concurrent creates never exceed the limit).

### 4.2 AI usage metering — IMPLEMENTED (Prompt 21)

The unit enum's `REQUESTS` / `MESSAGES` values are now in use:
`AI_REQUESTS_MAX` / `AI_MESSAGES_MAX` are metered server-side per usage
period with hard-limit enforcement (422 `USAGE_LIMIT_REACHED`), idempotent
retries and release-on-failure. Full architecture: `usage-metering.md`,
`ai-quotas.md`, `usage-periods.md`. `AI_TOKENS` is recorded when the
provider reports it but has NO quota row (recorded-not-enforced, §66).

## 5. Fail-closed policy

A missing or corrupt catalog row can never behave as "allowed" or "unlimited":

- `entitlementsFromRows` **pre-fills the whole map with fail-closed defaults**
  (`LIMIT → 0`, `BOOLEAN → false`) before applying DB rows (§68/§93). A plan
  missing a row therefore gets 0/false, never unlimited.
- Rows with codes unknown to the catalog are skipped (no dynamic entitlements).
- `getLimitIn` returns `0` (not `null`) for an unknown or misconfigured
  entitlement — `0` blocks, `null` would mean unlimited.
- `assertWithinBusinessesLimitTx` treats a corrupt plan as contributing
  nothing (§4.1 rule 3).
- A **failed billing lookup throws `BILLING_UNAVAILABLE` (503)** — it never
  degrades into unlimited access (§93). A missing/inactive FREE plan during
  `ensureSubscription` fails loudly the same way.
- The seed enforces completeness: every active plan must define all 7
  entitlements, or the seed aborts with an error.

## 6. Structured error shapes

Billing errors are structured domain failures (`src/lib/billing/errors.ts`)
mapped onto the standard envelope `{ ok: false, error: { code, message, details } }`.

### 6.1 `422 ENTITLEMENT_LIMIT_REACHED`

Thrown by `limitReachedError` when usage would exceed a `LIMIT`
(`currentUsage >= limit` — the check runs **before** the insert, so `current`
may equal the limit being hit):

```json
{
  "ok": false,
  "error": {
    "code": "ENTITLEMENT_LIMIT_REACHED",
    "message": "The plan limit for CUSTOMERS_MAX has been reached.",
    "details": {
      "feature": "CUSTOMERS_MAX",
      "limit": 50,
      "current": 50,
      "upgradeAvailable": true
    }
  }
}
```

No internal DB details leak into `details` (§113).

### 6.2 `403 ENTITLEMENT_NOT_AVAILABLE`

Thrown by `assertFeatureAccess` when a BOOLEAN feature is `false` on the
effective plan (§26/§34):

```json
{
  "ok": false,
  "error": {
    "code": "ENTITLEMENT_NOT_AVAILABLE",
    "message": "This feature is not available on the current plan.",
    "details": {
      "feature": "AI_COPILOT",
      "planCode": "FREE",
      "upgradeAvailable": true
    }
  }
}
```

Full error-code table (including lifecycle errors): see
`docs/billing/subscription-lifecycle.md` §8.

## 7. Verification

- `scripts/prompt20-billing-check.mjs` — 55/55 checks: seed shape (A), limits
  and in-transaction enforcement incl. concurrency (G), boolean gates
  (H), cross-tenant isolation (E), downgrade semantics (G6/G7).
- Downgrade never deletes data: over-limit businesses keep their rows and are
  only blocked from **further growth** (§42 — harness G3/G6/G7).
