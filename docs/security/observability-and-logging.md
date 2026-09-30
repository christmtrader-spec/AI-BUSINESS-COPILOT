# Observability & Logging (AI Business Copilot)

**Document ID:** SEC-OBS-v1
**Phase:** Prompt 29 §169 (created)
**Basis:** `src/lib/observability/logger.ts`, `src/lib/observability/request-id.ts`,
`src/lib/observability/events.ts`, `src/lib/observability/readiness.ts`,
`src/lib/api-helpers.ts`, `src/lib/db.ts`, `src/lib/email/*`,
`src/instrumentation-node.ts`, `next.config.ts`.
**Companions:** `docs/security/incident-response.md` (correlation in incidents) ·
`docs/deployment/production-operations.md` (runbook) ·
`docs/security/platform-admin-security.md` (durable platform audit).

---

## 1. Contract in one paragraph (Prompt 29 §169)

Every API response carries a canonical `X-Request-ID`; the server logs are
plain JSON lines on stdout/stderr with a fixed event vocabulary, recursive
secret redaction, and bounded size; production logs never contain full AI
prompts/responses, raw webhook bodies, credentials, or stack traces (unless
deliberately opted in); durable history lives in database audit tables while
stdout is transient diagnostics. There is no logging vendor, no agent, and
no metrics pipeline — the stdout JSON contract is the entire observability
surface (§174), and no external monitoring vendor has been added.

## 2. Request ID standard (Prompt 29 §24/§25)

- Header: **`X-Request-ID`**. A client-supplied value is honored ONLY when it
  is 8–64 chars of `[A-Za-z0-9._-]` (no whitespace, no control characters,
  no path separators — no header-injection surface). Anything malformed is
  **replaced by a server-generated UUID** (§134). Missing header → UUID.
- The canonical ID is memoized per request and **echoed on every API
  response** (route wrapper in `src/lib/api-helpers.ts`; `/api/health` and
  `/api/ready` echo it too). The same ID appears in every structured log
  line emitted while handling that request.
- Proxy note: Caddy does not need to generate IDs; the app owns the contract.
  Preserve the header through the proxy so upstream clients can correlate.

## 3. Structured logger (`src/lib/observability/logger.ts`)

- **Format:** one JSON object per line — `ts` (ISO), `level`, `service`
  (`ai-business-copilot`), `env`, then the event name and metadata. Errors go
  to stderr, everything else to stdout. No colors, no multiline records.
- **Levels:** `debug | info | warn | error`. `LOG_LEVEL` overrides the
  default; default is **INFO in production, DEBUG in development**.
- Enforcement lives in the logger, not at call sites, so redaction and
  bounding cannot drift.

## 4. Secret redaction (Prompt 29 §33/§34)

Key-based redaction is **recursive** — a key matching (case-insensitive) any
of: `password`, `passwd`, `secret`, `token`, `apikey`/`api_key`/`api-key`,
`authorization`, `cookie`/`set-cookie`, `database_url`, `nextauth_secret`,
`email_server_password`, `merchant`, `credential`, `private_key`,
`client_secret` — is replaced with `[REDACTED]` at every nesting depth.

Bounding (§34) — the whole metadata payload is capped (8 KB serialized):

| Bound | Behavior |
|---|---|
| String > 512 chars | value **DROPPED**, replaced by `[STRING_DROPPED length=N]` — never sliced (a slice could keep a sensitive suffix) |
| Depth > 4 | replaced by `[DEPTH_LIMIT]` |
| Arrays > 20 items | first 20 + `[+N more items]` |
| Objects > 40 keys | first 40 + `[truncatedKeys]` |
| Metadata over byte budget | values collapsed to type markers; final fallback = event name + `METADATA_DROPPED_SIZE_LIMIT` note |

Error objects serialize as `name` + `message` (+ `stack` only when allowed,
§8 below).

## 5. Operational event catalog (Prompt 29 §80–§83)

Fixed vocabulary in `src/lib/observability/events.ts`; server code logs only
these names and client input can never introduce one. Honest status: the
catalog is the enforced vocabulary (locked by `scripts/prompt29-unit.ts`);
emission sites exist today for the events marked ✅ below — the others are
catalog-reserved names for their domains, and where they will be emitted is
noted. No event name is ever fabricated outside this list.

