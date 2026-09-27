# Data Flow — Conceptual Integration Map (§197/§198)

> Status: **MAINTAINED** (docs/legal, phase r27). Describes how data moves
> between the user, the platform, and third parties — using **only** the
> integrations that actually exist in the repository today. No secrets,
> credentials, or connection strings appear in any diagram.

Companions: [service-providers.md](./service-providers.md) (provider
register, §40/§41/§111/§112/§193) ·
[public-saas-readiness.md](./public-saas-readiness.md). Public-facing
narrative: `/privacy` and `/ai-data-use` (content in `src/content/legal/`).

## Master diagram

```
                        ┌─────────────────────────────┐
                        │            User             │
                        │  browser: session cookie,   │
                        │  copilot_funnel cookie      │
                        └──────────────┬──────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────┐
│                        App — Next.js (server)                    │
│   NextAuth session · RBAC OWNER/ADMIN/MEMBER · tenant isolation  │
│   (businessId-scoped queries) · rate limiting · audit logging    │
└──────┬───────────────┬───────────────┬───────────────┬───────────┘
       │               │               │               │
       │ Prisma        │ AI SDK        │ Payment       │ (no external
       │               │               │ adapter       │  vendor — §6)
       ▼               ▼               ▼               ▼
┌────────────┐  ┌───────────────┐  ┌────────────┐  ┌──────────────┐
│  SQLite DB │  │ AI provider   │  │  Payment   │  │   Analytics  │
│  (Prisma)  │  │  [z-ai SDK]   │  │  provider  │  │  (first-party│
│  own infra │  │               │  │ mock/      │  │  → own DB)   │
│            │  │ LEAVES THE    │  │ zarinpal   │  │              │
│            │  │ PLATFORM ⚠    │  │ sandbox;   │  │              │
│            │  │               │  │ production │  │              │
│            │  │               │  │ INACTIVE   │  │              │
└────────────┘  └───────────────┘  └────────────┘  └──────────────┘

  Email: NO external flow exists. Console transport (dev) only;
  production fails closed. No vendor configured.
```

Hosting note: the App and the SQLite database run on a third-party host that
is **not individually enumerated publicly** (§256); it is deliberately shown
here only as the platform's own runtime, without a vendor name.

## 1. User → App → Database (§197 core)

- The user's browser talks to the Next.js server over the app origin
  (cookies: next-auth session/csrf/callback-url — essential;
  `copilot_funnel` — first-party analytics, 180d; `sidebar_state` — 7d
  preference; `abc-preferences` — localStorage).
- Every tenant read/write passes server-side session + membership
  verification, then a `businessId`-scoped Prisma query.
- All business data is stored in the platform's own SQLite database
  (`db/custom.db`). **No tenant data is replicated to any external
  database service.**

## 2. App → AI Provider — ⚠ LEAVES THE PLATFORM

**This flow leaves the platform. Data sent to the AI provider is processed
by a third party. It must never be described as staying local.**

- Trigger: copilot requests.
- Sent: prompt + business snapshot + conversation context.
- Returned: model responses, which are stored in the platform's own DB.
- Adapter: `src/lib/ai/provider.ts` (`z-ai-web-dev-sdk`, provider slug
  `z-ai`, server-only, provider-agnostic). See
  [service-providers.md](./service-providers.md) for the register row.
- Retention: *Provider retention and processing terms are governed by the
  applicable provider documentation and configuration.* No further retention
  claim is made or implied.
- Model identifier is recorded only when the provider genuinely reports one;
  no model name is published anywhere public.

### AI context minimization (§198)

- What reaches the provider is an **explicit snapshot DTO** — a deliberate,
  reviewed projection of business state — **never whole DB objects**. Prisma
  models are never passed through to the provider; a reviewer can enumerate
  every field in the snapshot.
- This is the platform's minimization control: the provider sees the minimum
  structured context needed for the copilot request, not a database dump.

### Internal cost data — never leaves, never leaks

- `AiCostRate`, `AiCostRecord`, and `AiCostAnomaly` are **internal** cost
  governance tables. They are: never part of the copilot context sent to the
  AI provider, never exposed in tenant-facing APIs (no routes exist), and
  never included in tenant exports.
- Tenant-visible usage shows consumption and entitlements only — never
  provider rates, cost, or margin. These records stay inside the platform's
  own DB and the internal cost boundary.

## 3. App → Payment Provider

Two different domains (do not conflate — full table in
[service-providers.md](./service-providers.md)):

- **Tenant finance Payment records** — the business's own customer money,
  recorded in-app. Pure DB rows; no external party involved.
- **Platform subscription processing** — `CheckoutSession` (30-min expiry;
  `PENDING|SUCCEEDED|FAILED|EXPIRED|CANCELED`; amount snapshot;
  `providerRef`), `PaymentTransaction` (idempotent on
  `[provider, providerEventId]`), and `ProcessedWebhookEvent` (replay
  ledger).

Today's state:

- Mock provider (development/test) is the only executable path.
- Zarinpal sandbox adapter exists (`src/lib/payments/zarinpal.ts`); production
  is **not active** — no merchant credentials configured. Activation
  blockers: `docs/billing/payment-production-checklist.md`.
- Subscription state machine: `TRIALING → EXPIRED` at trial end; **nothing is
  charged when a trial ends and no payment method is collected today.**
- No payment instruments are stored on the platform.

## 4. App → Email

- There is **no external email flow**. The `EmailProvider` boundary
  (`src/lib/email/index.ts`) uses a console transport in development.
- In production without a configured transport, `getEmailProvider()` throws a
  config error → password reset **fails closed** (no half-sent email, no
  silent fallback).
- Status: PLANNED — no vendor is configured. When a vendor is added, this
  document and [service-providers.md](./service-providers.md) must gain the
  same row in the same change.

## 5. App → Analytics

- **First-party only.** Funnel/commercial events (`CommercialEvent`, 16-event
  fixed directory, `eventType + dedupeKey` unique, optional
  userId/businessId/planCode/currency, server-authoritative timestamps) are
  written to the platform's own DB.
- Identity for anonymous funnels: `copilot_funnel` cookie UUID
  (`anonymousSessionKey`, 180d, SameSite=Lax). Measurement is first-party.
- **There is no third-party analytics processor.** No external analytics
  endpoint receives events.

## 6. Flows that do not exist

| Category | State |
|---|---|
| Third-party analytics | None — first-party only |
| Captcha | None |
| External email vendor | None configured (console transport / fail-closed) |
| Real payment processing | Not active (sandbox/mock only) |
| External database / backup SaaS | None enumerated (hosting described generically) |

Any new integration must appear here, in the provider register, and on the
public pages **in the same change** — an integration that is invisible to
this map is a defect.

## Current state (honest)

- The only external data flow that carries tenant-derived content today is
  **App → AI provider** (`z-ai` SDK). It is marked *leaves the platform* and
  governed by the neutral retention sentence — nothing stronger is claimed.
- Payment flow is internal/sandbox only; production is inactive and blocked
  on merchant activation.
- Email sends nothing externally; analytics never leaves the platform.
- All diagrams use actual integrations only; no credentials, hosts, or model
  names appear here by design.
