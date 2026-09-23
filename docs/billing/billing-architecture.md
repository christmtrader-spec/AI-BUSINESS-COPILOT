# Billing Architecture

**Document ID:** BILLING-DESIGN-v1.0 (rev. Prompt 20 — foundation implemented)
**Phase:** Prompt 17 (monetization design) → **Prompt 20 (billing foundation): IMPLEMENTED** — payments still deferred
**Implements:** Constitution A16 (`docs/PROJECT-CONSTITUTION.md:248-252`)
**Companion docs:** `docs/ARCHITECTURE.md`, `docs/marketing/launch-readiness.md`
**Prompt 20 companion docs:** `docs/billing/entitlements.md` · `docs/billing/subscription-lifecycle.md` · `docs/billing/plan-catalog.md` · `docs/billing/platform-billing-vs-business-finance.md`

---

## Implementation status (Prompt 20) — READ THIS FIRST

The **billing foundation described below is now implemented** (Prompt 20).
Payments are **not**. What exists today:

- **5 billing tables** via migration
  `prisma/migrations/20260923075730_prompt20_billing_foundation/migration.sql`:
  `Plan`, `EntitlementDefinition`, `PlanEntitlement` (relational join table —
  not `entitlementsJson`), `Subscription`, `SubscriptionEvent`.
- **Service layer** at `src/lib/billing/` (`catalog.ts` — plan + entitlement
  catalog; `state-machine.ts` — pure statuses/transitions/`decidePlan`;
  `service.ts` — transactional, evented, audited mutations + entitlement
  resolution; `errors.ts` — structured billing error codes). The service layer
  is the only module that touches the billing tables.
- **9 API endpoints** under `/api/v1/billing/`: `plans`, `plan`,
  `subscription`, `entitlements`, `events` (reads) and `change-plan`,
  `cancel`, `reactivate`, `trial` (mutations, OWNER/ADMIN + rate limits;
  trial disabled unless `BILLING_TRIALS_ENABLED=1`).
- **Entitlement gates** in: customers (`CUSTOMERS_MAX`), products
  (`PRODUCTS_MAX`), businesses (`BUSINESSES_MAX`), members + invites
  (`TEAM_MEMBERS_MAX`), copilot (`AI_COPILOT`), reports export
  (`CSV_EXPORT`), reports summary (`ADVANCED_REPORTS` — server omits the
  advanced block when not entitled).
- **Settings → Subscription UI** (`src/modules/billing/subscription-view.tsx`,
  `plan-limit-banner.tsx`): internal plan switching without payment (§83 —
  no money changes hands, nothing is labeled as payment).
- **Idempotent seed + FREE backfill** (`scripts/seed-billing.ts`): 5 plans ×
  7 entitlements, never overwrites, backfills every subscription-less
  business to FREE, invariant `subscriptions == businesses`.
- **Tests:** `scripts/prompt20-billing-check.mjs` — 55/55;
  `scripts/prompt20-state-machine.test.ts` — 38/38 (pure state-machine unit
  tests).

**Still deferred (unchanged from the design below):** payment provider
choice (legal-counsel gate), checkout, prices, invoices/cards/webhooks/
refunds, and the reserved `PAST_DUE`/`PAUSED` writers (nothing sets these
statuses yet).

**Prompt 21 update — AI usage metering is now IMPLEMENTED:**
`UsagePeriod` / `UsageCounter` / `UsageEvent` tables (migration
`20260923091927_prompt21_usage_metering`), `AI_REQUESTS_MAX` /
`AI_MESSAGES_MAX` hard-limit entitlements, idempotent metering with
release-on-failure, usage API + UI. See `usage-metering.md`, `ai-quotas.md`,
`usage-periods.md`, `usage-reconciliation.md`. Tests:
`scripts/prompt21-usage-check.mjs` — 76/76.

> **Prompt 20 note (supersession map for this document):** the design text
> below is preserved as history. Where implementation diverged, a short
> *Prompt 20 note* is added in place: §2 (`entitlementsJson` → relational
> `PlanEntitlement` per §17; 5 statuses → 6), §4 (placeholder entitlement
> keys → final 7-key catalog), §6 (`UsageCounter` → deferred to Prompt 21),
> §8 (pseudo-schema → real migration), §9 (non-goals partially lifted).
> The live behavior is documented in the four Prompt 20 companion docs above.

---

