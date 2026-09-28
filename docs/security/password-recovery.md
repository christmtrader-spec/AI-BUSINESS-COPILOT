# Password Recovery — Token Lifecycle (Prompt 18 · Prompt 29 update)

**Document ID:** SEC-RESET-v2
**Basis:** `src/lib/auth-security.ts`, `src/app/api/v1/auth/password-reset/request/route.ts`, `.../confirm/route.ts`, `src/lib/email/index.ts`, `src/lib/email/config.ts`, `src/lib/email/smtp-provider.ts`, `prisma/schema.prisma:50-63`.
**Companion docs:** `docs/security/authentication-current-state.md` (§5.2, §7), `docs/audit/rate-limiting.md` (limiter internals), `docs/security/observability-and-logging.md` (email event fields).
**Prompt 29 changes (§7–§23):** real SMTP adapter shipped; send-BEFORE-persist delivery law; bounded timeout; single attempt per request; HTML-escaped reset URL; structured email events.

---

## 1. Token lifecycle

```
REQUEST  POST /api/v1/auth/password-reset/request            CONFIRM  POST .../password-reset/confirm
─────────────────────────────────────────────────           ─────────────────────────────────────────────
 rate limits: ip 5/15min, email 3/hour                        rate limits: ip 10/15min, per-token 5/15min
 transport + base URL validated FIRST                         format gate: 43-char base64url check
   (unconfigured → uniform 503 BEFORE user lookup)            tokenHash = SHA-256(rawToken)
 cleanup: this user's dead tokens → global expired
   sweep → outstanding tokens (one live link max)
 rawToken = 32 random bytes → base64url (43 chars)            TX (atomic):
 email link contains the ONLY copy of rawToken                   1. findUnique by tokenHash
   ${base}/#/reset-password/<rawToken>                           2. claim: updateMany({ id, usedAt: null,
 SEND FIRST (Prompt 29 §13): provider.send(),                       expiresAt: { gt: now } }) → usedAt=now
   ONE bounded attempt (§21, no auto-retry)                       3. count !== 1 → TOKEN_DEAD (generic 400)
 delivery FAILED → NO token row persisted,                       4. bcrypt-12 new password
   still a generic 200                                            5. User.sessionVersion +1
 delivery OK → DB row stores SHA-256(rawToken) ONLY              6. audit auth.password_reset_completed
   + expiresAt(+30min), requestedIp, userAgent
 response: generic 200 always                                 old JWTs fail at next checkpoint; NO auto-login

 user opens SPA  #/reset-password/<rawToken>
   (fragment — never sent to any server)
```

Evidence: `request/route.ts:47-141`, `confirm/route.ts:42-126`, `auth-security.ts:42-58,148-151`.

## 2. Expiration — exactly 30 minutes

`PASSWORD_RESET_TTL_MINUTES = 30` (`src/lib/auth-security.ts:42`) is written into `expiresAt` at creation (`request/route.ts:101`) and enforced in the claim predicate `expiresAt: { gt: now }` (`confirm/route.ts:82`). **Why 30:** long enough for a normal "check your inbox" round-trip, short enough that a leaked link has a bounded window and the outstanding-token window for inbox-compromise scenarios stays small. It is a single documented constant shared by email copy ("valid for 30 minutes", `email/index.ts:105,117`) and DB policy — they cannot drift.

## 3. Token hashing — raw storage is forbidden

- Raw token: `randomBytes(32)` → base64url = **43 chars** (`auth-security.ts:46-48`) — 256 bits of entropy, unguessable and long enough that brute force is not a shortcut.
- The database stores **only `SHA-256(rawToken)` as a unique hex string** (`auth-security.ts:51-53`, `PasswordResetToken.tokenHash @unique`, `schema.prisma:54`). A DB dump, backup leak, or read-only query therefore yields nothing usable — an attacker with the hash still cannot construct the link. This is the same "hash-protected at rest" posture as `User.passwordHash`; it is not encryption and does not pretend to be.
- A constant-time-shaped format gate (`isPlausibleResetToken`, `auth-security.ts:56-58`) rejects garbage **before** any DB work or hashing.

## 4. Single-use — race-safe claim

The claim is a conditional `updateMany({ where: { id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } })` **inside the same transaction** that updates the password (`confirm/route.ts:71-115`). Two simultaneous confirmations of the same link race on `usedAt: null`: exactly one `updateMany` matches (`count === 1`), the loser throws `TOKEN_DEAD` and its whole transaction — including the password write — rolls back. A consumed token can never be reused; the password can be changed at most once per token.

## 5. Enumeration protection

