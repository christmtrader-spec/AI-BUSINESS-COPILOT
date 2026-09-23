# Platform Billing vs Tenant Business Finance — the architectural separation law

**Document ID:** BILLING-SEPARATION-v1.0
**Phase:** Prompt 20 (billing foundation) — **STATUS: IMPLEMENTED** (the separation it describes is enforced in code and harness-tested)
**Companion docs:** `docs/billing/billing-architecture.md`, `docs/billing/plan-catalog.md`, `docs/PROJECT-CONSTITUTION.md` (A08 money law, Rule 05)

There are two completely distinct ledgers in this system. They must never be
merged, reused, or made to stand in for each other.

---

## 1. The two table sets

### Platform Billing — the money *AI Business Copilot* may one day charge a business

| Table | Role |
|---|---|
| `Plan` | Sellable tier identity (stable `code`, display metadata, `active` retirement flag) |
| `EntitlementDefinition` | Feature-gate vocabulary (`code`, `type`, `unit`) |
| `PlanEntitlement` | The relational plan → entitlement join table (`value` / `boolValue`) |
| `Subscription` | The business's **current** plan state (one row per business, unique `businessId`) |
| `SubscriptionEvent` | Billing lifecycle history (append-only events) |

These tables answer one question: *what is this business entitled to, and how
did it get there?* They are managed exclusively through the billing service
layer (`src/lib/billing/service.ts`) — routes/components never query them
directly.

### Tenant Business Finance — the business's OWN accounting data

| Table | Role |
|---|---|
| `Sale` / `SaleItem` | The tenant's sales invoices and line items |
| `Expense` | The tenant's expenses |
| `Payment` | Money actually moved against a Sale or Expense (IN/OUT ledger) |
| `Customer` / `Supplier` | The tenant's counterparties |

These tables answer a different question: *what did the tenant business earn,
spend, and settle?* They are the deterministic source for every report, KPI,
and copilot answer (Rule 05 — the server computes, nothing is invented).

## 2. The separation law

1. **Never store SaaS subscription charges as `Payment` records.** A plan
   change, trial, cancellation, or expiry writes `SubscriptionEvent` rows —
   **never** a `Payment`, `Sale`, or `Expense` row. The harness proves this
   negatively: check **K1** ("NO SaaS payment records were created in tenant
   finance", §83) runs an entire billing exercise and verifies the billing
   fixtures created **zero** `Payment` rows; **K3** verifies subscription
   state lives in the billing tables, not Sale/Expense/Payment.
2. **Never reuse `Sale` / `Expense` / `Payment` for billing.** No synthetic
   "invoice" for a SaaS fee, no "expense" for a subscription cost, no
   payment-shaped record for an upgrade. There is no invoice for the platform
   itself anywhere in the system.
3. **The two table sets share nothing except `businessId`.** No foreign keys
   cross between them (`Subscription.planId` → `Plan`, `Payment.saleId` →
   `Sale` — different graphs). Reports, receivables, payables, and inventory
   valuations are computed from tenant finance **only**; entitlements are
   resolved from billing **only**. Neither pipeline reads the other's tables.

## 3. `SubscriptionEvent` vs `AuditLog`

Both are append-only histories and every billing mutation writes **both** in
the same transaction — but they serve different consumers:

| | `SubscriptionEvent` | `AuditLog` |
|---|---|---|
| **Domain** | Billing lifecycle history | Security / operational trace |
| **Grain** | State-machine transitions: `type`, `fromStatus`/`toStatus`, `fromPlanCode`/`toPlanCode`, small `dataJson` payload, actor | Actions across the whole app: `action` (e.g. `billing.plan_changed`), `entityType`/`entityId`, `before`/`after` JSON, actor, IP where applicable |
| **Consumer** | Billing UI (`GET /api/v1/billing/events`) — "what happened to this subscription, in order" | Audit view / security review — "who did what, when, to what" |
| **Rules** | No payment events exist (§20); never payment data in `dataJson` (§17: core relationships are relational, not JSON) | Account-level events use a nullable `businessId` (Prompt 18); business events are always tenant-scoped |

Concrete example: a plan change writes **both** a `PLAN_CHANGED`
`SubscriptionEvent` (with from/to plan codes) **and** a
`billing.plan_changed` `AuditLog` row (with before/after plan + status) —
in one transaction, via `eventAndAudit` (§47/§61). One is not a copy of the
other: they have different shapes, different query surfaces, and different
retention concerns.

## 4. What does NOT exist in Prompt 20 (explicit honesty list)

The platform-billing side is a **foundation without a money trail**. None of
the following exists anywhere in the codebase:

- ❌ No payment gateway / provider adapter (`PaymentProvider` interface remains a design sketch in `docs/billing/billing-architecture.md` §7)
- ❌ No checkout flow, no checkout session, no redirect-to-pay
- ❌ No invoices for the platform itself (tenant sale invoices exist; SaaS invoices do not)
- ❌ No card data, no payment methods, no tokenization — nothing to PCI-scope
- ❌ No webhooks (inbound or outbound) — no subscription became ACTIVE via a provider event because no provider exists
- ❌ No refunds, no credit notes, no proration, no dunning, no `PAST_DUE` writer
- ❌ No fake payment records — Rule 05 is absolute: nothing simulates a payment that did not happen. The K1 harness check proves zero `Payment` rows are created by any billing operation.

Consequently, plan changes in this phase are **explicit internal operations**
(OWNER/ADMIN via Settings → Subscription, §83): no money changes hands and
nothing is labeled as payment. The "verified provider webhook is the only
path to ACTIVE" law from the design doc applies to the **future payment
phase**, not to the internal tool that exists today.

## 5. The money law (A08) and where it applies

- **A08 (integer minor units only, `src/lib/money.ts`) governs tenant
  finance**: every `Sale`, `SaleItem`, `Expense`, and `Payment` amount is an
  integer minor-unit column, converted and formatted through the money
  helpers — never floats.
- **There are no SaaS prices to store.** The billing tables contain no money
  columns at all (`Plan`, `EntitlementDefinition`, `PlanEntitlement`,
  `Subscription`, `SubscriptionEvent` — zero price/amount fields, §39/§40).
  A08 has nothing to bite on in platform billing yet; when prices arrive,
  they arrive as integer minor units through the same law.

## 6. Contract for future payment phases

When a payment phase lands, it must preserve this separation:

- Provider integration adds **its own provider-mapping tables** (e.g.
  provider customer/subscription/price ids mapped to our ids) — the old
  design sketch's opaque `providerRef` column, if revived, becomes a dedicated
  mapping model rather than a column on `Subscription` (§84/§85: no
  provider-specific ids or secrets in the core tables today).
- It adds its own price tables (plan identity is not money — §40) and its own
  webhook-event tables; it does **not** touch `Sale`/`Expense`/`Payment`.
- It never writes tenant-finance rows as a side effect of billing.
- The failure mode is always fail-closed (`BILLING_UNAVAILABLE` 503), never a
  silent downgrade to unlimited.
