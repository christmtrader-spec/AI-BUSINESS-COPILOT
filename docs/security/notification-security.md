# Notification Platform — Security Reference

> Prompt 32 · Unified Notification Platform (in-app center + transactional email).
> Status: **IMPLEMENTED** — this document describes the implementation AS BUILT;
> every claim below maps to source files under `src/lib/notifications/` and the
> notification routes under `src/app/api/v1/me/notifications/**`,
> `src/app/api/v1/me/notification-preferences`, and
> `src/app/api/v1/platform/notifications/**`.

## 1. Scope and boundary

Notifications are a **communication layer derived from domain events — never an
authority layer** (§4/§32 final principle):

- Creating, clicking, reading, archiving or deleting a notification never
  mutates domain state. A click navigates to an internal hash route; the
  destination page re-authorizes the user from the session (§104/§398-§401).
- Notifications cannot grant entitlements, verify an email, reset a password,
  or confirm a payment. Those facts live in their owning domains.
- There is **no public notification-creation endpoint** (§187): customers can
  only list, read/unread, archive, and configure preferences. Creation is
  server-internal (event mappers + the operator announcement service).
- Password reset and email verification remain their own specialized email
  flows (Prompt 29/30, token-bearing links with their own TTLs and rate
  limits). They are **NOT notifications** and never flow through this
  platform (§33/§140).

Implementation source of truth:

| Concern | File |
| --- | --- |
| Closed 19-type catalog + per-type Zod schemas | `src/lib/notifications/catalog.ts` |
| `notify()` pipeline (validate → sanitize → dedupe → persist → dispatch) | `src/lib/notifications/service.ts` |
| Channel decision + email eligibility + flood control | `src/lib/notifications/policies.ts` |
| Preferences (effective map, guarded update) | `src/lib/notifications/preferences.ts` |
| Email dispatcher (claims, attempt cap, stale reaper, retry) | `src/lib/notifications/dispatcher.ts` |
| Channel adapters (in-app + Prompt 29 email transport) | `src/lib/notifications/channels.ts` |
| Rendering (localized text, HTML-escaped email, CTA) | `src/lib/notifications/templates.ts` |
| Data sanitizer + idempotency-key composition | `src/lib/notifications/dedupe.ts` |
| Queries, DTO, read/unread/archive state | `src/lib/notifications/dto.ts` |
| Operational cleanup | `src/lib/notifications/cleanup.ts`, `scripts/prune-expired-notifications.mjs` |
| Configuration (strict bounded integers) | `src/lib/notifications/config.ts` |
| Event mappers (one per real product event) | `src/lib/notifications/event-mappers.ts` |
| Models | `Notification`, `NotificationDelivery`, `NotificationPreference` (Prisma, ON DELETE CASCADE) |

Static verification: `scripts/notification-catalog-check.mjs` (catalog laws +
EN/FA translation completeness) and `scripts/notification-static-scan.mjs`
(no public creation endpoint, no `dangerouslySetInnerHTML`, no request-Host
URLs, no forbidden keys, no direct SMTP from the domain, no payload logging).

## 2. Catalog governance

- The catalog is a **closed 19-type directory** (`NOTIFICATION_TYPES` in
  `src/lib/notifications/catalog.ts`): 7 SECURITY, 5 BILLING, 2 AI,
  4 BUSINESS, 1 SYSTEM. There is no dynamic template registration.
- The client can **never introduce a type**: `Notification.type` is validated
  against the catalog before persistence (unknown → `NOTIFICATION_TYPE_UNKNOWN`,
  422), preference updates resolve the type through the same catalog, and
  request bodies carry no type/priority/severity/category values that reach
  the database (§5/§36/§187/§188).
- Each type carries a **STRICT per-type Zod `dataSchema`** (§23/§24). `notify()`
  validates the data object BEFORE persistence; a notification with missing or
  invalid required data is rejected (`NOTIFICATION_DATA_INVALID`, 422) so a
  malformed email can never be rendered from it (§354). Values are safe
  primitives only — no arbitrary nested objects (§24); unknown keys are
  stripped by the schemas.