- **Generic 200 always:** the request endpoint returns one identical message for existing and non-existing emails (`genericResponse`, `request/route.ts:40-45,141`).
- **Uniform 503:** transport and base-URL validity are resolved **before** the user lookup (`request/route.ts:71-81`), so an unconfigured production deployment fails identically for every address — no existence oracle via `RESET_DELIVERY_UNAVAILABLE`.
- **Generic 429:** both reset-request rate limits use the same message for existing and non-existing accounts (`request/route.ts:53-65`).
- **Generic 400 at confirm:** unknown / expired / used / malformed tokens are indistinguishable (`INVALID_RESET_TOKEN`, `confirm/route.ts:55-57,78,85,121-123`).
- **Login page never reveals existence** either: failed sign-in is a bare `null` from `authorize()` (`src/lib/auth.ts:69-72`).
- **Remaining tradeoff (honest):** the `auth.password_reset_requested` audit row is written only for existing accounts (`request/route.ts:129-138`). It is DB-internal — the business audit API filters by business id, so it never reaches any client (`src/app/api/v1/audit/route.ts:22`) — but someone with database access could infer account existence from its presence.

## 6. Rate limiting (server-enforced, in-memory — see `docs/audit/rate-limiting.md`)

| Dimension | Key | Limit | Window | Purpose |
|---|---|---|---|---|
| Request, per IP | `pwd-reset-ip:${ip}` | 5 | 15 min | spray / mail-bombing cap (`request/route.ts:53`) |
| Request, per email | `pwd-reset-email:${email}` | 3 | 1 hour | targeted flooding of one inbox (`request/route.ts:59`) |
| Confirm, per IP | `pwd-reset-confirm:${ip}` | 10 | 15 min | token-guessing cap (`confirm/route.ts:47`) |
| Confirm, per token | `pwd-reset-token:${hash.slice(0,16)}` | 5 | 15 min | targeted brute force on one link (`confirm/route.ts:61`) |

## 7. Session invalidation after reset

The password update and `sessionVersion: { increment: 1 }` happen in the claim transaction (`confirm/route.ts:94-97`), so every previously issued JWT fails the freshness check on its next request (both enforcement points, `src/lib/tenant.ts:66-72`, `src/lib/auth-security.ts:98-119`). **No auto-login:** the confirm response only says the previous sessions were signed out and the user must sign in with the new password (`confirm/route.ts:117-119`) — the person who completed the reset is re-authenticated from scratch, and a stolen pre-reset session is dead regardless.

## 8. Email abstraction — `EmailProvider`

- The auth module never talks to a vendor: it calls `getEmailProvider().send(...)` against the `EmailProvider` interface (`src/lib/email/index.ts:29-32,73-76`). **Prompt 29 shipped the real SMTP adapter** behind this boundary (`src/lib/email/smtp-provider.ts`, nodemailer) — no product-code changes were needed, exactly as designed.
- **Dev console transport** (`NODE_ENV !== "production"`, `email/index.ts:43-56,74`): prints a loud, clearly-marked line with a masked recipient (`maskAddress`) and the full text body **including the reset link** — that is the intended dev/QA delivery channel. `EMAIL_PROVIDER=test-memory` selects the TEST-ONLY in-memory provider (harnesses; never resolvable in production).
- **Production transport (Prompt 29):** the SMTP adapter is used when the transport is CONFIGURED — i.e. ALL of `EMAIL_SERVER_HOST` + `EMAIL_SERVER_PORT` + `EMAIL_FROM` together (+ credential consistency; `src/lib/email/config.ts` §18). `EMAIL_SECURE` must be explicitly `true` in production (implicit TLS, typ. port 465); explicit `false` is BLOCKED (§10); certificate verification is never disabled (`rejectUnauthorized: true`). **Production remains NOT_CONFIGURED until the operator supplies valid settings — there is no fake readiness**: an unconfigured transport → uniform `503 RESET_DELIVERY_UNAVAILABLE` BEFORE any user lookup; an INVALID (half-configured) transport fails closed (never a pretending fallback, `smtpProviderFromEnvironment()` throws `EMAIL_TRANSPORT_INVALID`).
- **Send-before-persist (Prompt 29 §13):** the reset token row is persisted ONLY AFTER `provider.send()` resolves successfully. If delivery definitively fails, no token is created that "appears usable" while no email went out — and the response is still a generic 200 (existence is never revealed). The token lives in exactly one place: the emailed link.
- **Bounded delivery (§11/§21):** connection/greeting/socket timeouts from `EMAIL_TIMEOUT_MS` (1000..60000 ms, default 10000) plus an overall race in the adapter — a send can never hang an HTTP request indefinitely. **Single attempt per request** (§21): no automatic retry inside the HTTP request path; the user simply requests again (rate limits unchanged). Errors are reduced to safe classes (`SMTP_TIMEOUT` / `SMTP_AUTH_FAILED` / `SMTP_CONNECTION_FAILED` / `SMTP_DELIVERY_FAILED`) before logging — the SMTP password and server details never appear.
- **Reset URL is HTML-escaped (§23):** `buildPasswordResetEmail` escapes ALL user-controlled interpolations (`&`, `<`, `>`, `"`, `'` — order-safe) before interpolation; the reset URL is additionally attribute-escaped in the `href` AND rendered as escaped text, so a hostile value cannot inject HTML into the email. Template ships in **EN and FA with RTL/LTR `<dir>`/`<lang>` attributes** and both directions are rendered/tested.
- **No token preview endpoints exist** — no API returns a reset token under any circumstances; the only transports are the email body and nothing else.
- Email content (`buildPasswordResetEmail`, `email/index.ts`): localized en/fa, product name, action, 30-minute expiry, single-use note, "ignore if you did not request this", generic security note — and never contains a password.

