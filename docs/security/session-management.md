# Session Management — JWT + Per-Device Registry

**Document ID:** SEC-SESSIONS-v1
**Phase:** Prompt 30 (§70-§87, §216-§219, §226-§234, §247, §361)
**Current State:** IMPLEMENTED AND TESTED (single-node, SQLite)
**Implementation Source:** `src/lib/auth/sessions/service.ts` · `src/lib/auth.ts` (sid issuance + jwt/session callbacks) · `src/lib/auth-security.ts` (`assertFreshSession` + `assertSessionRegistry`) · `src/app/api/v1/me/security/sessions/*` · `src/lib/auth/config.ts`

## JWT

NextAuth v4 JWT session strategy (SPA-friendly), 30-day maxAge — unchanged
transport from Prompt 18. The JWT remains the credential; the registry below
adds what a stateless token cannot provide.

## sid

- Issued at EVERY successful login (password path and MFA-assertion path):
  32 cryptographically random bytes → base64url. Never derived from userId,
  email, or any enumerable value.
- Stamped into the JWT (`token.sid`) and exposed through the session object
  for server-side helpers. The server NEVER trusts a client-asserted sid —
  only the signed JWT's copy, validated against the registry.

## UserSession

- One row per registered login: `sessionTokenHash` = **SHA-256(sid)** (the raw
  sid and the raw JWT are NEVER stored — §71/§72), `userId`, `createdAt`,
  `lastSeenAt`, `expiresAt`, `revokedAt?`, bounded `userAgent?` (≤255 chars),
  coarse `deviceLabel?` (family string such as "Chrome on Windows" — NOT a
  fingerprint), `ipHash?` (SHA-256 with a fixed app salt — hashing limits
  casual exposure but is NOT strong anonymization; IPv4 space is enumerable),
  `createdFrom` (`login` | `assertion`).
- **Registration failure FAILS THE LOGIN (§217):** a session that could never
  be individually revoked must never be issued.
- **Expiry alignment (§84):** `expiresAt` is derived from the SAME
  `SESSION_MAX_AGE_SECONDS` (30 days) as the JWT maxAge — one authority, they
  cannot drift.

## sessionTokenHash

The one-way registry key. Anything that needs to "find" a session uses the
hash; nothing in the codebase ever persists or logs the raw sid/JWT (enforced
by `scripts/identity-security-static-scan.mjs` §410/§416 patterns).

## sessionVersion

UNCHANGED global kill switch (Prompt 18). Bumped by password change/reset,
MFA enable/disable, global invalidation, account deletion; compared at every
freshness gate. The registry is deliberately NOT a replacement: sid revokes
ONE device; `sv` revokes EVERY device.

## Legacy JWT compatibility (§83/§226/§228/§229)

JWTs issued before this registry carry no `sid`. During the documented
compatibility window they keep working: sessionVersion + user checks still
apply; only the per-device registry is bypassed. They are NOT back-filled as
untracked rows. Honest UX: the Security Center shows `currentSession: null`
with the localized "activates after your next sign-in" note, and the sessions
endpoint returns `currentSessionRegistered: false`.

## Individual revocation

`POST /api/v1/me/security/sessions/[id]/revoke` — owner-checked (a foreign id
returns 404 `SESSION_NOT_FOUND`, no existence oracle), conditional update on
`revokedAt: null` (idempotent, no duplicate mutation). The revoked device
receives 401 `SESSION_REVOKED` on its next request. Revoking a single OTHER
session may require the password per policy; the current session is revoked
only via sign-out (`revoke-current`), never through this endpoint.

## Revoke all

`POST /api/v1/me/security/sessions/revoke-all` — password + typed
`SIGN OUT ALL`. Revokes every OTHER session; the CURRENT session survives
(§80/§247 — "sign out all other devices"). Global invalidation (including the
current device) happens only through the explicit sessionVersion-bumping
flows (password change/reset, MFA enable/disable, Platform System session
invalidation).

## Current session

Determined SERVER-SIDE from the JWT's sid → registry row (`isCurrent`).
The browser never declares which device it is.

## Expiry

- Expired UserSession (`expiresAt <= now`) → registry check fails
  (`SESSION_EXPIRED` semantics — fresh-session gate refuses).
- Expired JWT → NextAuth itself refuses.
- Cleanup: `scripts/prune-auth-security.mjs` removes expired/revoked rows
  (dry-run default, `--apply`); never touches live sessions.

## lastSeenAt throttling (§85/§434)

At most ONE write per `SESSION_LAST_SEEN_UPDATE_SECONDS` (default 300, bounded
60–3600) per session — a missed heartbeat is non-fatal and never invalidates a
live session. This prevents a per-request SQLite write storm.

## Single-node architecture

The registry is a normal SQLite table in the same single-node database. There
is no distributed session store, no Redis, no replication — consistent with
the locked stack. A multi-instance deployment would require an ADR (shared
store + shared limiter).

## Limitations

- Device labels are coarse (browser family × OS family); there is NO
  geolocation, no external IP-lookup service, and raw IPs are never shown in
  the UI (hashed at rest, never rendered).
- The compatibility window for legacy (sid-less) JWTs is a documented grace
  period, not a permanent state; operators may end it by invalidating sessions
  globally (Platform System), which forces re-authentication.
- Revocation takes effect at the revoked device's NEXT request; it cannot
  reach into an in-flight request.
