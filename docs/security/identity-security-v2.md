# Identity Security V2 — Architecture Overview

**Document ID:** SEC-IDV2-v1
**Phase:** Prompt 30 (§1-§505) · finalized Prompt 30-F
**Status:** DESCRIPTIVE — documents exactly what the shipped code does
**Current State:** IMPLEMENTED AND TESTED (Prompt 30 harness 93/93 · unit harness 54/54 · static scan 20/20 · privacy-deletion-check 32/32)

## Scope

Identity security for user accounts: email-ownership verification, optional TOTP
multi-factor authentication, one-time recovery codes, per-device session
management, step-up authentication and the Account Security Center. It sits
BESIDE the existing password + `sessionVersion` model (Prompt 18) — nothing in
Prompt 30 replaces or weakens it.

Out of scope (deliberately NOT implemented): SSO/OAuth/SAML, passkeys/WebAuthn,
trusted-device 30-day MFA skip, remembered-MFA, per-business MFA policy,
admin/helpdesk MFA reset or bypass, push/OTP-over-email second factors,
security scores or compliance badges.

## Authentication architecture

- **NextAuth v4, Credentials provider, JWT session strategy** — unchanged
  (`src/lib/auth.ts`). 30-day JWT maxAge (`SESSION_MAX_AGE_SECONDS`, one
  authority in `src/lib/auth/config.ts`).
- **bcrypt cost 12** password hashing (Prompt 18, unchanged).
- **`sessionVersion` (`sv`)** — GLOBAL kill switch. Stamped into the JWT at
  sign-in, compared against the DB at every freshness gate
  (`assertFreshSession` / `getAuthContext`). Bumped by: password change,
  password reset, MFA enable, MFA disable, revoke-all-with-invalidation,
  account deletion. UNCHANGED by Prompt 30.
- **`sid`** — PER-DEVICE switch (Prompt 30). 32 random bytes, base64url,
  generated at every successful login, stamped into the JWT, registered as
  `UserSession` with `sessionTokenHash = SHA-256(sid)`.
- **Factor separation (the six authentications, never conflated):**

| Factor | Proves | Can never be used for |
|---|---|---|
| Password | Knowledge of the account secret | Bypassing MFA when enrolled |
| Email verification | Control of the mailbox | Password reset, MFA, or login |
| MFA (TOTP) | Possession of the enrolled authenticator | Password recovery |
| Recovery code | One-time fallback possession proof | A session credential, password change, or security-control change by itself |
| Session (sid/JWT) | An authenticated transport | A recovery or verification credential |
| Step-up | Fresh re-authentication for one high-risk action | Anything beyond its window |

- **MFA login is two-step:** password success with MFA enrolled NEVER issues a
  session — `authorize()` throws the fixed code `MFA_REQUIRED`. The client
  completes a server-side `MfaLoginChallenge` (hash-only, 5-min TTL, max 5
  attempts, bound to `sessionVersionAtChallenge`) → one-time `assertion`
  (hash-only, single-use) → consumed inside NextAuth `authorize()` → full
  session. The client-visible assertion is the ONLY bridge, and it is never a
  session token itself.

## Email verification

- Modes: `OFF` (default) / `OPTIONAL` / `REQUIRED` via
  `AUTH_EMAIL_VERIFICATION_MODE`. Default OFF so an upgrade can never lock
  existing users out; existing accounts are NOT bulk-marked verified.
- Tokens: 32 random bytes, base64url; DB stores SHA-256 only; 30-minute TTL;
  single active token per user (issuance invalidates outstanding tokens).
- REQUIRED gates business creation, trial start and paid checkout only — never
  login. REQUIRED with SMTP unconfigured → readiness reports **BLOCKED**
  (never a silent downgrade). Full detail:
  [`email-verification.md`](./email-verification.md).

## MFA

- TOTP, RFC 6238-compatible via the maintained `otpauth` library: SHA-1 HMAC,
  6 digits, 30-second period, ±1 step skew window. Never hand-rolled.
- Secret: 20 random bytes → base32; encrypted at rest with AES-256-GCM
  (`secret-box`), key in `MFA_ENCRYPTION_KEY` (server-only env var, never in
  the DB, never logged/returned).
- Replay protection: `lastUsedTotpStep` — the same-or-older time step can never
  authenticate twice at login; future steps are never permanently rejected.
- Enrollment requires recent-password step-up + a valid TOTP code BEFORE
  `enabledAt` is set; the 10 recovery codes are created in the SAME
  transaction. Full detail: [`mfa.md`](./mfa.md).

## Recovery

- 10 one-time codes per account, 16 canonical chars each (4×4 grouping),
  Crockford-style 32-char alphabet (no I/L/O/U), ~80-bit entropy; lookalike
  normalization (O→0, I/L→1) before hashing; SHA-256 at rest.
- Shown exactly once (enable response / regeneration response); the summary
  endpoint exposes only the COUNT. A recovery code can complete an MFA login
  challenge or the MFA-disable step-up — nothing else.

## Session registry

