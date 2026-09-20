# Security Findings — 41-Route Audit (Prompt 17 round)

**Document ID:** AUDIT-P17-SEC
**Scope:** Every Route Handler under `src/app/api` (41 `route.ts` files: 39 under `/api/v1`, plus `GET /api` health and `/api/auth/[...nextauth]`), the cross-cutting libs they depend on, and the AI/copilot pipeline.
**Companion docs:** `docs/audit/production-monetization-baseline.md` (scorecard), `docs/security/data-classification.md` (data handling).

---

## 1. Executive verdict

**0 CRITICAL, 0 HIGH.** 4 MEDIUM findings — **all fixed this round**. A set of LOW findings was partially fixed (rate limits, reversal scoping) and partially documented as accepted MVP tradeoffs. Tenant isolation, authentication, authorization (RBAC), and input validation pass on all 41 routes.

No `middleware.ts` exists and no `"use server"` actions exist (grep-verified) — every route self-guards through the pipeline in `src/lib/api-helpers.ts` + `src/lib/tenant.ts`, so there is no route that bypasses AuthN/Tenant/RBAC/Validation by construction.

## 2. MEDIUM findings (all fixed)

### M1 — CSV formula injection in report exports
- **Was:** cells beginning with `=`, `+`, `@`, tab, CR, or a non-numeric `-` were written verbatim into CSV, so spreadsheet apps would execute them as formulas on open.
- **Fix:** `csvCell()` in `src/lib/csv.ts:15-30` prefixes a `'` for those leads while letting plain numeric cells (including negative numbers) through, per OWASP guidance; RFC 4180 quoting unchanged (`src/lib/csv.ts:26-29`). All report/export paths and the shared client helper route through `toCsv`/`csvCell` (`src/lib/csv.ts:36-39`).

### M2 — Import route parsed unbounded request body
- **Was:** `businesses/[id]/import` read `req.json()` with no size gate; a huge payload could exhaust memory before zod ran.
- **Fix:** hard `MAX_BACKUP_BYTES = 25 * 1024 * 1024` check on `content-length` before parsing, rejecting with `413 BACKUP_TOO_LARGE` (`src/app/api/v1/businesses/[id]/import/route.ts:88-91`), layered on the existing 4-per-5-min rate limit (`:72`) and zod row caps.

### M3 — Backup import trusted client money fields
- **Was:** imported `*Minor` fields and statuses were length/integer checked but not cross-checked, so a hand-edited backup could import financially inconsistent rows (overpayments, mismatched totals, wrong status).
- **Fix:** zod refinements in `src/lib/backup-schema.ts`:
  - sale: `totalMinor === subtotalMinor − discountMinor` (`:144-146`), `paidMinor ≤ totalMinor` (`:147-149`), `status === statusOf(totalMinor, paidMinor)` (`:150-152`);
  - sale item: `lineTotalMinor === qty × unitPriceMinor` (`:126-128`);
  - expense: `paidMinor ≤ amountMinor` (`:165-167`) + `status === statusOf(amountMinor, paidMinor)` (`:168-170`);
  - payment: exactly one of `saleId`/`expenseId` (`:183-185`) and `amountMinor > 0` (`:186-188`).

### M4 — Dangling `Business.ownerId` via member removal
- **Was:** `DELETE /api/v1/businesses/[id]/members/[memberId]` allowed removing the member whose `userId === business.ownerId`, leaving `Business.ownerId` pointing at a non-member (no ownership-transfer feature exists).
- **Fix:** the DELETE handler now rejects with `400 OWNER_TRANSFER_REQUIRED` when the target owns the business (`src/app/api/v1/businesses/[id]/members/[memberId]/route.ts:108-117`), alongside the existing last-owner and rank protections (`:118-123`).

## 3. LOW findings

### 3a. Fixed this round

| Item | Fix + reference |
|---|---|
| No rate limit on payment writes | `payments` POST 60/min and DELETE 30/min per user+business (`src/app/api/v1/payments/route.ts:92`, `payments/[id]/route.ts:23`) |
| No rate limit on business creation | 5/hour per user (`src/app/api/v1/businesses/route.ts:79`) |
| No rate limit on invite minting | 30/hour per user+business (`src/app/api/v1/businesses/[id]/invites/route.ts:84`) |
| Payment reversal tx cross-tenant write risk | Reversal transaction now loads the target sale/expense with `businessId: ctx.businessId` filters (`src/app/api/v1/payments/[id]/route.ts:37,46`); the payment itself is loaded `id + businessId` (`:30-32`) |

### 3b. Documented (accepted MVP tradeoffs — no code change)

