# AI Business Copilot — Project Worklog

> Shared handover document for every agent/session working on this project
> (Constitution Rule 08). Append entries below — never overwrite.
> Read this file BEFORE working, and append your section AFTER finishing.

---

## Project Quick Facts

- **Product:** AI Business Copilot — multi-tenant SaaS business management
  with an AI copilot (see `docs/PROJECT-CONSTITUTION.md`)
- **Stack (locked):** Next.js 16 App Router · TypeScript 5 · Tailwind 4 ·
  shadcn/ui (New York) · Prisma 6 + SQLite (`db/custom.db`) · NextAuth v4 ·
  Zustand + TanStack Query · zod · next-intl (en/fa, RTL) ·
  z-ai-web-dev-sdk behind AIProvider abstraction (server-only) — see
  `docs/TECH-DECISION-RECORD.md`
- **Docs:** `docs/PROJECT-CONSTITUTION.md` (law) ·
  `docs/ARCHITECTURE.md` (module map + phase roadmap §6) ·
  `docs/RISK-REGISTER.md` · `docs/PHASE-00-COMPLETION.md`
- **Commands:** dev server `bun run dev` (port 3000, background, log at
  `dev.log`) · lint `bun run lint` · db `bun run db:push` after schema edits
- **Money law:** integer minor units only, via `src/lib/money.ts` (A08) —
  never floats
- **Tenant law:** every business-scoped Prisma query filters by `businessId`
  after server-side session+membership verification (A01/A02)

## Current Project Status (assessment)

- Phase 00 (constitution) COMPLETE. Project is at clean-scaffold baseline:
  Next.js 16.1.3 running, `GET / 200`, lint clean, full shadcn/ui set
  present, Prisma/SQLite configured with demo `User`/`Post` models only,
  placeholder home page. No business features yet.
- Next milestone per roadmap: **Phase 01 — Foundation** (tenant schema,
  NextAuth credentials auth, app shell with sidebar/theme/i18n+RTL,
  business creation + settings).

## Next-Phase Priorities

1. Phase 01: replace demo schema with tenant core (User, Business,
   BusinessMember, AuditLog; money-ready Int columns) + `bun run db:push`.
2. Phase 01: NextAuth credentials auth (bcrypt), session with
   `activeBusinessId`, API pipeline helpers (`lib/api-helpers`,
   `lib/tenant`, `lib/rbac`).
3. Phase 01: app shell (responsive sidebar layout, light/dark/system theme,
   en/fa dictionaries with RTL, sticky-footer-safe layout), onboarding +
   settings.
4. Then Phase 02 (Customers/Suppliers/Products) per
   `docs/ARCHITECTURE.md §6`.

## Open Issues / Risks

- Demo `User`/`Post` models are scheduled for replacement in Phase 01
  (planned change).
- Automated unit-test runner deferred by environment policy; per-phase bar is
  lint + agent-browser E2E QA (Constitution §9). Money/RBAC logic must stay
  pure/testable for later coverage.
- Full risk register: `docs/RISK-REGISTER.md`.

---
Task ID: 00
Agent: Z.ai Code (main orchestrator)
Task: Prompt 00 — establish project constitution, assumptions, architecture
direction, module map, technology decision record, development rules, risk
register, and phase completion checklist. No product implementation (out of
scope per Prompt 00 §17).

Work Log:
- Inspected repository: package.json (Next.js 16.1.3, React 19, Tailwind 4,
  Prisma 6.11, NextAuth 4.24, next-intl 4.3, zod 4, zustand 5, TanStack
  Query 5, z-ai-web-dev-sdk 0.0.18), prisma/schema.prisma (demo User/Post),
  src/app/page.tsx (placeholder), full shadcn/ui component set present.
- Verified runtime: dev server up on :3000 (`GET / 200` in dev.log, no
  errors), `bun run lint` clean.
- Ratified all 17 assumptions (A01–A17) mapped onto the existing stack; no
  stack changes required (Rule 03/04 respected).
- Created documentation set:
  - `docs/PROJECT-CONSTITUTION.md` — vision, locked MVP scope (16 modules),
    A01–A17, binding dev rules 01–08, UI/UX + design system + DB/API/error
    principles, responsive QA matrix, testing requirements, AI action safety.
  - `docs/ARCHITECTURE.md` — modular-monolith architecture diagram, request
    pipeline, tenant isolation flow, AI copilot pipeline, DB v1 direction,
    module map (MVP vs future), 6-phase roadmap.
  - `docs/TECH-DECISION-RECORD.md` — locked stack with rationale (D1–D9),
    rejected alternatives, guardrails.
  - `docs/RISK-REGISTER.md` — 17 risks (R1–R17) incl. all mandated entries,
    watchlist, accepted risks.
  - `docs/PHASE-00-COMPLETION.md` — acceptance criteria checklist (all met),
    honest current-state table, files list, open issues.
