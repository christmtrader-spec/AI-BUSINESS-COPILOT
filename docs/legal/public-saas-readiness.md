# Public SaaS Readiness Report (§141/§142/§143/§204/§206/§207)

> Status: **SNAPSHOT — phase r27** (docs/legal). Rates the platform's public
> SaaS launch readiness per category, derived from **actual configuration,
> routes, docs, and code checks** — not manual checkboxes. Honest verdict:
> **PARTIALLY_READY**.

Companions: [service-providers.md](./service-providers.md) (provider
disclosure source) · [data-flow.md](./data-flow.md) (§197/§198 flows).
Public artifacts rated here: `/privacy`, `/terms`, `/ai-data-use`, `/cookies`
(structured content `src/content/legal/`, version `2026-09-v1`),
`/api/v1/legal/documents`, `POST /api/v1/legal/acceptance`, `public/robots.txt`.

## How to read the ratings

| Rating | Meaning |
|---|---|
| `READY` | The artifact exists, is wired, and is consistent with the code/docs. |
| `PARTIAL` | Exists but incomplete or missing a supporting piece. |
| `BLOCKED` | Exists or is specified, but launch is gated on an external action (e.g. credentials, legal sign-off). |
| `NOT_CONFIGURED` | The required configuration value/artifact is absent today. |

**Readiness derives from actual configuration/routes/docs/code checks —
mechanized by `scripts/legal-public-readiness.mjs` — not manual checkboxes.**
Honest status note: at documentation time that script was **not present** in
`scripts/` (could not verify it); every rating below was therefore derived by
direct repository inspection (env files, `src/lib/legal/public-config.ts`,
`src/content/legal/*`, routes, `prisma/schema.prisma`, `public/robots.txt`).
Until the script exists and passes, treat this snapshot as manual-but-
evidence-based, not automated.

## Category ratings

| Category | Rating | One-line reason (from actual configuration) |
|---|---|---|
| Legal Identity | `NOT_CONFIGURED` | `PUBLIC_COMPANY_LEGAL_NAME` is unset → pages render the honest "Not currently configured" fallback (no placeholder names). |
| Privacy Contact | `NOT_CONFIGURED` | `PRIVACY_CONTACT_EMAIL` unset; fallback rendered, no placeholder emails. |
| Legal Contact | `NOT_CONFIGURED` | `LEGAL_CONTACT_EMAIL` unset; fallback rendered. |
| Support Contact | `NOT_CONFIGURED` | `PUBLIC_SUPPORT_EMAIL` unset; fallback rendered. |
| Security Contact | `NOT_CONFIGURED` | `SECURITY_CONTACT_EMAIL` unset; fallback rendered. |
| Privacy Policy | `READY` | `/privacy` served from structured content (`privacy.ts`, version `2026-09-v1`) with the internal `legalReviewRequired` marker respected. |
| Terms | `READY` | `/terms` served from structured content (`terms.ts`, `2026-09-v1`). |
| AI Data Use | `READY` | `/ai-data-use` served from structured content; matches the real `z-ai` adapter behavior (no model name, neutral retention sentence). |
| Cookies | `READY` | `/cookies` documents exactly what exists: next-auth session/csrf/callback-url (essential), `copilot_funnel` 180d first-party, `sidebar_state` 7d, `abc-preferences` localStorage. |
| Data Inventory | `READY` (as internal docs) | `docs/database/data-inventory-before-baseline.md` + Prisma schema verified against live models. |
| Deletion Matrix | `READY` (as internal docs) | Cascade-on-delete behavior defined in schema (incl. `LegalAcceptance` cascade on user deletion); internal doc maintained. |
| Retention Matrix | `READY` (as internal docs) | Retention rules documented internally (cookies, sessions, ledger, trial); not yet rendered publicly. |
| Provider Disclosure | `READY` | Active AI provider and all `PLANNED`/`CONFIGURED_NOT_ACTIVE` states documented in [service-providers.md](./service-providers.md) and mirrored on public pages. |
| HTTPS | `NOT_CONFIGURED` | No `PUBLIC_BASE_URL` → `httpsOrigin` is false in `src/lib/legal/public-config.ts`; no public HTTPS origin exists in this deployment. |
| Public Base URL | `NOT_CONFIGURED` | `PUBLIC_BASE_URL` unset (must be a valid https origin when set — `INVALID` otherwise). |
| Payments | `BLOCKED` | Real processing gated on merchant activation + legal review; only mock/sandbox executes today (see blockers below). |

