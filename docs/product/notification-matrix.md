# Notification Matrix — Prompt 32 Catalog Reference

> One row per type in the closed 19-type catalog
> (`src/lib/notifications/catalog.ts`). Values are copied from the catalog:
> channel policy (`channels`), priority, severity, `mandatory`,
> `preferenceAvailable`, and `emailDefaultEnabled` (shown as the effective
> EMAIL default). Source and dedupe strings mirror the catalog's `source` and
> `dedupe` fields (documented event source §434, dedupe semantics §29/§30).
>
> **EMAIL column reading:** `ALWAYS`/`IF_ENABLED` is the catalog policy; the
> parenthetical is the effective default when the user has no explicit
> preference row. `NEVER` = the email channel is not part of the type.
> **Mandatory** = at least one channel is ALWAYS-delivered and preferences
> cannot disable it (true for all 19 types — IN_APP is ALWAYS everywhere).
> **Preference** = whether the optional channels are user-controllable
> (`preferenceAvailable`).

| Type | Category | Priority | Severity | IN_APP | EMAIL | Mandatory | Preference | Source Event | Dedupe Key | Data Sensitivity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `SECURITY_PASSWORD_CHANGED` | SECURITY | HIGH | INFO | ALWAYS | ALWAYS (default on) | yes | no | Successful password change — `POST /api/v1/auth/password-change` (§91) | `security:<SecurityEventId>` | Account security metadata (timestamps, device label) — no secrets |
| `SECURITY_PASSWORD_RESET_COMPLETED` | SECURITY | HIGH | INFO | ALWAYS | ALWAYS (default on) | yes | no | Successful reset — `POST /api/v1/auth/password-reset/confirm` (§92) | `security:<SecurityEventId>` | Account security metadata (timestamps, device label) — no secrets |
| `SECURITY_EMAIL_VERIFIED` | SECURITY | NORMAL | SUCCESS | ALWAYS | NEVER | yes | no | Email verification confirm — `POST /api/v1/auth/email-verification/confirm` (in-app only, no redundant email, §95) | `security:<SecurityEventId>` | Account security metadata (timestamps, device label) — no secrets |
| `SECURITY_MFA_ENABLED` | SECURITY | HIGH | SUCCESS | ALWAYS | ALWAYS (default on) | yes | no | MFA setup confirm — `POST /api/v1/me/security/mfa/setup/confirm` (§93) | `security:<SecurityEventId>` | Account security metadata (timestamps, device label) — no secrets |
| `SECURITY_MFA_DISABLED` | SECURITY | CRITICAL | WARNING | ALWAYS | ALWAYS (default on) | yes | no | MFA disable — `POST /api/v1/me/security/mfa/disable` (§94) | `security:<SecurityEventId>` | Account security metadata (timestamps, device label) — no secrets |
| `SECURITY_NEW_LOGIN` | SECURITY | NORMAL | INFO | ALWAYS | IF_ENABLED (default on) | yes | yes | Login completion (safe device label — never IP/geo/session secret, §96) | `login:<UserSessionId>` | Account security metadata (timestamps, device label) — no secrets |
| `SECURITY_SESSIONS_SIGNED_OUT` | SECURITY | NORMAL | INFO | ALWAYS | NEVER | yes | no | Global sign-out — `POST /api/v1/me/security/sessions/revoke-all` (in-app only, avoid noise, §97) | `security:<SecurityEventId>` | Account security metadata (timestamps, device label) — no secrets |
| `BILLING_TRIAL_STARTED` | BILLING | NORMAL | SUCCESS | ALWAYS | IF_ENABLED (default on) | yes | yes | `SubscriptionEvent TRIAL_STARTED` (state transition — never a UI click, §84) | `subscription:<SubscriptionEventId>` | Plan name / amount+currency (minor units) — no operator identity |
| `BILLING_TRIAL_ENDED` | BILLING | NORMAL | INFO | ALWAYS | IF_ENABLED (default on) | yes | yes | `SubscriptionEvent TRIAL_ENDED` / `EXPIRED` (§86) | `subscription:<SubscriptionEventId>` | Plan name / amount+currency (minor units) — no operator identity |
| `BILLING_SUBSCRIPTION_CHANGED` | BILLING | NORMAL | INFO | ALWAYS | IF_ENABLED (default on) | yes | yes | `SubscriptionEvent` PLAN_CHANGED / CANCELED / REACTIVATED / PAUSED / RESUMED / EXPIRED (no operator identity, §90) | `subscription:<SubscriptionEventId>` | Plan name / amount+currency (minor units) — no operator identity |
| `BILLING_PAYMENT_SUCCEEDED` | BILLING | NORMAL | SUCCESS | ALWAYS | IF_ENABLED (default on) | yes | yes | Provider-authoritative payment verification ONLY — never PENDING/RECONCILIATION (§87) | `payment:<CheckoutSessionId>:SUCCEEDED` | Plan name / amount+currency (minor units) — no operator identity |
| `BILLING_PAYMENT_FAILED` | BILLING | HIGH | ERROR | ALWAYS | IF_ENABLED (default on) | yes | yes | Provider-reported genuine failure — reason never fabricated (§88) | `payment:<CheckoutSessionId>:FAILED` | Plan name / amount+currency (minor units) — no operator identity |
| `AI_USAGE_LIMIT_NEAR` | AI | NORMAL | WARNING | ALWAYS | IF_ENABLED (default on) | yes | yes | UsageService meter crossing the configured near-limit percent (no provider cost, §81) | `usage:<businessId>:<periodEnd>:AI_MESSAGES:NEAR` — one per usage period (§83) | Usage counts and period boundary — never provider cost/rate/margin |
| `AI_USAGE_LIMIT_REACHED` | AI | HIGH | WARNING | ALWAYS | IF_ENABLED (default on) | yes | yes | UsageService counter reaching the plan quota (safe usage info only, §82) | `usage:<businessId>:<periodEnd>:AI_MESSAGES:REACHED` — one per usage period (§83) | Usage counts and period boundary — never provider cost/rate/margin |
| `BUSINESS_EXPORT_COMPLETED` | BUSINESS | LOW | SUCCESS | ALWAYS | IF_ENABLED (default on) | yes | yes | `DataExportJob` COMPLETED — after file + checksum verification (§100/§328) | `export:<DataExportJobId>` | Dataset names and summary counts — no file paths or raw rows |
| `BUSINESS_EXPORT_FAILED` | BUSINESS | NORMAL | ERROR | ALWAYS | IF_ENABLED (default on) | yes | yes | `DataExportJob` FAILED (stable safe failure code only, §101/§330) | `export:<DataExportJobId>` | Dataset names and summary counts — no file paths or raw rows |
| `BUSINESS_IMPORT_COMPLETED` | BUSINESS | NORMAL | SUCCESS | ALWAYS | IF_ENABLED (default on) | yes | yes | `DataImportJob` COMPLETED — after DB commit (§98/§329) | `import:<DataImportJobId>` | Dataset names and summary counts — no file paths or raw rows |
| `BUSINESS_IMPORT_FAILED` | BUSINESS | NORMAL | ERROR | ALWAYS | IF_ENABLED (default on) | yes | yes | `DataImportJob` FAILED (safe failure summary, §99/§330) | `import:<DataImportJobId>` | Dataset names and summary counts — no file paths or raw rows |
| `SYSTEM_ANNOUNCEMENT` | SYSTEM | LOW | INFO | ALWAYS | IF_ENABLED (default off) | yes | yes | Authorized platform operator service ONLY — no customer-controlled creation (§154/§155) | `announcement:<operatorMessageId>` | Operator-authored announcement text (plain text, ≤500 chars) |