| Item | Where | Note |
|---|---|---|
| In-memory rate limiter, per-process | `src/lib/rate-limit.ts:1-9` | Resets on restart; not shared across instances. ADR + distributed limiter required for multi-node. |
| Month-filtered lists load whole table | sales/expenses list routes | Per-business tables only; acceptable at MVP scale, revisit with pagination task. |
| Member emails visible to `data:read` roles | members list route | Needed for member management UX; emails are workspace-scoped. |
| Register returns 409 for existing email | `auth/register/route.ts` | Email-enumeration tradeoff for usable onboarding; login is rate-limited. |
| Client can append `role:"assistant"` to own transcript | copilot sessions/messages route | Non-authoritative: answers recomputed per ask from the deterministic snapshot; transcript is display cache (`prisma/schema.prisma:311-319`). |
| No password-change endpoint | — | Users cannot rotate passwords yet; no reset flow either. |
| `audit()` failures logged, not alerted | `src/lib/audit.ts:33-38` | Audit write failure never blocks the mutation; visible in server logs only. |
| Invoice-number race → P2002 → 500 | `Sale @@unique([businessId, number])` | Theoretical only: SQLite serializes writes; surfaced as generic 500, no data corruption. |

## 4. Per-route verdict summary

**41 routes audited; all pass AuthN / Tenant / RBAC / Validation.** Every business-scoped route: `getAuthContext` (session → userId → `X-Business-Id` header → DB membership → role) + `requirePermission` + zod-validated inputs; `[id]` routes load by `id + businessId` pairs and re-check `ctx.businessId === id`. Business identity is never taken from query/body. Notable exceptions to the standard pipeline (all intentional):

| Route | Deviation | Detail |
|---|---|---|
| `GET /api` | Public health | Returns a static message, no data (`src/app/api/route.ts`). |
| `/api/v1/me` | Session-direct | Reads/updates the caller's own profile; no business context required. |
| `/api/v1/invites/[token]` | Token-scoped | GET preview and POST accept both still require a session; the opaque one-time token (`randomBytes(36).toString("base64url")`, `businesses/[id]/invites/route.ts:106`) only designates the business+role, and OWNER is ungrantable via invites (`rbac.ts` rank checks + schema note `prisma/schema.prisma:94`). |
| `/api/auth/[...nextauth]` | NextAuth-owned | Login guarded by 10/5min email+IP limit inside `authorize()` (`src/lib/auth.ts:49-56`). |

Gates verified on sensitive routes: export `settings:manage`; import `settings:manage` **then OWNER-only** (`businesses/[id]/import/route.ts:61-70`); danger/delete `business:delete` (OWNER-only by matrix); copilot `copilot:use` (VIEWER excluded); audit view `audit:read`; payments `finance:manage`.

## 5. Regression coverage — `scripts/prompt17-security-check.mjs`

New HTTP harness this round (sibling of `scripts/e2e-smoke.ts`; run against a dev server). It asserts the audit fixes stay fixed:

1. **M1:** export CSV rows never contain an executable formula lead (`=`, `+`, `@`, tab, CR, non-numeric `-`) unguarded in the first cell position of any exported field.
2. **M2:** an oversized import payload (Content-Length > 25 MB simulated/declared) is rejected `413` with code `BACKUP_TOO_LARGE` before any parse.
3. **M3:** mutated backups are rejected by the import dry-run — tampered `totalMinor` (≠ subtotal−discount), `paidMinor > totalMinor`, wrong `status`, `lineTotalMinor ≠ qty × unitPriceMinor`, overpaid expense, non-positive payment — each surfaced as a per-row invalid/conflict, not a silent import.
4. **M4:** `DELETE` on the member row whose user owns the business returns `400 OWNER_TRANSFER_REQUIRED`.
5. **LOW regressions:** payment POST beyond 60/min and DELETE beyond 30/min → `429`; 6th business creation within an hour → `429`; 31st invite within an hour → `429`.
6. **Isolation spot-checks:** cross-business `[id]` access with a foreign `X-Business-Id` → `403`; VIEWER blocked from copilot/import; ADMIN blocked from OWNER-only import and business delete.

Exit 0 = all green; failures print per-check. It is the security regression gate for future rounds until a CI test framework lands (scorecard #15).

## 6. Residual risks

- **Single-process limiter:** a multi-instance deployment silently weakens every limit in §3a until the documented ADR/distributed limiter exists.
- **No password reset/change + no email delivery:** account recovery is currently impossible without DB access; acceptable for closed MVP, a launch blocker for public signup.
- **Audit log is tamper-visible, not tamper-proof:** any OWNER/ADMIN with `audit:read` can view but the log has no integrity chain; DB file access = full log access.
- **Email enumeration via login timing/register 409:** mitigated by rate limits, not eliminated.
- **SQLite single file:** backup discipline is procedural (manual file copy + export/import); a corrupt file without a fresh backup is unrecoverable (`docs/deployment/backup-restore-plan.md`).
- **Transcript self-appends:** the copilot history can be cosmetically polluted by its owner; no security impact because answers are recomputed server-side.
