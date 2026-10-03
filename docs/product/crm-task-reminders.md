# CRM Task Reminders + Scheduled Notification Processor

**Prompt 37 · Status: IMPLEMENTED + FINALIZED (Prompt 37-F) · Real scheduled CRM automation, operator-managed scheduling.**

CRM Tasks can now generate REAL notifications:

1. **Task assigned** — event-driven, immediate, when a task is created with or reassigned to another user.
2. **Task due soon** — ONE reminder per task+dueAt, sent by a scheduled processor inside the configured window before the due instant.
3. **Task overdue** — ONE notification per task+dueAt once the due instant has passed.

Everything else about a CRM Task (state machine, exactly-one context, assignee validation, soft delete, audit) is unchanged from Prompt 36.

**Prompt 37-F hardening (final behavior):**

- **Strict CLI (§5–§9):** `--apply --dry-run` is rejected with exit 1 BEFORE the processor import, before any database access and before any write-capable operation. Unknown flags exit 1. `--business-id=` values are validated immediately against the same safe ID law as the processor (`^[a-zA-Z0-9_-]{6,64}$`). `--max=` is strict: non-numeric or outside 10–500 exits 1 (never a silently clamped dangerous workload). Duplicate boolean flags are accepted idempotently; duplicate value flags take the LAST occurrence (deterministic, documented).
- **Safe logging law (§10/§11):** the former per-row `CRM_REMINDER_DEBUG` dump was replaced by strictly safe aggregate metadata — `{ debug: "crm-task-reminders", phase: "candidate-scan", dueSoonScanned, overdueScanned, max, mode }` — no task ids, business ids, dueAt values, offsets, assignee ids or titles. Logs carry only job/mode/runId/timestamps/counts/error categories. Enforced by `crm-reminder-static-scan` rules 21–26 plus dedicated unit + E2E checks (§46/§47).
- **Defensive re-check before every notification (§31–§36):** between the candidate scan and the notify step the processor re-reads the task's CURRENT minimal state (no description) and skips when the task was completed, canceled, soft-deleted, reassigned, rescheduled or reconfigured meanwhile, or when its context row no longer exists in the same business (a soft-deleted CUSTOMER/LEAD/OPPORTUNITY context can never produce a notification — the context is re-read directly with a `deletedAt` filter, never defaulted to `CUSTOMER`/`""`).
- **Assignment notification reliability (§13–§20):** the post-commit helper is now awaited by the task service (deterministic request completion) while remaining fire-safe — a notification failure never rolls back the committed task mutation. Before sending, the helper reloads the committed task and verifies: same business, not soft-deleted, the current assignee STILL equals the intended recipient (a concurrent reassignment B→C can never notify B) and the context is still resolvable. The recipient remains server-authoritative `task.assignedToUserId` (§19).
- **Concurrency (§23–§25):** overlapping processor runs are duplicate-safe by construction — verified with REAL concurrent CLI invocations on the same due-soon and overdue candidates (exactly ONE notification row each). The unique `(userId, type, sourceEventId)` index remains the final boundary; no reminder-history table, no Redis, no queue, no distributed lock.

---

## 1. Reminder configuration (per task)

`CrmTask` carries three tenant business-data fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `reminderEnabled` | Boolean, default `false` | ONE due-soon notification for the CURRENT `dueAt` value |
| `reminderMinutesBefore` | Int, nullable | Offset before `dueAt`; MUST be one of the closed values below |
| `overdueAlertEnabled` | Boolean, default `false` | ONE overdue notification for the CURRENT `dueAt` value |

**Closed offset vocabulary (§7):** `5, 10, 15, 30, 60, 120, 240, 1440, 2880, 10080` minutes (5 min → 7 days). Arbitrary integers are rejected by the API schema AND re-validated server-side.

**Consistency laws (server-authoritative, §8):**

- `reminderEnabled = false` ⇒ `reminderMinutesBefore` must be null.
- `reminderEnabled = true` ⇒ `dueAt` must exist and the offset must be in the vocabulary.
- `overdueAlertEnabled = true` ⇒ `dueAt` must exist.
- `dueAt` becomes null ⇒ the server automatically resets all three fields.
- A PATCH without reminder fields keeps the stored configuration (backward compatible, §163/§164).

**NOT implemented** (deliberate, §175/§176): recurring reminders, multiple reminders per task, per-user or per-business default offsets, daily overdue spam. One due-soon + one overdue notification per `(task, dueAt)` is the entire model.

## 2. Assignment notification

- Fires on `createTask()` when another user is assigned (never on self-assignment), and on `updateTask()` when the assignee CHANGES to a different, non-actor user (§34/§35).
- Recipient is ALWAYS the server-resolved `task.assignedToUserId` — never owner/admins/creator unless they are the assignee (§10/§198).
- Fired strictly AFTER the DB commit via `notifyFailSafe()`; a notification failure NEVER rolls back the task (§36).
- Changing title/description/priority/dueAt/reminder settings never triggers it (§33).

