# ADR 0036 — CRM Activities and Tasks (Prompt 36)

- **Status:** Accepted (implemented, Prompt 36)
- **Date:** 2026-10-02
- **Deciders:** Product/engineering (Z.ai Code session)
- **Supersedes:** nothing (additive to ADR 0035 — its history is untouched)

## 1. Context

Prompt 35 shipped the CRM foundation (leads, opportunities, fixed pipeline,
conversion, dashboard). Tenants could track *potential* revenue but had no
place to record the operational history around a deal (calls, notes,
meetings) or the follow-up work it generates (call the customer, prepare the
proposal). Prompt 36 adds that operational context **without** touching the
accounting core or the Prompt 35 entities' semantics.

## 2. Decision

Activities (`CrmActivity`) and tasks (`CrmTask`) are **first-class,
tenant-scoped CRM records** — not JSON blobs, not audit rows, not
notifications:

1. Two dedicated SQLite tables via ONE purely-additive migration
   (`20261002081507_prompt36_crm_activities_tasks`: 2 CREATE TABLE + 16
   CREATE INDEX; zero drops, zero data backfill).
2. Closed vocabularies enforced in code (`NOTE/CALL/EMAIL/MEETING/OTHER`,
   `OPEN/IN_PROGRESS/COMPLETED/CANCELED`, `LOW/NORMAL/HIGH/URGENT`) with a
   server-authoritative task state machine.
3. Exactly-one context anchor (customer XOR lead XOR opportunity), validated
   same-business at write time, immutable after creation.
4. Work queue buckets classified **server-side** (overdue / today /
   upcoming / unscheduled) using the server clock and the business timezone.
5. Unified timeline built from a bounded candidate window (≤50 per source)
   merged in application code — Prisma-only, no raw SQL.

## 3. Alternatives considered

| Alternative | Why rejected |
|---|---|
| Embed activities in Lead/Opportunity JSON columns | Loses queryability, pagination, per-type indexes, tenant-safe filtering and export fidelity |
| Use AuditLog as the timeline | AuditLog is the security/change history with different retention, semantics and privacy guarantees; merging them corrupts both |
| External task provider (SaaS) | Violates the architecture (no new external dependency; readiness §141 requires none) and leaks tenant data |
| Event bus / automation engine | Unnecessary for a bounded, single-tenant-scope feature; adds moving parts without a requirement |
| Client-side bucket classification | Browser clock/locale are not authoritative; server computes buckets + counts |

## 4. Consequences

**Positive:** follow-up work becomes visible per entity and per user; the
CRM dashboard gains an honest work-queue summary; timeline semantics stay
clean (context immutable, audit separate); export/portability coverage
extends automatically through the Prompt 31 catalog.

**Trade-offs / costs:** two new tables to mirror in export/privacy docs;
timeline is a bounded recent window (documented — not full history);
assignments and contexts re-validate on every write (one extra query).

## 5. Scope guardrails (kept)

- No reminder delivery of any kind (no scheduler, no fake cron/`setInterval`,
  no page-load "send reminder"). `dueAt` is classification-only.
- No new notification types; Prompt 32 unchanged.
- No AI grounding of activity/task text; AI Copilot snapshot unchanged.
- No Global Search expansion (descriptions may hold private operational
  context); `SearchType` vocabulary unchanged.
- No CRM import for the new datasets (documented).
- No financial interference: no Prompt 36 path writes to Sale/Expense/
  Payment/Receivable/Payable/Inventory/reports; WON still creates no Sale.

## 6. Future (explicitly deferred)

Scheduled reminders (with a real scheduler architecture), notification types
for task due/assigned, calendar integrations, safe CRM AI grounding, and a
reconsideration of Global Search inclusion for tasks/activities.
