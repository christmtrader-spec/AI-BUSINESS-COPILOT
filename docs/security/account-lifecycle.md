# Account Lifecycle — Signup, Passwords, Sessions, Deletion (Prompt 18)

**Document ID:** SEC-LIFECYCLE-v1
**Basis:** `src/app/api/v1/auth/register/route.ts`, `.../password-change/route.ts`, `.../password-reset/*`, `src/app/api/v1/me/route.ts`, `src/lib/auth-security.ts`, `src/lib/auth.ts`, `prisma/schema.prisma`.
**Companion docs:** `docs/security/password-recovery.md` (reset token lifecycle), `docs/security/authentication-current-state.md` (session mechanics), `docs/security/data-classification.md` (Prompt 17 tiers — this doc adds the deletion classification).

---

## 1. Signup — `POST /api/v1/auth/register`

- Body: `name` (trimmed, 1–80), `email` (trimmed, lowercased, valid, ≤200), `password` via the shared policy schema (`register/route.ts:16-21`).
- Hashing: **bcrypt cost 12** at creation (`register/route.ts:36`); no plaintext ever persisted.
- Throttling: `register:${ip}` — 10 per 15 min (`register/route.ts:24`).
- Duplicate email → `409 EMAIL_TAKEN` (`register/route.ts:33`). **Documented enumeration tradeoff:** unlike password reset, registration is a *positive-action* flow — the user is typing a password they intend to keep, and the standard UX requires telling them the email is already registered (otherwise they create a second, unreachable account). Reset and login remain enumeration-safe; signup deliberately is not.
- No auto-created business; onboarding does that after first sign-in (`register/route.ts:2-4`).

## 2. Password creation — one policy, one source of truth

`passwordSchema` (`src/lib/auth-security.ts:32-37`) is consumed by **all three** password-setting paths: registration, password change, and password reset confirm. Policy: **8–200 characters, ≥1 letter, ≥1 digit**; no artificial complexity theater beyond that (usability over rule-count).

**Whitespace is significant:** passwords are **NOT trimmed** (`auth-security.ts:25-31`). A leading/trailing space is part of the secret at every path — the policy must not silently change what register has always done. The schema itself never mutates the input (no `.trim()`), and each route passes the raw string to `bcrypt.hash`.

## 3. Password change — `POST /api/v1/auth/password-change`

- Identity comes exclusively from the authenticated session, never from the body (`password-change/route.ts:2-5`); gate: `assertFreshSession` (session-version freshness, `:38`).
- Throttle: `pwd-change:${userId}:${ip}` — 10 per 15 min (`:41`).
- Flow: `bcrypt.compare(currentPassword)` → `400 INVALID_CURRENT_PASSWORD` on failure — **deliberately vague**, never disclosing why the check failed (`:58-61`) → reject reuse of the exact current password with `422 PASSWORD_UNCHANGED` (`:64-72`) → bcrypt-12 → one transaction: password + `sessionVersion` increment + audit `auth.password_changed` (`:74-94`).
- **Re-auth is required by policy:** after a change, every existing session (including the device that made the change) fails its next freshness checkpoint and must sign in again (`:8-10`, `auth-security.ts:79-82`).

## 4. Password reset (no session)

Full token lifecycle, hashing, single-use race protection, enumeration posture, and dev/prod matrix: **`docs/security/password-recovery.md`**. Summary: 30-minute single-use hashed token; confirm atomically claims it, sets bcrypt-12 password, bumps `sessionVersion`, signs every session out, and requires an explicit sign-in (no auto-login).

## 5. Session invalidation policy

All three events share one primitive: `User.sessionVersion` (`prisma/schema.prisma:27`) compared against the `sv` stamp in each JWT at two checkpoints (`src/lib/tenant.ts:66-72`, `src/lib/auth-security.ts:98-119`). JWTs without `sv` (pre-feature) are treated as version 0 — nobody was logged out on deploy (`src/lib/auth.ts:24-25`).

