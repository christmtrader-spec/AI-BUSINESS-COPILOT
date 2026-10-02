# CRM Activities & Tasks — Product Reference (Prompt 36)

**Status:** Shipped (Prompt 36) · **Companion:** `docs/security/crm-activities-tasks-security.md` · `docs/adr/0036-crm-activities-and-tasks.md`

## 1. What shipped

Prompt 36 adds the CRM operational layer on top of Prompt 35's foundation:

| Capability | Where |
|---|---|
| Activities — historical interactions (Note / Call / Email / Meeting / Other) | Timeline cards on customer / lead / opportunity detail |
| Tasks — future/current actions (Open → In progress → Completed/Canceled, reopen) | Timeline + Tasks cards, CRM **Tasks** tab work queue |
| Work queue — "what do I need to do?" buckets (Overdue / Due today / Upcoming / No due date) | `#/crm?tab=tasks` (tab list: leads · pipeline · opportunities · tasks) |
| Work-queue summary counts (My open / Overdue / Due today) | Separate **Work queue** card on `#/crm` — never mixed with money cards |
| Unified CRM timeline (activities + active tasks, newest first) | Entity detail pages |

## 2. Semantics

- **Activity ≠ AuditLog.** An activity is a business interaction the user
  records on purpose. AuditLog stays the security/mutation history — the two
  are never merged (the timeline never renders audit rows).
- **Activity ≠ system event.** There is no `SYSTEM` activity type. Stage
  changes, conversions and WON events create **no** automatic activities,
  tasks, notifications or sales (§106 of the prompt spec).
- **Task ≠ Notification ≠ CalendarEvent.** Tasks store `dueAt` for
  classification only.
- **Type/status/priority vocabularies are closed:**
  `NOTE CALL EMAIL MEETING OTHER` · `OPEN IN_PROGRESS COMPLETED CANCELED` ·
  `LOW NORMAL HIGH URGENT`. No custom values.

## 3. Context rules (exactly one)

Every activity and task is anchored to **exactly one** of Customer / Lead /
Opportunity. Zero or multiple contexts → rejected (422). The referenced
record must live in the caller's business and be soft-alive; context is
**immutable** after creation (wrong entity → delete + re-create). When a
dialog is opened from an entity page the context is preselected and locked;
from the work queue a context selector is required.

## 4. Task lifecycle

```
OPEN → IN_PROGRESS | COMPLETED | CANCELED
IN_PROGRESS → COMPLETED | OPEN | CANCELED
COMPLETED → OPEN | CANCELED          (reopen clears completedAt)
CANCELED → OPEN | COMPLETED
```

- Completion stamps `completedAt = now` (server clock).
- Reopening/canceling clears `completedAt`.
- Status changes ride `POST /api/v1/crm/tasks/[id]/status` — the generic
  PATCH can never set status.
- The server validates every transition (422 `INVALID_STATUS_TRANSITION`).

## 5. Work queue

- Server-driven classification: **overdue** = due instant passed (server
  clock, UTC) · **today** = same calendar day in the **business timezone** ·
  **upcoming** · **unscheduled** (no dueAt). The browser clock is never used.
- Order inside buckets: priority (URGENT→LOW) → dueAt asc → createdAt asc → id.
- Hard cap 50 rows. Default scope = the calling user's assigned tasks;
  another member's queue requires membership in the same business.
- Counts (`myOpenTaskCount`, `myOverdueTaskCount`, `myDueTodayCount`) are
  server-computed and rendered in their own card, separate from pipeline money.

## 6. Timeline

`GET /api/v1/crm/timeline?contextType=&contextId=` merges activities
(ordered by `occurredAt`) and active tasks (ordered by `createdAt`),
newest first with an `id` tie-break. **Bounded candidate window:** at most
50 rows per source are fetched, merged in application code and paginated
(default 25). Deliberately excludes AuditLog, security events, notification
deliveries and financial records.

## 7. What is explicitly NOT implemented

| Capability | Status |
|---|---|
| Scheduled reminder delivery (email/push/SMS/calendar) | **NOT IMPLEMENTED** — a due task is only surfaced in the queue/lists; no scheduler exists, no fake cron/`setInterval` loops |
| Task/activity notifications (`TASK_DUE`, …) | **NOT IMPLEMENTED** — Prompt 32 platform unchanged |
| AI grounding of activity/task text | **NOT IMPLEMENTED** — descriptions never enter the AI snapshot |
| Global Search for tasks/activities | **NOT IMPLEMENTED** — descriptions may hold private operational context; SearchType vocabulary unchanged |
| CRM import (activities/tasks) | **NOT IMPLEMENTED** (see `docs/data/data-import.md`) |
| Task dependencies / recurring tasks / custom statuses | NOT IMPLEMENTED (out of scope) |

## 8. Timezone semantics

Activity `occurredAt` and task `dueAt` are true UTC instants (NOT the
date-only rule of Prompt 35). Forms pick a wall clock in the **business
timezone** and convert deterministically to UTC; all display goes through
`fmtDateTime` which renders in the business timezone regardless of the
device.
