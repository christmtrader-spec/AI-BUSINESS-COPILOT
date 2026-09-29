# Email Verification

**Document ID:** SEC-EMAILVERIFY-v1
**Phase:** Prompt 30 (§4-§26, §120, §130-§132, §199, §221-§222, §249, §281-§282)
**Current State:** IMPLEMENTED AND TESTED — mode OPTIONAL in the QA sandbox; OFF is the shipped default
**Implementation Source:** `src/lib/auth/email-verification/service.ts`, `gate.ts`, `token-format.ts`, `src/app/api/v1/auth/email-verification/*`, `src/lib/auth/email-verification/../config.ts` (`AUTH_EMAIL_VERIFICATION_MODE`), template in `src/lib/email/` (`buildEmailVerificationEmail`)

## Purpose separation (§314/§315)

Email-verification tokens and password-reset tokens are SEPARATE MODELS and
SEPARATE FLOWS. They reuse the same cryptographic helpers (32 random bytes →
base64url; SHA-256 at rest) but never the same rows: a verification token can
never reset a password, and a reset token can never verify an email. Error
codes never cross flows either (the resend route translates the shared base-URL
failure into the email-verification vocabulary).

## Modes

| `AUTH_EMAIL_VERIFICATION_MODE` | Behavior |
|---|---|
| `OFF` (default) | Feature unavailable. Resend/status return honest 503 `EMAIL_VERIFICATION_UNAVAILABLE`. Nothing gates. An invalid configured value resolves to OFF (fail toward the least restrictive documented default). |
| `OPTIONAL` | Users may verify from the Security Center; nothing is blocked. No SMTP requirement is imposed by the mode itself. |
| `REQUIRED` | Business creation, trial start and paid checkout additionally require a verified email (`assertEmailVerifiedForCommercialAction`). Login and browsing are NEVER gated; existing data stays intact; invitations are unaffected. With SMTP unconfigured → readiness **BLOCKED** (never a silent downgrade). |

Existing accounts are never bulk-marked verified: `emailVerifiedAt` starts NULL
and is set ONLY by a claimed token.

## Token generation and storage

- Raw token: 32 cryptographically random bytes → base64url (43 chars). Generated
  by the same helper as reset tokens (`generateResetToken`) but persisted in the
  `EmailVerificationToken` table ONLY.
- Storage: SHA-256 of the raw token (`tokenHash`, UNIQUE). The raw token exists
  exclusively inside the emailed link — never logged, never stored, never
  returned by an API after the send.
- Link: `APP_BASE_URL`/`NEXTAUTH_URL` + `/#/verify-email/<token>`. Built from
  configuration ONLY — never from the request Host (link-poisoning defense).
- Emails: EN/FA templates, RTL/LTR aware, HTML-escaped content (no header/body
  injection).

## TTL

`EMAIL_VERIFICATION_TTL_MINUTES = 30` (single authority,
`src/lib/auth/config.ts`). `expiresAt` is enforced at claim time
(`expiresAt > now` required).

## Single active token rule (§21)

Issuing a new token first deletes the user's outstanding (`usedAt IS NULL`)
tokens — at most ONE active verification email can exist per account. The
concurrency property: the surviving active token always corresponds to the
FINAL valid email flow, because issuance is delete-then-insert of the same
new token (send-before-persist happens per request; the last successful
request owns the single active row). Tokens are additionally cleaned up
opportunistically (own expired/used + globally expired) and by
`scripts/prune-auth-security.mjs`.

## Resend rate limiting (§23)

`POST /api/v1/auth/email-verification/resend` — authenticated-only (no public
per-email endpoint exists), dual limiter:

- `email-verify-resend:<userId>:<ip>` — 3 per 15 min
- `email-verify-resend-u:<userId>` — 6 per hour

Exhausted → 429 `EMAIL_VERIFICATION_RATE_LIMITED` with `retryAfterMs`.

## Confirmation

`POST /api/v1/auth/email-verification/confirm` — anonymous (the emailed link is
the bearer), IP-limited (`email-verify-confirm:<ip>`, 20/15 min). Order:
format gate → hash → lookup → atomic claim.

- **Atomic single-use claim (§19):** `updateMany` on `usedAt IS NULL AND
  expiresAt > now` — exactly one concurrent confirmation wins; the loser gets
  the generic invalid outcome.
- Claim → set `User.emailVerifiedAt` (idempotent if already verified).
- Repeated verification / used token / unknown token / expired token all return
  the SAME safe generic result — no existence oracle (§282).
- Raw tokens never appear in logs, responses or analytics at any point after
  the send.

## Account behavior

- `GET /api/v1/auth/email-verification/status` (authenticated): `verified`,
  `verificationMode`, `canResend`. No token, no hash, no SMTP details.
- The session can expose `emailVerified` for display; server gates always
  re-check the DB.

## SMTP dependency

Transport is resolved BEFORE token work. Dev uses the console transport (the
email body, including the link, is printed to `dev.log` — documented dev-only
behavior the test harness reads). Production uses the Prompt 29 SMTP adapter
with bounded timeouts; a missing SMTP config in production is an honest 503 —
never a fake send.

## Failure semantics (send-before-persist, §221/§222)

The token row is created ONLY after `provider.send()` resolves. A delivery
failure returns an honest `{ sent: false }` (plus a `SecurityEvent`
`auth.email_verification.failed`) and persists NOTHING. The inverse failure —
send succeeded, persistence failed — leaves the emailed link dead (no row),
which is the documented honest outcome: the user simply requests a new email.
Nothing ever reports success that did not happen.

## Enumeration protection

- Confirm is anonymous but returns only safe generic outcomes.
- Resend/status are authenticated-only; there is no public "is this email
  registered/verified" endpoint.
- Delivery failures are value-free (masked recipient in logs only).
- Login behavior is identical whether or not an account exists (Prompt 18
  law, unchanged).

## Known limitations

- The emailed link is a bearer secret for 30 minutes — anyone with mailbox
  access can verify. That is the point of email verification, not a flaw.
- Dev console transport prints full email bodies to `dev.log` (dev only).
- No verification on email CHANGE is wired beyond what the profile flow does
  today; changing the address on an account resets nothing silently.
