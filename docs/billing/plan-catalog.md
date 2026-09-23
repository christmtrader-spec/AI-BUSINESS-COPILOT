# Plan Catalog — FREE / STARTER / BUSINESS / PRO / ENTERPRISE

**Document ID:** BILLING-PLAN-CATALOG-v1.0
**Phase:** Prompt 20 (billing foundation) — **STATUS: IMPLEMENTED**
**Source of truth:** `src/lib/billing/catalog.ts` (initial seed input) → `Plan` table (runtime authority)
**Companion docs:** `docs/billing/entitlements.md` (per-plan values), `docs/billing/subscription-lifecycle.md`, `docs/billing/platform-billing-vs-business-finance.md`

The catalog defines five plans. The **entitlement values per plan are
documented in `docs/billing/entitlements.md` §2**; this document covers plan
identity, purpose, mutability rules, and the seed mechanism.

> **Pricing law (§39/§40): there are NO prices anywhere in this codebase —
> no price columns, no price rows, no checkout.** Plan identity is not money.
> Every plan below states this explicitly.

---

## 1. The plans

### FREE

- **Code:** `FREE` (stable, immutable machine identifier)
- **Purpose:** The deterministic default plan. Every business — new or
  migrated — starts here. Core business management included.
- **Intended customer:** anyone starting out, and every business that existed
  before billing (the seed backfills them all to FREE — never a paid plan,
  never no plan, §65).
- **Entitlement profile:** lowest limits (customers 50 / products 25 /
  team 2 / businesses 1), AI Copilot on, advanced reports **off**, CSV export
  on (deliberate backwards-compatibility decision — see entitlements doc §2).
- **Pricing: NOT DEFINED YET.** No price exists for this plan anywhere in the
  codebase (§39).

### STARTER

- **Code:** `STARTER`
- **Purpose:** Higher limits and advanced report insights.
- **Intended customer:** growing one-person businesses.
- **Entitlement profile:** customers 500 / products 200 / team 5 /
  businesses 2; all boolean features on.
- **Pricing: NOT DEFINED YET.** No price exists for this plan anywhere in the
  codebase (§39).

### BUSINESS

- **Code:** `BUSINESS`
- **Purpose:** Larger limits and multi-member team access.
- **Intended customer:** established shops with staff.
- **Entitlement profile:** customers 2,500 / products 1,000 / team 15 /
  businesses 5; all boolean features on.
- **Pricing: NOT DEFINED YET.** No price exists for this plan anywhere in the
  codebase (§39).

### PRO

- **Code:** `PRO`
- **Purpose:** High limits for larger operations — advanced AI and reporting
  included.
- **Intended customer:** larger operations running multiple businesses.
- **Entitlement profile:** customers 25,000 / products 10,000 / team 50 /
  businesses 10; all boolean features on.
- **Pricing: NOT DEFINED YET.** No price exists for this plan anywhere in the
  codebase (§39).

### ENTERPRISE

- **Code:** `ENTERPRISE`
- **Purpose:** Customizable limits for large organizations. Negotiated per
  customer.
- **Intended customer:** large organizations; assignment happens server-side,
  case by case.
- **Entitlement profile:** all LIMITs `null` = **unlimited**; all boolean
  features on.
- **Self-service exclusion:** `ENTERPRISE` exists in the catalog and is a
  valid change-plan target server-side, but it is **not offered for
  self-service switching** — `selfServicePlanCodes()` excludes it, so
  `GET /api/v1/billing/plans` lists only the 4 public self-service plans
  (harness C4).
- **Pricing: NOT DEFINED YET.** No price exists for this plan anywhere in the
  codebase (§39); "negotiated per customer" is a future sales-process concept
  with no implementation behind it.

## 2. Plan mutability rules

