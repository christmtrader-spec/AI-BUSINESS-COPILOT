# MFA (TOTP) — Design and Operations

**Document ID:** SEC-MFA-v1
**Phase:** Prompt 30 (§28-§68, §106-§113, §183-§220, §245, §319, §363, §437-§438)
**Current State:** IMPLEMENTED AND TESTED — capability is operator-gated and OFF by default (`MFA_ENABLED=false` shipped default; the QA sandbox enables it for testing)
**Implementation Source:** `src/lib/auth/mfa/service.ts` · `src/lib/security/secret-box.ts` · `src/lib/auth/config.ts` · `src/app/api/v1/me/security/mfa/*` · `src/app/api/v1/auth/mfa/*` · `src/lib/auth.ts` (assertion path) · `src/modules/settings/security-view.tsx`

## TOTP and RFC compatibility

- RFC 6238-compatible via the maintained **`otpauth`** library — the algorithm
  is never hand-rolled.
- Parameters (fixed policy, `src/lib/auth/config.ts`): **SHA-1** HMAC,
  **6 digits**, **30-second** period — the mainstream-authenticator default.
- Clock skew (§44): current/previous/next 30-second steps accepted
  (`TOTP_WINDOW_STEPS = 1`, ±30s around SERVER time — client time is never
  consulted). Codes older than the window are always rejected.
- Code format is gated before any crypto work: exactly six digits.

## Replay state (§45)

`MfaCredential.lastUsedTotpStep` stores the last ACCEPTED absolute time step
from LOGIN completions. A step ≤ `lastUsedTotpStep` is rejected (`REPLAY`), so
the same time step can never authenticate twice during login. Future steps are
never permanently rejected — a legitimate next-step code stays usable. The
enrollment confirmation deliberately does NOT stamp the step (the first login
inside the same 30s window must still succeed); step-up verification is
session-bound and exempt (`enforceReplay: false`).

## Encrypted storage

- Secret: 20 cryptographically random bytes → base32 (`OTPAuth.Secret.fromHex`
  path). NEVER derived from email, userId, password or time.
- At rest: **AES-256-GCM** authenticated encryption (`secret-box`) with a fresh
  96-bit IV per encryption; envelope format
  `v1.<iv>.<authTag>.<ciphertext>` (base64url, bounded, versioned).
- Tamper rejection: any failed decrypt (wrong key, corruption, bad tag) returns
  NULL; callers fail CLOSED with the safe `MFA_SECRET_DECRYPTION_FAILED`
  service error and a value-free operational log — never a crash, never
  material in the error.
- Plaintext exists only inside the immediate verify operation; no module-level
  cache; no zeroization guarantee is claimed (documented honestly).

## MFA_ENCRYPTION_KEY

- Server-only env var; NEVER stored in the DB, logged, returned by an API,
  audited, or written into docs/.env.example with a value.
- Accepts base64 / base64url / hex of EXACTLY 32 bytes. Rejected: missing,
  short (<43 chars base64), obvious placeholders (`changeme`, `example`,
  `your-key`, …), all-same-character low-entropy strings, non-key material.
- Generation: `openssl rand -base64 32`.
- `MFA_ENABLED=true` with an invalid/missing key ⇒ capability **BLOCKED**
  (fail closed, §190): the setup endpoints refuse with a safe error and the
  Security Center shows the blocked copy instead of encouraging an action
  that will necessarily fail.

## Setup (enrollment)

