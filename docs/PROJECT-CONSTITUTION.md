# AI Business Copilot — Project Constitution

**Document ID:** CONSTITUTION-v1.0
**Phase:** Prompt 00 (Foundation Contract)
**Status:** Ratified
**Supersedes:** None

> This document is the binding contract for the **AI Business Copilot** project.
> Every future phase (Prompt 01+) must comply with it. Changing any assumption
> below requires a written Architecture Decision Record (ADR) in
> `docs/adr/` documenting what changed, why, alternatives considered, impact,
> and migration requirements (Rule 07).

---

## 1. Product Vision

**AI Business Copilot** is an intelligent business management platform for
individuals, freelancers, home businesses, small businesses, shops, online
sellers, service businesses, workshops, and small-to-medium companies.

The long-term vision is an extensible **AI Business Operating System
(AI Business OS)**.

The defining capability is the **AI Copilot**: a non-accountant business owner
asks natural-language questions ("Who owes me money?", "Why did my expenses
increase?", "Which products are running low?") and receives understandable,
actionable answers derived from **real business data**.

### 1.1 Non-Negotiable AI Data Integrity Rules

1. The AI must **never fabricate business numbers**.
2. All numerical answers come from **trusted application data** and
   **deterministic calculations** wherever possible.
3. The AI distinguishes between:
   - **Authoritative data** — database totals, invoice amounts, payments,
     inventory quantities, calculated profit, recorded expenses.
   - **AI interpretation** — explanations, summaries, recommendations,
     trend descriptions, insights. These must be presented as interpretation,
     never as authoritative fact.
4. When data is insufficient, the AI must explicitly say so.
5. Deterministic calculations are performed by the application **first**
   (intent → authorized query → calculation → structured result → AI
   natural-language explanation). The LLM is never asked to compute database
   totals from raw records.
6. The AI never receives unrestricted database access — only a controlled,
   validated, authorization-checked tool layer.

### 1.2 Long-Term Product Architecture (Direction Only)

```text
AI BUSINESS OS

Identity
├── Users
├── Organizations
├── Businesses
├── Roles
└── Permissions

Business Operations
├── Customers
├── Suppliers
├── Products
├── Inventory
├── Sales
├── Purchases
├── Expenses
├── Payments
├── Receivables
└── Payables

Intelligence
├── AI Copilot
├── Analytics
├── Forecasting
├── Alerts
└── Recommendations

Platform
├── Notifications
├── Files
├── Audit Logs
├── Settings
├── Subscription
└── Administration
```

This is the target direction — **not** an instruction to implement everything
immediately.

---

## 2. MVP Scope (Locked)

The first commercially testable MVP includes exactly:

| # | Module              | Notes                                        |
|---|---------------------|----------------------------------------------|
| 1 | Authentication      | Email/password sessions (NextAuth v4)        |
| 2 | User profile        | Name, locale, theme preference               |
| 3 | Business creation   | Multi-tenant workspace creation              |
| 4 | Business settings   | Currency, locale, timezone, tax label        |
| 5 | Customers           | CRM master data                              |
| 6 | Suppliers           | Vendor master data                           |
| 7 | Products            | Items/services master data                   |
| 8 | Sales               | Sales invoices                               |
| 9 | Expenses            | Expense recording                            |
| 10| Payments            | Received + made payments                     |
| 11| Receivables         | Derived from invoices − payments             |
| 12| Payables            | Derived from supplier bills − payments (minimal) |
| 13| Basic inventory     | Stock quantity on products + simple adjustments |
| 14| Business dashboard  | Actionable KPIs, not decoration              |
| 15| Reports             | Sales, expenses, cash flow, receivables aging |
| 16| AI Business Copilot | Natural-language Q&A over business data      |

**Anything not listed above is out of MVP scope** and must not be implemented
merely because it appears in the long-term vision. Future modules are listed
in `docs/ARCHITECTURE.md §5` and may only appear in the UI as clearly-labeled
"coming soon" placeholders, never as fake functionality (Rule 05).

---

## 3. Explicit Assumptions (Ratified A01–A17)

These assumptions are binding project constraints. Each entry states the
assumption and how the current stack satisfies or reserves for it.

### A01 — Multi-Tenant SaaS
- A user may belong to one or more businesses (`BusinessMember` join table).
- Every business-owned record carries a `businessId` foreign key.
- **Tenant isolation is a security requirement**: every API request resolves
  the caller's session → active business → verified membership → role, and
  every Prisma query is scoped by `businessId`. Frontend hiding is never
  sufficient.
- Status: **Ratified**. Reserved in DB schema from Phase 01.

### A02 — Role-Based Access Control
- Conceptual roles: `OWNER`, `ADMIN`, `MANAGER`, `STAFF`, `ACCOUNTANT`,
  `VIEWER` (stored as enum on `BusinessMember.role`).
- Authorization is enforced **server-side in the API layer** on every request
  (role → permission matrix in `src/lib/rbac.ts`). Frontend visibility is a
  UX convenience only.
- Status: **Ratified**.

### A03 — Offline-Friendly Architecture
- Online-first. The REST API + client cache (TanStack Query) architecture
  allows a future offline queue (persisted mutation log + replay) **without
  backend redesign**.
- No offline complexity in the foundation phase.
- Status: **Ratified** (reserved, not implemented).

### A04 — Currency
- No currency is hard-coded into the database architecture.
- Each `Business` stores: `currencyCode`, `currencySymbol`,
  `decimalPrecision`, `locale`, `timezone`.
- Amounts are stored as **integer minor units** (see A08) + `currencyCode`
  on transactional records, preserving future multi-currency compatibility.
- MVP UX supports one primary currency per business.
- Status: **Ratified**.

### A05 — Localization
- All user-facing strings live in centralized dictionaries
  (`src/i18n/dictionaries/{en,fa}.ts`). No hardcoded UI strings in feature
  code. `next-intl` is the selected mechanism (already in the stack).
- Minimum supported languages: **English (en)** and **Persian (fa)**.
- Status: **Ratified**. Foundation for en/fa lands in Phase 01.

### A06 — RTL Support
- Persian is a first-class language. `dir="rtl"` is driven by locale.
- Layouts must use **Tailwind logical properties** (`ms-*`, `me-*`, `ps-*`,
  `pe-*`, `text-start`, `text-end`) so LTR/RTL both hold on navigation,
  tables, forms, charts, and dialogs.
- Every important screen is RTL-QA'd (see §8 Responsive Visual QA).
- Status: **Ratified**.

### A07 — Date and Time
- Authoritative timestamps are stored by the database as UTC `DateTime`
  (Prisma standard). Device-local date strings are never written to the DB.
- Each business configures `timezone` and `locale`; rendering formats dates
  client-side via `Intl`/`date-fns` with the business locale.
- Status: **Ratified**.

### A08 — Financial Precision
- **Floating-point arithmetic is forbidden for authoritative money values.**
- Money is stored as **integer minor units** (e.g., cents) in `Int` columns
  (SQLite has no `Decimal`). All money math goes through deterministic
  helpers in `src/lib/money.ts` (integer arithmetic, explicit rounding
  policy: half-up on display formatting only, never on stored totals).
- Currency conversion (future) requires an ADR.
- Status: **Ratified**.

### A09 — Auditability
- An `AuditLog` table records: `businessId`, `actorUserId`, `action`,
  `entityType`, `entityId`, `beforeJson`, `afterJson`, `ip`, `userAgent`,
  `createdAt`.
- Audited operations (minimum): invoice create/update, payment create,
  expense create/delete, product price change, inventory adjustment,
  permission change, business configuration change.
- Writes go through a single `audit()` helper — no ad-hoc logging.
- Status: **Ratified**. Schema lands in Phase 01; coverage grows per module.

### A10 — AI Provider Abstraction
- Business logic depends on the `AIProvider` interface
  (`src/lib/ai/provider.ts`), **not** on any vendor SDK.
- Default implementation wraps `z-ai-web-dev-sdk` **server-side only**.
- Swapping/adding providers (OpenAI, Anthropic, local models) is a new
  adapter file — no business-logic changes.
- Status: **Ratified**.

### A11 — AI Must Not Invent Financial Facts
- See §1.1. Enforced by: structured metric payloads produced deterministically
  by the app, provider-level system rules, response labeling of
  authoritative vs. interpreted content, and refusal-on-insufficient-data.
- Status: **Ratified**.

### A12 — Deterministic Calculations First
- Question → intent detection → authorized DB query → deterministic
  calculation → structured result → AI natural-language explanation.
- Deterministic metrics live in `src/lib/copilot/metrics.ts` (pure,
  unit-testable functions over Prisma aggregates).
- Status: **Ratified**.

### A13 — No Direct Unrestricted AI Database Access
- Flow: AI → approved tool → validated parameters (zod) → authorization
  check (tenant + role) → DB operation → structured result → AI response.
- The tool registry (`src/lib/copilot/tools.ts`) is an explicit allow-list.
- Status: **Ratified**.

### A14 — Security First
- Mandatory considerations: authentication, authorization, tenant isolation,
  secure sessions/tokens, password security (bcrypt/argon2 via NextAuth
  credentials), secrets management (server-side env only), input validation
  (zod on every API route), rate limiting (AI + auth endpoints), file upload
  security (future), injection prevention (Prisma parameterization; no raw
  string SQL), audit logging, consistent error handling, sensitive-data
  protection.
- Never: expose secrets in frontend code, commit API keys, store plaintext
  passwords, leak stack traces/DB errors/internal paths to users.
- Status: **Ratified**.

### A15 — Files
- File storage is abstracted behind a `StorageAdapter` interface (local disk
  adapter first). Business logic never imports a storage vendor directly.
- Future: invoice images, receipts, documents, product images.
- Status: **Ratified** (interface reserved; no upload feature in MVP).

### A16 — Subscription Architecture
- Future plans: Free, Starter, Business, Pro, Enterprise.
- **Billing is not implemented in Prompt 00.** Design reserves: `plan` field
  concept on Business and a module boundary (`src/modules/billing/`).
- Status: **Ratified** (reserved, not implemented).

### A17 — Modular Architecture
- Modular monolith with loose coupling. Module boundaries mirror §1.2:
  Identity, Business, CRM, Products, Inventory, Sales, Expenses, Finance,
  Reporting, AI, Notifications, Billing, Administration.
- Feature code lives in `src/modules/<module>/`, shared primitives in
  `src/lib/`, and modules communicate through exported service functions —
  never by reaching into another module's internals.
- Status: **Ratified**.

---

## 4. Development Rules (Binding)

### RULE 01 — Incremental Development
Always continue from the existing codebase. Never rebuild from scratch to add
a feature.

### RULE 02 — Do Not Break Working Functionality
Before changing an existing feature: inspect it, map dependencies, identify
regressions, make the smallest safe change, verify existing functionality
still works (lint + browser QA).

### RULE 03 — No Silent Architecture Changes
No replacing frameworks, database systems, auth systems, state management,
API architecture, or component systems without a documented ADR.

### RULE 04 — No Duplicate Systems
Before creating anything new, search for an existing service, utility,
component, hook, or endpoint that does the job. Reuse correct abstractions.

### RULE 05 — No Fake Functionality
No UI that looks functional without real backend behavior (unless the phase
explicitly declares a prototype). No fake financial data in
production-facing paths. Empty states must be real empty states.

### RULE 06 — No Premature Complexity
No microservices, event buses, distributed systems, advanced caching,
complex offline sync, Kubernetes, or elaborate infrastructure. Start with the
simplest architecture that can evolve safely. (The `mini-services/` escape
hatch exists for real-time needs only, e.g. WebSockets.)

### RULE 07 — Documentation
Every major architectural decision is documented. Changing an assumption
requires an ADR (what/why/alternatives/impact/migration).

### RULE 08 — Worklog Continuity (operational)
Each work session records progress in `/home/z/my-project/worklog.md`
(status, changes, verification results, next priorities) so subsequent
sessions can continue incrementally.

---

## 5. UI/UX Principles

The product must feel like a modern professional SaaS: **simple, fast, clear,
trustworthy, professional, accessible, responsive** — on mobile, tablet,
laptop, and desktop.

- Clear visual hierarchy; large readable numbers for money.
- Minimal decoration; dashboard prioritizes actionable information.
- Fast access to common actions (persistent primary actions).
- Clear empty, loading, and error states on every data view.
- Accessible forms (labels, descriptions, keyboard navigable, ARIA).
- Responsive tables (horizontal scroll / card fallback on mobile).
- Mobile-friendly dialogs and touch-friendly targets (≥ 44px).

**Sticky footer law:** any footer sticks to the viewport bottom on short
pages (`min-h-screen flex flex-col` root + `mt-auto` footer) and is pushed
naturally on long pages — never overlapping content.

---

## 6. Design System Requirements

A centralized design system — no random per-screen styles:

- **Tokens:** colors, typography, spacing, radius, shadows via Tailwind CSS 4
  theme tokens + shadcn/ui CSS variables (`bg-background`, `text-foreground`,
  `bg-primary`, etc.).
- **Components (shadcn/ui New York):** buttons, inputs, selects, tables,
  cards, dialogs, toasts, charts, skeletons, empty states.
- **Themes:** light, dark, and system preference via `next-themes`.
- **Tone:** professional financial application — restrained palette, high
  legibility, no indigo/blue accent unless product-approved.
- Money formatting (symbol, grouping, precision) always derives from the
  business currency config (A04).

---

## 7. Database, API & Error-Handling Principles

### Database
- Priorities: data integrity, referential integrity, tenant isolation,
  financial precision (A08), auditability (A09), indexing, query
  performance, migration safety.
- Entities represent real business concepts. Prefer relational structure
  over unstructured JSON; JSON columns only where flexibility justifies.
- Never design the schema around a UI screen.

### API (Next.js Route Handlers under `/api`)
Every backend operation must: validate input (zod) → authenticate →
authorize (role) → verify tenant ownership → return a predictable response
envelope (`{ ok, data }` / `{ ok: false, error: { code, message } }`) →
handle errors consistently → never leak sensitive information.
API design remains versionable (`/api/v1/...` namespace reserved).

### Error Handling
Users receive understandable messages ("Unable to load customers. Please
try again."). Detailed diagnostics go to server logs only. Never expose
stack traces, secrets, credentials, or internal paths.

---

## 8. Responsive Visual QA

QA matrix for every important screen (Login, Dashboard, Customers, Products,
Sales, Expenses, AI Copilot, Reports, Settings):

| Width × Height | Device class |
|-----------------|--------------|
| 360 × 640       | Small mobile |
| 390 × 844       | iPhone-class |
| 412 × 915       | Android-class |
| 1366 × 768      | Laptop       |
| 1920 × 1080     | Desktop      |

Each screen is checked in: **light mode, dark mode, LTR (en), RTL (fa)**.

---

## 9. Testing Requirements

Every completed phase includes appropriate testing where applicable: unit,
integration, API, database, authorization (tenant isolation + RBAC), UI, and
regression tests.

**Financial calculations and RBAC/tenant isolation require the strongest
coverage.** The deterministic money/copilot-metric layer
(`src/lib/money.ts`, `src/lib/copilot/metrics.ts`) is the priority test
target. (Per current environment policy, heavyweight test runners may be
deferred; lint + browser-based end-to-end QA is the minimum bar each phase.)

---

## 10. AI Action Safety

The AI never executes high-impact actions from vague questions. Explicit
confirmation + appropriate authorization is required for: deleting financial
records, sending customer messages, issuing refunds, changing prices,
changing permissions, creating financial transactions, exporting sensitive
data. Reading/calculation/explanation may proceed; **execution** requires a
confirmation workflow. The MVP Copilot is read-only by design.

---

## 11. Out of Scope for Prompt 00 (Respected)

No full application build, no full schema, no every-screen implementation,
no advanced accounting/tax/e-invoicing, no payment gateways, no all-AI-agents,
no integrations, no production deployment infrastructure. Prompt 00
establishes the constitution only; implementation proceeds phase-by-phase
per `docs/ARCHITECTURE.md §6` roadmap.
