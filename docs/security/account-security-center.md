# Account Security Center

**Document ID:** SEC-SECCENTER-v1
**Phase:** Prompt 30 (§92-§125, §159-§164, §198, §202, §230-§257, §455-§465)
**Current State:** IMPLEMENTED AND TESTED (EN/FA · RTL/LTR · light/dark · mobile 390×844 & 412×915 · desktop 1280×800 & 1440×900)
**Implementation Source:** `src/modules/settings/security-view.tsx` · `src/modules/settings/verify-email-view.tsx` · `src/app/api/v1/me/security/*` · `src/app/api/v1/auth/email-verification/*` · i18n: `security.*` in `src/i18n/messages/en.ts` / `fa.ts`

## Sections

Exactly ONE instance of each section renders (a duplicated ActivitySection
render was removed in Prompt 30-F):

1. **Password** — factual copy; changing the password goes through the
   existing profile flow (current password + all-device sign-out). No
   "last changed" timestamp is claimed because the schema does not store one.
2. **Email verification** — current address, verified/not state, mode-aware
   actions (Verify / Resend). OFF mode shows the honest "not enabled for this
   deployment" copy. Never shows tokens.
3. **MFA** — enrollment state + server-authoritative capability
   (`mfaCapabilityState`):
   - `AVAILABLE` → Enable button active.
   - `DISABLED` → "Two-factor authentication is turned off for this
     deployment." Button disabled — never waits for the setup endpoint to
     fail.
   - `BLOCKED` → "…temporarily unavailable — deployment configuration is
     incomplete." Button disabled (setup would fail closed). No key/validation
     detail is exposed.
   When enabled: recovery-code count remaining + Regenerate / Disable actions.
4. **Recovery codes** — one-time dialog after enable/regenerate; copy-all and
   print are client-side actions; the dialog requires an explicit "I saved my
   recovery codes" acknowledgment; codes live in React memory ONLY (never
   localStorage/sessionStorage/URL).
5. **Sessions** — registered devices with device label, created, last active,
   expiry, This-device badge; revoke one (optional password) and revoke-all
   others (password + typed `SIGN OUT ALL`). Honest legacy note when the
   current session predates the registry.
6. **Security activity** — newest-first paged feed (20/page, Load more) with
   localized fixed-vocabulary event names, success/failure and device label.
   No raw IPs, no payloads.

## API boundaries

| Endpoint | Method | Notes |
|---|---|---|
| `/api/v1/me/security` | GET | Explicit DTO: email, emailVerified, mode, mfaEnabled, **mfaCapabilityState**, recoveryCodeCount, currentSession, sessionCount, 30-day activity summary. Every limiter result ENFORCED (429 `RATE_LIMITED`). |
| `/api/v1/me/security/sessions` | GET | Paged (default 10, max 50), DTOs without token material, `currentSessionRegistered` flag. |
| `/api/v1/me/security/sessions/[id]/revoke` | POST | Owner-checked; foreign id → 404. |
| `/api/v1/me/security/sessions/revoke-all` | POST | Password + typed confirmation; current session kept. |
| `/api/v1/me/security/sessions/revoke-current` | POST | Sign-out companion; revokes the current registry row. |
| `/api/v1/me/security/activity` | GET | Paged (default 20, max 100), newest first. |
| `/api/v1/me/security/reauth` | POST | Step-up (password [+ MFA when enrolled]); records the recency event. |
| `/api/v1/me/security/mfa/setup/start` / `setup/confirm` | POST | Enrollment; provisioning material once; atomic enable. |
| `/api/v1/me/security/mfa/disable` | POST | Password + TOTP/recovery + typed `DISABLE MFA`. |
| `/api/v1/me/security/mfa/recovery-codes/regenerate` | POST | Password + current TOTP; one transaction. |

All of them: identity from the SESSION (no client userId), `assertFreshSession`
(+ registry validation where the sid exists), enforced rate limits, explicit
DTOs (no ORM serialization), no secrets in any response except the two
sanctioned one-time recovery-code responses.

## Step-up requirements

Destructive operations funnel through `src/lib/auth/step-up.ts`
(server-authoritative recency — default 10 minutes): MFA setup, MFA disable,
recovery-code regeneration, revoke-all, plus the existing account deletion
(fresh auth + password + MFA when enrolled + typed `DELETE`). Password change
keeps its own current-password verification and does not double-charge the
step-up.

## Supported controls

Email verification (mode-dependent), TOTP MFA enrollment/disable, recovery-code
regeneration, per-device session visibility and revocation, revoke-all-others,
sign-out, security activity review, step-up confirmation.

## Unsupported controls (honestly absent)

No trusted-device/remembered-MFA, no passkeys/SSO/social login, no per-business
MFA policy, no admin MFA reset, no push/OTP-over-email factors, no security
score, no compliance badges, no "100% protected" claims — the copy is factual
by design (§456/§457).

## Accessibility and platform behavior

- OTP inputs: numeric-only, paste-friendly, `autocomplete="one-time-code"`,
  proper labels; codes never enter URLs.
- Semantic structure with labelled dialogs; keyboard-reachable actions;
  destructive confirmations use typed phrases (never color-only).
- Responsive: single-column stack on mobile (no horizontal overflow at
  390×844 / 412×915), two-column arrangement where useful on desktop;
  RTL mirrors correctly in FA (logical properties); dark/light both verified.
