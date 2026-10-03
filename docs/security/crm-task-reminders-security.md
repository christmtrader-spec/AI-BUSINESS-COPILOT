# CRM Task Reminders — Security

**Prompt 37 · Status: IMPLEMENTED + FINALIZED (Prompt 37-F).** Security posture of the CRM task assignment notifications, reminder configuration and the scheduled reminder processor.

## 1. Tenant isolation

- Task reads/writes ride the existing Prompt 36 tenant scoping: `businessId` is derived from the authenticated session's active membership, NEVER from the request body/query (§90; the reminder-summary and reminder-scoped processor follow the same law).
- The processor's optional `--business-id` scope is a LOCAL OPERATOR flag: validated against `^[a-zA-Z0-9_-]{6,64}$`, injected into the WHERE clause as a typed value (no raw SQL), and it does NOT authorize anything — the CLI has database-level authority because it runs on the node itself (§197).
- A business-scoped run can never create notifications for another business's users: candidates are selected by `businessId` and the recipient is the row's own `assignedToUserId` (verified E2E §124).
- Cross-tenant assignment stays rejected: assigning a task to a user without an active membership in the CURRENT business is 422 (§22/§124).

## 2. Recipient authority

- The notification recipient is ALWAYS `task.assignedToUserId`, read server-side from the domain row (§10/§198). There is no code path that accepts a recipient email, user id or phone from the request body, the query, the CLI arguments or the browser for reminder delivery (§198/§199).
- Email addresses are resolved exclusively by the Notification Service from `User.email`; CRM code never touches SMTP (§56/§199).
- Self-assignment and unchanged-assignment updates never notify (§32/§33/§34).

## 3. RBAC

- Reminder configuration rides the task create/patch endpoints: `data:write` required (§90). VIEWER-class members are read-only.
- `GET /api/v1/crm/tasks/reminder-summary` requires `data:read` (§91).
- There is no `/api/v1/reminders` write API and no public scheduler endpoint (§91/§158/§171).

## 4. Scheduler execution model

- The processor is an EXTERNAL, operator-managed process (`scripts/process-crm-task-reminders.mjs`) invoked by cron/systemd/Windows Task Scheduler. The application runtime contains no timer, no loop, no hidden page scheduler (§2/§97 — enforced by `crm-reminder-static-scan` rules 1–3/18).
- DRY RUN (default) performs zero notification writes; even the duplicate estimate is a read-only existence check (§66/§166).
- APPLY may only write Notification/Delivery rows through the platform's `notifyFailSafe()`; task rows are read-only in the processor (§167/§168 — scan rule 20).
- No distributed locks, no Redis/queue primitives, no leases — single-node honesty (§73/§74 — scan rule 19).

## 5. Notification data minimization

Per-type strict schemas (Prompt 32 §23 machinery + Prompt 37 §17–§19):

- ALLOWED: taskId (bounded safe-id regex), taskTitle ≤160, priority (closed enum), contextType (closed enum), contextTitle ≤160, dueAt (ISO instant), businessTimezone ≤64, reminderMinutesBefore (closed offset values).
- FORBIDDEN (rejected at persistence AND by static scan): task description, phone/email/address/contact fields, financial values, AI data, security data, passwords/tokens/MFA/session keys (defense-in-depth sanitizer + scan rules 11–14).
- The business NAME is not embedded — the Notification Center resolves it from `businessId` at read time (§47).
- sourceEventId composition uses ONLY stable server identifiers (task id, dueAt/updatedAt ISO, assignee id, a fixed type marker). Titles/descriptions/contexts are never part of an id (§169 — scan rule 15).

## 6. Logging hygiene

