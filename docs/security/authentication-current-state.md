# Authentication — Current State (Prompt 18)

**Document ID:** SEC-AUTH-v2
**Round:** Prompt 18 (r19-docs)
**Basis:** `src/lib/auth.ts`, `src/lib/auth-security.ts`, `src/lib/tenant.ts`, `src/lib/email/index.ts`, the auth/me route handlers, and `prisma/schema.prisma` (storage truth).
**Companion docs (not duplicated here):** `docs/audit/security-findings.md` (41-route audit), `docs/audit/rate-limiting.md` (limiter internals), `docs/security/data-classification.md` (data tiers), `docs/security/password-recovery.md` (reset token lifecycle), `docs/security/account-lifecycle.md` (signup/change/delete policy).

---

## 1. Method and session strategy

- **NextAuth v4 Credentials provider + JWT session strategy** (`src/lib/auth.ts:39-46`): sessions are stateless JWTs with `maxAge` 30 days (`src/lib/auth.ts:39-42`). No server-side session table exists; the JWT itself is the credential.
- The JWT carries `sub` (userId) and `sv` (session version); the active business is **not** a session claim — every request re-verifies membership server-side (`src/lib/auth.ts:80-94`, `src/lib/tenant.ts:39-93`).
- Sign-in identity check: email normalized (trim + lowercase), `bcrypt.compare` against `User.passwordHash` (`src/lib/auth.ts:14-17,71`).
- A stable `NEXTAUTH_SECRET` is mandatory; production fails fast without it (`src/lib/auth.ts:28-38`).

## 2. Password hashing

- **bcrypt, cost 12**, applied identically at every write site: registration (`src/app/api/v1/auth/register/route.ts:36`), password change (`src/app/api/v1/auth/password-change/route.ts:74`), password reset confirm (`src/app/api/v1/auth/password-reset/confirm/route.ts:93`).
- Verification is always `bcrypt.compare` (login `src/lib/auth.ts:71`, change `password-change/route.ts:58,65`, delete `src/app/api/v1/me/route.ts:100`).
- Passwords are **never logged, never returned by any API, never written to audit metadata** (logging law: `src/lib/auth-security.ts:14-15`).

## 3. Session invalidation — `User.sessionVersion` (new in Prompt 18)

`User.sessionVersion Int @default(0)` (`prisma/schema.prisma:27`). The JWT is stamped with `sv` at sign-in (`src/lib/auth.ts:80-85`); any password-changing event increments the stored version, so every previously issued JWT fails the comparison and must re-authenticate.

**Both enforcement points** (server-enforced, zero extra queries on business APIs):

| Checkpoint | Covers | Mechanism |
|---|---|---|
| `getAuthContext` (`src/lib/tenant.ts:51-72`) | All business-scoped APIs | Membership query `include`s the user's `sessionVersion` (`tenant.ts:58`); mismatch → `401 SESSION_INVALIDATED` |
| `assertFreshSession` (`src/lib/auth-security.ts:98-119`) | Account-scoped APIs: `GET/PATCH/DELETE /api/v1/me`, password change | Re-reads `sessionVersion` from DB; missing user or mismatch → `401 SESSION_INVALIDATED` |

- **Back-compat:** JWTs issued before this feature carry no `sv` and are treated as version 0 — matching every existing user's default, so nobody was logged out on deploy (`src/lib/auth.ts:24-25`, `src/lib/auth-security.ts:84-85`). Type surface: `src/types/next-auth.d.ts`.
- **Honest limitation:** with the JWT strategy there is no push-based global revocation. Invalidation takes effect on the **next request that passes through one of the two checkpoints** — all business APIs go through `getAuthContext` and all account APIs through `assertFreshSession`, so in practice the old token is dead on its very next use (`src/lib/auth-security.ts:79-82`). A token that is simply never used again is "dead" only because it expires naturally after 30 days.

## 4. Throttling inventory (server-enforced, in-memory)

Full limiter mechanics and multi-instance caveats: `docs/audit/rate-limiting.md`.

| Action | Key | Limit | Window | Evidence |
|---|---|---|---|---|
| Login | `login:${email}:${ip}` | 10 | 5 min | `src/lib/auth.ts:65` |
| Register | `register:${ip}` | 10 | 15 min | `register/route.ts:24` |
| Password change | `pwd-change:${userId}:${ip}` | 10 | 15 min | `password-change/route.ts:41` |
| Reset request (per IP) | `pwd-reset-ip:${ip}` | 5 | 15 min | `password-reset/request/route.ts:53` |
| Reset request (per email) | `pwd-reset-email:${email}` | 3 | 1 hour | `password-reset/request/route.ts:59` |
| Reset confirm (per IP) | `pwd-reset-confirm:${ip}` | 10 | 15 min | `password-reset/confirm/route.ts:47` |
| Reset confirm (per token) | `pwd-reset-token:${hash16}` | 5 | 15 min | `password-reset/confirm/route.ts:61` |
| Account deletion | `account-delete:${userId}:${ip}` | 5 | 15 min | `src/app/api/v1/me/route.ts:83` |