- Priority (LOW/NORMAL/HIGH/CRITICAL) and severity (INFO/SUCCESS/WARNING/
  ERROR) are server-decided presentation/urgency vocabulary (§6/§7) — distinct
  axes, both catalog-fixed.

## 3. Tenant/user isolation

- Every `/me/notifications*` query is **ownership-scoped by the session
  userId** (`assertFreshSession`); the request can never carry or target a
  different userId (§19/§183).
- Foreign ids are **404 with no existence leak**: the lookup is
  `findFirst({ id, userId })` — another user's notification id simply does not
  exist (`findOwnedNotification`, §183/§184); id shape is pre-validated
  (`^[a-zA-Z0-9_-]{10,64}$`).
- The **business filter is honored only for businesses the user CURRENTLY
  belongs to**: the route loads the live membership list at read time and the
  query service intersects the filter with it (§197/§198). Business names in
  DTOs are resolved with `members: { some: { userId } }` — a former member
  gets `businessName: null`.
- List/read-state responses are `Cache-Control: private, no-store` (§241);
  `markAllRead` is a single bounded `updateMany` that can never touch another
  user's rows (§55/§301).
- The DTO never exposes `dataJson` internals, delivery rows, or storage keys —
  only id, type/category/priority/severity keys, localized title/body, read
  state, timestamps, a server-generated action route, and a business-context
  NAME summary (§189).

## 4. Secrets exclusion (data sanitizer)

`sanitizeNotificationData` (`src/lib/notifications/dedupe.ts`) is the
defense-in-depth gate applied AFTER per-type schema validation (§25/§26/§346):

- **Forbidden key fragments at ANY depth** (case-insensitive, punctuation
  stripped so `apiKey`, `providerApiKey`, `smtpPassword` all trip):
  `password`, `passwd`, `secret`, `token`, `api_key`, `apikey`,
  `authorization`, `auth`, `cookie`, `otp`, `mfa`, `recoverycode`,
  `recovery_code`, `session`, `reset`, `credential`, `privatekey`,
  `private_key`, `merchant`, `signature`, `authorizationheader`, `bearer`.
- **Forbidden exact keys** whose CONTENT would be prohibited even under an
  innocuous name: `prompt`, `response`, `aiprompt`, `airesponse`, `messages`,
  `cost`, `rate`, `margin`, `providercost`, `ip`, `ipaddress`,
  `ipaddresshash`, `useragent` (AI content, provider cost, and device/network
  identity can never enter notification data, §80/§96).
- Nesting depth > 2 rejected; arrays bounded (≤32 items); only string/number/
  boolean/null values allowed; the serialized payload must fit
  `NOTIFICATION_MAX_DATA_BYTES` (default 32 768 bytes, bounded 1024–262144).
  Any violation throws `NotificationDataViolation` → the notification is
  rejected, never partially stored.

Consequently **security notifications never carry MFA secrets, OTPs, recovery
codes, or reset tokens** — such values do not exist in the security flows'
notification payloads (only timestamps and a coarse device label), and the
sanitizer makes accidental future introduction structurally impossible.
Password-reset links and email-verification links remain token-bearing emails
in their own specialized flows (see §1).

## 5. Action URLs

- Notifications persist a server-generated **allowlisted route key**, never a
  URL: `security | billing | data | usage | notifications | dashboard`
  (`ACTION_ROUTES`, §102/§103). The only mapping to internal hash paths lives
  in `actionRoutePath` / the DTO layer (`security` → `#/settings/security`,
  `billing`/`usage` → `#/settings/billing`, `data` → `#/data`,
  `notifications` → `#/notifications`, `dashboard` → `#/dashboard`).
- The client can never supply an action target: request bodies have no such
  field, and the DTO resolves the route through the allowlist map (unknown
  stored values render as `action: null`).