1. `POST /api/v1/me/security/mfa/setup/start` — authenticated + FRESH session +
   recent-password step-up + capability gates (`AVAILABLE` required) + rate
   limited (`mfa-setup`, 5/15 min). Creates the PENDING credential
   (`enabledAt` NULL — never trusted by login) with the encrypted secret and
   returns the provisioning material ONCE:
   - `otpauth://` URI (issuer `AI Business Copilot`, account = the
     authenticated user's email — server-derived, never client input),
   - QR as a data URI (rendered client-side; never logged, never in URLs or
     analytics),
   - the manual key (base32) for devices without a camera.
2. `POST /api/v1/me/security/mfa/setup/confirm` — requires a valid CURRENT
   TOTP code + explicit `confirmedSaved` acknowledgment. **MFA is never marked
   enabled before a valid TOTP verifies (§38).** The bounded setup window
   (challenge TTL) rejects abandoned pendings.

## Enable atomics (§107/§215/§220)

ONE transaction commits: `enabledAt` (conditional `updateMany` on
`enabledAt: null` — a concurrent double-confirm loses cleanly) + the full
10-code recovery set + the audit row. If any part fails, MFA is NOT enabled.
After enable: all sessions revoked + `sessionVersion++` — every device (this
one included) signs in again WITH the second factor; the UI shows the one-time
recovery codes, then signs the user out.

## QR and manual key

Both are derived from the same server-side secret during the setup response
only. The QR is rendered from a data URI in the client; neither the URI, the
manual key, nor the QR is ever logged, persisted client-side, or placed in a
URL. After the setup response, no endpoint returns secret material ever again
(`GET /me/security` and later GETs return state flags only).

## Recovery codes

- 10 codes (`RECOVERY_CODES_COUNT`), each **16 canonical characters** in
  **4×4 groups** (`XXXX-XXXX-XXXX-XXXX`), from a Crockford-style 32-char
  alphabet (`0-9` + `A-Z` minus `I L O U`) — ~80 bits of entropy per code.
- Normalization before hashing: trim, uppercase, strip spaces/dashes, map
  typed lookalikes O→0 and I/L→1. The canonical form is hashed with SHA-256;
  only hashes are stored (`codeHash` UNIQUE).
- Shown exactly ONCE (enable response, regeneration response); require an
  explicit "saved" acknowledgment; never redisplayed, never downloadable to
  disk automatically, copy/print are client-side clipboard/printer actions.
- Use is an atomic single-use claim: `updateMany` on `usedAt IS NULL` —
  concurrent reuse lets exactly one request win. A used code returns the
  generic invalid outcome and emits `auth.mfa.recovery_code_used`.
- The Security Center shows the REMAINING COUNT only — never codes, never
  hashes.

## Login challenge and MFA login

- Password success with MFA enabled NEVER creates a session: `authorize()`
  throws the fixed code `MFA_REQUIRED` (no MFA-state details, no oracle —
  whether an account has MFA is not disclosed before valid credentials).
- `POST /api/v1/auth/mfa/challenge` (email+password re-verified server-side,
  login-limiter shared) creates `MfaLoginChallenge`: random challenge, only the
  SHA-256 hash stored, TTL `MFA_CHALLENGE_TTL_SECONDS` (default 300s, bounded
  60–900), `attemptCount` bounded (`MFA_MAX_ATTEMPTS_PER_CHALLENGE = 5`),
  `sessionVersionAtChallenge` recorded — a password change/reset/delete
  mid-challenge invalidates it (§437/§438).
- `POST /api/v1/auth/mfa/complete` accepts TOTP or `RECOVERY_CODE`; limiter
  `mfa-login:<userId>:<ip>` (10/5 min). Success mints a ONE-TIME assertion
  (random, hash-only `assertionHash`, single-use `assertionUsedAt`, expires
  with the challenge) and emits the challenge-creation/success events.
- The client then signs in to NextAuth with `mfaAssertion`; `authorize()`
  verifies hash + single-use + expiry + sessionVersion INSIDE the credentials
  flow (no second session system) and completes the normal login (sid issued,
  UserSession registered, `mfaUsed` stamped informationally — never
  authorization-relevant).

## Disable (§65/§66/§163/§211/§245, §319)

`POST /api/v1/me/security/mfa/disable` — current password + current TOTP **or**
a valid recovery code + typed confirmation `DISABLE MFA`. ONE transaction:
credential deleted + `sessionVersion++` + every registered session revoked +
audit. A second disable finds nothing enabled and returns the safe
`alreadyDisabled` state (no duplicate mutation). There is NO admin, support or
helpdesk bypass — only the account owner can disable.

## Regenerate (§61/§164/§212/§248)

`POST /api/v1/me/security/mfa/recovery-codes/regenerate` — FRESH session +
current password + CURRENT TOTP (recovery codes are NOT accepted here: codes
minting codes would let one surviving code perpetuate access). ONE transaction
deletes ALL unused old codes and inserts the new set — a double-click can never
create two competing active sets; old codes stop working immediately.

## No admin bypass

Platform operators and support roles have no endpoint, CLI or SQL-assisted
path to view, reset, disable or enroll MFA for a user. Session invalidation
via Platform System remains the global kill switch (as since Prompt 18/28);
it never reveals or touches MFA secrets.

## Known limitations

- A lost authenticator AND lost recovery codes = account lockout by design;
  recovery requires proving mailbox ownership through the (separate) password
  reset flow, which removes MFA only as part of the documented reset semantics
  — no operator shortcut exists.
- Key rotation: envelope is versioned (`secretVersion`), bulk rotation is NOT
  implemented.
- SHA-1 is the RFC-compatible TOTP default; this matches every mainstream
  authenticator and is not a weakness in this construction, but it is fixed
  policy (not configurable).
- MFA enrollment state lives per user; there is no per-business MFA policy.