| Event | What happens | Effect on existing JWTs |
|---|---|---|
| **A. Password change** | `sessionVersion` incremented in the same tx as the hash (`password-change/route.ts:76-94`) | Every old JWT fails at the **next checkpointed request** → re-auth required (all sessions, incl. the requester's device) |
| **B. Password reset** | `sessionVersion` incremented in the claim tx (`password-reset/confirm/route.ts:94-97`) | Same as A; no auto-login — explicit sign-in with the new password |
| **C. Account deletion** | `User` row deleted (`me/route.ts:138`) | Every JWT resolves to a missing user and fails its next checkpoint (`assertFreshSession`/`getAuthContext`) — all sessions dead immediately after deletion |

**Honest wording (no push-revocation claim):** with the JWT strategy, A and B take effect on the *next request through a checkpoint* — it is not push-based revocation. All business APIs and all account APIs pass through the checkpoints (`auth-security.ts:79-82`), so an old token is dead on its next use; an unused token expires naturally at 30 days (`src/lib/auth.ts:40-42`). For C the user row is gone, so *no* token can ever revalidate.

## 6. Account deletion — `DELETE /api/v1/me`

- Gates: authenticated session + session-version freshness (`assertFreshSession`, `me/route.ts:80`) → throttle `account-delete:${userId}:${ip}` 5/15min (`:83`) → password re-check via `bcrypt.compare` (`:100-103`, failure `400 INVALID_CURRENT_PASSWORD`) → typed confirmation `confirmation: "DELETE"` as a zod literal (`:41-45`) — a destructive action that cannot be triggered by a stray tap.
- The UI explains consequences before the request; the API itself is final. **The operation is not recoverable** (§9).
- Ownership guard runs **before** anything is destroyed: any owned business → `409 OWNED_BUSINESS_BLOCKED` with `ownedBusinesses: [{ id, name, members }]` and the instruction to delete the business first via Settings → Business → Danger zone (`me/route.ts:105-119`).
- Commit: one transaction writes `auth.account_deleted` then `user.delete` (`me/route.ts:121-139`).

## 7. User vs business data classification (deletion view)

| Class | Data | Fate on account deletion |
|---|---|---|
| **A — user-private** | name, `passwordHash`, locale, chat sessions + messages (`ChatSession/ChatMessage.userId` cascade, `schema.prisma:355,383`), memberships (`BusinessMember.userId` cascade, `:103`), password-reset tokens (`:53` cascade) | **Deleted** with the user row |
| **B — business-owned** | customers, suppliers, products, sales, expenses, payments, reports, chat sessions owned by the business | **Untouched** — they belong to the business, never to a person |
| **C — shared/tenant data** | the user's memberships in **other people's** businesses | Removed with the user (cascade); those businesses continue to exist, other members unaffected |
| **D — audit data** | `AuditLog` rows | **Preserved.** `actorId` is `onDelete: SetNull` (`schema.prisma:142`) — records survive without a personal link. Note: some historical `beforeJson`/`afterJson` snapshots may embed names/emails captured at event time; they are retained as historical record, not stripped |
| **E — auth/security data** | `PasswordResetToken` rows | Cascade-deleted with the user (`schema.prisma:53`); outstanding JWTs die naturally per §5-C |

## 8. Business ownership constraints

`Business.ownerId` is a required relation (`schema.prisma:77-78`) — it can **never dangle**. Therefore:

- A user who still owns **any** business cannot delete the account (`409 OWNED_BUSINESS_BLOCKED`, `me/route.ts:110-119`).
- The owner must first delete each business through the existing OWNER-only flow (Settings → Business → Danger zone); the deletion attempt tells them exactly which businesses block it, with member counts.
- A business **shared with other members is never silently destroyed** by one person's account deletion — ownership must be resolved explicitly first.

## 9. Recovery limitations (stated plainly)

- A deleted account and its user-private data are **not recoverable**; there is no soft-delete, trash, or reactivation path for the `User` row (`me/route.ts:121-139` — a hard `delete`).
- **Email reuse after deletion creates a fresh account** with empty history — no linkage to the deleted account, no restoration of old data.
- Business-owned data (class B) survives only if ownership was resolved properly first; once a business itself is deleted via the OWNER flow, its data follows the existing business-deletion behavior (documented in `docs/deployment/backup-restore-plan.md` for restore options).

## 10. What this phase does NOT do

- **No email verification** — accounts are usable immediately after signup; address ownership is never proven.
- **No MFA / 2FA** — single factor (password) only.
- **No session device list / management UI** — invalidation is all-or-nothing via `sessionVersion`; you cannot sign out one device specifically.
- **No SMTP wiring** — the `EmailProvider` boundary exists and is ready for adapters (`src/lib/email/index.ts:29-76`), but production has no configured transport; password reset returns a uniform 503 until one is wired (`.env.example` reserves `EMAIL_*`).
- No "recent sign-in" freshness window on deletion — the freshness gate is the session-version check plus password re-entry (`me/route.ts:78-103`), not a login-age check.

## 11. Migration baseline note (Prompt 19)

The Prompt 19 database baseline (`0_init`, `docs/database/prompt19-baseline.md`) captured the existing schema — including `User.sessionVersion` and the `PasswordResetToken` table — as the first committed migration with **zero drift and zero data change**. Signup, password change/reset, session invalidation and account-deletion behavior described in this document are **unchanged** by that round; the only operational change is that future schema touches go through migrations (`docs/database/migration-workflow.md`), and database backups/restores follow `docs/deployment/backup-restore-plan.md` (the file-restore path was drill-verified on a clone in Prompt 19).