## Acceptance & legal-UX infrastructure (supporting evidence)

- `LegalAcceptance` model: append-only, unique `[userId, documentType,
  documentVersion]`, cascade on user deletion.
- Signup checkbox is unchecked by default (no dark-pattern consent).
- `POST /api/v1/legal/acceptance` resolves the **current** document version
  server-side; the client is never trusted with version authority.
- `GET /api/v1/legal/documents` returns only
  `documentType/version/effectiveDate/lastUpdated`.
- `effectiveDate` is `null` = **not configured**; documents carry the
  internal `legalReviewRequired` marker.
- `public/robots.txt`: `Allow: /`, `Disallow: /api`. No sitemap exists yet
  (honest absence; internal routes are never listed).

## Known blockers (launch-gating, in order)

1. **Legal identity not configured** — `PUBLIC_COMPANY_LEGAL_NAME` unset.
2. **Privacy / legal / support / security contacts not configured** —
   `PRIVACY_CONTACT_EMAIL`, `LEGAL_CONTACT_EMAIL`, `PUBLIC_SUPPORT_EMAIL`,
   `SECURITY_CONTACT_EMAIL` all unset.
3. **Public HTTPS / base URL not configured** — no `PUBLIC_BASE_URL`;
   `httpsOrigin` false.
4. **`LEGAL_REVIEW_REQUIRED` on all public legal copy** — counsel sign-off
   for `/privacy`, `/terms`, `/ai-data-use`, `/cookies` outstanding.
5. **Payment processor not activated** — merchant credentials, production
   `PAYMENT_ENV`, webhook secret rotation, verification-chain sign-off
   (full list: `docs/billing/payment-production-checklist.md`), plus legal
   review of payment copy.
6. **AI provider production cost rates not configured** — the `AiCostRate`
   table has **zero production rows by design**; no invented rates exist, so
   production AI unit economics are unknown until verified rates are entered.

## Overall verdict

**PARTIALLY_READY** — the public legal pages, legal-acceptance
infrastructure, first-party analytics disclosure, and internal inventories
are READY; every contact/identity/HTTPS configuration is `NOT_CONFIGURED`;
payments are `BLOCKED`. The platform is public-page complete but not
launch-configuration complete.

**Public legal readiness is not a legal compliance certification.** This
report rates configuration and artifact completeness only. Compliance with
any law, regulation, or contract requires qualified legal review, which has
not occurred (the `legalReviewRequired` markers are still set).

## Current state (honest)

- All five contact categories and both identity/URL categories are
  `NOT_CONFIGURED` — the pages honestly render "Not currently configured"
  rather than placeholder emails.
- The four public legal pages are READY **as artifacts**, but every one of
  them still carries `legalReviewRequired`; READY here never means
  legally approved.
- Payments remain `BLOCKED` exactly as documented in
  `docs/billing/payment-production-checklist.md`; no blocker has been
  silently cleared.
- The readiness check script (`scripts/legal-public-readiness.mjs`) was not
  found in the repository at documentation time; the automation claim is
  therefore aspirational, and this snapshot is the result of direct
  inspection. Re-run against the script once it lands, and re-rate after
  any config change.
- Next actions, in order: configure identity + contacts + HTTPS base URL →
  complete legal review → clear payment activation blockers → enter verified
  AI production cost rates → re-run automated readiness checks.