## 3. The reminder processor

`src/lib/crm/task-reminder-processor.ts` — `processCrmTaskReminders(options)`:

- **Input:** `{ now?, businessId?, dryRun?, maxTasks? }` — `now` is injectable for tests (§182); production uses the server clock.
- **Output:** `{ mode, scanned, dueSoonCandidates, overdueCandidates, created, duplicates, skipped, failed }` — no task text, no emails (§39/§69).
- **Due-soon rule (§75):** `now >= dueAt - reminderMinutesBefore` AND `now < dueAt`, active statuses (OPEN/IN_PROGRESS) only, assignee required.
- **Overdue rule (§75):** `now >= dueAt`, same eligibility. A task is never due-soon AND overdue in the same run — the windows are disjoint (§76/§119).
- **Determinism:** queries ordered `dueAt asc, id asc`; merged runs order `businessId asc → dueAt asc → id asc` (§195/§196).
- **Idempotency:** notification identity = `(userId, type, sourceEventId)` with `sourceEventId = crm-task-due-soon|crm-task-overdue : taskId : dueAtISO : assigneeUserId` — NO run timestamp (§25/§27/§28/§180/§181). Repeated runs dedupe on the existing Notification unique index; the Notification row IS the reminder history (no `CrmTaskReminderHistory` model, §174).
- **dueAt change ⇒ new logical reminder** (§29/§120): the new instant creates a new identity; historical notifications remain.
- **Never mutates tasks** (§167/§168): no status change, no reassignment, no reminder toggles — notification-only.
- **Error isolation (§67/§68):** one bad candidate increments `failed` and the run continues; systemic DB failure propagates (nonzero exit).

## 4. Scheduler = EXTERNAL process (the architectural decision)

The application owns eligibility, dedupe, idempotency, notification creation and delivery semantics. The OPERATING SYSTEM owns when the processor starts. There is **no in-process scheduler** — no setInterval/setTimeout, no request-time polling, no queue, no Redis, no worker process (§2/§4).

The repository ships `scripts/process-crm-task-reminders.mjs`:

```bash
bun scripts/process-crm-task-reminders.mjs                    # DRY RUN (default — no writes)
bun scripts/process-crm-task-reminders.mjs --dry-run          # explicit dry run
bun scripts/process-crm-task-reminders.mjs --apply            # create notifications
bun scripts/process-crm-task-reminders.mjs --apply --business-id=<id> --max=100
```

**CLI contract (Prompt 37-F §5–§9):** `--apply --dry-run` → exit 1 before ANY processing (zero DB access); unknown flags → exit 1; `--business-id=` validated immediately (`^[a-zA-Z0-9_-]{6,64}$`); `--max=` is a strict decimal integer within 10–500 (never silently clamped). Duplicate boolean flags are accepted idempotently; duplicate value flags take the last occurrence. Usage validation always precedes the processor import.

**EXAMPLES ONLY — OPERATOR-MANAGED — NEVER AUTO-INSTALLED:**

- **Linux cron (every 5 minutes, §70):**
  ```
  */5 * * * * app cd /srv/my-project && bun scripts/process-crm-task-reminders.mjs --apply >> /var/log/aibc-crm-reminders.log 2>&1
  ```
- **systemd timer (§71):** `aibc-crm-reminders.service` (ExecStart=bun scripts/process-crm-task-reminders.mjs --apply) + `aibc-crm-reminders.timer` (`OnUnitInactiveSec=5min`); systemd prevents overlapping runs of the same unit.
- **Windows Task Scheduler (§72):** every 5 minutes, program `bun.exe`, arguments `scripts/process-crm-task-reminders.mjs --apply`, working directory = project root, "Do not start a new instance".
- **Overlap protection** is the scheduler's job (`flock`, systemd concurrency, Task Scheduler instance policy — §73). The processor stays idempotent regardless: the Notification unique index dedupes.
- There is **NO public HTTP scheduler endpoint** and **NO CRON_SECRET** — the CLI talks to the database locally (§158/§171).

## 5. Operational limits

| Setting | Default | Range | Meaning |
| --- | --- | --- | --- |
| `CRM_REMINDER_MAX_PER_RUN` | 100 | 10–500 | Max notification attempts per run; remaining candidates stay eligible for the next run (§40) |
| `CRM_REMINDER_OVERDUE_LOOKBACK_HOURS` | 168 (= 7 days) | 1–720 | Only overdue tasks with `dueAt >= now - lookback` are scanned. This is an OPERATIONAL scanning boundary, **not** a legal retention policy (§41) |

Due-soon scanning horizon = 7 days = the maximum offset (§42/§43). If the scheduler is down, no notifications fire until the next run; eligibility resumes subject to the current time, the reminder offset and the overdue lookback — arbitrary old missed reminders are NOT replayed (§191/§192).

