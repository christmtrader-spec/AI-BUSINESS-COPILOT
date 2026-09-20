# AI Business Copilot — Architecture Direction & Module Map

**Document ID:** ARCH-v1.0
**Phase:** Prompt 00
**Companion to:** `docs/PROJECT-CONSTITUTION.md`

---

## 1. Architecture Style

**Modular monolith** on Next.js 16 (App Router) — one deployable app, strict
internal module boundaries. This satisfies Rule 06 (no premature complexity)
while preserving A17 (modularity): modules communicate only through exported
service functions and typed contracts.

```text
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT (Browser)                         │
│  React 19 + Next.js App Router                                  │
│  shadcn/ui (New York) · Tailwind 4 · next-themes · Recharts     │
│  State: Zustand (UI) + TanStack Query (server cache)            │
│  i18n dictionaries (en/fa) · dir=ltr|rtl                        │
└───────────────────────────┬─────────────────────────────────────┘
                            │  fetch (same-origin, relative URLs)
┌───────────────────────────▼─────────────────────────────────────┐
│                     NEXT.JS SERVER (Node)                       │
│                                                                 │
│  /api/v1/** Route Handlers                                      │
│  ┌────────────────────────────────────────────────────────┐     │
│  │ REQUEST PIPELINE (every route)                         │     │
│  │  1. zod input validation                               │     │
│  │  2. authenticate (NextAuth session)                    │     │
│  │  3. resolve active business + membership (tenant)      │     │
│  │  4. authorize (RBAC permission matrix)                 │     │
│  │  5. execute module service (Prisma, businessId-scoped) │     │
│  │  6. audit() on critical mutations                      │     │
│  │  7. consistent response envelope / error mapping       │     │
│  └────────────────────────────────────────────────────────┘     │
│                                                                 │
│  Modules (A17 boundaries)                                       │
│  identity · business · customers · suppliers · products ·       │
│  inventory · sales · expenses · payments · finance ·            │
│  reporting · copilot(AI) · notifications · audit · billing*     │
│                                                                 │
│  Cross-cutting libs:                                            │
│  lib/auth · lib/rbac · lib/tenant · lib/money (int minor units) │
│  lib/copilot/metrics (deterministic) · lib/copilot/tools        │
│  lib/ai/provider (vendor abstraction) · lib/storage (A15)       │
│  lib/i18n · lib/audit · lib/api-helpers · lib/rate-limit        │
└───────────────┬──────────────────────────────┬──────────────────┘
                │                              │
┌───────────────▼───────────────┐  ┌───────────▼──────────────────┐
│  PRISMA ORM                   │  │  AI PROVIDER (server-only)   │
│  SQLite (db/custom.db)        │  │  AIProvider interface        │
│  Tenant-scoped relational     │  │  └─ z-ai-web-dev-sdk adapter │
│  schema · money = Int minor   │  │  (swap vendor = new adapter) │
└───────────────────────────────┘  └──────────────────────────────┘

* billing module = boundary placeholder only (A16)
```

---

## 2. Tenant Isolation Flow (A01/A02 — Security Critical)

```text
Browser request (session cookie)
  → NextAuth verifies session → userId
  → resolve activeBusinessId (session claim)
  → BusinessMember lookup: (userId, businessId) must exist → role
  → RBAC matrix: does role allow this action on this resource?
  → ALL Prisma queries include { where: { businessId } }
  → cross-tenant access attempt = 403 + audit log
```

No feature code may query a business-scoped table without a `businessId`
filter. This is enforced by convention + code review + authorization tests.

---

## 3. AI Copilot Pipeline (A10–A13)

```text
User question ("How much did I sell this week?")
  → POST /api/v1/copilot/ask  (auth + rate limit)
  → intent detection (fast LLM classify OR rule-based; JSON schema output)
  → approved tool selection from lib/copilot/tools.ts (explicit allow-list)
  → tool validates params (zod) + tenant/role check
  → deterministic metric computation (lib/copilot/metrics.ts, Prisma aggregates)
  → structured result { metric, valueMinor, currency, period, provenance: "app-data" }
  → AIProvider.chat( system: data-integrity rules, context: structured result )
  → natural-language explanation (interpretation, labeled as such)
  → response: { answer, data: [authoritative figures], disclaimers }
```

