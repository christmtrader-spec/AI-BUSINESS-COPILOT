# Data Deletion Matrix — AI Business Copilot

**Document ID:** LEGAL-DDM-v1
**Phase:** Prompt 27 documentation (§22/§76) — **STATUS: DESCRIPTIVE MATRIX** (states below are exactly what the shipped code does)
**Source of truth:** `prisma/schema.prisma` (cascade/SetNull relations, re-verified line-by-line while writing this matrix), `DELETE /api/v1/me` (Prompt 18 account lifecycle), `DELETE /api/v1/businesses/[id]` + `/danger` (Prompt 7-era owner flow)
**Companion docs:** `docs/legal/data-processing-inventory.md` · `docs/legal/data-retention-inventory.md` · `docs/legal/user-data-rights.md` · `docs/security/account-lifecycle.md` · sibling Prompt 27 docs: `docs/legal/data-flow.md` · `docs/legal/service-providers.md`

> **Honesty rules.** NO compliance claim. Every cell uses only states the implementation
> supports: `DELETED` / `ANONYMIZED` / `RETAINED` / `DEPENDENT` / `NOT CURRENTLY AUTOMATED` /
> `UNKNOWN-REVIEW REQUIRED` / `CURRENTLY NOT EXPLICITLY CONFIGURED` / `NOT IMPLEMENTED`.
> No invented grace periods, no invented anonymization. Schema note: the Phase-0 audit
> summarized some user relations as cascades; the schema was re-verified — actor-style relations
> (`Payment.actor`, `InventoryAdjustment.actor`, `BusinessInvite.createdBy/acceptedBy`,
> `SubscriptionEvent.actor`, `AuditLog.actor`) are **`onDelete: SetNull`**: the row survives, the
> personal actor link is removed.

---

## 1. Two different operations — do not conflate

| | **DELETE ACCOUNT** — `DELETE /api/v1/me` | **DELETE BUSINESS** — `DELETE /api/v1/businesses/[id]` |
|---|---|---|
| Who | The account owner themselves | Business OWNER only (RBAC-enforced) |
| Gates | Fresh-session assertion + current password + typed `"DELETE"` + rate limit 5/15 min | Typed **current business name** confirmation; `GET .../danger` returns counts first |
| Scope | The user row + user-personal data (memberships, chats, reset tokens, legal acceptances) + actor-link nulling | One `db.business.delete` — every business-scoped table cascades |
| Platform effect | Writes audit `auth.account_deleted` with `businessId` null (platform-level, RETAINED) | No platform-level tombstone; the tenant audit trail itself is cascaded away |
| Blocking rule | **409 `OWNED_BUSINESS_BLOCKED`** while the user owns any business (structured error incl. the owned list) | Account deletion of the owner is unaffected (business already gone) |
| What it can never do | Delete businesses of others, their data, or platform ledgers | Delete the (former) owner's account, other businesses, or the no-FK platform ledgers |

## 2. Deletion matrix

**User Deletion** = effect of `DELETE /api/v1/me`. **Business Deletion** = effect of
`DELETE /api/v1/businesses/[id]`. **Independent Retention** = what exists outside both
operations. Status vocabulary as in the banner.