| Event | Meaning | Emission today |
|---|---|---|
| `api.request.failed` | unhandled/expected API failure with requestId, route, method, status, code, error class, duration | ✅ API wrapper |
| `api.request.rate_limited` | a rate limiter rejected a request | ✅ rate limiter + reset route |
| `auth.login.failed` / `auth.login.success` | sign-in outcomes | catalog-reserved (auth domain) |
| `auth.password_reset.requested` | reset requested (uniform — never asserts account existence) | ✅ reset route |
| `auth.password_reset.sent` | reset email delivered (token persisted after this) | ✅ reset route |
| `auth.password_reset.failed` | transport unavailable or delivery failed (safe fields only) | ✅ reset route |
| `billing.payment.verification_failed` | payment verification failure (safe fields only, §7) | catalog-reserved (billing domain) |
| `billing.subscription.transition_failed` | subscription state transition failure | catalog-reserved (billing domain) |
| `ai.request.failed` | AI request failure (safe fields only, §6) | catalog-reserved (AI domain) |
| `ai.cost.attribution_failed` | cost attribution could not complete honestly | catalog-reserved (AI cost domain) |
| `database.connection.failed` | database unreachable (e.g. from readiness) | ✅ readiness |
| `database.migration_state_changed` | migration state changed | catalog-reserved (migration tooling) |
| `backup.created` | a backup was created | catalog-reserved (backup tooling logs plainly today) |
| `backup.verification_failed` | backup verification failed | catalog-reserved (verify tooling) |
| `restore.drill.failed` | restore drill FAIL | catalog-reserved (drill tooling) |

### Error classes (§83)

`validation` · `authentication` · `authorization` · `rate_limit` ·
`not_found` · `conflict` · `dependency` · `database` · `provider` ·
`timeout` · `internal` — mapped from HTTP status by `classifyStatus()`
(400/402/422→validation, 401→authentication, 403→authorization, 404→
not_found, 409→conflict, 429→rate_limit, 503/504→dependency, ≥500→internal).
No internal detail leaves the server; the class is the coarsest safe label.

## 6. AI log safety

AI requests are NEVER logged with their payload. The full prompt, the model
response, and business context (snapshot contents, business names beyond the
id, user question text) never appear in any log line. Safe fields only:

`requestId`, `businessId`, `provider`, `model` (provider-reported or
UNKNOWN — never invented), `tokenStatus`, `costStatus`, duration, success.

This matches the AI boundary law (`docs/security/trust-model.md` §5): what
crosses the provider seam is logged only as shape/outcome, never content.
Cost figures likewise never enter logs — they live in the AI cost ledger
(`docs/ai/ai-cost-architecture.md`).

## 7. Payment log safety

Payment webhooks and verification paths never log the raw webhook body,
signature secrets, merchant credentials, or provider keys. Safe fields only:

`provider`, `checkoutId`, `providerRef`, `status`, reason code, `requestId`.

Merchant ids are redacted by the logger's key rules anyway (`merchant`),
but the payment code path must not place secrets into log metadata in the
first place. No raw provider payloads are persisted to stdout — durable
payment facts live in the billing models, auditable through the platform
audit trail.

## 8. Log levels for expected vs unexpected (Prompt 29 §85)

- **Expected 4xx stay quiet:** 401/403/404 are NOT logged at ERROR — they
  are visible via domain audit trails and aggregate counters. 4xx validation
  problems log at DEBUG.
- **5xx-mapped ApiErrors** (e.g. honest 503 dependency states) log at WARN
  with the full safe field set.
- **Unhandled 500** logs at ERROR via `api.request.failed` — with
  `errorName` and a bounded `errorMessage` (≤300 chars), never the request
  body, never parameters.
- **Stack traces in production exist ONLY with `SECURE_SERVER_DIAGNOSTICS=true`**
  explicitly set (§28). Default production logs are stackless; development
  always includes stacks. Rotate the flag off after diagnosing.

## 9. Prisma logging (Prompt 29 §30)

Production Prisma client logs **warn + error only**. The query stream is a
development convenience (dev = `query` + warn + error) and is deliberately
absent in production: it would flood stdout on a single-node deployment and
risks emitting SQL parameters containing user-controlled or sensitive values.

## 10. Durable audit vs transient stdout (Prompt 29 §82)

| Layer | Store | Lifetime | Purpose |
|---|---|---|---|
| Durable audit | `AuditLog` / `PlatformAuditLog` (+ `SubscriptionEvent`, billing events) | DB rows, append-only | compliance-grade history: actor, action, entity, before/after, IP, user-agent |
| Transient diagnostics | stdout JSON lines (this document) | whatever the operator's log retention keeps | incident correlation, failure triage — may be lost on rotation |

The structured event writer never writes to the database; the audit writers
never depend on stdout. Losing logs does not lose audit history; losing the
DB does not retroactively erase what logs captured. Retention of durable
audit rows is a legal/operational decision tracked separately
(`docs/legal/data-retention-inventory.md`) — stdout retention is the
operator's log-rotation policy (runbook §9).

## 11. Incident correlation how-to

1. Get the `X-Request-ID` from the user's report, the browser network panel,
   or a support ticket (every response has it).
2. Search the structured logs for that ID — all lines of that request carry
   it:

   ```bash
   grep -F '"requestId":"<ID>"' server.log
   ```

