# User Data Rights — Technical Capabilities — AI Business Copilot

**Document ID:** LEGAL-UDR-v1
**Phase:** Prompt 27 documentation (§25/§81/§151/§159) — **STATUS: CAPABILITY MAP** (product controls today; explicitly not a statement of legal rights)
**Source of truth:** `src/app/api/v1/me/*`, `src/app/api/v1/businesses/[id]/export`, `src/app/api/v1/copilot/sessions/[id]`, `src/app/api/v1/legal/*`, `src/content/legal/registry.ts`
**Companion docs:** `docs/legal/data-processing-inventory.md` · `docs/legal/data-retention-inventory.md` · `docs/legal/data-deletion-matrix.md` · `docs/security/account-lifecycle.md` · sibling Prompt 27 docs: `docs/legal/data-flow.md` · `docs/legal/service-providers.md` · public pages `/privacy`, `/terms`, `/ai-data-use`, `/cookies`

> **Honesty rules.** NO compliance claim (no GDPR/CCPA/SOC2/ISO/HIPAA assessment). **Product
> controls ≠ legal rights**: §2 lists what the software can do today; §6 lists statutory-style
> requests as a *future-compatibility* map without asserting any of them is legally owed or fully
> served. There is **no automated DSR portal** — request intake is **NOT IMPLEMENTED** as a
> workflow. Status vocabulary: `DELETED` / `ANONYMIZED` / `RETAINED` / `DEPENDENT` / `NOT
> CURRENTLY AUTOMATED` / `UNKNOWN-REVIEW REQUIRED` / `CURRENTLY NOT EXPLICITLY CONFIGURED` /
> `NOT IMPLEMENTED`. Public pages ship from content version `2026-09-v1`, `effectiveDate` null,
> internal `legalReviewRequired` marker.

---

## 1. Framing

- This document separates **self-service product controls** (shipped API/UI capabilities a person
  can use directly) from **legally-framed requests** (which today would be handled
  operationally, case by case, by humans).
- Where a legal-style right has partial technical backing, both facts are stated: what exists,
  and what is missing. Nothing is described as a "right fulfilled".

## 2. Capabilities available today (product controls)

| Control | How it works today | Gates / limits | Status |
|---|---|---|---|
| Access to account profile | `GET /api/v1/me` — the authenticated user reads their own account (id, email, name, locale, session context) | Valid session required | IMPLEMENTED |
| Correction of profile | `PATCH /api/v1/me` — name, locale (email change is not part of this endpoint) | Valid session; zod-validated | IMPLEMENTED (email change: NOT IMPLEMENTED) |
| Account deletion | `DELETE /api/v1/me` — hard delete of the account and user-personal data | Fresh-session assertion + current password + typed `"DELETE"` + rate limit 5/15 min; **409 `OWNED_BUSINESS_BLOCKED`** with owned list while the user owns any business | IMPLEMENTED |
| Business data access | The app UI/APIs over the tenant's own records (sales, expenses, payments, customers, suppliers, products, audit trail) | Session + membership + RBAC (`data:read` etc.); tenant scoping throughout | IMPLEMENTED |
| Business data export (JSON) | `GET /api/v1/businesses/[id]/export` — one-file business backup | `settings:manage`, rate-limited, audited | IMPLEMENTED — exact scope in §5 |
| Business data export (CSV) | CSV reports under the `CSV_EXPORT` entitlement — **aggregated summaries only** | Entitlement-gated; OWASP CSV-injection guard (`src/lib/csv.ts`) | IMPLEMENTED (not row-level) |
| AI conversation deletion | `DELETE /api/v1/copilot/sessions/[id]` — removes one ChatSession + its messages for the owning user | Owning user only; per-session | IMPLEMENTED |
| Legal acceptance records | `POST /api/v1/legal/acceptance` (server resolves the current version — client is never trusted with version authority); `GET /api/v1/legal/acceptance` reads the user's own records; `GET /api/v1/legal/documents` returns **metadata only** (documentType/version/locale/effectiveDate — no content) | Session-scoped; append-only | IMPLEMENTED |
| Read the legal documents | `/privacy`, `/terms`, `/ai-data-use`, `/cookies` — public, structured content in `src/content/legal/` | None (public) | IMPLEMENTED (content version `2026-09-v1`; `effectiveDate` null; `legalReviewRequired`) |
| Contact / legal request pathway | The public pages render contact points from env config (`PUBLIC_SUPPORT_EMAIL`, `PRIVACY_CONTACT_EMAIL`, `LEGAL_CONTACT_EMAIL`, `SECURITY_CONTACT_EMAIL`) | All contact values currently **NOT_CONFIGURED** → pages render an honest "not configured" state | **CURRENTLY NOT EXPLICITLY CONFIGURED** |
| Password reset (account recovery) | Reset flow with 30-min single-use token, `sessionVersion` invalidation | Production email transport **CURRENTLY NOT EXPLICITLY CONFIGURED** — reset fails closed without `APP_BASE_URL`/transport | IMPLEMENTED (delivery: dev console only) |

