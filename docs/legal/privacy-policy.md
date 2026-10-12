# Privacy Policy — internal document record

**Document ID:** LEGAL-PRIVACY-v1 · **Created:** 2026-09-25 (Prompt 27 §163)
**Status:** DRAFT — **LEGAL REVIEW REQUIRED** before public production launch.

The public Privacy Policy lives in the structured content layer
(`src/content/legal/privacy.ts`, explicit `en` + `fa` variants) and is
rendered at `/privacy` by the public legal document pages
(`src/components/legal/legal-doc-view.tsx` + `src/content/legal/registry.ts`).
This file is the internal record of WHAT it claims and WHY each claim is true.

## Claim → evidence mapping

| Public claim | Evidence in code |
|---|---|
| Account data (name, email, hashed password, locale) | `User` model; bcrypt hashing (`register` route, `auth.ts`) |
| Business data (customers, suppliers, products, inventory, sales, expenses, tenant payments, reports) | `Customer`…`Payment` models; module routes |
| Security data (audit with actor/IP/user-agent) | `AuditLog` model; `src/lib/audit.ts` |
| AI data (conversations + token metadata when reported) | `ChatSession`/`ChatMessage`; `AiProviderUsage` (`src/lib/ai/provider.ts` — usage never fabricated) |
| Billing data (subscription, usage counters, checkout metadata) | `Subscription`, `UsageCounter`, `CheckoutSession`, `PaymentTransaction` |
| Platform operational data (first-party funnel events, rate limits, logs) | `CommercialEvent` (`src/lib/billing/events.ts` — fixed event directory, allowlisted dimensions only, served via `POST /api/public/events`), in-memory rate limiters; no contact-lead storage exists (no contact form) |
| AI processed by "AI service providers configured by the platform" | `src/lib/ai/provider.ts` (§25 — no provider named publicly) |
| Conversations deletable by the user | `DELETE /api/v1/copilot/sessions/[id]` (owner-scoped, audited) |
| Funnel events never store raw prompts/responses | `src/lib/billing/events.ts` — fixed event directory, allowlisted dimensions only |
| Essential cookie + local storage only; no ads, no third-party scripts | `cookie-assessment.md` |
| No data sale; sharing only as listed | No outbound integrations beyond AI/email/payment-when-enabled |
| Soft-deleted business records persist until business deletion | `deletedAt` columns; no purge job exists |
| Audit records live for the business lifetime, removed with the business | `businesses/[id]/route.ts` DELETE + schema cascade |
| Funnel-event retention "not yet configured" | No retention mechanism in code (§57 honest wording); no contact-lead storage exists |
| Account deletion blocked while owning a business; sessions die immediately | `me/route.ts` DELETE (`OWNED_BUSINESS_BLOCKED`) |
| Business deletion irreversible; counts shown before delete | `businesses/[id]/route.ts` DELETE |
| Payments: tenant-finance vs platform-billing distinction; no live payments claim | `docs/billing/platform-billing-vs-business-finance.md`; `PAYMENTS_ENABLED` unset |
| Factual security controls; no absolute security claim | data-classification.md; §89/§93 wording rules |

## Deliberate omissions

- No controller/processor legal determination (§11 — neutral wording only;
  any future role assignment is `LEGAL REVIEW REQUIRED`).
- No invented retention periods (§57).
- No compliance certifications of any kind (§2).
- No invented company identity, address or jurisdiction (§79/§148/§147).

## Persian version

The Persian text is a careful draft written for this release. Per §145/§146,
legal equivalence of the two languages is NOT claimed until both are
reviewed; `scripts/legal-public-readiness.mjs` verifies structural parity
(section-for-section, non-empty in both locales).