| Data Type | User Deletion | Business Deletion | Independent Retention | Status |
|---|---|---|---|---|
| User | **DELETED** (hard `user.delete`, gated) | n/a — blocked first (`OWNED_BUSINESS_BLOCKED`) | Kept while account exists; no TTL | DEPENDENT |
| Business | n/a — owner-block prevents user deletion; business itself untouched | **DELETED** (OWNER-only, typed name) | Kept while tenant exists | DEPENDENT |
| Membership | **DELETED** (cascade); businesses of others survive | **DELETED** (cascade) | — | DEPENDENT |
| Customer | NOT AFFECTED (business-owned) | **DELETED** (hard cascade, incl. soft-deleted rows) | Soft delete (`deletedAt`) retains history; no purge | DEPENDENT |
| Supplier | NOT AFFECTED (business-owned) | **DELETED** (hard cascade, incl. soft-deleted) | Soft delete; no purge | DEPENDENT |
| Product | NOT AFFECTED (business-owned) | **DELETED** (cascade) | Soft delete on product rows; no purge | DEPENDENT |
| Sale | NOT AFFECTED (business-owned) | **DELETED** (`Sale`+`SaleItem` cascade) | Soft delete retains history; no purge | DEPENDENT |
| Expense | NOT AFFECTED (business-owned) | **DELETED** (cascade) | Soft delete; no purge | DEPENDENT |
| Payment | NOT AFFECTED; `actorId` **SetNull** (link removed, record stays with business) | **DELETED** (cascade) | Soft delete/reversal; no purge | DEPENDENT |
| AI Session | **DELETED** (cascade); also user-initiated per-session delete | **DELETED** (cascade) | — | DEPENDENT |
| AI Message | **DELETED** (cascade via session and direct user relation) | **DELETED** (cascade) | Failed requests never synced (local only) | DEPENDENT |
| Usage (UsagePeriod/UsageCounter/UsageEvent) | NOT AFFECTED (business-scoped) | **DELETED** (cascade) | — | DEPENDENT |
| DataExportJob (Prompt 31) | NOT AFFECTED (business-owned) | **DELETED** (cascade) | Job row tied to business lifetime; its artifact file expires at the operational TTL and is removed by `scripts/prune-expired-exports.mjs` | DEPENDENT + operational TTL |
| DataImportJob (Prompt 31) | NOT AFFECTED (business-owned) | **DELETED** (cascade) | Staged upload file deleted on cancel and by the TTL (`IMPORT_FILE_TTL_HOURS`) via `scripts/prune-expired-imports.mjs`; error-report metadata lives with the row | DEPENDENT + operational TTL |
| Subscription (+ SubscriptionEvent) | NOT AFFECTED; event `actorId` **SetNull** | **DELETED** (cascade) | Ended subscriptions never deleted by design while the business lives (`docs/billing/subscription-lifecycle.md`) | DEPENDENT |
| Checkout (CheckoutSession) | NOT AFFECTED (business-scoped) | **DELETED** (cascade) | 30-min session expiry (lazy) is a lifecycle state, not deletion | DEPENDENT |
| Payment Transaction | NOT AFFECTED (business-scoped) | **DELETED** (cascade; idempotency anchor `[provider, providerEventId]` goes with it) | — | DEPENDENT |
| Audit Log | Log rows **RETAINED**; `actorId` **SetNull** (**ANONYMIZED** actor link — not row deletion); platform-level rows (`businessId` null, e.g. `auth.account_deleted`) **RETAINED** | **DELETED** — the entire tenant trail cascades with the business | Append-only; no update/delete endpoints; no purge job | DEPENDENT (tenant trail) / RETAINED (platform rows) |
| Commercial Events | NOT AFFECTED — `userId?` is a plain String, no FK; dangling id remains (not ANONYMIZED) | NOT AFFECTED — `businessId?` plain String, no FK; dangling id remains | **RETAINED** unconditionally; no TTL, no purge | RETAINED |
| AI Cost (AiCostRecord, AiCostAnomaly) | NOT AFFECTED (no user FK; user linkage absent by design) | NOT AFFECTED — `businessId` plain String; dangling id remains | **RETAINED** — never auto-deleted, no delete path | RETAINED |
| Contact Lead | — | — | — | **NOT IMPLEMENTED** (no model, no storage) |
| LegalAcceptance | **DELETED** (cascade) | NOT AFFECTED (user-level evidence) | Append-only while account exists | DEPENDENT |
| PasswordResetToken | **DELETED** (cascade) | NOT AFFECTED (user-level) | 30-min single-use expiry + opportunistic cleanup | DEPENDENT + time-based |
| PlatformOperator (Prompt 28) | **DELETED** (cascade via `userId` — a deleted account can never leave a privileged row behind; no orphan, no silent preserved access) | NOT AFFECTED (platform-level; unrelated to business deletion) | Exists while the backing user exists; `active=false` is reversible deactivation, not deletion | DEPENDENT |
| PlatformAuditLog (Prompt 28) | Rows **RETAINED**; `operatorId` **SetNull** (operator link removed, row stays — role is snapshotted so the record stays interpretable) | NOT AFFECTED — deliberately NO business foreign key; target ids are plain strings, so platform audit survives business deletion by design | Append-orientation: no update/delete code paths; **retention period CURRENTLY NOT EXPLICITLY CONFIGURED** (no purge job, no invented number) | RETAINED (retention policy undefined) |
| EmailVerificationToken (Prompt 30) | **DELETED** (cascade) | NOT AFFECTED (user-level) | 30-min single-use expiry (`usedAt`/`expiresAt`) + opportunistic cleanup on the same rate-limited flows + `scripts/prune-auth-security.mjs` | DEPENDENT + time-based |
| MfaCredential (Prompt 30) | **DELETED** (cascade) — the encrypted TOTP secret never outlives the account | NOT AFFECTED (user-level) | Deleted earlier by an explicit MFA disable (password + MFA + typed confirmation); exists while enrolled otherwise | DEPENDENT |
| MfaRecoveryCode (Prompt 30) | **DELETED** (cascade) — hash-only rows | NOT AFFECTED (user-level) | Replaced wholesale by regeneration (old unused set deleted in the same transaction); consumed codes keep `usedAt` until then | DEPENDENT |
| MfaLoginChallenge (Prompt 30) | **DELETED** (cascade) | NOT AFFECTED (user-level) | 5-minute TTL (`MFA_CHALLENGE_TTL_SECONDS`, bounded 60–900) + invalidated by sessionVersion changes; pruned by `scripts/prune-auth-security.mjs` | DEPENDENT + time-based |
| UserSession (Prompt 30) | **DELETED** (cascade) | NOT AFFECTED (user-level) | 30-day expiry aligned with the JWT maxAge; per-device revocation sets `revokedAt`; expired/revoked rows pruned by `scripts/prune-auth-security.mjs`; last-seen updates throttled (300s default) | DEPENDENT + time-based |
| SecurityEvent (Prompt 30) | **DELETED** (cascade) — privacy-first choice: per-user security history does NOT survive the account | NOT AFFECTED (user-level; business events are not recorded here — the tenant trail is `AuditLog`) | No independent TTL configured (CURRENTLY NOT EXPLICITLY CONFIGURED); high-risk events are only written from rate-limited paths | DEPENDENT (retention policy undefined) |
| Notification (Prompt 32) | **DELETED** (cascade via `userId`) | Business-scoped notifications **DELETED** (cascade via `businessId`); user-level security notifications survive the business | Inactive rows (read/archived/expired) removed by operational cleanup `scripts/prune-expired-notifications.mjs` (non-security 90d / security 365d defaults) — documented in Prompt 32 (§200/§201/§455/§456) | DEPENDENT + operational cleanup |
| NotificationPreference (Prompt 32) | **DELETED** (cascade via `userId`) | NOT AFFECTED (user-level) | Exists while the account exists | DEPENDENT |
| NotificationDelivery (Prompt 32) | **DELETED** (cascade via the parent Notification) | **DELETED** with the parent Notification | Shares the notification's lifetime (cascade) — no independent retention | DEPENDENT |
| InventoryStocktake (+ InventoryStocktakeLine) (Prompt 40) | NOT AFFECTED (business-owned); creator/counter links are `onDelete: Restrict` — see the Prompt 40 section below | **DELETED** (cascade; lines cascade with their session) | — | DEPENDENT |

