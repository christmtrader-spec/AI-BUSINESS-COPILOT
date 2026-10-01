# ADR 0035 — Advanced CRM Foundation (Prompt 35)

- **Status:** Accepted (implemented, Prompt 35)
- **Date:** 2026-10-01
- **Deciders:** Product/engineering (Z.ai Code session)
- **Scope label:** post-MVP product extension — "Advanced CRM Foundation"

## 1. Context

The Project Constitution lists "Advanced CRM" as a **Future Module**: the locked
MVP definition (Prompts 00–16) deliberately shipped only the accounting-core
loop (customers, suppliers, products, inventory, sales, expenses, payments)
plus the platform/identity/billing/security/notifications/portability/search
layers (Prompts 17–34). Prompt 35 now introduces the first real CRM workflow.
This ADR records why, and what the boundaries are, **without rewriting the
historical MVP contract** — the MVP shipped exactly as scoped; CRM is an
additive post-MVP extension.

### Why now

1. The accounting core is complete and hardened: every write path is audited,
   tenant-isolated, rate-limited where risk warrants, and covered by the P17–P34
   regression harnesses.
2. Discovery (Prompt 33) and record context (Prompt 34) established the
   entity/deep-link/360 patterns CRM needs; reusing them keeps CRM cheap and
   consistent.
3. Tenants currently track leads/opportunities outside the product; the gap is
   operational, not financial.

## 2. Scope of Prompt 35

Exactly:

1. **Leads** (`CrmLead`) — potential customers; explicit conversion.
2. **Opportunities** (`CrmOpportunity`) — potential deals; fixed pipeline.
3. **Fixed sales pipeline** (code-defined stages, §6/§7 of the prompt) —
   deliberately NO `PipelineStage` table.
4. **Lead conversion** — atomic; reuses the existing `CUSTOMERS_MAX`
   entitlement gate; optional linked opportunity in the same transaction.
5. **Opportunity stage management** — server-authoritative transitions.
6. **CRM dashboard summary** (`/api/v1/crm/summary`) — forecast metrics only.
7. **Lead/Opportunity detail** — Prompt 34 architecture (DTO, 404 semantics,
   shared components).
8. **Customer 360 CRM section** — visually separated from financial summary.
9. **Global search + palette + Search Center integration** (closed map).
10. **Entity deep links** `#/leads/<id>`, `#/opportunities/<id>`.
11. **Tenant-safe APIs, audit, export coverage, privacy coverage.**

Deliberately NOT in Prompt 35 (§3/§142): CRM activities, tasks, reminders,
call/email tracking, calendar, marketing campaigns, mass email, contact
sequences, AI lead scoring, predictive forecasting, external/WhatsApp/
Telegram/telephony integrations, custom fields, custom pipelines, automation
builder, workflow engine, autonomous agents, CRM import. This is an "Advanced
CRM **Foundation**", not a "full enterprise CRM".

## 3. Alternatives considered

| Alternative | Why rejected |
|---|---|
| **Custom pipelines/stages per business (DB-defined stages)** | Adds a stage table + per-tenant state machine before any value exists; summary math, search tokens and UI all become data-dependent. The fixed vocabulary keeps every invariant statically verifiable (unit tests + static scans). Revisit only with real tenant demand. |
| **Store CRM inside Customer (status flags)** | Conflates LEAD ≠ CUSTOMER (§4); a "potential customer" is not a counterparty; pollutes financial master data and breaks 360 semantics. |
| **Auto-create Sale on WON** | Forbidden (§1/§33). Revenue recognition must stay an explicit, authorized user action through the existing sales pipeline; anything automatic would silently change financial totals and audit meaning. |
| **Separate CRM microservice** | No scale need; would break the single Prisma/SQLite transactional model (conversion atomicity + entitlement gate) and the unified auth/audit path. |
| **No CRM (status quo)** | Real operational gap; deferring means tenants keep using spreadsheets with zero isolation/audit. |

## 4. Data model impact

Additive only — exactly two new tables:

- `CrmLead`: identity/contact fields, closed `source`, server-owned `status`,
  optional assignee (`User`, SetNull), conversion link (`Customer`, SetNull),
  `convertedAt`, `deletedAt` (soft delete), tenant cascade.