- The processor logs counts/mode/limits only (`crm.reminder.processor.completed`), never titles, context names, emails or notification bodies (§69/§170).
- The CLI prints the same safe counters; errors are logged as error NAMES, not payloads (§66/§68).
- **Prompt 37-F hardening (§10/§11/§47):** the per-row `CRM_REMINDER_DEBUG` dump (task ids, business ids, dueAt, offsets, assignment state) was REPLACED by strictly safe aggregate metadata — `{ debug: "crm-task-reminders", phase: "candidate-scan", dueSoonScanned, overdueScanned, max, mode }`. Static scan rules 21–26 pin this: no per-task ids, business ids, dueAt values, per-task offsets or assignee ids in ANY console/structured log line, and no debug-mode bypass of the policy. Verified dynamically by the §46/§47 E2E checks (fixture ids/titles/emails never appear in captured CLI output, with and without `CRM_REMINDER_DEBUG=1`).

## 6b. Defensive re-checks and race safety (Prompt 37-F, §16–§20/§31–§36)

- **Reminder path:** before every notification the processor re-reads the task's current minimal state (`id, businessId, status, deletedAt, dueAt, assignedToUserId, reminderEnabled, reminderMinutesBefore, overdueAlertEnabled` — never the description) and skips unless the task is still active (OPEN/IN_PROGRESS), still live (`deletedAt = null`), still assigned to the SAME user, still due at the SAME instant and still configured (§31–§34). The pure predicates live in `src/lib/crm/task-reminder-safety.ts` and are unit-tested against every race.
- **Context liveness (§36/§17):** the context row is re-read DIRECTLY with `deletedAt: null` + business scope (`src/lib/crm/task-context-read.ts`) — a soft-deleted/foreign context (which a relation include would NOT exclude) skips the notification. There is NO `CUSTOMER`/`""` fallback anywhere.
- **Assignment path:** the post-commit helper (`notifyAssignmentSafe`) is awaited by the task service (deterministic completion, §14/§15) and re-verifies before sending: same business, not soft-deleted, current assignee STILL equals the intended recipient (a concurrent reassignment B→C can never notify B, §20) and the context still resolvable (§17/§18). A skipped attempt logs only a SAFE category (`crm.assignment.notify_skipped` with a reason word — no ids, no titles).
- **Concurrent processor idempotency (§23–§25):** overlapping runs dedupe on the Notification unique index — proven with REAL concurrent CLI processes on the same due-soon and overdue candidates (exactly ONE row each). This is duplicate safety, NOT distributed scheduling: single-node scheduler ownership remains the deployment model (§70/§73/§74).
- **Notification failure isolation (§37):** a `null` outcome counts as `failed` and the run continues; no retry with a fresh sourceEventId, no task mutation.

## 7. Template + email safety

- In-app rendering produces plain strings (client renders text nodes, never HTML); email HTML escapes every interpolated value (`taskTitle`, `contextTitle`) — verified by the catalog injection probe (§104/§140).
- Emails are built from trusted configuration (APP_BASE_URL/NEXTAUTH_URL), never the request Host (§41 law inherited from Prompt 32).
- FA emails preserve `dir="rtl"`; no hardcoded LTR (§103).

## 8. Timezone integrity

`businessTimezone` originates from `Business.timezone` (server-side, §21); the renderer validates the IANA zone and falls back to UTC without throwing (§22). Static scan rule 16 pins the action route to the closed `crmTasks` catalog key — an `actionRoute` can never come from a task payload (§105).

## 9. Failure containment

- `notifyFailSafe()` wraps every notification write: a failure is logged and swallowed; task create/update/assignment commit is never rolled back (§36/§129).
- Email failures keep the IN_APP notification; delivery rows follow the platform state machine; no second retry layer is introduced for reminders (§82/§83/§130).
- Per-candidate errors increment `failed` and continue; systemic DB failures exit nonzero so an operator's cron log shows the truth (§67/§68).

## 10. Static verification

- `scripts/crm-reminder-static-scan.mjs` — 26 rules (§97 + Prompt 37-F safe-logging rules 21–26), all green.
- `scripts/crm-activity-task-static-scan.mjs` — 21 rules incl. the updated scheduler-allowlist rule (§98), all green.
- `scripts/notification-static-scan.mjs` — 28 checks incl. the Prompt 37 CRM rules (§99), all green.
- `scripts/notification-catalog-check.mjs` — 453/453 including the three CRM entries (§100/§142).