## 3. Dependency walk-through (documentation-only "dry run")

This is an on-paper walk-through of what each operation touches, in dependency order. **No
mutation happens here and no dry-run/preview API is implemented** — the closest shipped feature
is `GET /api/v1/businesses/[id]/danger` (pre-deletion counts). Any automated preview would be
**NOT IMPLEMENTED** today.

```
USER ──DELETE /api/v1/me──▶  [gate: fresh session + password + MFA if enrolled + "DELETE" + 5/15min]
  ├─ deletes: User · Memberships · ChatSessions+ChatMessages · PasswordResetTokens
  │           · LegalAcceptances
  ├─ deletes (Prompt 30, all cascade): EmailVerificationTokens · MfaCredential ·
  │           MfaRecoveryCodes · MfaLoginChallenges · UserSessions · SecurityEvents
  ├─ nulls (SetNull): Payment.actor · InventoryAdjustment.actor · SubscriptionEvent.actor
  │           · BusinessInvite.createdBy/acceptedBy · AuditLog.actor
  ├─ BLOCKS (409 OWNED_BUSINESS_BLOCKED + owned list) while user owns ANY business
  └─ survives: businesses of others + ALL business data · CommercialEvent (userId dangling)
              · AiCostRecord/AiCostAnomaly/AiCostRate · ProcessedWebhookEvent
              · platform audit rows (auth.account_deleted, businessId=null)

BUSINESS ──DELETE /api/v1/businesses/[id]──▶  [gate: OWNER + GET /danger counts + typed name]
  ├─ single db.business.delete cascades: BusinessMember · BusinessInvite · Customer · Supplier
  │           · Product · InventoryAdjustment · Sale(+SaleItem) · Expense · Payment
  │           · ChatSession(+ChatMessage) · UsagePeriod(+UsageCounter+UsageEvent)
  │           · Subscription(+SubscriptionEvent) · CheckoutSession(+PaymentTransaction)
  │           · AuditLog (entire tenant trail)
  └─ survives: owner/members User rows · CommercialEvent (businessId dangling)
              · AiCostRecord/AiCostAnomaly/AiCostRate · ProcessedWebhookEvent
              · platform-level audit rows
```

