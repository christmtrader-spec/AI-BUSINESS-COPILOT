# CRM Foundation — Product Documentation (Prompt 35)

**Status:** Implemented (Prompt 35) · post-MVP extension · see
`docs/adr/0035-advanced-crm-foundation.md` for the decision record.

## What this is

An operational, tenant-scoped CRM layer: **Leads**, **Opportunities**, a
**fixed sales pipeline**, **lead conversion**, and a **CRM dashboard**. It is
non-accounting: nothing here is revenue, receivable, or cash. The ONLY bridge
to finance is an explicit user action ("New invoice" on a WON opportunity)
that reuses the existing sales creation flow.

## Core concepts (§4)

| Concept | Meaning |
|---|---|
| **Customer** | Existing business counterparty / master record (accounting-relevant). |
| **Lead** | A potential customer that has NOT necessarily become a customer. `LEAD ≠ CUSTOMER`. |
| **Opportunity** | A potential commercial deal tied to a lead and/or customer. `OPPORTUNITY ≠ SALE`. |
| **Sale** | An actual financial transaction — unchanged by CRM state. |

Conversion is explicit. Winning an opportunity never creates a Sale.

## Lead lifecycle

```
NEW ──→ CONTACTED ──→ QUALIFIED ──→ CONVERTED
  │          │             │
  └──────────┴────────────┴──→ DISQUALIFIED (terminal)
```

- Server-controlled transitions (`POST /api/v1/crm/leads/[id]/status`);
  invalid moves → `422 INVALID_STATUS_TRANSITION`.
- `CONVERTED` is reachable ONLY through the atomic conversion flow
  (`POST /api/v1/crm/leads/[id]/convert`) — a bare status flip is rejected.
- `DISQUALIFIED` and `CONVERTED` are terminal in Prompt 35 (no reactivation).

### Conversion

Two explicit modes, executed inside ONE serializable transaction:

1. **EXISTING_CUSTOMER** — links a same-business, non-deleted customer.
2. **CREATE_CUSTOMER** — creates the customer from lead-derived fields
   (name/phone/email only — the current Customer model has no `companyName`;
   the lead keeps it). Creation passes the existing `CUSTOMERS_MAX`
   entitlement gate inside the transaction.

Optional `opportunityTitle` creates ONE opportunity linked to the resulting
customer in the same transaction. Either everything commits or nothing does.

## Opportunity lifecycle & fixed pipeline

Stages (code-defined; no PipelineStage table):

| Stage | Category | Default probability |
|---|---|---|
| DISCOVERY | OPEN | 10 |
| QUALIFIED | OPEN | 25 |
| PROPOSAL | OPEN | 50 |
| NEGOTIATION | OPEN | 75 |
| WON | WON | 100 (forced) |
| LOST | LOST | 0 (forced) |

- Allowed transitions: OPEN→OPEN, OPEN→WON, OPEN→LOST, WON→OPEN (reopen),
  LOST→OPEN. WON↔LOST directly is forbidden.
- **WON requires** a same-business, non-deleted customer; `probabilityPct`
  forced to 100; `wonAt` stamped; `lostReason` cleared.
- **LOST requires** a reason (≤1000 chars); probability forced 0; `lostAt`
  stamped.
- Reopening clears `wonAt`/`lostAt`/`lostReason` and resets probability to the
  stage default unless an explicit valid value is supplied in the same call.
- Stage changes go through `POST /api/v1/crm/opportunities/[id]/stage` ONLY —
  the generic PATCH cannot change stage.
- Probability is an integer 0–100 for OPEN stages (150/−10/NaN/decimals all
  rejected server-side).

## Expected value & weighted pipeline (§12/§35)

- `expectedValueMinor` is an integer FORECAST in minor units, captured in the
  business currency at creation and never converted afterward.
- Weighted value = `expectedValueMinor × probabilityPct / 100` — exact integer
  arithmetic, computed server-side (summary) and per-detail.
- UI labels always say **Expected value / Weighted pipeline / Forecast** —
  never "Revenue", "Income", or "Sales". The summary endpoint's values never
  enter sales/receivables/reports/AI metrics (statically scanned + E2E-tested).

## CRM dashboard (`#/crm`)

- Tabs: `Leads` (`#/crm?tab=leads`), `Pipeline`
  (`#/crm?tab=pipeline`), `Opportunities` (`#/crm?tab=opportunities`).
- Bare `#/crm` and unknown `?tab=` values fall back to **pipeline** (the
  documented deterministic default).
- Summary strip: Open pipeline · Weighted pipeline · Won/Lost counts · Leads
  (all CRM forecast metrics).
- Pipeline board: six fixed columns; OPEN columns show count + Σ expected
  value; below md the board becomes an intentional horizontal scroll area
  (six columns are never squeezed into 360px). Stage changes use the explicit
  Move Stage dialog (no fake drag-and-drop).

## Customer 360 integration

The customer detail page shows a **CRM pipeline** section BELOW the financial
summary (separate heading — receivables vs potential sales are never visually
mixed): open-opportunity count, up to 10 recent opportunities (click →
`#/opportunities/<id>`), and the converting lead origin when the customer came
from a lead. The financial cards (Total Sales / Paid / Receivable / Invoices)
are unchanged.

## Global search integration

Search covers 8 entity types now. LEAD fields: name, companyName, phone,
email, sourceDetail (notes are secondary-only, never titles). OPPORTUNITY
fields: title, description, customer.name, lead.name. Results deep-link
through the closed map (`SEARCH_TYPE_TO_ENTITY`) to `#/leads/<id>` /
`#/opportunities/<id>`; the API's `destination` string is never trusted for
navigation. No query logging, no search history.

## Current limitations (honest)

- Fixed pipeline only — no custom stages/pipelines.
- No CRM activities/tasks/reminders/call or email tracking.
- No AI lead scoring or forecasting; CRM is not in the AI Copilot snapshot.
- No external integrations (email/WhatsApp/Telegram/telephony).
- No CRM import (export only) — see `docs/data/data-import.md`.
- No CRM notification types; no CRM plan gating (NOT CONFIGURED).
- Recent-lists in details are bounded windows (≤10); full history lives in
  the lists.
