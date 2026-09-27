# Service Providers Register — Third-Party Processing Disclosure

> Status: **MAINTAINED** (docs/legal, phase r27). This register lists every
> third party that touches platform data — and every category that is
> deliberately **not** a third-party processor. Facts were verified against
> the repository (package.json, adapters, env config, robots.txt). Where a
> fact is absent, the honest state is written; nothing is invented.

Companions: [data-flow.md](./data-flow.md) (§197/§198 conceptual flows) ·
[public-saas-readiness.md](./public-saas-readiness.md) (§141–§207 readiness).
Public-facing disclosure lives on the legal pages `/privacy`, `/ai-data-use`,
`/cookies`, `/terms` (structured content in `src/content/legal/`, version
`2026-09-v1`).

## Register

| Provider / Category | Purpose | Data Category | Status | Public Documentation | Configuration State |
|---|---|---|---|---|---|
| **AI provider** — platform AI adapter, provider slug `z-ai` (`z-ai-web-dev-sdk`) | Copilot AI requests: prompt + business snapshot + conversation context are sent to the provider; responses are returned and stored | Prompt text, business snapshot content, conversation context, provider responses | **ACTIVE** | SDK vendor domain only: https://z.ai — labeled as the SDK's home, **not** a provider-docs or data-processing-agreement link | Provider-agnostic, server-only adapter (`src/lib/ai/provider.ts`); the SDK is imported there and nowhere else. A model identifier is recorded **only** when the provider genuinely reports one; no model name is published. Provider retention and processing terms are governed by the applicable provider documentation and configuration. |
| **Payment provider** — Zarinpal adapter | Platform subscription payment processing (checkout, verification, subscription activation) | Checkout/transaction metadata only: amount snapshot, currency, provider reference. No card data, ever | **CONFIGURED_NOT_ACTIVE** | Not linked. Internal docs: `docs/billing/zarinpal-setup.md`, `docs/billing/payment-providers.md` | Adapter `src/lib/payments/zarinpal.ts` implements the neutral `PaymentProvider` interface (sandbox integration). `PAYMENT_ENV` = `mock\|sandbox\|production`. Production **not active**; no merchant credentials configured; mock provider used for tests. |
| **Hosting / infrastructure** | Application runtime and database file storage for the deployed platform | All platform data at rest (generic description) | **ACTIVE** | Not individually enumerated publicly (§256) | A third-party host, described generically. No host name, region, or contract detail is published. |
| **Email delivery** | Transactional email (e.g. password reset) | Recipient address, message content | **PLANNED** | None | Provider-agnostic `EmailProvider` boundary (`src/lib/email/index.ts`). Development console transport only; production without a configured transport throws a config error, so password reset **fails closed**. No vendor configured. |
| **Analytics** | First-party conversion/funnel measurement | First-party `CommercialEvent` rows; anonymous `copilot_funnel` cookie UUID (`anonymousSessionKey`, 180d, SameSite=Lax) | **ACTIVE — FIRST-PARTY ONLY** | N/A — there is **no** third-party analytics processor | Events are written to the platform's own database. No external analytics endpoint exists. See `/cookies` for the full cookie list. |
| **Captcha** | n/a | n/a | **NONE** | n/a | No captcha service is deployed or configured. |

## Status vocabulary

| Status | Meaning |
|---|---|
| `ACTIVE` | Code path is live in this deployment and third-party processing occurs today. |
| `CONFIGURED_NOT_ACTIVE` | Adapter/config exists and is wired, but the third party is not processing anything in this deployment (e.g. missing credentials, non-production `PAYMENT_ENV`). |
| `PLANNED` | A neutral boundary exists in code; no vendor is configured. |
| `UNKNOWN` | A third party may exist but its state could not be verified. (No row currently carries this status.) |

## ACTIVE vs PLANNED rule

**Never list a planned integration as active.** A category is `ACTIVE` only
when a real third party receives data in this deployment today. Boundaries,
interfaces, adapters, or scaffolding alone never justify `ACTIVE` — they stay
`PLANNED` (email) or `CONFIGURED_NOT_ACTIVE` (Zarinpal production) until the
configuration genuinely exists. This register must be re-verified against the
repository whenever any row changes status.

## Subprocessor-terminology caution

This register deliberately uses **"third-party service provider"**, not
"subprocessor". Subprocessor is a contract/legal-status term whose accuracy
depends on agreements that are not verified here. If a future legal review
requires subprocessor language, that decision belongs to counsel — not to
this document. Until then, the safer neutral term is used everywhere
(including the public pages).

## Provider consistency check

The register must always agree with three repository sources of truth:

1. **`package.json`** — today: `z-ai-web-dev-sdk` (`^0.0.18`) is the only AI
   SDK dependency. Verified.
2. **Env config** — today: no `ZARINPAL_*` merchant credential, no email
   vendor variables, and no `PUBLIC_*`/`PRIVACY_*`/`LEGAL_*`/`SECURITY_*`
   contact variables are set. Verified.
3. **Adapters** — AI: `src/lib/ai/provider.ts` (only SDK import site).
   Payments: `src/lib/payments/zarinpal.ts` + mock provider. Email:
   `src/lib/email/index.ts` (console transport only). Verified.

If any of these changes (new dependency, new adapter file, new env var), this
register, [data-flow.md](./data-flow.md), and the public pages must be
updated together. A mismatch between the register and the code is a
documentation defect, not a code one — fix the register first.

## Provider-specific claims safety

- Do **not** publish a model name. The model identifier is stored internally
  only when the provider genuinely reports one; public copy never names it.
- Do **not** link a fabricated provider docs URL. The only external link in
  this register is https://z.ai, explicitly labeled as the SDK vendor domain.
- Retention, processing, and location claims about any provider are limited
  to the neutral sentence: *"Provider retention and processing terms are
  governed by the applicable provider documentation and configuration."*
- No claim is made about provider uptime, SLAs, security certifications, or
  data residency — none of these are verified.

## Two different payment domains (do not conflate)

| Domain | What it is | Third-party PSP involved? |
|---|---|---|
| **Tenant finance — Payment records** | The business's own customer money, recorded in-app (invoices/payments inside a tenant's workspace) | No — these are application records in the platform's own DB |
| **Platform subscription — CheckoutSession / PaymentTransaction** | The tenant paying for the SaaS plan, processed against a payment service provider | Yes — Zarinpal adapter when active; today only the mock provider executes |

## Current state (honest)

- **Active third-party processing today:** the AI provider (via the `z-ai`
  adapter) and a generic third-party host. That is the complete list.
- Zarinpal is `CONFIGURED_NOT_ACTIVE`: sandbox adapter code exists and is
  tested, but no merchant credentials are configured and no real payment has
  been processed. The mock provider is the only executable payment path.
- Email is `PLANNED`: console transport in development, fail-closed in
  production. No vendor is configured.
- Analytics is first-party only; there is no third-party analytics processor
  and no captcha.
- No row carries `UNKNOWN` — every category above was checked against the
  repository at documentation time. Rows must be re-verified before any
  public launch decision (see
  [public-saas-readiness.md](./public-saas-readiness.md)).