- `CrmOpportunity`: title/description, closed `stage`, integer
  `probabilityPct` (0–100), integer `expectedValueMinor` (forecast, minor
  units), `currencyCode` (captured at creation), optional
  assignee/customer/lead links, terminal fields (`wonAt`/`lostAt`/
  `lostReason`), `deletedAt`, tenant cascade.

Relations added: `Business.crmLeads/crmOpportunities`,
`Customer.crmLeads/crmOpportunities`, `User.crmLeadAssignments/
crmOpportunityAssignments` (explicit relation names — both CRM models
reference `User`). Indexes: `[businessId, deletedAt]`, `[businessId, status]`,
`[businessId, stage]`, `[businessId, expectedCloseDate]`,
`[businessId, assignedToUserId]`, `[customerId]`, `[leadId]` — every list
filter in §19/§28 is index-backed; no speculative indexes.

## 5. Migration impact

One additive migration `20261001090000_prompt35_crm_foundation` (2 CREATE
TABLE + 11 CREATE INDEX; zero drops, zero column rewrites, zero data
backfill). Backup taken before apply; `migrate status` → 0 pending; db
inventory shows existing counts unchanged.

## 6. Security impact

- No new permissions: CRM views ride `data:read`; all writes ride
  `data:write` (§17). `finance:manage` is NOT required for CRM writes, but
  creating an invoice from an opportunity goes through the existing
  sales-authorization path unchanged.
- Tenant isolation unchanged: every query scopes the server-derived
  `ctx.businessId`; foreign/deleted records resolve 404 (never 403) so
  existence never leaks.
- Assignee/customer/lead relations are validated same-business at every
  write (422 otherwise).
- No client-controlled tenant scope anywhere; closed vocabularies end-to-end
  (statuses/sources/stages accepted only from the closed maps).

## 7. Privacy impact

- New legal inventory entries (§88 docs): CRM rows are CONFIDENTIAL business
  data that may be personal data when a lead is a natural person.
- Deletion: soft delete in ops, business-deletion cascade, account deletion
  SetNull on assignments; converted customers are never touched.
- CRM is not a marketing/tracking system: no pixels/advertising IDs/
  behavioral profiles/fingerprinting (§89). Search adds no query logging or
  history (§90).
- Export: `crm_leads` + `crm_opportunities` datasets (JSON+CSV) with
  relationships as stable ids; import is explicitly NOT IMPLEMENTED (§87).
- AI grounding: CRM is NOT part of the AI Copilot snapshot (§72); no
  notification types (§73); no SecurityEvent usage (§132).

## 8. Financial-separation rules (the load-bearing wall)

`expectedValueMinor`/weighted values are FORECASTS. Enforced by:

1. No CRM write path touches Sale/Expense/Payment/Inventory (the only finance
   integration is the user-triggered "New invoice" reusing `SaleFormDialog`).
2. Reports/receivables/cash queries select from financial tables only — CRM
   tables are not joined anywhere in finance code (statically scanned).
3. Stage WON changes CRM state only (E2E-tested: financial totals unchanged).
4. UI labels: "Expected value"/"Weighted pipeline", never "Revenue".
5. Customer 360 keeps the financial cards untouched; CRM section is a
   separate block below.

## 9. Future extensibility

Fixed vocabulary today does not preclude custom stages later: a
`PipelineStage` table can be introduced behind the same `stageCategory`
concept; conversion can gain reactivation (CONVERTED → back) as an explicit
audited flow; notification/AI grounding can attach to the same audit events
once CRM behavior stabilizes. None of these are started in Prompt 35.

## 10. Deliberately excluded CRM functionality

See §2 — and additionally (§145): no CRM activities, tasks, reminders,
custom pipelines, marketing automation, AI lead scoring, CRM imports, email
sequences, external CRM integrations, semantic CRM search, autonomous sales
agents.

## 11. CRM plan gating

No documented commercial rule exists for CRM entitlements
(`docs/billing/entitlements.md` untouched): **CRM PLAN GATING = NOT
CONFIGURED**. CRM operates under the existing `data:read`/`data:write`
authorization only. Creating a customer through conversion still respects the
existing `CUSTOMERS_MAX` gate because Customer is an already-metered
resource (§75 — non-negotiable).