## 5. Flows (new in Prompt 18)

**Before this phase there was NO password change, NO password reset, and NO account deletion** — the only account mutations were register and profile PATCH. All three flows below were added.

### 5.1 Password change — `POST /api/v1/auth/password-change`

Session + `assertFreshSession` → per-user+IP throttle → verify `currentPassword` (failure: deliberately vague `400 INVALID_CURRENT_PASSWORD`) → reject reuse of the current password (`422 PASSWORD_UNCHANGED`) → shared policy schema → bcrypt-12 → **one transaction**: password update + `sessionVersion` increment + audit `auth.password_changed` (`src/app/api/v1/auth/password-change/route.ts:36-98`). Response is safe (`{ changed, sessionsInvalidated }`); all other sessions die at their next checkpoint.

### 5.2 Password reset — email-based, no session required

`POST /api/v1/auth/password-reset/request` (generic 200, hashed single-use 30-minute token, uniform 503 when delivery is unconfigured) and `POST /api/v1/auth/password-reset/confirm` (atomic single-use claim, generic `400 INVALID_RESET_TOKEN`). Full lifecycle, threat model, and dev/prod matrix: **`docs/security/password-recovery.md`**.

### 5.3 Account deletion — `DELETE /api/v1/me`

Password + typed `confirmation: "DELETE"` → ownership guard (any owned business → `409 OWNED_BUSINESS_BLOCKED` with the business list) → transaction: audit `auth.account_deleted` + `user.delete` (`src/app/api/v1/me/route.ts:78-142`). Data-classification consequences and the "not recoverable" policy: **`docs/security/account-lifecycle.md`**.

## 6. Security assumptions (stated plainly)

- **Single-node SQLite** (`prisma/schema.prisma:11`): transactions provide atomicity for token claims and deletion, but there is no multi-writer scale-out story.
- **In-memory rate limiter**: per-process `Map`, resets on restart, effective limits multiply with N instances (`src/lib/rate-limit.ts`; full analysis in `docs/audit/rate-limiting.md`).
- **No email transport in production yet**: `EMAIL_*` configuration is reserved for a future adapter (`src/lib/email/index.ts:58-71`, `.env.example`); until wired, production password reset returns a uniform `503 RESET_DELIVERY_UNAVAILABLE` — the product never pretends an email was sent.
- Reset links depend on `APP_BASE_URL`/`NEXTAUTH_URL` configuration, never on request headers (`src/lib/auth-security.ts:136-146`).
- **Database workflow is migration-based (Prompt 19):** the schema (including `User.sessionVersion` and the `PasswordResetToken` table) is now captured in the committed baseline migration `0_init` with zero drift (`docs/database/prompt19-baseline.md`); future schema changes ship as new migrations through `prisma migrate deploy` (`docs/database/migration-workflow.md`). This changed nothing about the auth behavior described above — sessions, hashing and rate limits are unchanged.

## 7. Audit event catalogue (new in Prompt 18)

Four account-level events, all written through `audit()` (`src/lib/audit.ts:21-40`) with `businessId: null` (nullable since Prompt 18, `prisma/schema.prisma:139-140`) and **no secrets in metadata** — no passwords, no token material (`password-reset/request/route.ts:129-138`, `password-reset/confirm/route.ts:99-112`, `password-change/route.ts:81-94`, `me/route.ts:122-137`):

| Action | Written when | Notable metadata |
|---|---|---|
| `auth.password_changed` | Successful password change | `after.sessionsInvalidated: true` |
| `auth.password_reset_requested` | Request for an **existing** account only | IP + user-agent; no token |
| `auth.password_reset_completed` | Token claimed + password set | `after.sessionsInvalidated: true` |
| `auth.account_deleted` | Account deletion committed | `after.membershipsRemoved: true` |

**Where they surface:** `GET /api/v1/audit` filters `businessId = ctx.businessId` (`src/app/api/v1/audit/route.ts:22`), and business exports are equally business-scoped — so `businessId: null` rows are **absent from the in-product business audit view by design**. They are visible only via direct database access / server-side review, which is also what keeps the reset-request event (written only for existing accounts) out of any attacker-visible surface. Actor attribution uses `actorId` with `onDelete: SetNull` (`prisma/schema.prisma:142`), so records survive account deletion without a dangling user link.
