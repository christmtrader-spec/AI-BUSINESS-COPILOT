# Data Retention Inventory — AI Business Copilot

**Document ID:** LEGAL-DRI-v1
**Phase:** Prompt 27 documentation (§73) — **STATUS: DESCRIPTIVE INVENTORY** (policies that exist are named; everything else says so honestly)
**Source of truth:** `prisma/schema.prisma`, deletion/rotation code paths (`src/lib/auth.ts`, `src/lib/security/*` for reset tokens), billing services, `src/lib/ai/cost/*`
**Companion docs:** `docs/legal/data-processing-inventory.md` (what the categories are) · `docs/legal/data-deletion-matrix.md` (what each deletion operation removes) · `docs/legal/user-data-rights.md` (how a person reaches these controls) · sibling Prompt 27 docs: `docs/legal/data-flow.md` · `docs/legal/service-providers.md`

> **Honesty rules.** NO compliance claim is made. **No retention period is invented.** Where no
> policy is configured, the row reads **CURRENTLY NOT EXPLICITLY CONFIGURED** — that phrase is the
> expected value for most rows and is not a defect of this document. Status vocabulary:
> `DELETED` / `ANONYMIZED` / `RETAINED` / `DEPENDENT` / `NOT CURRENTLY AUTOMATED` /
> `UNKNOWN-REVIEW REQUIRED` / `CURRENTLY NOT EXPLICITLY CONFIGURED` / `NOT IMPLEMENTED`.
> The public pages `/privacy`, `/terms`, `/ai-data-use`, `/cookies` (content version
> `2026-09-v1`, `effectiveDate` null) describe the same system to users.

---

## 1. Retention principles actually implemented

1. **Cascade-on-delete is the only general-purpose deletion mechanism.** Business data is deleted
   when the business is deleted (hard cascade); user-personal data is deleted when the account is
   deleted. There is no time-based purge for tenant data.
2. **Financial records use soft delete in normal operations** (`deletedAt` on Sale/Expense/Payment
   — a reversal/void, not a purge). Soft-deleted rows are **RETAINED** indefinitely as historical
   financial records. **Business deletion is a hard cascade** and removes soft-deleted rows too —
   see §4 for the active-state vs historical-record distinction.
3. **Append-only ledgers are retained:** `AuditLog` (no update/delete endpoints exist), commercial
   events, AI cost records, webhook replay ledger.
4. **The only time-based expiries implemented** are deliberate and narrow: `PasswordResetToken`
   (30-min single-use), `CheckoutSession` (30-min expiry), the funnel cookie (180-day client-side
   max-age). Nothing else auto-expires.

## 2. Inventory

Columns: **Policy** = the rule as configured today (or the honest absence of one).
**Implementation** = the code path that enforces it. **Deletion method** = how rows ever leave the
database. Categories mirror `docs/legal/data-processing-inventory.md` §4.