> ⚠️ *The warning below was written in Prompt 17 and is kept verbatim as
> history. Since Prompt 20 it is **outdated in one direction only**: the
> billing tables, API routes, and service layer NOW exist (see above).
> It remains true that no payment integration exists.*
>
> ⚠️ Nothing in this document is built: no `src/modules/billing/` module, no
> billing API route, no payment integration, no billing tables in
> `prisma/schema.prisma`. ARCHITECTURE.md already marks billing as a
> "boundary placeholder only" (`docs/ARCHITECTURE.md:59`, `:154`). This doc
> fixes the target design so later implementation does not re-litigate it.

---

## 1. Scope, honesty, and the payment-provider boundary

### 1.1 Positioning context

The product is **"AI Business Copilot" — AI-powered business management and
financial insight** (Constitution §1, `docs/PROJECT-CONSTITUTION.md:18-29`),
**not** accounting software. All billing/marketing copy stays inside that
positioning (claims policy: `docs/marketing/launch-readiness.md` §3).

### 1.2 Payment provider — deferred, with a hard jurisdiction note

Choosing a payment provider is **explicitly deferred** and must be made with
legal counsel: the primary target market includes Iran (FA-first UI,
`src/i18n/messages/fa.ts:3-7`) and payment integration is legally and
contractually constrained by the operator's jurisdiction.

- Payment/KYC/transfer topics — including anything touching sanctions or
  jurisdictional bypass — are **OUT OF SCOPE** here and everywhere in this
  repository; they are never discussed in code, docs, or marketing.
- The design is deliberately **provider-agnostic**: the `PaymentProvider`
  interface (§7) isolates all provider contact behind one adapter, so the
  eventual choice does not touch business logic.
- **No fake payment confirmation, ever** (Rule 05,
  `docs/PROJECT-CONSTITUTION.md:284-287`): a subscription becomes ACTIVE only
  on a verified provider webhook/billing event — no "manual confirm" path,
  no seeded paid accounts, no UI implying payment happened when it did not.

  > *Prompt 20 note: in this phase (no provider exists yet) plan changes are
  > **explicit internal operations** by an authorized user — they set ACTIVE
  > and write `PLAN_CHANGED` events, but **no money changes hands and nothing
  > is labeled as payment** (§83). No simulated "payment" record is created
  > anywhere (harness K1 proves zero `Payment` rows). The webhook-only path
  > above remains the law for the future payment phase. See
  > `docs/billing/platform-billing-vs-business-finance.md` §4.*

---

## 2. Entities (conceptual model)

| Entity | Purpose | Key design decisions |
|---|---|---|
| **Plan** | A sellable tier | `code` (FREE/STARTER/BUSINESS/PRO — A16 lists Enterprise as future), `entitlementsJson` (feature key → limit), **currency-agnostic pricing placeholders** (amounts resolved at checkout time by the provider adapter + business locale/currency, A04) |
| **Subscription** | A business's plan state over time | Belongs to a **Business, not a User** (§3); one row per business, unique `(businessId)` |
| **SubscriptionStatus** | Lifecycle state | `TRIALING / ACTIVE / PAST_DUE / CANCELED / EXPIRED` |
| **Entitlement** | One feature key → limit + unit + enforcement layer | Owned by a Plan (also exposed inside `entitlementsJson` for one-read resolution) |
| **UsageCounter** | Period-keyed consumption | Unique `(businessId, key, period)`; incremented server-side |
| **BillingPeriod** | The billing clock | `MONTHLY`/`YEARLY` design placeholder; period keys are `YYYY-MM` strings for monthly counters |
| **Trial** | Time-boxed paid-tier evaluation | `SubscriptionStatus.TRIALING` + `trialEndsAt` (no separate table in v1) |

> *Prompt 20 note: superseded by the relational `PlanEntitlement` join table
> (`Plan ⋈ EntitlementDefinition`) — §17 of the implementation mandates
> relational resolution, not an `entitlementsJson` blob. The status set is
> 6 values: `PAST_DUE` and `PAUSED` are reserved/unused in this phase, and
> the `UsageCounter` entity is deferred (see §6). See
> `docs/billing/subscription-lifecycle.md` §1–§2 and
> `docs/billing/platform-billing-vs-business-finance.md` §1.*

### 2.1 SubscriptionStatus semantics (design)

> *Prompt 20 note: superseded by `STATUS_SEMANTICS` in
> `src/lib/billing/state-machine.ts` (6 statuses — `PAUSED` added as a
> reserved state) — the exact, implemented semantics live in
> `docs/billing/subscription-lifecycle.md` §1.*