## 3. Identity verification

- **Authenticated account is the verification**: every control in §2 operates on the server-side
  session. No action is taken on the strength of an unverified email claim.
- **For a person who cannot access their account** (lost access, no account, third-party
  inquiry): the only path today is the operational/contact route in §4. A formal identity-proofing
  workflow (document checks, challenge questions, verified-claims service) is **NOT IMPLEMENTED**;
  until one exists, any such request is handled by an approved operational decision, not by an
  automated flow — and the contact emails that would receive it are CURRENTLY NOT EXPLICITLY
  CONFIGURED.
- The reset-token flow (30-min single-use, hashed, `requestedIp`/UA recorded) is the only
  shipped proof-of-control mechanism besides the live session.

## 4. Requests handled operationally today

No intake system exists — **NOT IMPLEMENTED** as workflow. In practice, a request that arrives by
any channel would be triaged by humans against these facts:

| Request style | What the platform can actually do | How it would be served today |
|---|---|---|
| "Give me my data" | Profile via `GET /api/v1/me`; tenant data via export (§5); user's own AI conversations via the copilot APIs | Self-service if the requester holds the account; otherwise manual, after approved verification |
| "Fix my data" | Profile `PATCH`; every tenant record editable in-app by its roles | Self-service; bulk/merge corrections manual |
| "Delete my data" | Account deletion (gated) + business deletion (OWNER-only) + per-session chat delete | Self-service; anything beyond the two operations (ledgers, dangling ids) has no delete path — `docs/legal/data-deletion-matrix.md` |
| "Stop processing / object / restrict" | No processing-flag mechanism exists — **NOT IMPLEMENTED** | Manual only; the honest technical answer is that the ledgers listed as RETAINED keep running |
| "Take my data elsewhere" | JSON backup + CSV summaries (§5) | Self-service within the implemented scope; a fuller portability package needs §5's gap list |

## 5. Export scope — exactly as implemented

`GET /api/v1/businesses/[id]/export` (settings:manage, rate-limited, audited) contains, and only
contains: **business** profile + **members** (id/name/email) + **customers** + **suppliers** +
**products** + **inventoryAdjustments** + **sales** (with items) + **expenses** + **payments** +
**auditTrail**. It **excludes**: password hashes, provider secrets, checkout/payment
transactions, usage events, commercial events, AI cost records.

What a full personal-portability export would still need (**all NOT IMPLEMENTED as an export**):

1. The user's own profile record as a standalone artifact (today it is readable via API, not part
   of any export file).
2. The user's AI conversations (ChatSession/ChatMessage are readable in-app and deletable, but
   are not in any export).
3. The user's legal acceptance records (readable via `GET /api/v1/legal/acceptance`, not exported).
4. Cross-tenant aggregation for a person who is/was a member of several businesses — the current
   export is per-business, per-tenant.
5. A defined machine-readable packaging/format decision and an audit trail for who received what.

### 5.1 Customer data-portability export (Prompt 31 — implemented)

Since Prompt 31, business **owners and admins** can generate a self-service, tenant-scoped
business-data export at `#/data` (Data Portability center): JSON (exact integer minor units) or
CSV/ZIP with a manifest and checksums, covering the datasets documented in
`docs/data/data-export.md` (business profile, members, customers, suppliers, products, inventory
adjustments, sales + line items, expenses, payments, subscription and usage summaries). It
excludes all security secrets, platform data and AI transcripts (verified by
`scripts/data-portability-audit.mjs`).