- The **email CTA is built only from trusted configuration**
  (`APP_BASE_URL` ?? `NEXTAUTH_URL`, `templates.ctaUrl`) — never from the
  request `Host` header or any request input (§41/§42). Only `http:`/`https:`
  URLs are produced; with no base URL configured the email still sends,
  **without a link**, rather than linking somewhere untrusted.

## 6. Email security

- All notification email goes through the **Prompt 29 EmailProvider
  abstraction** (`getEmailProvider()`) — the notifications domain never
  touches SMTP/nodemailer directly (enforced by
  `scripts/notification-static-scan.mjs`, §33/§389). Header safety, TLS
  policy (`EMAIL_SECURE` mandatory true in production, certificate
  verification never disabled), credential handling, and the bounded
  `EMAIL_TIMEOUT_MS` are inherited from that adapter.
- Every interpolated value is **HTML-escaped** (`escapeHtml`, identical
  contract to the Prompt 29 email templates, §287 injection test); the email
  renders `dir="rtl"` for Persian and `dir="ltr"` for English — decided
  server-side from the user's persisted locale, never the browser's guess
  (§39).
- Emails **never contain secrets** (§40) and stay small: they summarize state
  and link into the app (§232/§233). The email body is the localized template;
  the subject is the localized title; a localized footer is appended.
- **No tracking pixels, no open tracking, no click tracking** — the rendered
  HTML contains no remote images, no beacons, and no redirectors (§38/§286;
  see §12 Privacy below).

## 7. Delivery state machine

Per-channel rows (`NotificationDelivery`) implement the fixed state machine
(§32/§142/§143):

```
PENDING → PROCESSING → SENT | FAILED      (EMAIL)
PENDING → CANCELED
FAILED  → PROCESSING   (explicit, bounded operator retry only)
SKIPPED                   (not delivered, with a normalized reason)
SENT is terminal — never back to PROCESSING
```

- The **IN_APP row is the delivery**: persisting the Notification commits an
  IN_APP delivery recorded `SENT` in the same transaction (§34/§73).
- The **EMAIL row always exists** for types whose email policy is not NEVER —
  `PENDING` when it will dispatch, `SKIPPED` with the normalized reason
  (`POLICY_NEVER` / `PREFERENCE_DISABLED` / `RECIPIENT_UNVERIFIED` /
  `FLOOD_LIMIT`) otherwise — so every channel decision is auditable (§32/§142).
- Dispatch happens strictly AFTER the creating transaction commits (§74/§358):
  there is never an "email sent but row rolled back" state.
- The PENDING → PROCESSING claim is an **atomic guarded update**
  (`updateMany` conditioned on `status: "PENDING"`), so two processes can
  never double-send one delivery (§145).
- **Stale recovery**: a delivery stuck in PROCESSING longer than
  `NOTIFICATION_STALE_DELIVERY_MINUTES` (default 30, bounded 5–1440) is marked
  FAILED with `STALE_PROCESSING` — **never auto-resent** (no provider-level
  exactly-once exists, §146/§147/§360). Reaping runs opportunistically when
  the platform diagnostics endpoint is viewed (§308).
- **Attempt cap**: `NOTIFICATION_EMAIL_MAX_ATTEMPTS` (default 3, bounded
  1–10). A claim beyond the cap is terminal FAILED `ATTEMPTS_EXHAUSTED` with an
  operational log (§45/§361).
- Failures are normalized into the fixed vocabulary `SMTP_CONFIG`,
  `SMTP_TIMEOUT`, `SMTP_AUTH`, `SMTP_CONNECTION`, `TEMPLATE`,
  `INVALID_RECIPIENT`, `ATTEMPTS_EXHAUSTED`, `STALE_PROCESSING`,
  `RECIPIENT_UNVERIFIED`, `UNKNOWN` (§263) — raw SMTP output is never stored.

## 8. Mandatory vs optional policy

Resolution order (§10/§11/§14/§17/§18): catalog channel policy first —