## 9. Cleanup strategy — opportunistic, no job queue

On each request **for an existing user** (single-node deployment, no scheduler — documented choice, `request/route.ts:14-16,89-97`):

1. delete that user's dead tokens (expired **or** already used);
2. global sweep of all expired tokens (`@@index([expiresAt])` makes this cheap, `schema.prisma:62`);
3. delete all remaining outstanding tokens for the user → **at most one live link per user** at any moment.

## 10. Security of the URL

- The raw token exists in exactly one place: the emailed link `${base}/#/reset-password/<rawToken>` (`auth-security.ts:148-151`). The base comes from `APP_BASE_URL ?? NEXTAUTH_URL` configuration — never from the request `Host` header, which would enable password-reset poisoning (`auth-security.ts:131-146`).
- **Hash fragments are not sent to the server:** the token rides in the URL fragment of the SPA route, so browsers never transmit it in the HTTP request line, and fragments are stripped from `Referrer` headers by browser behavior. No server-side route ever renders or receives the token except the confirm POST body.
- **SPA link policy (reset view):** the reset view is part of the same-origin SPA and never renders off-domain links from a token-bearing URL, so the fragment is not leaked as a referrer to third parties.
- **Tokens are never logged.** The complete inventory of places tokens could appear:
  - *Dev email transport:* link printed **by design, dev only** (`NODE_ENV !== "production"` gate, `email/index.ts:74`) — this is the dev delivery channel, not a leak.
  - *Audit records:* never contain token material (`request/route.ts:129-138`, `confirm/route.ts:99-112`).
  - *API responses:* generic strings only (`request/route.ts:40-45`, `confirm/route.ts:117-119`).
  - *Delivery-failure log:* masked address + error message, explicitly not the link (`request/route.ts:121-127`).
  - *Database:* hash + `requestedIp`/`userAgent` only (`schema.prisma:50-63`).

## 11. Dev vs production behavior matrix

| Aspect | Development (`NODE_ENV !== "production"`) | Production |
|---|---|---|
| Transport | Console provider prints masked recipient + body **including link** (`email/index.ts:43-56`); `EMAIL_PROVIDER=test-memory` selects the test-only in-memory provider | Real SMTP adapter (Prompt 29) when the full `EMAIL_*` contract is CONFIGURED with `EMAIL_SECURE=true`; NOT_CONFIGURED → uniform `503 RESET_DELIVERY_UNAVAILABLE` before any user lookup; INVALID config fails closed — never a fake or pretending transport (`src/lib/email/config.ts`, `smtp-provider.ts`) |
| Link base URL | `APP_BASE_URL ?? NEXTAUTH_URL`; missing both → uniform 503 (`auth-security.ts:136-146`) | Same; must be configured to the public origin |
| Delivery semantics | Console "send" always succeeds | **Send-before-persist (§13):** token row persisted ONLY after `provider.send()` resolves; one bounded attempt (§21, timeout `EMAIL_TIMEOUT_MS`, default 10s) — delivery failure → generic 200, NO token persisted |
| Delivery failure | Logged with masked address; response stays generic 200 (`request/route.ts:121-127`) | Same rule + structured safe event (`auth.password_reset.sent`/`failed`: operation, provider, masked recipient, requestId, durationMs, errorCode — never the reset URL or token, `docs/security/observability-and-logging.md` §12); never reveals account state |
| Fake delivery | None — console output is loud and explicitly marked | None — "not configured" is a hard 503, never a pretend success |
| Token in logs | Link visible in dev console by design | Never — the SMTP path never logs links; audit/API/DB never hold raw tokens |
| Reset URL in HTML | Same builder | All interpolations HTML-escaped incl. attribute-escaped URL (§23); EN/FA templates with RTL/LTR dir/lang attributes |

## 12. Migration baseline note (Prompt 19)

The token lifecycle above is **unchanged** by the database migration baseline (`0_init`, `docs/database/prompt19-baseline.md`) — TTL (30 minutes), SHA-256 hashing, single-use claim, rate limits and opportunistic cleanup are exactly as documented. The `PasswordResetToken` table is now part of the committed baseline migration (schema identical, zero drift), and database backups therefore contain only token **hashes**, consistent with §3. Future schema changes follow `docs/database/migration-workflow.md`.
