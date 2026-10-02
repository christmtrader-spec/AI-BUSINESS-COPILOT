# CRM Activities & Tasks — Security Reference (Prompt 36)

**Status:** Shipped · **Companion:** `docs/product/crm-activities-tasks.md` · `docs/security/crm-security.md` (Prompt 35 base)

## 1. Tenant isolation

- `businessId` comes **only** from the server auth context
  (`getAuthContext()` → verified membership). Body/query tenant params are
  never read.
- Every activity/task query filters `businessId` + `deletedAt: null`.
- Foreign-tenant and soft-deleted records resolve to **404** — existence
  never leaks across tenants (identical to Prompt 35 semantics).

## 2. RBAC

- Read paths (lists, detail, timeline, work queue): `data:read`.
- Write paths (create/update/status/delete): `data:write`.
- No new permission was introduced; VIEWER-class roles stay read-only.

## 3. Context validation (§8/§9/§70)

- Exactly one of `customerId` / `leadId` / `opportunityId` — zero or two →
  422. The closed `contextType` switch maps to explicit model lookups; no
  arbitrary Prisma field construction from client input.
- The referenced record must belong to the caller's business and be
  soft-alive → otherwise 422 at write time, 404 at read time.
- Context is immutable after creation (PATCH rejects by schema).

## 4. Assignee validation (§10/§69)

`assignedToUserId` must be a member of the CURRENT business (checked through
`BusinessMember`, the same membership authority as Prompt 35). Platform
users, other-business users and non-members → 422. Work-queue requests for
another user's queue perform the same membership check.

## 5. Server-authoritative state machine (§13)

- Status transitions validate against the closed map; anything else → 422
  `INVALID_STATUS_TRANSITION`.
- `completedAt` is server-stamped (`now()` on COMPLETED) and server-cleared
  (null on any non-completed status). Client clocks are never trusted.

## 6. DTO minimization (§79 discipline)

- All responses map through explicit allowlist DTOs; raw Prisma rows are
  never serialized (no `businessId`, no internal flags).
- Work-queue rows carry exactly: id/title/priority/status/dueAt/assignee/
  contextType/contextId/contextTitle.
- Create/POST endpoints return detail DTOs, not raw rows.

## 7. Privacy (§59/§74/§75/§76)

- **Descriptions are never logged** — not in audit payloads, not in server
  logs. They may contain emails/phones/private notes.
- Audit payloads (`crm.activity.create|update|delete`,
  `crm.task.create|update|status_change|delete`) carry metadata only:
  type, title, occurredAt/dueAt/durationMinutes, status, priority,
  assignee id, context identifiers. No bodies, no descriptions, no tokens,
  no session/MFA data, no AI-cost data.
- Classification: **CONFIDENTIAL BUSINESS DATA** (potential personal data
  when activities/tasks reference natural persons). No marketing tracking,
  no analytics history, no hidden profiling.

## 8. Deletion behavior (§61/§104/§126)

| Event | Effect |
|---|---|
| Activity/task delete (UI) | Soft delete (`deletedAt`) — disappears from timeline/list/queue/export-active; audit remains |
| Business deletion | Cascade (both tables reference Business `onDelete: Cascade`) |
| User account deletion | Created-by links are `Restrict` (rows are tenant history; the P18 account-deletion gate applies as for other creator links — documented in the deletion matrix); assignee link is `SetNull` |
| Customer/Lead/Opportunity deletion | `SetNull` on the context column at DB level; normal UI soft-delete simply hides rows from active timelines (no cascade of history) |

## 9. Boundaries kept

- No AuditLog-as-timeline (audit and timeline remain separate records).
- No notification types added; no scheduler/reminders/fake crons.
- No AI grounding of CRM text; Global Search unchanged (no ACTIVITY/TASK
  search types).
- Financial non-interference: no Prompt 36 path touches Sale, Expense,
  Payment, Receivable, Payable, Inventory or reports; verified by
  before/after financial snapshot equality in the E2E harness.

## 10. Static verification

`scripts/crm-activity-task-static-scan.mjs` enforces 21 invariants (tenant
scoping, closed vocabularies, no raw rows, no unbounded `findMany`, no raw
SQL, no description logging, no password/MFA/AI-cost/notification leakage,
no AuditLog-as-timeline, no fake reminder schedulers, no
`dangerouslySetInnerHTML`, no arbitrary redirects). Expected: 0 failures.