- Verified `/` renders via agent-browser (no blank screen, no console
  errors).
- Created mandatory 15-minute `webDevReview` cron job to continue roadmap
  development incrementally under this constitution.

Stage Summary:
- Prompt 00 COMPLETE; constitution ratified. No product code written
  (per §17/§21 — documentation phase only).
- Next work: Phase 01 — Foundation (tenant schema + auth + app shell +
  i18n/RTL + onboarding/settings) following `docs/ARCHITECTURE.md §6`.
- All future sessions MUST read the constitution first and keep changes
  incremental (Rules 01–08).

---
Task ID: 01
Agent: Z.ai Code (cron webDevReview round)
Task: Assess project status, QA via agent-browser, then advance Phase 01 —
Foundation (tenant schema, auth, app shell, i18n/RTL, onboarding, settings)
per docs/ARCHITECTURE.md §6 roadmap.

Work Log:
- Reviewed worklog + docs; confirmed Phase 00 complete, baseline stable.
- Implemented Phase 01 (full-stack):
  DB: prisma/schema.prisma rewritten — User (passwordHash, locale),
  Business (currencyCode/Symbol/decimalPrecision/locale/timezone per A04),
  BusinessMember (role string; SQLite has no enums — validated in rbac.ts),
  AuditLog (A09); `bun run db:push` OK.
  Libs: money.ts (integer minor units, string-math toMinor, formatMoney),
  rbac.ts (6 roles × 9 permissions matrix + ROLE_RANK), currencies.ts (55
  currencies), api-helpers.ts (envelope {ok,data|error} + route() + zod),
  tenant.ts (session → X-Business-Id → DB membership check per request),
  audit.ts, rate-limit.ts (sliding window), auth.ts (NextAuth credentials
  + bcryptjs 12 rounds + JWT), api-client.ts (x-business-id header,
  envelope unwrap, ApiClientError).
  API: /api/auth/[...nextauth], /api/v1/auth/register, /api/v1/businesses
  (GET/POST), /api/v1/businesses/[id] (GET/PATCH+audit),
  /api/v1/businesses/[id]/members (GET/POST), .../members/[memberId]
  (PATCH/DELETE with last-owner protection + rank checks),
  /api/v1/audit (GET), /api/v1/me (GET/PATCH).
  Frontend: SPA at `/` only (sandbox constraint — no other page routes;
  state-based navigation documented in ARCHITECTURE.md). Providers
  (SessionProvider + next-themes + TanStack Query + NextIntlClientProvider
  with static en/fa catalogs), zustand store (persisted locale +
  activeBusinessId; hydration-safe via useSyncExternalStore), auth view
  (sign in/up), onboarding (business form with currency→symbol/precision
  cascade + live money preview), app shell (shadcn Sidebar with dir-aware
  side, business switcher, locale switcher, theme toggle, user menu),
  dashboard (getting-started, roadmap, honest empty metrics), business
  settings, members management, profile, audit log, coming-soon views.
  i18n: complete en + fa dictionaries (A05), RTL via logical properties +
  html[dir] driven by locale (A06). globals.css: RTL font stack, custom
  scrollbars, selection styling.
- Fixed during QA: missing src/i18n/config.ts (lost dir-creation race),
  dropped useEffect import, dropped signOut import (ReferenceError caught
  by Next dev overlay), sidebar side prop not forwarded in RTL,
  set-state-in-effect lint errors (render-adjust pattern), stray
  tCommon misuse in onboarding error path.
- Added "Team members" sidebar entry (was only reachable via dashboard).

Verification (agent-browser E2E):
- register → auto-signin → onboarding → create business → dashboard: OK
- settings currency USD→EUR/€ persisted after reload: OK
- audit log shows business.create, 2× business.update, member.add: OK (A09)
- member add (ali@copilot.dev as ADMIN): OK
- فارسی RTL: dir=rtl, lang=fa, sidebar flips to right (x=1024/1280): OK
- dark/light/system themes: OK (screenshots in download/qa-*.png)
- mobile 390×844: no horizontal overflow, sidebar collapses: OK
- sign-out → sign-in cycle: OK (POST /api/auth/signout verified)
- SECURITY: eve (no membership) → empty list + 403 FORBIDDEN on business
  + audit; unauth → 401; ADMIN ali demoting OWNER sara → 403 ROLE_TOO_HIGH;
  register rate-limited: OK (A01/A02/A14)