| Attribute | Rule |
|---|---|
| `code` | **Stable, immutable machine identifier.** Never renamed after subscriptions exist. `Plan.code` carries a unique index; authorization never uses display names (§7/§8). |
| `name`, `description` | Mutable display data. Renaming "Starter" to "Starter Plus" is safe; renaming the `code` is not. |
| `active` | Retirement flag. A retired plan is set `active = false` and is **never deleted** (§80). `changePlan` rejects inactive targets with `422 INVALID_PLAN`. |
| `isPublic` | Catalog visibility flag. (All 5 seeded plans are public; self-service switching additionally excludes `ENTERPRISE` by code.) |
| `sortOrder` | Display ordering (10/20/30/40/50 in the seed). |
| `id` | Referenced by `Subscription.planId` with **`ON DELETE RESTRICT`** — deleting a plan that still has subscriptions is blocked at the database level (§80). Retirement via `active = false` is the only supported off-ramp. |

Changing an entitlement **value** for a plan is a data operation on
`PlanEntitlement` rows, not a code change: once seeded, the database is the
runtime authority, and the seed's `update: {}` clauses mean re-running it
never overwrites existing rows (§63). There is currently **no admin UI or API
for catalog edits** — none is planned for Prompt 20.

## 3. The seed mechanism (`scripts/seed-billing.ts`)

Run explicitly with:

```bash
bun scripts/seed-billing.ts
```

This is an **explicit one-time-per-database mechanism** — §118: the
application never seeds at startup, and nothing in the runtime creates
catalog rows.

Properties (each verified by the harness):

1. **Idempotent upserts (§63/§103).** Entitlement definitions, plans, and
   plan→entitlement mappings are upserted **by stable code** with empty
   `update:` clauses — only MISSING records are created; existing rows are
   never overwritten; no plan is ever deleted. Re-running the seed is a
   no-op (harness A5).
2. **Completeness verification.** After seeding, every active plan must have
   exactly `ENTITLEMENTS.length` (7) `PlanEntitlement` rows — the seed aborts
   with an error otherwise ("catalog incomplete"). The normal state is
   5 plans × 7 entitlements = 35 mappings (harness A1–A4).
3. **FREE backfill (§14/§64/§104).** Every business **without** a
   subscription receives a deterministic FREE subscription — never a paid
   plan, never no plan (§65). Each backfill writes a `CREATED`
   `SubscriptionEvent` with `dataJson.source = "seed-backfill"` and a
   `billing.subscription_created` audit row, in one transaction per business
   (auditable; harness B3).
4. **Invariant: `subscriptions == businesses`.** The seed re-counts both
   tables and **throws** if they diverge — every business must end with
   exactly one subscription (harness B1). Businesses created after the seed
   are covered at runtime by `ensureSubscription` ("born entitled", harness
   B4) and, as a lazy safety net, by the fresh-context loader on read.
5. **Safe scope.** Additive only: touches ONLY the 5 billing tables plus the
   audit log; imports the catalog from `src/lib/billing/catalog.ts` (single
   source of truth — no duplicated matrix in the seed).

The seed prints its final state (plans / entitlements / mappings /
subscriptions / businesses / subscriptionEvents counts) and exits non-zero on
any failure.

## 4. How plans get assigned

| Moment | Mechanism | Plan |
|---|---|---|
| Business created (`POST /api/v1/businesses`) | `ensureSubscription` inside the creation transaction | FREE (after the `BUSINESSES_MAX` gate) |
| Business predates billing | Seed backfill (§3 above) | FREE |
| Read finds a subscription-less business | `getEntitlementContextFresh` lazy backfill (`source: "lazy-backfill"`) | FREE |
| Owner/Admin decision | `POST /api/v1/billing/change-plan` (internal tool; no money involved, §83) | Any active plan |

There is no purchase flow: plan changes are explicit internal operations by
an authorized user (OWNER/ADMIN), and every change is recorded as a
`PLAN_CHANGED` event + audit row (see `docs/billing/subscription-lifecycle.md`).
