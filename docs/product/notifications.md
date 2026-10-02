# Notifications — Product Reference

> Prompt 32 · Unified Notification Platform.
> Status: **IMPLEMENTED** — describes the shipped behavior of the in-app
> notification center, the transactional email channel, and notification
> preferences. Security properties: `docs/security/notification-security.md`;
> the full 22-type catalog with per-type policy:
> `docs/product/notification-matrix.md`.

## 1. What the notification platform is

A unified, user-facing record of activity that already happened elsewhere in
the product, delivered through two channels:

- **In-app notification center** — the bell in the app shell plus a full page
  at `#/notifications`. Persisting the notification row IS the in-app
  delivery; it is always created for every notification type.
- **Transactional email** — a summary of the same event via the existing
  Prompt 29 SMTP abstraction (best-effort; see §4).

Five categories: **Security** (account/security state changes), **Billing**
(trial, subscription, payment outcomes), **AI** (usage-limit thresholds),
**Business** (export/import job outcomes), **System** (operator
announcements). The closed catalog has exactly 22 types (Prompt 37 adds the three BUSINESS_CRM_TASK_* types); users cannot create,
forward, or reply to notifications, and nothing in a notification mutates
product state — it summarizes and links to the relevant screen.

## 2. Notification center

- **Bell** (app shell): shows the unread count as a badge, visually capped at
  **99+** (the API always returns the exact count). The count is polled
  conservatively every **45 seconds** and paused while the tab is hidden
  (refetch resumes on window focus). There is no websocket/live push.
- **Recent drawer**: the bell opens a compact panel with the **10 most
  recent** active notifications, a "Mark all read" action, "View all", and a
  shortcut to notification settings.
- **Full page `#/notifications`**:
  - Filters: **All / Unread / Security / Billing / AI / Business / System**
    (allowlisted; server-validated).
  - Date grouping: **Today / Yesterday / Earlier**, localized (EN/FA).
  - Per-item actions: **mark read**, **mark unread**, **archive**; page-level
    **mark all read**.
  - Ordering: newest first, with a stable secondary key; lazy "Load more".
  - Pagination: **20 per page** by default (API default), server maximum
    **100** (`NOTIFICATION_MAX_PAGE_SIZE`).
- **Archive is a UX state, never deletion**: archived items disappear from
  the active list and unread counts but the record persists for its
  documented retention period (90/365 days operational cleanup — see the
  matrix doc). There is no "delete notification" control.
- Clicking a notification marks it read (fire-and-forget, never blocks
  navigation) and navigates to the type's linked screen (Security settings,
  Billing, Data portability, or Dashboard). The destination re-authorizes;
  the click grants nothing.
- Severity is conveyed by icon + text (never color alone); unread state uses
  dot + bold + aria labels; the whole surface is keyboard accessible.

## 3. Preferences (`#/settings/notifications`)

- **Per-category, per-channel controls**: each of the 22 types is listed
  under its category with its available channels (IN_APP and/or EMAIL).
  IN_APP is always on; where EMAIL is user-controllable, a switch writes one
  explicit preference row (type + channel + enabled).
- **Mandatory security channels are shown locked — "Always enabled"** with an
  explanatory note. The server rejects disabling them with
  `NOTIFICATION_PREFERENCE_FORBIDDEN` (403) regardless of the UI.
- **There is no single "disable email" switch** (deliberate, §158): email
  control is per-type so security communication can never be silently muted
  wholesale.
- Types whose email channel does not exist (e.g. email-verified confirmation
  and global sign-out are in-app only) show no email control; types with an
  optional email channel have a documented default (on, except System
  announcements — see the matrix).
- Changing a preference affects only FUTURE notifications.

## 4. Email channel

- **Best-effort transactional email** via the Prompt 29 SMTP abstraction —
  the same transport, TLS policy, and timeout contract as password-reset
  mail. No separate notification SMTP system exists.
- **Optional emails are sent only to verified addresses**; if the account
  address is unverified, the email is skipped (`RECIPIENT_UNVERIFIED`) and
  the in-app notification still exists. Mandatory security emails are
  delivered to the account address even when unverified, by documented
  policy, and ignore preferences.
- **Locale** comes from the user's profile (EN fallback); **Persian emails
  render RTL** (`dir="rtl"`), English LTR. Every interpolated value is
  HTML-escaped; emails summarize and link into the app — they never contain
  secrets, OTPs, tokens, or reset links, and there are no tracking pixels.