| Data category | Purpose · storage | Retention policy | Current implementation | Deletion method | Notes |
|---|---|---|---|---|---|
| User identity | Auth + account · `User` | CURRENTLY NOT EXPLICITLY CONFIGURED (kept while account exists) | Account deletion `DELETE /api/v1/me` (fresh-session gate + password + typed "DELETE" + rate limit 5/15min) | Hard `user.delete` | Blocked while user owns any business (409 `OWNED_BUSINESS_BLOCKED`) |
| Business identity | Tenant config · `Business` | CURRENTLY NOT EXPLICITLY CONFIGURED | Business deletion `DELETE /api/v1/businesses/[id]` (OWNER-only, typed name confirmation) | Hard `db.business.delete` cascade | `GET .../danger` returns counts first |
| Business financial data (derived) | KPIs, reports, outstanding balances | Not stored — computed per request | Report/dashboard queries | n/a (nothing persists) | Only the underlying records below persist |
| Customer data | Sales-side parties · `Customer` | CURRENTLY NOT EXPLICITLY CONFIGURED | Soft delete (`deletedAt`) in normal ops; **no purge job exists** | Business deletion cascade (hard, incl. soft-deleted rows) | Historical records retained until business deletion |
| Supplier data | Expense-side parties · `Supplier` | Same as Customer | Same | Same | Same |
| Product data | Catalog + stock · `Product`, `InventoryAdjustment` | CURRENTLY NOT EXPLICITLY CONFIGURED | Product soft delete; adjustments hard rows | Business deletion cascade | Adjustment actor link SetNull on user deletion |
| Sales | Revenue records · `Sale`+`SaleItem` | CURRENTLY NOT EXPLICITLY CONFIGURED (historical records kept) | Soft delete; no purge | Business deletion cascade | `@@unique([businessId, number])` history intact until cascade |
| Expenses | Cost records · `Expense` | Same as Sales | Soft delete; no purge | Business deletion cascade | |
| Payments (business finance) | Cash in/out · `Payment` | Same as Sales | Deletion = audited reversal pipeline; no purge | Business deletion cascade | Actor SetNull on user deletion |
| AI prompts | Copilot questions · `ChatMessage` (role USER) + grounding snapshot built per ask | CURRENTLY NOT EXPLICITLY CONFIGURED | Persisted in `ChatSession`/`ChatMessage` per business+user; failed requests never synced | Session delete (user-initiated), account deletion, business deletion | Snapshot DTO never persisted as such |
| AI responses | Copilot answers · `ChatMessage` (role ASSISTANT) | Same as prompts | Same persistence | Same | Citations in `metaJson` |
| AI usage metadata | Metering · `UsageEvent` (+`UsagePeriod`/`UsageCounter`) | CURRENTLY NOT EXPLICITLY CONFIGURED | Written per AI request (COMMITTED/RELEASED) | Business deletion cascade | No prompt/response content in usage ledgers |
| Commercial events | First-party funnel · `CommercialEvent` | CURRENTLY NOT EXPLICITLY CONFIGURED — **no TTL, no purge** | Append-only directory; `eventType`+`dedupeKey` idempotency | None implemented | **RETAINED** across both account and business deletion (plain String refs, no FK) |
| Subscription data | Plan state · `Subscription` + `SubscriptionEvent` | CURRENTLY NOT EXPLICITLY CONFIGURED | State machine rows; ended subscriptions never deleted by design (`docs/billing/subscription-lifecycle.md`) | Business deletion cascade | **Trial records** = `TRIALING` subscriptions + `TRIAL_STARTED`/`TRIAL_ENDED` events; trials disabled by default (`BILLING_TRIALS_ENABLED` unset); trial length validated 1..90 days but no record-retention policy configured |
| Payment records (platform billing) | Checkout + settlement · `CheckoutSession`, `PaymentTransaction` | Checkout sessions expire after **30 minutes** (lazy expiry + auto-heal); transaction records CURRENTLY NOT EXPLICITLY CONFIGURED | `docs/billing/payment-current-state.md`; idempotency by `[provider, providerEventId]` | Business deletion cascade | Mock provider active; Zarinpal sandbox adapter; production NOT active |
| Security logs | Reset tokens, session invalidation, rate-limit state, auth audit rows | `PasswordResetToken`: **expiresAt 30 min, single-use** + **opportunistic cleanup** of expired tokens; rest CURRENTLY NOT EXPLICITLY CONFIGURED | Reset flow (`tokenHash` SHA-256, `requestedIp`, UA); `sessionVersion` bump on password change/reset; in-memory rate limiter | Token rows: consumed/expire+cleanup, or user-deletion cascade; auth audit rows (e.g. `auth.account_deleted`, businessId null) **RETAINED** | Rate-limit buckets are process memory only — no durable store, lost on restart |
| Audit logs | Change history · `AuditLog` | CURRENTLY NOT EXPLICITLY CONFIGURED (business trail kept for business lifetime) | Append-only; write-only via `audit()` helper; no update/delete endpoints | Business deletion cascade (tenant trail); actor link SetNull on account deletion | Platform-level rows (businessId null) **RETAINED** across everything |
| AI cost records | Cost ledger + anomalies · `AiCostRecord`, `AiCostAnomaly` | **Never auto-deleted** — no delete path exists | Append-only; reconciliation (`reconcileAiCosts`) never rewrites KNOWN records | None implemented | **RETAINED** across business deletion (businessId plain String, no FK); anomaly lifecycle is status-based (OPEN/ACKNOWLEDGED/RESOLVED), not deletion |
| Provider rate metadata | Internal rate registry · `AiCostRate` | **Never auto-deleted**; deactivate-not-delete | `createAiCostRate`/`verifyAiCostRate`/deactivation in `src/lib/ai/cost/rates.ts` | None implemented | Historical rate versions preserved for correct past-cost reconstruction |
| Legal acceptance records | Contract evidence · `LegalAcceptance` (append-only, unique `[userId,documentType,documentVersion]`) | CURRENTLY NOT EXPLICITLY CONFIGURED | Written at signup (optional `acceptedLegal` on register) and via `POST /api/v1/legal/acceptance` (server resolves version) | **User deletion cascade only** | Not affected by business deletion |
| Funnel cookie | `copilot_funnel` identity | **180 days** (client-side max-age), `SameSite=Lax`, `Path=/`, first-party | `src/lib/funnel-cookie.ts` | Browser cookie expiry | Server-side linked events (CommercialEvent) have no matching TTL — gap noted |
| Webhook events | Replay ledger · `ProcessedWebhookEvent` | CURRENTLY NOT EXPLICITLY CONFIGURED — no purge | Idempotent insert keyed by provider event id | None implemented | RETAINED |
| Contact leads | — | — | — | — | **NOT IMPLEMENTED** — no model, no form, no storage; pricing CTA is `mailto:` driven by `NEXT_PUBLIC_SALES_CONTACT` (disabled when unset) |