- `ALWAYS` → deliver; user preferences are IGNORED (mandatory);
- `NEVER` → the channel is not part of this type;
- `IF_ENABLED` → the user's explicit preference row, else the catalog default
  (`emailDefaultEnabled`).

- Every catalog type has `IN_APP: ALWAYS` — the in-app record is mandatory for
  all 19 types; `mandatory: true` is a derived invariant (validated by
  `scripts/notification-catalog-check.mjs`).
- **Mandatory security emails ignore user preferences** and, per the
  documented policy (§49-equivalent), **reach the account's address even when
  it is not verified** — the address IS the login identity and security state
  changes must reach the account holder.
- **OPTIONAL (IF_ENABLED) email is sent only to VERIFIED addresses**
  (§48/§49); otherwise the delivery is recorded SKIPPED
  `RECIPIENT_UNVERIFIED`. The recipient address is always resolved
  server-side from `User.email` — never from a request (§48).
- Mandatory channels reject preference updates with
  `NOTIFICATION_PREFERENCE_FORBIDDEN` (403) — the service layer, not the UI,
  is the enforcement point (§62).
- **Flood control** (§246/§321): when a user already has
  `NOTIFICATION_ACTIVE_DELIVERY_LIMIT` (default 100, bounded 10–1000) PENDING
  email deliveries, OPTIONAL emails are skipped (`FLOOD_LIMIT`); the in-app
  record is always created and mandatory security email bypasses the cap.

## 9. Deduplication / idempotency

- The database enforces `@@unique([userId, type, sourceEventId])` (§28/§30).
  A Prisma `P2002` violation resolves to `{ duplicate: true }` — an API or
  domain retry can never flood the user with copies of one logical event.
- `sourceEventId` is a **server-generated semantic key** composed from DURABLE
  server identifiers (event row ids, session ids, checkout session ids,
  business + usage-period boundaries) — never timestamps alone, never
  client-generated strings (§29/§333). `composeSourceEventId` strips
  everything outside `[a-zA-Z0-9._:-]` and bounds the result to 300 chars.
- **AI alerts are one-per-usage-period**: the key embeds
  `<businessId>:<periodEnd>:AI_MESSAGES:(NEAR|REACHED)`, so at most one NEAR
  and one REACHED notification exist per business per usage period (§83).
- NULL `sourceEventId` rows are non-deduplicable by design (SQLite NULL
  semantics); the service always sets one for event-derived types (§30).

## 10. Rate limits (per user, sliding window, process-local)

| Endpoint | Limit |
| --- | --- |
| `GET /api/v1/me/notifications` (list) | 60/min |
| `GET /api/v1/me/notifications/unread-count` | 120/min |
| `POST /api/v1/me/notifications/[id]/read` | 120/min |
| `POST /api/v1/me/notifications/[id]/unread` | 60/min |
| `POST /api/v1/me/notifications/[id]/archive` | 60/min |
| `POST /api/v1/me/notifications/read-all` | 30/min |
| `GET`/`PUT /api/v1/me/notification-preferences` | 30/min each |

All endpoints require a fresh session (`assertFreshSession`) and return 429
with `retryAfterMs` when exhausted. As everywhere in this app, the limiter is
an in-process sliding window (single-node law, runbook §6).

## 11. Logging law & failure safety

**Logging law (§131/§132/§133):** notification log events carry ONLY safe
operational fields — `notificationId`, `deliveryId`, `type`, `channel`,
`status`, `failureCode`, `durationMs`, `requestId` (plus a `count` for the
stale reaper and an error NAME for dispatch/mapper failures).
**NEVER logged:** `dataJson`, any notification payload, rendered email
text/HTML, or raw SMTP transcripts. The logger's recursive redaction and
bounding apply on top; the static scan asserts no payload logging in the
domain (§132/§133/§310). See `docs/security/observability-and-logging.md`
§12b for the event list.

**Failure safety (§72/§136/§137/§139):**