- A failed email never removes the in-app notification. Failed optional
  emails can be retried only by platform operators (never by users); the
  per-delivery attempt cap is `NOTIFICATION_EMAIL_MAX_ATTEMPTS` (default 3).

## 5. Event coverage (22 catalog types)

Full per-type policy (channels, priority, severity, defaults, dedupe keys,
data sensitivity): `docs/product/notification-matrix.md`. Trigger sources:

| Type | Trigger source |
| --- | --- |
| `SECURITY_PASSWORD_CHANGED` | Successful password change (`POST /api/v1/auth/password-change`) |
| `SECURITY_PASSWORD_RESET_COMPLETED` | Successful password reset confirm (`POST /api/v1/auth/password-reset/confirm`) |
| `SECURITY_EMAIL_VERIFIED` | Email verification confirm (in-app only — no redundant email) |
| `SECURITY_MFA_ENABLED` | MFA setup confirm |
| `SECURITY_MFA_DISABLED` | MFA disable (password + MFA + typed confirmation) |
| `SECURITY_NEW_LOGIN` | Sign-in completion (safe device label only — no IP/geo) |
| `SECURITY_SESSIONS_SIGNED_OUT` | Global "sign out all sessions" (in-app only, low noise) |
| `BILLING_TRIAL_STARTED` | `SubscriptionEvent TRIAL_STARTED` (state transition — never a UI click) |
| `BILLING_TRIAL_ENDED` | `SubscriptionEvent TRIAL_ENDED` / `EXPIRED` |
| `BILLING_SUBSCRIPTION_CHANGED` | `SubscriptionEvent` PLAN_CHANGED / CANCELED / REACTIVATED / PAUSED / RESUMED / EXPIRED |
| `BILLING_PAYMENT_SUCCEEDED` | Provider-authoritative payment verification only (never PENDING/RECONCILIATION) |
| `BILLING_PAYMENT_FAILED` | Provider-reported genuine failure (reason never fabricated) |
| `AI_USAGE_LIMIT_NEAR` | Usage meter crossing the configured near-limit percent (one per usage period) |
| `AI_USAGE_LIMIT_REACHED` | Usage counter reaching the plan quota (one per usage period) |
| `BUSINESS_EXPORT_COMPLETED` | Data export job COMPLETED (after file + checksum verification) |
| `BUSINESS_EXPORT_FAILED` | Data export job FAILED (stable safe failure code only) |
| `BUSINESS_IMPORT_COMPLETED` | Data import job COMPLETED (after DB commit) |
| `BUSINESS_IMPORT_FAILED` | Data import job FAILED (safe failure summary) |
| `BUSINESS_CRM_TASK_ASSIGNED` | CRM task created with / reassigned to another user (after commit; self-assignment suppressed — Prompt 37) |
| `BUSINESS_CRM_TASK_DUE_SOON` | Reminder processor (operator-scheduled CLI) within the reminder window; one per task+dueAt+assignee |
| `BUSINESS_CRM_TASK_OVERDUE` | Reminder processor once the task is past due; one per task+dueAt+assignee |
| `SYSTEM_ANNOUNCEMENT` | Authorized platform operator service only — explicit recipients, no audience queries |

Deliberately unmapped events (subscription CREATED, trial-ending reminders,
AI cost events, single-session revocation, platform audit events): see
"Unmapped events" in `docs/product/notification-matrix.md`.

## 6. What Prompt 32 deliberately does NOT include

Stated as implemented — none of the following exists in the product:

- **Marketing/newsletters** — no bulk or commercial messaging; the only
  operator message is the SYSTEM_ANNOUNCEMENT type (plain text, explicit
  recipients, platform-audited).
- **SMS** — channel placeholder only, not implemented.
- **Push / web-push** — no service workers, no push subscriptions.
- **Telegram / WhatsApp** (or any chat-platform bridge) — not implemented.
- **Digests / quiet hours / frequency capping** beyond the documented
  one-per-usage-period AI dedupe — not implemented.
- **Full-text search of notifications** — the list API exposes only the
  allowlisted filters (All/Unread/category/priority/business); no search box.
- **Websocket live push** — the bell polls every 45s (paused while the tab is
  hidden); there is no persistent connection.
- **Background queue/workers** — email dispatch runs on the request path
  immediately after the creating transaction commits, bounded by the Prompt 29
  email timeout; no queue infrastructure exists (single-node law).
- **Open/click analytics** — no tracking pixels or click beacons anywhere.
- Also absent by design: a user-facing "resend this email" control (operator
  retry only), a single global "disable all email" switch, and user-facing
  delivery diagnostics.