## 3. Historical financial records vs active account state

Two different kinds of "retained" exist and must not be conflated:

| | Active account state | Historical financial records |
|---|---|---|
| Examples | `User`, `BusinessMember`, `Subscription` (current), `LegalAcceptance`, chat sessions | `Sale`/`Expense`/`Payment` rows incl. soft-deleted (`deletedAt`), `SubscriptionEvent` history, `AuditLog` |
| What "retained" means | Live rows that operate the account/tenant | Past records kept because the ledger is the product; soft delete preserves history |
| When removed | Account deletion (user-personal) or business deletion (tenant data) — the only implemented exits | **Only** business deletion (hard cascade). No purge job, no archive step, no legal-hold flag — all **NOT IMPLEMENTED** |
| Policy | CURRENTLY NOT EXPLICITLY CONFIGURED | CURRENTLY NOT EXPLICITLY CONFIGURED |

## 4. Policy gaps (the honest list)

- Time-based retention policies for tenant data, audit logs, commercial events, AI cost ledgers,
  and webhook ledger: **CURRENTLY NOT EXPLICITLY CONFIGURED** across the board. Deletion happens
  only through the two explicit operations in `docs/legal/data-deletion-matrix.md`.
- Backup/snapshot retention (SQLite `db/custom.db`, `db/backups/*`): operational topic documented
  in `docs/deployment/backup-restore-plan.md`; **no retention policy configured there either**.
- The funnel cookie's 180-day max-age is the only user-facing expiry; no server-side TTL matches
  it for the corresponding CommercialEvent rows.
- Dangling references after deletion (CommercialEvent `userId?`/`businessId?`, AiCostRecord
  `businessId`) are plain strings that no longer resolve — they are **RETAINED as-is**
  (not ANONYMIZED, not rewritten). Whether that state is acceptable is UNKNOWN-REVIEW REQUIRED.

## 5. Current state (honest)

- Implemented expiries, complete list: `PasswordResetToken` 30-min single-use (+ opportunistic
  cleanup), `CheckoutSession` 30-min expiry, funnel cookie 180-day max-age. That is **all**.
- Implemented deletion exits, complete list: account deletion (gated, user-personal cascade) and
  business deletion (OWNER-only hard cascade). Everything else is RETAINED until one of those
  fires, or forever for the no-FK ledgers (commercial events, AI cost records, AI cost rates,
  webhook ledger, platform-level audit rows).
- Every "CURRENTLY NOT EXPLICITLY CONFIGURED" above is a decision someone still has to make;
  this document intentionally does not guess the numbers. Legal pages (version `2026-09-v1`)
  make the same honest statements to users and carry the internal `legalReviewRequired` marker
  with `effectiveDate` null until review closes.