- `UserSession` adds what a stateless JWT cannot: per-device revocation, device
  list, last-seen. Registry validation is part of the ONE freshness path
  (`assertSessionRegistry` inside `assertFreshSession`), so there is no second,
  inconsistent validation route. Legacy JWTs without `sid` keep working during
  a documented compatibility window (sessionVersion still applies; the registry
  is bypassed; `currentSession` is honestly `null` in the Security Center).
- Full detail: [`session-management.md`](./session-management.md).

## sessionVersion

Unchanged from Prompt 18 (see above). Prompt 30 explicitly does NOT weaken it;
password change/reset/deletion still invalidate every JWT with a lower `sv`,
and MFA login challenges carry `sessionVersionAtChallenge` so a password change
mid-challenge kills the challenge.

## Step-up

`src/lib/auth/step-up.ts` — server-authoritative recency (default window 600s,
`MFA_STEP_UP_MAX_AGE_SECONDS`, bounded 300–1800). A successful verification is
recorded as a SecurityEvent; the destructive operation checks for that event in
the window. No client timestamps, no booleans, no localStorage. VERIFY-NOW
variants (`verifyPasswordNow`, `verifyStrongAuthNow`) cover flows that collect
credentials in-body (disable MFA, revoke-all, regenerate codes, account
deletion).

## Security events

`SecurityEvent` — fixed `auth.*` vocabulary (`src/lib/auth/security-events/
service.ts`), fixed reason codes, no secrets, hashed IP, bounded UA, fire-safe
writes. Written only from rate-limited auth paths (attacker-driven request
storms cannot create unbounded rows). Feed + pagination in the Security Center.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AUTH_EMAIL_VERIFICATION_MODE` | `OFF` | OFF / OPTIONAL / REQUIRED |
| `MFA_ENABLED` | `false` | Capability switch; never force-migrated onto users |
| `MFA_ENCRYPTION_KEY` | — | 32-byte base64/base64url/hex; REQUIRED when MFA_ENABLED=true (fail closed) |
| `MFA_CHALLENGE_TTL_SECONDS` | `300` | Login challenge TTL, bounded 60–900 |
| `MFA_STEP_UP_MAX_AGE_SECONDS` | `600` | Step-up window, bounded 300–1800 |
| `SESSION_LAST_SEEN_UPDATE_SECONDS` | `300` | lastSeenAt write throttle, bounded 60–3600 |

Capability semantics (server-authoritative, surfaced as `mfaCapabilityState` in
`GET /api/v1/me/security` — never hard-coded in the UI):

| MFA_ENABLED | Key valid | State |
|---|---|---|
| false | — | `DISABLED` |
| true | yes | `AVAILABLE` |
| true | missing/invalid/placeholder | `BLOCKED` |

Readiness: MFA DISABLED / READY (enabled+configured) / BLOCKED;
email OFF / READY (OPTIONAL+SMTP) / BLOCKED (REQUIRED+SMTP missing).
The PUBLIC `/api/ready` payload deliberately omits MFA/encryption state (§187);
Platform System shows it.

## Compatibility

- Existing users: nothing changes by default (MFA DISABLED, verification OFF,
  no forced enrollment, no mass session invalidation).
- Pre-Prompt-30 JWTs (no `sid`): keep working; sessionVersion still applies.
- Historical migrations untouched; the Prompt 30 migration
  (`20260929090000_prompt30_identity_security_v2`) is additive.
- Deletion: all six Prompt 30 models are user-owned with `onDelete: Cascade` —
  account deletion removes every security record including SecurityEvents
  (privacy-first, documented in `docs/legal/data-deletion-matrix.md`).

## Known limitations

- Rate limiting and the limiter are PROCESS-LOCAL (single-node MVP) — a
  multi-instance deployment needs a shared limiter (ADR required).
- Hashed IP storage (`ipHash`) limits casual exposure but is not strong
  anonymization (IPv4 space is enumerable).
- MFA key rotation: the secret-box envelope is versioned (`v1`,
  `MfaCredential.secretVersion`) but bulk rotation is NOT implemented.
- SQLite single-writer: last-seen writes are throttled to avoid write storms;
  heavy concurrent auth traffic is still single-node-bound.
- Security events have no independent retention TTL (documented in
  `docs/legal/data-retention-inventory.md`).

## Operational readiness

- `scripts/prune-auth-security.mjs` — dry-run default, `--apply` for expired
  verification tokens / challenges / sessions; never deletes active
  credentials, unused recovery codes, live sessions, or valid tokens.
- `scripts/prompt30-check.mjs` (E2E), `scripts/prompt30-unit.ts` (unit),
  `scripts/identity-security-static-scan.mjs` (static invariants) — all green;
  exact counts live in the worklog entry `r30-prompt30-finalization`.

## Implementation source

`src/lib/auth/config.ts` · `src/lib/auth/email-verification/*` ·
`src/lib/auth/mfa/service.ts` · `src/lib/auth/sessions/service.ts` ·
`src/lib/auth/security-events/service.ts` · `src/lib/auth/step-up.ts` ·
`src/lib/security/secret-box.ts` · `src/lib/auth.ts` ·
`src/app/api/v1/auth/*` · `src/app/api/v1/me/security/*` ·
`src/modules/settings/security-view.tsx` · `prisma/migrations/
20260929090000_prompt30_identity_security_v2/`