- `bun run lint` clean; dev.log clean (no runtime errors).

Stage Summary:
- Phase 01 Foundation COMPLETE and verified end-to-end.
- Known minor: SidebarMenuBadge "coming soon" labels slightly cramped in
  RTL dark mode (cosmetic, noted for Phase 06 polish).
- Sandbox constraint recorded: only `/` page route exists by design; API
  routes under /api are unaffected.
- Next (Phase 02 per roadmap): Customers / Suppliers / Products CRUD +
  basic inventory adjustments; shared data-table + form-dialog patterns;
  money fields through lib/money; audit on all mutations.
- Test accounts in DB: sara@copilot.dev (OWNER), ali@copilot.dev (ADMIN),
  eve@outsider.dev (no membership) — password copilot2026/evilpass99
  (dev-only database; replace before any production use).

---
Task ID: 02
Agent: Z.ai Code (cron webDevReview round)
Task: Status assessment + QA, then Phase 02 — Master Data (Customers,
Suppliers, Products CRUD + basic inventory adjustments) per roadmap §6.

Work Log:
- Baseline verified: server 200, lint clean, Phase 01 handover reviewed.
- DB: added Customer, Supplier, Product, InventoryAdjustment models.
  Soft delete (deletedAt) on all master data; money = Int minor units
  (salePriceMinor/costPriceMinor, A08); stockQty + lowStockAt on Product;
  adjustments carry delta/reason/actor for full stock history. db:push OK
  (after adding missing inverse relations on User/Business).
- API (all tenant-scoped + zod + RBAC + audited):
  /api/v1/customers[/id] — list (q search, pagination), create, PATCH,
  soft DELETE; /api/v1/suppliers[/id] — same; /api/v1/products[/id] —
  CRUD with explicit price-change audit (product.price_change);
  /api/v1/products/[id]/stock — transactional adjustment: validates
  newQty >= 0 (422 INSUFFICIENT_STOCK), writes InventoryAdjustment +
  audit in one tx; /api/v1/inventory/adjustments — recent history feed.
  Shared schemas extracted to src/lib/schemas.ts (listParams, party,
  product, stock schemas). Server money contract = integer minor units.
- Frontend:
  Generic PartyView (customers & suppliers share one implementation —
  Rule 04) with search, pagination, create/edit dialog, delete confirm.
  ProductsView with MoneyInput (symbol prefix, toMinor validation),
  low-stock/out-of-stock badges, stock dialog. InventoryView with stock
  levels + recent adjustments feed (green/red deltas). Shared table-kit:
  SearchInput (debounced), Pagination (labels optional), FormDialog,
  MoneyInput. Sidebar: customers/suppliers/products/inventory now live
  (no "coming soon"); badge hidden on icon-collapse (RTL cramp fix).
  i18n: full parties/products/inventory catalogs in en + fa; dir="auto"
  on mixed-content cells for bidi correctness.
- Ops note: dev server restart REQUIRED after schema push (old Prisma
  Client cached in memory → tx.customer undefined). Killed next-server
  and relaunched `bun run dev` detached. Future rounds: restart server
  after any db:push that adds models.
- Fixed during QA: Pagination crashed when called without labels prop
  (made labels optional + safe access); leftover void queryClient in
  InventoryView after import cleanup.

Verification (agent-browser E2E + curl):
- curl: customer create 201, product create 201, stock +5 → 15,
  oversell → 422 INSUFFICIENT_STOCK. Audit shows customer.create,
  product.create, 3× inventory.adjust. OK
- UI: customers list shows seeded + UI-created "Mina Jafari"; add
  dialog works. Products table shows Candle (€ price, sku/unit, stock
  15→13 via dialog decrease with reason). Inventory shows stock +
  full history (initial 10, +5 delivery, −2 damaged). OK
- فارسی RTL: inventory fully mirrored, Persian labels; dir=auto fixes
  mixed-content cells. Screenshots: download/qa-inventory-*.png,
  qa-final-*.png. OK
- Mobile 390×844: no horizontal overflow. `bun run lint` clean.

Stage Summary:
- Phase 02 COMPLETE: items 5-7,13 of MVP scope (customers, suppliers,
  products, basic inventory) now real and audited.
- Remaining known issue: none blocking. Dev-DB has test rows (Reza
  Karimi, Mina Jafari, Handmade Candle) — fine for dev.
- Next (Phase 03 per roadmap): Transactions — sales invoices + items,
  expenses, payments; receivables/payables derived views. Reuse
  money.ts + table-kit; keep everything audited. Phase 04 afterwards
  (dashboard KPIs + reports from real data).