Policy-dependent leftovers (survive both operations; **what remains is a policy question, not a
code path** — see `docs/legal/data-retention-inventory.md` §4): the four no-FK ledgers plus
dangling id strings. Nothing rewrites or anonymizes them — NOT CURRENTLY AUTOMATED.

## 4. Deletion-ownership rules

1. **A member cannot delete business-owned data via account deletion.** Customers, suppliers,
   products, sales, expenses, payments, usage, subscriptions, checkout/payment transactions belong
   to the business context. Account deletion cascades only user-personal rows; it never reaches
   business tables (and for the businesses a user merely belongs to, even the membership rows
   disappear while the business and its data survive untouched).
2. **Owner-block:** account deletion returns **409 `OWNED_BUSINESS_BLOCKED`** with the list of
   owned businesses while the user owns any of them. The user must delete or transfer each
   business first — the platform never deletes a business as a side effect of account deletion.
3. **Business deletion is OWNER-only** and requires typing the **current** business name (not a
   fixed phrase), after seeing real counts via `/danger`. One transaction, one `business.delete`
   — the cascade is the deletion mechanism, so partial states are not possible.
4. **No role can delete audit history**: `AuditLog` has no update/delete endpoints at all; the
   only way tenant audit rows leave the database is business deletion itself.

## 5. Structured-error honesty

- Account deletion while owning businesses fails with **409 `OWNED_BUSINESS_BLOCKED`** and an
  owned-business list in the payload — the client can render exactly what blocks the operation;
  nothing fails silently or "cleans up around" the blocker.
- Other gates surface as structured errors too: fresh-session failure, wrong password, missing
  typed `"DELETE"` confirmation, and the 5-per-15-min rate limit (429). Business deletion fails
  closed on role (non-OWNER), name mismatch, and rate limiting — no partial deletion is ever
  attempted before all gates pass (counts via `/danger` are read-only).
- Per-session AI data removal is separate and narrower: `DELETE /api/v1/copilot/sessions/[id]`
  removes one conversation (session + messages) for the owning user — it is not an account-level
  operation and appears in `docs/legal/user-data-rights.md` §2 as a product control.