**This is a business-data portability export, not a complete personal-data portability export.**
The gaps below still apply: personal-profile data, AI conversations and legal acceptances are
not part of the artifact; a person who belongs to several businesses needs one export per
business; and the packaged artifact is scoped to business records, exactly as the next section
describes.

## 6. Future DSR compatibility map (documented foundation — not implemented handling)

| Request type | Foundation that exists today | Gap to an automated right | Status of the right |
|---|---|---|---|
| Access | `GET /api/v1/me`; tenant APIs; exports (§5); own chat APIs | Request intake, verification workflow, cross-tenant packaging, deadlines/SLA machinery | Foundation only — **NOT IMPLEMENTED** as a right |
| Correction | `PATCH /api/v1/me`; in-app editing of tenant records | Email change; correction of ledger/audit history (append-only by design); intake | Foundation only — **NOT IMPLEMENTED** as a right |
| Deletion (erasure-style) | Account deletion, business deletion, per-session chat delete (`docs/legal/data-deletion-matrix.md`) | Deletion of RETAINED ledgers (commercial events, AI cost, webhook ledger, platform audit rows, dangling ids); intake + verification | Partial foundation — **NOT IMPLEMENTED** as a right |
| Restriction | No processing-flag/pause mechanism on any table | A restriction state machine per data subject | **NOT IMPLEMENTED** |
| Objection | No opt-out toggles for the operational ledgers; funnel cookie is first-party and session-scoped, but no decline control exists beyond clearing it | Consent/preference surface | **NOT IMPLEMENTED** |
| Portability | JSON backup + CSV summaries within §5's scope | §5 gap list (profile, chats, acceptances, cross-tenant) | Partial foundation — **NOT IMPLEMENTED** as a right |

## 7. Contact pathway honesty

- All four contact entries plus `PUBLIC_COMPANY_LEGAL_NAME` and `PUBLIC_BASE_URL`
  (`src/lib/legal/public-config.ts`) are **NOT_CONFIGURED** today; public pages show an honest
  "not configured" state rather than a placeholder — there is no invented company identity,
  jurisdiction, or address anywhere in the product or in these documents.
- The pricing "Contact sales" CTA is a `mailto:` driven by `NEXT_PUBLIC_SALES_CONTACT` and renders
  nothing when unset — **no lead is captured or stored** (Contact leads NOT IMPLEMENTED, see
  `docs/legal/data-processing-inventory.md` §4.4).
- Production email transport is dev-console only; until configured, password-reset delivery fails
  closed rather than pretending to send.

## 8. Current state (honest)

- Self-service controls that genuinely exist today: profile read/update, gated account deletion,
  per-session AI conversation deletion, tenant data access, JSON business export + CSV summaries,
  own legal-acceptance records, public legal pages. Everything else in §6 is a documented
  foundation, not a fulfilled right.
- The request pathway is effectively **self-service or manual**; the DSR-style intake,
  verification workflow, and SLA machinery are **NOT IMPLEMENTED**, and the contact addresses that
  would route manual requests are **CURRENTLY NOT EXPLICITLY CONFIGURED**.
- Identity verification today = authenticated session, or an approved operational decision for
  account-less requesters; unverified email alone never triggers any data operation.
- Whether and how the RETAINED ledgers (see `docs/legal/data-retention-inventory.md`) must respond
  to future deletion/objection-style requests is UNKNOWN-REVIEW REQUIRED; the public pages keep
  their `legalReviewRequired` marker and null `effectiveDate` until that review closes.

### CRM data (Prompt 35)

CRM records (`CrmLead`, `CrmOpportunity`) created by a business are part of the
business dataset: they are covered by the data-export right (JSON/CSV datasets
`crm_leads` / `crm_opportunities`) and by business deletion. A member's account
deletion does not delete business CRM rows; assignment links are anonymized to
NULL. CRM contains no tracking/marketing data (no pixels, no advertising IDs,
no behavioral profiles).

Prompt 36 extends the same rights to CRM activities and tasks
(`CrmActivity`, `CrmTask`): exportable through the `crm_activities` /
`crm_tasks` JSON/CSV datasets, soft-deletable by authorized tenant roles,
cascade-deleted with the business, and classified CONFIDENTIAL BUSINESS
DATA (descriptions may contain personal contact details and are never
logged, audited verbatim, or sent to AI). No reminder delivery exists, so
no reminder-related processing of personal data occurs.