## 6. Notification catalog entries (§24)

| Type | Priority | Severity | IN_APP | EMAIL | Expires after | CTA |
| --- | --- | --- | --- | --- | --- | --- |
| `BUSINESS_CRM_TASK_ASSIGNED` | NORMAL | INFO | ALWAYS | IF_ENABLED | 30 days | `#/crm?tab=tasks` |
| `BUSINESS_CRM_TASK_DUE_SOON` | HIGH | WARNING | ALWAYS | IF_ENABLED | 7 days | `#/crm?tab=tasks` |
| `BUSINESS_CRM_TASK_OVERDUE` | HIGH | WARNING | ALWAYS | IF_ENABLED | 14 days | `#/crm?tab=tasks` |

All three: category BUSINESS, mandatory, `preferenceAvailable = true`, `emailDefaultEnabled = true` — the existing Notification Preferences screen exposes their EMAIL toggles automatically (no new preference model, §16/§57). Overdue uses WARNING, never ERROR — being late is not an error (§14). Noise types (`COMPLETED/UPDATED/DELETED/REOPENED`) are deliberately absent (§12).

**Data schema (strict, §17/§18/§19):** taskId (bounded safe id), taskTitle (≤160), priority (closed enum), contextType (CUSTOMER|LEAD|OPPORTUNITY), contextTitle (≤160), dueAt (ISO, nullable only for ASSIGNED), businessTimezone (≤64), plus `reminderMinutesBefore` for DUE_SOON. **No** task description, no contact details, no financial/AI/security data, no business name (resolved from `businessId` by the Notification Center, §47).

## 7. Timezone correctness

`businessTimezone` comes from `Business.timezone` server-side — never the browser, request header or client body (§21). Notification rendering formats `dueAt` in the stored business timezone via `Intl.DateTimeFormat` (DST-correct, no manual offset math); an invalid timezone falls back safely to UTC and never throws (§22). Timestamps are stored UTC; language/number formatting follows the user locale (Persian numerals in FA), while the wall-clock time stays in the business timezone (§102). Email preserves `dir="rtl"` for Persian (§103) and HTML-escapes every interpolated value (§104).

## 8. Channels

- **IN_APP:** always created (the persisted row IS the in-app delivery).
- **EMAIL:** follows the user preference; optional emails require a verified recipient; the existing optional-email flood cap stays authoritative (§15/§84/§85/§172).
- Email dispatch is downstream of the persisted Notification row: an email failure never removes the in-app notification and never recreates it (§81/§82). The existing `NotificationDelivery` retry and `prune-expired-notifications.mjs` cleanup remain the only delivery/cleanup implementations (§83/§173).

## 9. UI

- **Task form:** "Reminders" section — due-reminder switch, offset select (localized labels), overdue-alert switch. Without a due date all reminder controls are disabled with "Set a due date to enable reminders."; clearing the due date disables them immediately. The server re-validates everything (§58/§59).
- **Task detail:** Reminder ("1 hour before" / "No due reminder") + Overdue alert (On/Off) — no internal codes (§61/§109).
- **Work queue:** small bell badge with an accessible label ("Reminder configured") when any reminder is configured (icon + text, never color alone, §62).
- **CRM dashboard Work Queue card:** "Upcoming reminders (24h)" — tasks with reminder windows opening within 24h; a configuration count, never a notification count (§63).
- `GET /api/v1/crm/tasks/reminder-summary` returns `{ dueSoonEnabledCount, overdueAlertsEnabledCount, dueSoonNext24hCount }` (§64).
- **Notification Preferences (Prompt 37-F):** the Settings screen lists all three CRM task types under the Business section — IN_APP shown as "Always enabled" (mandatory), EMAIL as the preference-controlled toggle (§52/§54). Toggling EMAIL off persists server-side and future reminders keep their IN_APP delivery while EMAIL is skipped (verified E2E §84).
- Clicking the notification CTA opens the EXISTING `#/crm?tab=tasks` workspace — no new page, no task deep-link (§23/§88/§89).

## 10. Data portability

The `crm_tasks` export includes `reminderEnabled`, `reminderMinutesBefore`, `overdueAlertEnabled` (JSON + CSV). Task reminder import remains NOT IMPLEMENTED (§151/§152).

## 11. Limitations (honest)

- **Single-node scheduling.** Multi-node requires a central scheduler/lease/queue after a database architecture change (§74).
- **Scheduler down ⇒ no reminders fire** until the next run; the app stays fully healthy (§191).
- **One reminder + one overdue alert per dueAt** — no recurring or multiple reminders (§175).
- **No calendar integration, no push/SMS, no recurring tasks, no CRM import** (§205).
- The overdue lookback is a scanning boundary, not retention.