## 6. Current state (honest)

- **DELETED is real but only via two operations** (account, business) plus two narrow extras
  (per-session copilot delete; reset-token expiry+cleanup). There is no bulk erasure, no
  scheduled purge, no anonymization job — all NOT CURRENTLY AUTOMATED.
- **ANONYMIZED appears exactly once** in this matrix: audit-log actor links nulled by SetNull on
  account deletion. Dangling CommercialEvent/AiCostRecord ids after business deletion are
  **RETAINED as-is**, not anonymized — whether that needs rework is UNKNOWN-REVIEW REQUIRED.
- Deleting the tenant audit trail with the business is the implemented behavior; whether an
  operation requires preserving parts of it is an unmade policy decision (CURRENTLY NOT EXPLICITLY
  CONFIGURED).
- Contact leads: NOT IMPLEMENTED — there is nothing to delete.
- Prompt 30 security records are all user-owned with `onDelete: Cascade`: account deletion
  removes email-verification tokens, the MFA credential (encrypted secret), recovery-code
  hashes, login challenges, session-registry rows AND per-user SecurityEvents. This is a
  privacy-first design choice — **security history does not survive the account**, and this
  matrix describes that behavior exactly (verified by `scripts/privacy-deletion-check.mjs`).
- Prompt 32 notification records follow the same cascade law: `Notification`,
  `NotificationPreference` (via `userId`) and `NotificationDelivery` (via the parent
  notification) are deleted immediately with the account. Business deletion removes
  business-scoped notifications while user-level security notifications survive — a member's
  security history is not business data. The notification archive is a UX state, never a
  deletion path; the only non-cascade removal is the operational cleanup script, which
  deletes only inactive (read/archived/expired) rows past the retention windows.
- Cross-checks: category definitions in `docs/legal/data-processing-inventory.md`; retention
  statuses in `docs/legal/data-retention-inventory.md`; how a person reaches the two operations
  from the product in `docs/legal/user-data-rights.md`; public descriptions on `/privacy`,
  `/terms`, `/ai-data-use`, `/cookies` (content version `2026-09-v1`).

## CRM (Prompt 35)

| Event | CRM effect |
|---|---|
| Business deletion | `CrmLead` / `CrmOpportunity` DELETED (cascade) — CRM rows never outlive the tenant. |
| Lead delete (user action) | Soft delete (`deletedAt`): hidden from lists/search/summary; audit remains. Converted `Customer` is NEVER touched (§68). |
| Opportunity delete (user action) | Soft delete (`deletedAt`): hidden from lists/search/summary; audit remains. No financial effect. |
| Account deletion | `assignedToUserId` links SET NULL (the CRM rows are business data and stay with the business). |
| Customer deletion (soft) | CRM links resolve as "not found" (queries filter `deletedAt: null` on the customer side); CRM rows are not destroyed. |

### CRM Activities & Tasks (Prompt 36)

| Event | CRM effect |
|---|---|
| Business deletion | `CrmActivity` / `CrmTask` DELETED (cascade). |
| Activity/Task delete (user action) | Soft delete (`deletedAt`): hidden from timeline/lists/work queue/export-active; audit remains (§23/§28). Deleting a task never deletes its customer/lead/opportunity, any activity, or any financial record. |
| Account deletion | `CrmTask.assignedToUserId` SET NULL. Creator links (`createdByUserId`) are `onDelete: Restrict` — the same project-specific policy as other creator-linked records: account deletion is gated by the existing rules and the tenant rows are not silently rewritten; documented here BEFORE the migration (§61 honesty rule). |
| Customer/Lead/Opportunity deletion (soft) | Rows remain (tenant data per retention policy) but disappear from ACTIVE timelines (queries filter `deletedAt: null` on the context side, §104). No automatic cross-context reassignment (§126). |
| Context deletion (hard cascade path) | Context column SET NULL (schema `onDelete: SetNull`); the history row itself is not destroyed by the context going away. |

