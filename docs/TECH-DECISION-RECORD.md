# Technology Decision Record (TDR)

**Document ID:** TDR-v1.0
**Phase:** Prompt 00
**Principle:** Do not change technologies merely for preference (Constitution
Rule 03). Any change to the stack below requires an ADR.

---

## 1. Selected Stack (verified present in repository)

| Layer               | Choice                                   | Version (verified) | Status    |
|---------------------|------------------------------------------|--------------------|-----------|
| Framework           | Next.js — App Router                     | 16.1.3 (running)   | Locked    |
| Language            | TypeScript (strict)                      | 5.x                | Locked    |
| UI runtime          | React                                    | 19.x               | Locked    |
| Styling             | Tailwind CSS                             | 4.x                | Locked    |
| Component system    | shadcn/ui (New York) + Lucide icons      | installed          | Locked    |
| Theming             | next-themes (light/dark/system)          | 0.4.6              | Locked    |
| ORM / DB            | Prisma + SQLite (file `db/custom.db`)    | 6.11.1             | Locked (MVP) |
| Auth                | NextAuth.js (credentials provider)       | 4.24.11            | Locked    |
| Client state        | Zustand                                  | 5.0.6              | Locked    |
| Server state        | TanStack Query                           | 5.82.0             | Locked    |
| Forms               | react-hook-form + @hookform/resolvers    | 7.60.0 / 5.1.1     | Locked    |
| Validation          | zod                                      | 4.0.2              | Locked    |
| Charts              | Recharts                                 | 2.15.4             | Locked    |
| Dates               | date-fns + Intl                          | 4.1.0              | Locked    |
| i18n                | next-intl (en/fa dictionaries)           | 4.3.4              | Locked    |
| Animations          | framer-motion (subtle transitions only)  | 12.23.2            | Locked    |
| Tables              | @tanstack/react-table                    | 8.21.3             | Locked    |
| AI (server-only)    | z-ai-web-dev-sdk behind `AIProvider`     | 0.0.18             | Locked    |
| Runtime / pkg mgr   | bun (dev, lint, scripts)                 | 1.3.x              | Locked    |

Non-negotiables: **Next.js 16 + TypeScript**. Everything else may evolve only
via ADR.

---

## 2. Decision Rationale

### D1 — Next.js 16 App Router (locked by project contract)
Single codebase for UI + versionable API (`/api/v1/**` Route Handlers).
Route Handlers (not server actions) are the mandated API style for this
project — keeps API principles (validation/auth/audit envelope) explicit and
versionable, and matches A03 (offline-ready REST shape).

### D2 — Tailwind 4 + shadcn/ui + next-themes
Constitution §6 demands a centralized design system with light/dark/system.
shadcn/ui gives accessible primitives we own in-repo (customizable for RTL),
rather than a black-box vendor theme. Tailwind logical utilities (`ms/me/ps/pe`,
`text-start/end`) give first-class RTL (A06).

### D3 — Prisma + SQLite for MVP, PostgreSQL as scale path
SQLite (single file, zero-ops) fits MVP and the single-node deployment.
**SQLite lacks `Decimal` → money stored as integer minor units (`Int`) —
this satisfies A08 without floats and keeps the schema portable.** The
repository/service layer keeps queries Prisma-idiomatic so a future Postgres
migration is a datasource change + ADR, not a rewrite (A01 integrity rules
and indexes are portable). Migration trigger points: concurrent writers,
reporting load, or hosted multi-node deployment.

### D4 — NextAuth.js v4 credentials provider
Email/password with bcrypt hashing, JWT session strategy. Session carries
`userId` + `activeBusinessId`; every API route re-verifies membership
(A01/A02 — never trust the client). OAuth providers can be added later
without architectural change.

### D5 — Zustand + TanStack Query
Zustand for ephemeral UI state (theme, sidebar, copilot draft); TanStack
Query as the server-state cache for all API reads/mutations (loading/error
states for free, aligns with A03 future offline persistence).

### D6 — Money as integer minor units (`src/lib/money.ts`)
A08 mandates no floats. All amounts in DB are `Int` minor units; formatting
uses business `currencyCode`/`symbol`/`decimalPrecision` (A04). All money
arithmetic flows through pure, unit-testable helpers. **Never** use JS
`number` math directly on money in feature code.

### D7 — AI provider abstraction (A10) with z-ai-web-dev-sdk as first adapter
`AIProvider` interface in `src/lib/ai/provider.ts`; the vendor SDK is
imported **only** inside the adapter, **only** server-side. Business logic
and the copilot pipeline never see a vendor type. Deterministic metrics
(A12) are computed by the app; the provider only narrates/explains (A11).

### D8 — next-intl for en/fa (A05/A06)
Centralized message catalogs, locale-aware `dir` switching, ICU messages.
Persian is first-class: `dir="rtl"` at the html/app-shell level, logical
spacing utilities, and RTL QA in the definition of done.

### D9 — Modular monolith (A17, Rule 06)
No microservices/event buses in MVP. Module boundaries in
`src/modules/*` + shared libs in `src/lib/*`. The only sanctioned extra
process is a `mini-services/` WebSocket service if/when real-time features
demand it (gateway-provided pattern).

---

## 3. Rejected / Deferred Alternatives

| Alternative                              | Why rejected/deferred                                        |
|------------------------------------------|--------------------------------------------------------------|
| PostgreSQL from day one                  | Violates Rule 06 for MVP; SQLite sufficient; migration path documented (D3) |
| Server Actions as API layer              | Project mandates explicit, versionable REST-style APIs       |
| Heavyweight i18n routing (locale prefix) | Single-origin app; cookie/locality-driven locale is simpler; revisit if SEO for marketing pages is needed |
| Float/`Decimal.js` for money             | Float forbidden (A08); bigint-minor-units is exact and DB-portable |
| Direct vendor AI SDK calls in features   | Vendor lock-in (A10) — adapter only                          |
| Redux / global stores for server data    | TanStack Query covers it with less complexity (Rule 06)      |
| Microservices / Redis / queues           | No current requirement (Rule 06)                             |

---

## 4. Consequences & Guardrails

- Money, RBAC, tenant scoping, and audit helpers are the **only** sanctioned
  paths for their concerns (Rule 04 — no duplicate systems).
- Every new dependency requires justification against the locked stack;
  prefer what is already installed.
- `bun run lint` must stay clean; the dev server (port 3000) is the only
  runtime target; `bun run build` is not used in this environment.