| Status | Meaning | Access |
|---|---|---|
| `TRIALING` | In trial window (`trialEndsAt` in future) | Paid-tier entitlements; countdown affordance |
| `ACTIVE` | Verified payment covers current period | Paid-tier entitlements |
| `PAST_DUE` | Renewal failed but grace window open | Paid-tier entitlements + renewal banner |
| `CANCELED` | Canceled by owner; retains access until `periodEnd` | Plan entitlements until expiry |
| `EXPIRED` | No valid coverage | FREE-tier entitlements only |

SQLite stores Prisma enums as strings (`prisma/schema.prisma:14-16` — "SQLite
connector does not support Prisma enums"), so all of the above are string
columns validated with zod at every boundary, exactly like
`BusinessMember.role` (`prisma/schema.prisma:77-78`).

---

## 3. Why the subscription belongs to a BUSINESS, not a user

**Decision:** `BusinessSubscription.businessId` is the owner of the billing
relationship. A user may hold memberships in several businesses with different
plans.

Justification, grounded in the existing schema (`prisma/schema.prisma:18-83`):

1. **SaaS for teams.** The tenant graph is `User ─< BusinessMember >─ Business`
   (`prisma/schema.prisma:18-36,38-69,71-83`); every business-owned record
   hangs off `businessId`. Billing meters the *business's* consumption
   (customers, invoices, AI asks) — per-tenant, not per-person.
2. **Members inherit business entitlements.** RBAC already resolves everything
   through membership (`BusinessMember.role`, unique `(businessId, userId)`,
   `prisma/schema.prisma:81`) with server-side permission checks
   (`requirePermission`, e.g. `src/app/api/v1/businesses/[id]/export/route.ts:34`).
   Entitlement checks slot into the same pipeline (ARCHITECTURE §2,
   `docs/ARCHITECTURE.md:67-77`) — no per-user billing lookups.
3. **Matches the tenant-isolation law (A01):** every request resolves an
   *active business* — the natural billing scope. A user-level plan would
   double-charge an owner running two shops and share one shop's limits across
   unrelated consultants.

---

## 4. Entitlements — categories and feature matrix

Entitlement keys are **feature-level limits** enforced server-side. Categories
follow A16 (`docs/PROJECT-CONSTITUTION.md:249`): **FREE / STARTER / BUSINESS /
PRO** (ENTERPRISE deferred).

Limit keys (conceptual — no prices, no final numbers in this design doc):

| Entitlement key | Unit | FREE | STARTER | BUSINESS | PRO |
|---|---|---|---|---|---|
| `BUSINESSES_MAX` | count (owned) | 1 | 1 | 2 | 5 |
| `CUSTOMERS_MAX` | active rows | 25 | 200 | 1,000 | 5,000 |
| `PRODUCTS_MAX` | active rows | 25 | 200 | 1,000 | 5,000 |
| `TEAM_MEMBERS_MAX` | members | 1 | 3 | 10 | 25 |
| `AI_REQUESTS_MONTHLY` | requests / period | 20 | 150 | 750 | 3,000 |
| `EXPORTS_MONTHLY` | downloads / period | 2 | 10 | 30 | 100 |
| `REPORT_HISTORY_MONTHS` | months lookback | 1 | 6 | 24 | 60 |
| `FILE_STORAGE_MB` | megabytes | — | 100 | 500 | 5,000 |

Notes: values above are **placeholder magnitudes for design review only**
(final numbers are a pricing decision, not engineering); `FILE_STORAGE_MB` is
forward-looking (no file upload exists — A15 is interface-only,
`docs/PROJECT-CONSTITUTION.md:242-246`).

> *Prompt 20 note: superseded by the final 7-entitlement catalog in
> `src/lib/billing/catalog.ts` (`CUSTOMERS_MAX`, `PRODUCTS_MAX`,
> `TEAM_MEMBERS_MAX`, `BUSINESSES_MAX`, `AI_COPILOT`, `ADVANCED_REPORTS`,
> `CSV_EXPORT` — with `ENTERPRISE` as a fifth, catalog-only plan) and the
> exact per-plan values in `docs/billing/entitlements.md` §2.*

### 4.1 Entitlement record shape (design)

> *Prompt 20 note: superseded by `EntitlementSpec`/`PlanSpec` in
> `src/lib/billing/catalog.ts` and the `EntitlementDefinition` +
> `PlanEntitlement` tables (see `docs/billing/entitlements.md` §1).*

```ts
// src/modules/billing/entitlements.ts (FUTURE — design sketch)
type EntitlementKey =
  | "BUSINESSES_MAX" | "CUSTOMERS_MAX" | "PRODUCTS_MAX" | "TEAM_MEMBERS_MAX"
  | "AI_REQUESTS_MONTHLY" | "EXPORTS_MONTHLY"
  | "REPORT_HISTORY_MONTHS" | "FILE_STORAGE_MB";

type Entitlement = {
  key: EntitlementKey;
  limit: number | null; // null = unlimited (used sparingly)
  unit: "count" | "rows" | "requests" | "downloads" | "months" | "mb";
  enforcement: "api-guard" | "api-guard+ui";
  period: "lifetime" | "monthly" | null; // monthly keys get a UsageCounter
};
```

---

## 5. Enforcement — the law

> **LAW: entitlements are verified SERVER-SIDE only, never from client state
> or localStorage.** The client may *display* limits for UX, but every gate is
> a server check. This is the same law as tenant isolation and RBAC (A01/A02:
> "frontend hiding is never sufficient", `docs/PROJECT-CONSTITUTION.md:130-144`;
> "server-side in the API layer on every request", `:141-144`).

Two layers:

1. **Server API guards (authoritative).** Each protected route adds one
   entitlement check after the existing pipeline steps (zod → authenticate →
   tenant resolve → RBAC → **entitlement** → execute — ARCHITECTURE §1,
   `docs/ARCHITECTURE.md:29-38`). Concretely:
   - Row-count limits: `count()` before create (e.g. customers create checks
     `CUSTOMERS_MAX` against `db.customer.count({ where: { businessId } })`).
   - Metered limits: `getUsage()` before / `recordUsage()` after the work
     (copilot ask → `AI_REQUESTS_MONTHLY`; export → `EXPORTS_MONTHLY`,
     replacing the hard-coded 4-per-5-min limiter with plan-aware metering,
     `src/app/api/v1/businesses/[id]/export/route.ts:36`).
   - Range limits: query-time clamp (reports lookback ≤
     `REPORT_HISTORY_MONTHS`).
   - zod keeps validating *shape*; the entitlement check is *service-level*
     authorization, exactly like `requirePermission` today (`src/lib/tenant.ts`).
2. **UI affordances (non-authoritative).** Upgrade badges, "limit reached"
   empty states, countdown chips — read from API responses, never authority.
   Violations return the standard error envelope
   (`{ ok: false, error: { code, message } }`, `docs/PROJECT-CONSTITUTION.md:355-358`)
   with a stable new code (e.g. `ENTITLEMENT_LIMIT`) so the UI can offer an
   upgrade path.

**Module boundary:** all billing logic lives in `src/modules/billing/` and is
consumed by other modules only through exported service functions (A17,
`docs/PROJECT-CONSTITUTION.md:254-261`) — feature modules must never query
billing tables directly.

---

## 6. Usage abstraction (design)

> *Prompt 21 note: **IMPLEMENTED** — the sketch below became
> `src/lib/billing/usage.ts` with relational `UsagePeriod` / `UsageCounter` /
> `UsageEvent` tables (migration `20260923091927_prompt21_usage_metering`),
> quotas from the entitlement catalog (`AI_REQUESTS_MAX` / `AI_MESSAGES_MAX`),
> idempotency via `UsageEvent(businessId, metric, idempotencyKey)` UNIQUE and
> release-on-failure reconciliation. Live behavior: `docs/billing/usage-metering.md`.*

```ts
// src/modules/billing/usage.ts (FUTURE — design sketch)
import { db } from "@/lib/db";

export function currentPeriod(now = new Date()): string { // "YYYY-MM"
  return now.toISOString().slice(0, 7);
}

/** Server-side consumption record — called AFTER the work succeeds. */
export async function recordUsage(
  businessId: string,
  key: EntitlementKey,
  n = 1,
): Promise<void> {
  const period = currentPeriod();
  await db.usageCounter.upsert({
    where: { businessId_key_period: { businessId, key, period } },
    create: { businessId, key, period, used: n },
    update: { used: { increment: n } },
  });
}

/** Pre-check. Returns { used, limit, remaining, exceeded }. */
export async function getUsage(
  businessId: string,
  key: EntitlementKey,
  period = currentPeriod(),
): Promise<UsageSnapshot> { /* resolve entitlement + counter, one query */ }
```

Rules: counters are **period-keyed** (`YYYY-MM`) — expiry is implicit (new
period = fresh counter, no cron); increments happen in the same transaction
as the mutation where correctness matters, following the transactional-summary
pattern of the payments pipeline (`prisma/schema.prisma:213-217`).

---

## 7. Payment abstraction (design)

```text
PaymentProvider (interface)          ← the ONLY seam that touches money-in
   └─ provider adapter               ← one file per vendor (like AIProvider, A10)
        └─ billing service           ← src/modules/billing/ service fns
             └─ subscription + entitlement + usage update (server-side)
```

```ts
// src/modules/billing/payment-provider.ts (FUTURE — design sketch)
export interface PaymentProvider {
  createCheckout(input: CheckoutInput): Promise<{ redirectUrl: string }>;
  verifyWebhook(req: Request): Promise<BillingEvent | null>; // validates signature
  handleRenewal(event: BillingEvent): Promise<SubscriptionTransition>;
  cancelSubscription(input: { businessId: string }): Promise<void>;
}
```

Flow laws:
1. `verifyWebhook` is the **only** code path that can move a subscription to
   `ACTIVE` — manual flips forbidden (§1.2, no fake confirmation).
   > *Prompt 20 note: superseded **for this phase** by the internal
   > change-plan tool (`changePlan` in `src/lib/billing/service.ts`) — an
   > authorized OWNER/ADMIN operation that re-engages a subscription without
   > money (§41/§83). The webhook-only law returns with the payment phase;
   > `verifyWebhook` does not exist yet.*
2. Provider identity never leaks past the adapter (mirror of D7/A10 for AI,
   `docs/TECH-DECISION-RECORD.md:79-83`).
3. Provider selection is **deferred** and requires legal counsel sign-off
   (§1.2); sanctions/KYC/bypass topics stay out of scope everywhere.
4. Failed renewals → `PAST_DUE` (grace) → `EXPIRED`; `EXPIRED` resolves to
   FREE tier. Downgrades never delete user data (soft-delete pattern already
   exists, `prisma/schema.prisma:142`).

---

## 8. Minimal Prisma model sketch (PSEUDO-SCHEMA — NOT applied)

> *Prompt 20 note: superseded by the real schema — `prisma/schema.prisma`
> (the 5 billing models) and migration
> `20260923075730_prompt20_billing_foundation`. Divergences: `Subscription`
> (not `BusinessSubscription`) references a `Plan` row by FK (`ON DELETE
> RESTRICT`) instead of storing a `planCode` string; the join-table pattern
> replaced flat `PlanEntitlement` key rows; no `providerRef` column exists
> (§84/§85); history lives in `SubscriptionEvent`.*

```prisma
// prisma/schema.prisma (FUTURE — sketch; do NOT paste into the live schema)
// NOTE: SQLite has no enums (schema.prisma:14-16) → status/period stay strings.

model BusinessSubscription {
  id             String   @id @default(cuid())
  businessId     String   @unique            // ONE subscription per business
  business       Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  planCode       String                       // FREE | STARTER | BUSINESS | PRO
  billingPeriod  String   @default("MONTHLY") // MONTHLY | YEARLY
  status         String   @default("TRIALING")// TRIALING|ACTIVE|PAST_DUE|CANCELED|EXPIRED
  trialEndsAt    DateTime?
  periodStart    DateTime?
  periodEnd      DateTime?                    // access horizon for ACTIVE/CANCELED
  providerRef    String?                      // provider-side subscription id (opaque)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@index([status, periodEnd])
}

model PlanEntitlement {
  id           String  @id @default(cuid())
  planCode     String                       // FREE | STARTER | BUSINESS | PRO
  key          String                       // e.g. "AI_REQUESTS_MONTHLY"
  limit        Int?                         // null = unlimited (rare)
  unit         String                       // "requests" | "rows" | ...
  enforcement  String                       // "api-guard" | "api-guard+ui"
  period       String?                      // "monthly" | null (lifetime)

  @@unique([planCode, key])
}

model UsageCounter {
  id         String   @id @default(cuid())
  businessId String
  business   Business @relation(fields: [businessId], references: [id], onDelete: Cascade)
  key        String                        // entitlement key
  period     String                        // "YYYY-MM" (monthly counters)
  used       Int      @default(0)

  @@unique([businessId, key, period])
  @@index([businessId, period])
}
```

(`Business` gains the reverse relation `subscription BusinessSubscription?` —
conceptual; not applied to the live schema in this phase.)

---

## 9. Explicit non-goals of this phase

> *Prompt 20 note: this section is preserved as Prompt 17 history and is now
> partially superseded — billing code/routes/tables/UI **do** exist as of
> Prompt 20 (see the Implementation status section at the top). Still true:
> no prices, no checkout, no provider choice (legal-counsel gate, §1.2).
> The current non-goal list lives in the Implementation status section.*

No billing code/routes/tables/UI in Prompt 17 (A16 —
`docs/PROJECT-CONSTITUTION.md:250-252` — still true), no prices or checkout
flows anywhere, no provider choice (deferred to a phase starting with legal
counsel sign-off, §1.2), and no `src/` changes accompany this document.