## Purchase Orders (Prompt 41)

| Event | Purchase order effect |
|---|---|
| Business deletion | `PurchaseOrder` + `PurchaseOrderLine` DELETED (cascade via the tenant FK). The supplier/product FKs are `Restrict`, but business deletion removes the tenant rows first, so procurement history never outlives the tenant. |
| Document deletion (user action) | **NO user-facing delete exists** for purchase orders — terminal documents (CLOSED/CANCELLED) are immutable records; CANCELLED is the only "discard" path and it is a lifecycle state, not a deletion. No destructive user-facing delete of terminal documents is introduced. |
| Supplier soft-delete | Documents remain fully readable (snapshot identity); `DRAFT → SENT` is blocked while the supplier is deleted. Nothing is destroyed. |
| Product soft-delete | Lines and their snapshots remain; document stays readable. |
| Account deletion | `createdByUserId` is `onDelete: Restrict` (creator-linked policy): account deletion is gated by the existing rules; tenant rows are not silently rewritten. The audit trail keeps `actorId` history per the audit retention rules. |
| Audit retention | `purchase_order.*` audit rows (create/update/line_add/line_update/line_remove/send/confirm/close/cancel) follow the standard AuditLog retention — business-scoped, deleted with the business; bodies carry metadata only (never notes content, never secrets). |

### Inventory Stocktake (Prompt 40)

| Event | Effect |
|---|---|
| Business deletion | `InventoryStocktake` / `InventoryStocktakeLine` **DELETED** (cascade; lines cascade with their session) — count sessions never outlive the tenant. |
| Account deletion | `createdByUserId` (session creator) and `countedByUserId` (line counter) are `onDelete: Restrict` — the same creator-linked policy as CRM creator-linked records: account deletion is gated by the existing rules and the tenant rows are not silently rewritten; documented here BEFORE the migration. |
| User-facing hard delete | **NONE.** No DELETE endpoint exists for stocktake records; a session that should not reconcile ends via **Cancel** (terminal, immutable) — cancellation removes no data and changes no stock. |
| Notes field | Optional free text (≤ 2000 chars) may contain user-entered content; it is **never logged, never audited, never sent to AI**, and survives exactly as long as its session. |


## Goods Receipt lifecycle (Prompt 42)

| Aspect | Policy |
| --- | --- |
| Lifecycle | `DRAFT → POSTED / CANCELLED`; `POSTED` and `CANCELLED` are terminal |
| User-facing hard delete | **None** — receipts have no delete endpoint; document retention is the lifecycle immutability strategy |
| Posted receipt | Immutable historical inventory evidence (stock already moved; `InventoryAdjustment` rows exist). No edit, no cancel, no reversal — a genuine reversal workflow is a separate future prompt |
| Cancelled receipt | Terminal, read-only; never mutated stock so there is nothing to reverse |
| Business-level deletion | Governed by the existing tenant deletion policy: `GoodsReceipt`/`GoodsReceiptLine` cascade with the business (tenant offboarding removes its receiving history); `GoodsReturn`/`GoodsReturnLine` (Prompt 43) cascade with the business AND with their source receipt (a return never outlives its receipt — the FK only ever fires at business deletion because returns have no user-facing delete); creator links are `Restrict` (same policy as P40/P41/P42 documents); product links are `Restrict` so soft-deleted products keep their return history |
| Sales orders (Prompt 45) | `SalesOrder`/`SalesOrderLine` cascade with the business; the customer link is `SetNull` with the frozen `customerNameAtOrder` snapshot keeping every order readable after the live relation detaches; the ONE linked `Sale` is detached (`SetNull`) rather than destroyed — invoice evidence outlives the order; product links are `Restrict` (soft-delete keeps history); the creator link is `Restrict` (same creator-linked policy as P40–P44) |
| Purchase order interaction | A PO with posted receipts cannot be cancelled (`PURCHASE_ORDER_HAS_POSTED_RECEIPTS`); PO deletion is only ever the business-cascade path |