- Domain call sites use `notifyFailSafe` exclusively: any notification failure
  is caught, logged (`notification.create_failed`), and swallowed — a failed
  notification can **never roll back** the domain mutation that produced it
  (a sale, a password change, a subscription update).
- Notification creation and its delivery rows commit in ONE transaction
  before any send; email dispatch is fire-safe and never throws into the
  domain path.
- An **email failure leaves the in-app notification intact** (it was already
  committed SENT) — channel failures are independent by construction.

## 12. Privacy

- **No open/click analytics**: no tracking pixels, no open tracking, no click
  beacons, no third-party loaders in notification emails or the in-app center
  (§38/§286). Delivery evidence is first-party only.
- **Delivery rows are internal**: the tenant DTO exposes no delivery state,
  attempt counts, or failure codes; `providerMessageId` is never
  tenant-visible (§47/§189) and the current EmailProvider contract returns
  void, so it stays null until a future adapter surfaces one.
- Localized text is never persisted — rows store translation KEYS plus the
  schema-validated data object; text is rendered at read time in the user's
  locale (§192/§193).
- Rows are deleted with the user (cascade), business-scoped rows with the
  business, and inactive rows by the operational retention script
  (`docs/legal/data-deletion-matrix.md`, `docs/legal/data-retention-inventory.md`).

## 13. Platform boundary

- **Diagnostics are read-only** under `platform:system:read`
  (`GET /api/v1/platform/notifications`): delivery counts by status, top
  failed TYPES, catalog/template health, email-transport readiness, and the
  retention setting. NO message bodies, NO provider details, NO storage paths
  (§257/§259/§262). Viewing diagnostics opportunistically reaps stale
  PROCESSING rows — which only MARKS them FAILED and never resends (§365).
- **Retry** (`POST /api/v1/platform/notifications/deliveries/[deliveryId]/retry`)
  requires `PLATFORM_SUPER_ADMIN` or `PLATFORM_SUPPORT` and is permitted ONLY
  for FAILED email deliveries whose catalog type has an OPTIONAL
  (preference-controlled) email channel. **Mandatory security emails can never
  be resent through retry** (`MANDATORY_CHANNEL` rejection) — no reset link,
  MFA code, or recovery code can ever flow through a notification retry
  (§260/§261). The attempt cap still applies (`ATTEMPTS_EXHAUSTED`); the
  re-queued delivery goes through the standard atomic claim so the attempt
  counter stays authoritative. Every retry is platform-audited.
- **SYSTEM_ANNOUNCEMENT creation is platform-only**
  (`POST /api/v1/platform/notifications/announcements`,
  `PLATFORM_SUPER_ADMIN`/`PLATFORM_SUPPORT`): EXPLICIT recipient user ids only
  (max 50 per call) — never an audience query (§155); the message is bounded
  plain text (≤500 chars) that flows through the per-type schema and
  sanitizer gates; no HTML, no markdown (§153). Platform-audited with
  recipient counts only, never message content.
- Customers have no path into any of the above: the static scan asserts no
  tenant route mutates deliveries and no public creation endpoint exists
  (§186/§187/§396).

## 14. Known limitations (honest)

- **Single-node semantics**: the atomic claim prevents concurrent double-send
  on the one deployment; the rate limiter and the flood counter are
  process-local memory (runbook §5/§6).
- **Provider message ids are not captured**: the current EmailProvider
  contract returns void, so `providerMessageId` stays null (§47).
- **No background queue/workers**: email dispatch is request-path (after
  commit), bounded by the Prompt 29 `EMAIL_TIMEOUT_MS`; a process crash after
  commit but before dispatch leaves a PENDING row that is never auto-sent —
  it will eventually be claimed by a retry or reaped by the stale detector
  into FAILED `STALE_PROCESSING`.
- **Operator surface is API-only**: the platform notification
  diagnostics/retry/announcement endpoints exist; the Platform System console
  does not yet render a notification section.
- **Retry duplicates are possible by design** when an operator retries a
  failed OPTIONAL email (documented risk, §260/§262).