3. Classify with the error class + event name, then widen: same `route`
   around the same `ts` window; check `auth.*` events for credential
   incidents and `api.request.rate_limited` for abuse patterns.
4. Pair stdout findings with durable audit rows (actor/IP/before-after) from
   the audit tables — the runbook's incident phases describe the full loop
   (`docs/security/incident-response.md`).

Redaction guarantee for incident handling: what you paste into a ticket from
these logs is safe by construction — secret-shaped keys are `[REDACTED]`,
oversized strings are dropped (not sliced), and stacks are absent unless
`SECURE_SERVER_DIAGNOSTICS=true` was deliberately enabled.

## 12. Email observability fields (Prompt 29 §19)

Email lifecycle events carry ONLY: `operation` (e.g. `password_reset.send`),
`provider` (`smtp` | `console` | `test-memory`), **masked recipient**
(`a***b@domain.tld` via `maskAddress`), `requestId`, `durationMs`,
`errorCode` (safe class such as `SMTP_TIMEOUT` / `SMTP_AUTH_FAILED` /
`SMTP_CONNECTION_FAILED` / `SMTP_DELIVERY_FAILED`). NEVER logged: the reset
URL, the raw token, the SMTP password, or full SMTP transcript details.
(Development console transport prints the reset link by design and is
gated to non-production.)

## 12b. Notification log events (Prompt 32 §131–§133)

The notification platform emits its own structured operational events from
`src/lib/notifications/*` (`service.ts`, `dispatcher.ts`, `event-mappers.ts`):

| Event | Meaning | Safe fields |
|---|---|---|
| `notification.created` | a notification (and its delivery rows) committed | `notificationId`, `type`, `requestId` |
| `notification.create_failed` | creation/validation failed inside `notifyFailSafe` — logged and swallowed, never propagated to the domain | `type`, `code` (stable error code), `error` (error NAME only) |
| `notification.delivery.sent` | one EMAIL delivery reached SENT | `deliveryId`, `notificationId`, `type`, `status`, `durationMs`, `requestId` |
| `notification.delivery.failed` | one EMAIL delivery reached FAILED | `deliveryId`, `notificationId`, `type`, `status`, `failureCode`, `durationMs`, `requestId` |
| `notification.delivery.exhausted` | attempt cap (`NOTIFICATION_EMAIL_MAX_ATTEMPTS`) reached — terminal FAILED | same as failed, `failureCode: ATTEMPTS_EXHAUSTED` |
| `notification.delivery.stale_reaped` | stale PROCESSING deliveries marked FAILED `STALE_PROCESSING` | `count` |
| `notification.delivery.dispatch_error` | the dispatcher itself caught an unexpected error (delivery marked FAILED `UNKNOWN`) | `deliveryId`, `error` (error NAME only) |
| `notification.mapper.*` (`subscription_failed`, `payment_failed_mapper_error`, `usage_failed`) | an event mapper failed before/at creation (fire-safe) | `eventId`/`businessId`/`sessionId`, `error` (error NAME only) |

**The law (§132/§133):** NEVER log the notification `dataJson`, any rendered
email text/HTML, or raw SMTP transcripts. The fields above are the complete
safe set — ids, type, status, normalized `failureCode`, duration, `requestId`.
The logger's recursive redaction/bounding applies on top, and
`scripts/notification-static-scan.mjs` asserts no payload logging in the
notification domain.

**Security notifications** (`SECURITY_*` types, including the mandatory
security emails) are created through the same `notification.created` /
`notification.create_failed` structured events with the same safe fields —
no secret content (MFA secrets, OTPs, recovery codes, reset tokens, session
ids) ever enters a log line or a notification payload.

Catalog note (honest): these event names are emitted as literal strings via
`logInfo`/`logError` and are NOT yet registered in the `OPERATIONAL_EVENTS`
fixed vocabulary (`src/lib/observability/events.ts`, Prompt 29) — the
redaction, bounding, and level rules of the logger still apply to every line.

## 13. CSP and headers note (Prompt 29 §97/§98)

The adopted CSP is deliberately minimal: **`frame-ancestors 'none'`** only
(clickjacking protection with zero impact on Next.js asset loading), plus
`X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`.
HSTS is added ONLY when `PUBLIC_BASE_URL` is https (§97). A full
script/style CSP is **future hardening**, documented as such — a blind
aggressive CSP was explicitly rejected for now (§98) to avoid regressing
browser behavior without a proper nonce/hash rollout.

## 14. Vendor neutrality (Prompt 29 §174)

No external monitoring vendors, APM agents, or log shippers have been added.
The observability surface is: stdout JSON lines (this contract) + the two
public probe endpoints (`/api/health`, `/api/ready`) + readiness internals
visible only in Platform System. Any future vendor integration must map ONTO
this contract (parse the JSON lines or scrape the endpoints) without changing
the app's output — and must be recorded in the risk register before adoption.