Hard guarantees:
- Numbers shown to the user come from the structured result, never from the
  LLM's own generation.
- Insufficient data → the assistant explicitly says so.
- MVP Copilot is **read-only**; execution-type actions require a future
  confirmation workflow (Constitution §10).

---

## 4. Data Model Direction (DB v1 lands in Phase 01)

Core tenant graph:

```text
User ─┬─< BusinessMember >─ Business
      │                        │  currencyCode · symbol · locale · timezone
      │                        ├─< Customer
      │                        ├─< Supplier
      │                        ├─< Product (stockQty for basic inventory)
      │                        ├─< SalesInvoice ─< SalesInvoiceItem
      │                        │        └─< Payment (received)
      │                        ├─< Expense (category, paidFrom)
      │                        ├─< SupplierBill (minimal, for payables)
      │                        │        └─< Payment (made)
      │                        └─< AuditLog
      └─ Account (NextAuth credentials)
```

Rules: every business-owned table has indexed `businessId`; money columns
are `Int` minor units (A08); timestamps are Prisma `DateTime` UTC (A07);
deletions are soft (`deletedAt`) for financial records.

---

## 5. Module Map

### 5.1 MVP Modules (implemented phase-by-phase)

| Module            | Phase | Scope                                                  |
|-------------------|-------|--------------------------------------------------------|
| Identity/Auth     | 01    | NextAuth credentials, session, user profile            |
| Business (tenant) | 01    | Create business, members, settings, active-business switch |
| Design system     | 01    | App shell, nav, theme, i18n en/fa, RTL                 |
| Customers         | 02    | CRUD, notes, balances                                  |
| Suppliers         | 02    | CRUD, notes, balances                                  |
| Products          | 02    | CRUD, price/cost, stock qty                            |
| Inventory (basic) | 02    | Quantity adjustments with audit                        |
| Sales             | 03    | Invoices + items, statuses, line totals                |
| Expenses          | 03    | Categorized expense records                            |
| Payments          | 03    | Received/made payments against invoices/bills          |
| Receivables       | 03    | Derived views: outstanding, overdue, aging             |
| Payables          | 03    | Derived views (minimal)                                |
| Dashboard         | 04    | Actionable KPIs from real data                         |
| Reports           | 04    | Sales, expenses, cash flow, receivables aging          |
| AI Copilot        | 05    | Chat UI, intent → tool → metric → explanation          |
| Notifications     | 05+   | In-app alerts (overdue, low stock)                     |
| Audit             | 01+   | AuditLog + viewer for admins                           |
| Settings          | 01    | Business settings, user preferences                    |
| Billing           | —     | Boundary placeholder only (A16)                        |

### 5.2 Future Modules (NOT in MVP — direction only)

Purchases (full), advanced accounting, double-entry ledger, tax management,
electronic invoicing, checks, loans, payroll, fixed assets, manufacturing,
multi-branch, multi-company, advanced CRM, e-commerce integrations, banking
integrations, crypto portfolio tracking, forecasting, AI document processing,
voice AI, autonomous AI agents, subscription billing (implementation),
offline mobile sync.

---

## 6. Phase Roadmap (Execution Order)

| Phase | Title                | Deliverables (incremental, each phase keeps app working) |
|-------|----------------------|----------------------------------------------------------|
| 01    | Foundation           | DB schema v1 (User/Business/BusinessMember/AuditLog + settings), NextAuth credentials auth, app shell (responsive sidebar layout, theme switcher, en/fa i18n + RTL, sticky footer), onboarding (create business), settings pages |
| 02    | Master Data          | Customers, Suppliers, Products + basic inventory adjustments; real empty states |
| 03    | Transactions         | Sales invoices, expenses, payments; receivables/payables views; audit coverage |
| 04    | Dashboard & Reports  | KPI dashboard, charts (Recharts), reports from real data |
| 05    | AI Copilot           | Provider abstraction, tool layer, deterministic metrics, chat UI, rate limiting |
| 06    | Hardening & QA       | Full QA matrix (5 viewports × light/dark × LTR/RTL), security pass, polish, performance |

Each phase ends with: lint clean, dev server verified, browser QA of new +
existing flows, and a worklog entry (Rule 08).
