# ADR 0037 — CRM Task Reminders and the Operator-Managed External Scheduler

**Status:** Accepted (Prompt 37) · Finalized (Prompt 37-F)
**Date:** 2026-10-02 · Finalized 2026-10-03
**Supersedes:** the Prompt 36 position "reminders are NOT implemented" (docs/adr/0036 §Non-goals — now realized as this ADR).

## Context

Prompt 36 delivered CRM Tasks with `dueAt` but deliberately no reminder delivery (single-node, SQLite, no background worker). Prompt 37 requires REAL scheduled reminders: task-assignment notifications, one due-soon reminder and one overdue notification per task+dueAt, delivered through the Prompt 32 notification platform (in-app always; optional, preference-controlled, verified-recipient email).

The deployment reality is fixed by the product's documented architecture:

- SQLite (single file), single node, no Redis, no message broker, no external workflow engine.
- No in-process background worker exists — and the request/response lifecycle is the only execution context the Next.js app owns.
- Operators already run maintenance scripts (backups, prunes) from the OS.

## Decision

**The application owns reminder LOGIC; the operating system owns reminder TIMING.**

1. A server-only processor (`src/lib/crm/task-reminder-processor.ts`) implements eligibility, classification, bounding, dedupe and notification creation. It is invoked by `scripts/process-crm-task-reminders.mjs`, which the operator schedules externally (cron / systemd timer / Windows Task Scheduler — every 5 minutes recommended).
2. The CLI defaults to DRY RUN; `--apply` performs writes. No HTTP scheduler endpoint exists; no CRON_SECRET is introduced.
3. Idempotency rests entirely on the existing Notification unique index `(userId, type, sourceEventId)` with deterministic ids (`type-marker:taskId:dueAtISO:assigneeId` — no run timestamp). The Notification row is the reminder history; no reminder-state table exists.
4. Assignment notifications are event-driven inside the task service (after commit, fire-safe); reminder notifications are time-driven inside the processor. The two paths share only the notification platform.

## Consequences

**Positive**

- The runtime stays a plain request/response Next.js app: no timers, no polling, no worker supervision, no new infrastructure, no new failure domain.
- Crash-safety and overlap-safety compose: an overlapping or repeated run dedupes to zero side effects; a missed run self-heals within the configured lookback.
- Deterministic candidate ordering + hard per-run caps keep operational cost flat and small.
- The exact same processor serves tests (injected `now`, per-business scope) and production.

**Negative / honest limitations**

- If the operator does not install the schedule, reminders simply never fire — the app must degrade to "notifications appear when the processor next runs" (documented).
- Multi-node deployments are NOT supported by this design; a central scheduler/lease/queue would be required (deliberately not faked).
- The overdue lookback (default 7 days) bounds rescanning: it is an operational boundary, not a retention policy, and very old overdue tasks silently age out of eligibility.
- Overlap protection is the OS scheduler's responsibility (flock / systemd / Task Scheduler instance policy).

## Rejected alternatives

| Alternative | Why rejected |
| --- | --- |
| In-process timer (setInterval / long-running worker inside Next.js) | Ties scheduling to the app lifecycle; dies/restarts with the dev/prod server; violates the documented no-background-worker architecture; not observable by the operator. |
| Redis + BullMQ / RabbitMQ / Kafka | New mandatory infrastructure for a single-node SQLite product; unjustified operational burden; violates the no-queue law (§4). |
| Postgres-based queue / LISTEN-NOTIFY | Requires a database engine migration for scheduling sugar; same in-process worker problem remains. |
| External automation SaaS (Zapier-like / cron-as-a-service) | Sends tenant data to a third party; contradicts the platform's data-minimization and self-hosting posture. |
| Browser polling / service-worker scheduling | Client clocks are untrusted; tabs close; scheduling must be server-authoritative (§2). |
| Public HTTP "run reminders" endpoint + CRON_SECRET | Widens the attack surface for no benefit when local CLI execution exists (§158/§171). |
| Fake queue table / CrmTaskReminderHistory model | Simulates infrastructure without adding capability; the Notification unique index already provides exactly-once semantics (§174). |

## Future work (explicitly NOT in Prompt 37)

Multiple configurable reminders per task; per-user/per-business defaults; calendar integration; push/SMS; multi-node scheduling with a central lease. All require a new ADR.

## Prompt 37-F finalization — concurrency semantics (§67)

The processor is designed to be **idempotent under overlapping invocations**: the deterministic `(userId, type, sourceEventId)` identity and the Notification unique index collapse duplicate attempts, verified with real concurrent CLI runs (due-soon and overdue each dedupe to exactly ONE notification row). However:

- **Single-node scheduler ownership remains the documented deployment model.** Idempotency is a safety NET, not a distributed-coordination mechanism.
- The **database unique constraint is the final duplicate-protection boundary** — no lease table, no distributed mutex, no Redis, no queue exists or is planned.
- Overlap protection at the OS layer (flock / systemd unit concurrency / Task Scheduler instance policy) is still RECOMMENDED so wasted work is avoided, but correctness never depends on it.
- Multi-node deployments are NOT claimed safe: two nodes scheduling the same database would still dedupe correctly per event, but there is no central ownership, no leader election and no horizontal scaling story. Do not present this design as "distributed safe".
- CLI usage validation (Prompt 37-F §5–§9) happens before the processor import — conflicting/unknown/invalid arguments exit 1 with zero database access, so a misconfigured cron entry can never create a partial or dangerous run.