Notes:

- Every notification also commits an IN_APP delivery row (status SENT) in the
  creating transaction, and — except for the two EMAIL NEVER types — an EMAIL
  delivery row (PENDING when it will dispatch, SKIPPED with a normalized
  reason otherwise) so each channel decision is auditable.
- Mandatory security email reaches the account address even when unverified
  (documented policy §49-equivalent); optional email requires a verified
  address.
- Ephemeral expiry (`expiresAfterDays`): SECURITY_NEW_LOGIN and
  SECURITY_SESSIONS_SIGNED_OUT 30 days; AI alerts 60 days; BUSINESS job
  outcomes 30 days; BUSINESS_CRM_TASK_DUE_SOON 7 days;
  BUSINESS_CRM_TASK_OVERDUE 14 days; BUSINESS_CRM_TASK_ASSIGNED 30 days;
  SYSTEM_ANNOUNCEMENT 90 days; all other SECURITY and
  BILLING types never expire (null).

## CRM task notifications (Prompt 37)

Three types complete the first REAL scheduled automation (assignment =
event-driven; due-soon/overdue = time-driven via the operator-scheduled
processor `scripts/process-crm-task-reminders.mjs`):

- `BUSINESS_CRM_TASK_ASSIGNED` (NORMAL/INFO, expiry 30d) — task created with
  or reassigned to another user; self-assignment never notifies.
- `BUSINESS_CRM_TASK_DUE_SOON` (HIGH/WARNING, expiry 7d) — one per
  (task, dueAt, assignee) inside the configured reminder window.
- `BUSINESS_CRM_TASK_OVERDUE` (HIGH/WARNING, expiry 14d) — one per
  (task, dueAt, assignee) once due; WARNING severity, never ERROR.

All three: category BUSINESS, IN_APP ALWAYS, EMAIL IF_ENABLED,
preferenceAvailable, actionRoute `crmTasks` → `#/crm?tab=tasks`. Full
semantics: `docs/product/crm-task-reminders.md`.

## Unmapped events

Real product events that deliberately have NO notification type (documented
in the catalog header, not omissions):

- **`SubscriptionEvent CREATED`** — every business creation would emit a
  notification; excluded as noise avoidance (`event-mappers.ts`).
- **`BILLING_TRIAL_ENDING`** — no scheduler/background worker exists, so a
  request-time reminder cannot be built honestly (§85 of the spec).
- **`BILLING_PAYMENT_REQUIRES_ACTION` / `RECONCILIATION_REQUIRED`** —
  platform-internal states with no customer-visible product surface; never
  tenant-visible (§89).
- **AI cost events (`AI_COST_*`, e.g. AI_COST_UNKNOWN /
  AI_COST_GOVERNANCE_WARNING)** — provider cost is platform data; tenant-visible
  cost notifications are prohibited (§80). The AI category communicates usage
  counts only.
- **Single-session revocation** (`SECURITY_SESSION_REVOKED`) — noise
  avoidance is the documented policy (§97); global sign-out is covered by
  `SECURITY_SESSIONS_SIGNED_OUT`.
- **Platform audit events** — operator/platform activity is recorded in
  `PlatformAuditLog` and is never surfaced as tenant notifications.

## Delivery record retention

NotificationDelivery rows **cascade with their notification**
(`onDelete: Cascade` on `NotificationDelivery.notification`); they have no
independent lifetime or cleanup path. Delivery history therefore equals the
notification's operational lifetime — including the 90/365-day operational
retention applied by `scripts/prune-expired-notifications.mjs` (deliveries are
removed together with the notification row they belong to).
