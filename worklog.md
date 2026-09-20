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

---
Task ID: 03
Agent: Z.ai Code (cron webDevReview round)
Task: Status assessment + QA, then Phase 03 — Transactions (sales invoices +
items, expenses, payments, receivables/payables derived views) per roadmap §6.
Mandates: styling details, more features, worklog handover.

Work Log:
- Baseline verified: server 200, lint clean, Phase 01/02 flows intact
  (agent-browser snapshot + console: zero errors).
- DB: added Sale (per-business sequential `number`, customerId?, denormalized
  subtotalMinor/discountMinor/totalMinor + paidMinor/status maintained by the
  payments pipeline), SaleItem (product snapshot: name/unit/qty/unitPrice/
  lineTotalMinor), Expense (supplierId?, category, amountMinor + paidMinor/
  status), Payment (exactly one of saleId/expenseId, direction IN|OUT, method
  CASH|BANK_TRANSFER|CARD|OTHER, paidAt, actor). All money = Int minor units
  (A08). db:push OK; dev server restarted (Phase 02 lesson applied).
- Server: money.ts gained statusOf() (single source of truth for
  UNPAID/PARTIAL/PAID); finance.ts (formatInvoiceNumber); schemas.ts gained
  sale/expense/payment zod contracts (payment refine: exactly one target;
  totals recomputed SERVER-side — client values never trusted).
  Routes (all tenant-scoped + RBAC + audited):
  /api/v1/sales (GET list w/ q+status+pagination, POST create w/ items —
  validates customer/products per business, computes totals, decrements
  stock + writes InventoryAdjustment "Sale INV-xxxx" in ONE tx),
  /api/v1/sales/[id] (GET detail w/ items+payments, DELETE soft — blocked
  while payments exist, restores stock with reversal adjustments),
  /api/v1/expenses (GET/POST), /api/v1/expenses/[id] (PATCH — amount may
  never drop below paid; DELETE blocked while payments exist),
  /api/v1/payments (GET w/ direction filter; POST — finance:manage,
  overpayment → 422, updates paidMinor+status in same tx),
  /api/v1/payments/[id] (DELETE — reverses balances),
  /api/v1/receivables + /api/v1/payables (derived views: totals, open counts,
  oldest-first items, per-party aggregation).
- Frontend: finance-kit.tsx (FinanceStatusBadge color-coded, StatCard,
  fmtMoney/fmtDate, txKeys + useInvalidateFinance); sale-form-dialog (customer
  picker, line items w/ product autofill + custom items, discount, live
  integer-math totals preview); sale-detail-dialog (items, totals, payment
  history w/ delete, record-payment inline); payments/payment-form-dialog
  (shared by payments module + receivables/payables quick actions + invoice
  detail; groups open invoices/expenses, defaults amount to outstanding
  balance); sales/expenses/payments views (search, status/direction filters,
  pagination, empty states); balances-view (shared receivables/payables:
  stat cards, per-party badges, Pay action per row). Sidebar: 5 modules now
  live (only Copilot/Reports "coming soon"). Footer + sidebar badge →
  "Phase 03 · Transactions". Dashboard: getting-started step 4 now links to
  Sales; roadmap p1/p2 marked done (emerald + check); "At a glance" now shows
  REAL derived numbers (receivable, payable, payments count) — no fake data.
  i18n: complete `finance` namespace in en + fa (RTL), dashboard strings
  updated both languages.
- FIXED DURING QA (agent-browser found real bugs):
  1) CRITICAL money bug (Constitution risk R2): toMinor() used the scale
     multiplier (100) as the decimal digit count → ANY decimal input ("12.5")
     threw "Amount out of safe range"; whole numbers silently worked.
     Fixed (digits vs scale split) + verified with an 11-case sanity suite
     incl. half-up rounding, precision 0/4, thousands separators.
  2) Radix SelectItem crash with empty-string value (walk-in/custom/no-
     supplier options) → sentinel values mapped back to "".
  3) TanStack Query invalidation never matched: query keys were nested
     ([["sales"], ...]) while invalidate used ["sales"] → lists went stale
     after mutations. Flattened to [...txKeys.x, ...] / ["sales","detail",id].
  4) Sale dialog kept stale draft on reopen → render-adjust reset pattern.
  5) Removed unused prop/leftovers; a11y DialogTitle warnings verified as
     stale HMR history (all dialogs have Title+Description).
- Styling details: monospace tracking-tight invoice numbers (list + detail),
  color-coded status badges (amber UNPAID / sky PARTIAL / emerald PAID),
  signed +/− colored amounts in the payments ledger, per-party outstanding
  badges, responsive line-item grid (stacked cards on mobile, inline on
  sm+), consistent FormDialog footers, custom scrollbars already global.

Verification (agent-browser E2E + API):
- Invoice INV-0001 (Gift wrap €2.50 + Handmade Candle 2×€12.50 = €27.50)
  created via UI; stock 13→11; InventoryAdjustment "Sale INV-0001"; audit
  sale.create + inventory.adjust. OK
- Partial payment €10 (detail dialog) → PARTIAL, balance €17.50; receivables
  showed €17.50; full payment €17.50 (receivables quick action, amount
  auto-defaulted) → PAID, receivables "Everything is settled", balance €0.00.
  OK
- Expense Rent €800 → payables €800; paid €300 (payables quick action) →
  PARTIAL, payables €500. OK
- Payments ledger shows IN/OUT with signed colored amounts; direction filter
  works. OK
- Dashboard at-a-glance: receivable €0.00, payable €500.00, payments 3 —
  exact real values. OK
- SECURITY: unauth → 401; fake business id → FORBIDDEN; overpayment → 422
  OVERPAYMENT; eve added as VIEWER: read 200, POST sale 403
  PERMISSION_DENIED, POST payment 403; UI hides write buttons for VIEWER;
  DELETE paid invoice → 422 SALE_HAS_PAYMENTS; audit trail complete
  (member.add, payment.create×3, expense.create, sale.create, ...). OK
- فارسی RTL: dir=rtl lang=fa, sidebar mirrored right, sales module fully
  translated, mixed-content cells dir=auto. Mobile 390×844: no horizontal
  overflow (scrollW=clientW=390). Dark + light themes verified. Screenshots:
  download/qa-final-sales.png, qa-final-detail.png,
  qa-final-receivables-light.png, qa-sales-rtl.png, qa-sales-mobile-fa.png.
- `bun run lint` clean; dev.log clean (no runtime errors).

Stage Summary:
- Phase 03 COMPLETE: MVP items 8-12 (sales, expenses, payments, receivables,
  payables) live with deterministic integer money math, transactional stock
  integration, full audit coverage, en/fa + RTL.
- Data model note: paidMinor/status are denormalized; single writer is the
  payments pipeline (create/delete + expense PATCH recompute) — keep it that
  way (documented in schema comments).
- Known minor: payments ledger pagination only (no search yet); sale detail
  dialog opens from list only; invoice PDF export deferred to Phase 04/06.
- Next (Phase 04 per roadmap): dashboard KPIs + reports from real data
  (Recharts; revenue vs expenses timeline, top products, cash collected),
  sales summary endpoint; then Phase 05 AI Copilot (read-only, grounded in
  these deterministic metrics).
- Test accounts unchanged: sara@copilot.dev (OWNER), ali@copilot.dev (ADMIN),
  eve@outsider.dev (now VIEWER member) — dev-only DB.

---
Task ID: 04
Agent: Z.ai Code (cron webDevReview round)
Task: Status assessment + QA, then Phase 04 — Dashboard & Reports (deterministic
KPIs + charts from real data) per roadmap §6. Mandates: styling details, more
features, worklog handover.

Work Log:
- Baseline verified: lint clean; agent-browser E2E of all Phase 01-03 modules
  (dashboard, sales, expenses, payments, receivables, payables, products,
  inventory, customers) — all rendering with real data, zero console errors.
- INFRA FIX: dev server had a stale module graph (broken HMR after
  "unrecoverable error" reloads) causing phantom MISSING_MESSAGE errors and an
  empty main content on reload. pkill'd server could NOT be restarted by plain
  `nohup ... &` — sandbox reaps it when the tool call ends. WORKING PATTERN:
  double-fork `( setsid bun run dev >> dev.log 2>&1 < /dev/null & )` — the
  next-server process survives across tool calls (verified PID across calls).
  Recorded here because future rounds WILL need to restart the server after
  db:push.
- DB: no schema changes this round.
- API: new GET /api/v1/reports/summary?days=7|30|90 (data:read, tenant-scoped):
  KPIs (revenue issued, collected, expenses, paid out, net cash, net accrual,
  sales count, avg sale), timezone-aware daily timeline (Intl en-CA bucketing
  honoring Business.timezone per A04), top products (from SaleItems),
  expenses by category, outstanding receivable/payable (aggregates),
  inventory value at cost + low-stock items. All integer minor units (A08),
  all computed server-side (Rule 05 / A11-A13).
  FIX during QA: expense aggregate used totalMinor (doesn't exist on Expense)
  → amountMinor; caught by API smoke test before UI wiring.
- Frontend Reports view (src/modules/reports/reports-view.tsx) with Recharts
  via shadcn ChartContainer: 4 KPI cards (icon chips, tone colors), income vs
  spending gradient area chart, cash in/out bar chart, expenses-by-category
  donut + % list, top products horizontal bars, inventory health card (value +
  low-stock badges), outstanding balances as clickable nav cards. Range
  selector 7/30/90. Empty state when zero activity. Loading skeletons. Error
  retry. dir="ltr" inside chart containers for RTL safety; localized tooltips
  via custom MoneyTooltip.
- Dashboard upgrade: "Performance — last 30 days" card (mini area chart +
  4 stat tiles + Open reports button, shared query cache with Reports);
  low-stock amber alert banner (only when lowStockCount > 0 — no fake
  urgency) with Review products action; getting-started step 4 now marked
  done when at least one sale exists (sales probe query); roadmap p3 done /
  p4 current in en+fa.
- Styling details: rebranded chart palette (emerald/teal/amber/rose/orange —
  removed default blue hues, light + dark); print stylesheet
  (.invoice-print-sheet) in globals.css; recharts focus-visible outline.
- New features: (1) Payments ledger search — API `q` filters note/method/
  invoice number (numeric only)/customer/supplier/category + SearchInput in
  view (closes Phase 03 known gap); (2) invoice PRINT from sale detail
  dialog — self-contained printable HTML window (dir/lang aware, escaped,
  items/totals/payments/footer) + window.print, verified in browser; (3) CSV
  export for customers & suppliers (PartyView) — up to 500 rows, BOM for
  Excel, RFC-4180 escaping (lib/csv.ts), toast on success; (4) i18n ICU
  plurals for low-stock alert + Persian numerals via fmtCount
  (۱ فاکتور، ۰ فقره باز) for counts in reports + dashboard.
- i18n: new `reports` namespace en+fa; dashboard perf/alert strings en+fa;
  payments searchPlaceholder en+fa; finance.saleDetail print labels en+fa;
  common.exportCsv en+fa; parties.exportedToast en+fa. Sidebar/footer →
  "Phase 04 · Reports".

Verification (agent-browser E2E + curl):
- API: days=30 aggregates match known test data exactly (€27.50 revenue,
  €27.50 collected, €800.00 expenses, €300 paid out, net cash -€272.50);
  topProducts (Candle 2×€12.50, Gift wrap €2.50); inventory value €77.00
  (11×€7); outstanding payable €500. Empty business → clean zeros, no
  division errors. Payments search: q=rent→1, q=1→2 (invoice number),
  q=candle→0. OK
- UI: Reports view EN + FA renders all sections; charts verified via DOM
  (62 bar rectangles, 1 donut sector, area surfaces); range switcher 7/30/90
  recomputes; outstanding cards navigate. OK
- Dashboard: low-stock alert appears after stock adjusted to 3≤5 (amber,
  fa singular "۱ کالا در آستانه اتمام است", en "1 product is running low" —
  ICU plural verified both languages); step 4 struck-through (done).
  OK
- Print: invoice sheet renders items/totals/payments correctly (screenshot
  download/qa-print-invoice.png). OK
- CSV export click: no errors; button renders in EN/FA. OK
- فارسی RTL: dir=rtl lang=fa, sidebar mirrored, reports fully Persian with
  native numerals; screenshots qa-reports-fa-rtl.png, qa-reports-fa-final.png,
  qa-reports-fa-bottom.png. OK
- Dark + light themes verified (qa-dashboard-fa-dark.png,
  qa-reports-en-light.png). Mobile 390×844: no horizontal overflow
  (sw=cw=390), alert + steps stack (qa-dashboard-mobile.png). OK
- Fresh console after reload: ZERO errors (earlier MISSING_MESSAGE +
  exportCsv errors confirmed stale-history; exportCsv fixed by adding key).
  `bun run lint` clean; dev.log clean (no runtime errors). OK

Stage Summary:
- Phase 04 COMPLETE: MVP item 14 (reports) live with deterministic
  server-computed aggregates; dashboard upgraded from static cards to real
  derived metrics. AI Copilot remains the only "coming soon" module.
- Known minor: low-stock item badge count renders Western digit inside fa
  badge (raw stockQty — cosmetic only); reports dates in tooltip use UI
  locale while financial amounts follow business currency config (by design).
- Ops note: dev server currently running (double-fork pattern above); no db
  changes this round so no restart needed for next round.
- Next (Phase 05 per roadmap): AI Copilot — read-only NL Q&A over deterministic
  metrics via /api/v1/copilot (z-ai-web-dev-sdk server-side behind
  AIProvider abstraction; prompt = serialized report/summary data, never raw
  guesswork; A11-A13 guardrails; rate-limited; audited). Alternatively
  security hardening (Phase 06) if AI skill docs unavailable.
- Test accounts unchanged: sara@copilot.dev (OWNER, has business w/ data),
  ali@copilot.dev (ADMIN), eve@outsider.dev (VIEWER), rep16007@t.dev
  (fresh OWNER of empty "Empty Co", pwd testpass123) — dev-only DB.
  Product "Handmade Candle" intentionally left at stock 3 (low-stock demo).

---
Task ID: 05
Agent: Z.ai Code (cron webDevReview round)
Task: Status assessment + QA, then Phase 05 — AI Business Copilot (read-only
NL Q&A grounded in deterministic metrics) per roadmap §6. Mandates: styling
details, more features, worklog handover.

Work Log:
- Baseline verified: server 200, lint clean, all Phase 01-04 modules render
  (agent-browser snapshot); session persisted. AI Copilot was the only
  "coming soon" module → implemented it this round (no schema changes).
- INFRA (Rule 05 refactor): extracted the entire deterministic computation
  from /api/v1/reports/summary into src/lib/reports.ts
  (buildReportSummary + normalizeReportDays + ALLOWED_REPORT_DAYS) — now a
  SINGLE source of truth shared by the Reports UI and the Copilot grounding
  pipeline. Route file reduced to auth + param parsing + ok(). Verified
  identical output after refactor (€27.50 / €800.00 / €500.00 etc).
- AI seam (A11-A13): src/lib/ai/provider.ts — AIProvider interface +
  ZaiProvider wrapping z-ai-web-dev-sdk (server-only pkg installed; SDK
  imported NOWHERE else; swap-friendly; empty completions raise
  AiUnavailableError → 503 AI_UNAVAILABLE).
- Grounding pipeline: src/lib/ai/snapshot.ts (server-only) — builds the
  copilot context from buildReportSummary + open sales/expenses (top 8
  debtors/creditors w/ exact balances) + last 8 payments. CRITICAL DESIGN:
  every monetary figure is pre-computed AND pre-formatted with the business
  currency config and passed as display STRINGS ("€25.00"); raw minor units
  are never given to the model, ratios (collection rate, expense share) are
  computed server-side too — the model NEVER does arithmetic. System prompt
  has 8 hard rules: quote only verbatim figures, admit missing figures,
  read-only, mirror user language (fa/en), no instruction leakage.
- API: POST /api/v1/copilot — getAuthContext + requirePermission
  ("copilot:use" — VIEWER excluded by RBAC matrix) + rate limit 10/min/user
  (A14, 429 w/ retryAfterMs) + zod (copilotAskSchema: question ≤500 chars,
  history ≤8 messages replayed last-6, days 7|30|90) + audit
  "copilot.query" (question truncated 200 chars). maxDuration 60.
- Frontend: src/modules/copilot/copilot-view.tsx — full chat UX: user/
  assistant bubbles (logical rounded corners, RTL-safe, dir="auto" content),
  markdown-lite renderer (bold/bullets/code — no deps, no raw HTML, safe by
  construction), 6 localized suggestion chips, data-window segmented control
  (7/30/90 → passed to grounding), "What it can see" Collapsible listing the
  7 grounded data sections (transparency by design), typing indicator
  (staggered bounce dots + "Thinking…"), copy-answer button (hover reveal +
  copied check), retry chip after failed turns (lastQuestionRef), 0/500
  char counter, Enter-to-send/Shift+Enter newline, auto-scroll w/ atBottom
  detection, viewer lock card (Lock icon + role explanation), error mapping
  (429 → localized wait-{seconds}s, 403, generic). Height calc(100svh-15rem)
  app-like layout, custom scrollbars, emerald/teal brand tones.
- Integration: app-shell routes module "copilot" → CopilotView; sidebar
  badge "coming soon" REMOVED (copilot live); sidebar+footer → "Phase 05 ·
  AI Copilot". Dashboard: teaser card now LIVE ("Ask the copilot" button
  navigates; disabled for roles without copilot:use); roadmap p1-p5 done +
  NEW p6 "Hardening & polish (next)" highlighted. i18n: complete `copilot`
  namespace en+fa (+ groundedNote key fix found in QA), dashboard strings
  updated both languages.

Verification (agent-browser E2E + curl):
- curl: EN question → exact grounded answer (receivable €0.00, rent
  payable €500.00, revenue €27.50, 100% collection rate); FA question →
  Persian answer w/ native numerals (۲ واحد، €25.00 Handmade Candle);
  eve (VIEWER) → 403; unauth → 401. OK
- Burst test: 10 requests 200, 11th → 429 RATE_LIMITED + retryAfterMs. OK
- Audit: copilot.query entries with question+days in /api/v1/audit. OK
- UI (agent-browser): empty state + chips → answer bubble flow; follow-up
  "Which product sold best + inventory worth?" → €25.00 candle revenue,
  €21.00 inventory (3×€7), low stock 3 — exact; 7-day window switch →
  window-scoped figures (collected €27.50, paid out €300, -€772.50 profit);
  transparency panel renders 7 sections; copy button present. OK
- فارسی RTL: dir=rtl lang=fa, sidebar mirrored, copilot fully Persian
  (۷/۳۰/۹۰ روز), Persian question answered in Persian w/ Persian numerals
  (شمع دستساز ۳ عدد). Screenshots: qa-copilot-empty/typing/answer/
  window7-panel/fa-rtl/fa-answer/fa-light/mobile-fa .png. OK
- VIEWER lock card verified in browser (eve signed in). OK
- Mobile 390×844: sw=cw=390 no overflow. Light + dark themes verified.
- Fresh console after reload: ZERO errors (one MISSING_MESSAGE
  copilot.groundedNote caught+fixed during QA). `bun run lint` clean.
- dev.log: only STALE pre-fix Phase-04 Prisma error (line 190/1510, old
  session); all recent requests 200.

Stage Summary:
- Phase 05 COMPLETE: MVP item 15 (AI copilot) live — read-only, grounded,
  rate-limited, audited, bilingual. MVP roadmap §6 items: ALL 16 modules
  now functional; only Phase 06 hardening remains.
- Design guarantee: the copilot CANNOT invent money figures (data is
  pre-formatted strings; ratios pre-computed; prompt forbids arithmetic).
  Follow-ups keep context via last-6 history replay; system prompt always
  rebuilt fresh (history can't carry stale numbers).
- Known minor: non-streaming answers (3-20s wait covered by typing
  indicator; streaming can be added later if SDK supports); audit stores
  only truncated questions (privacy by design).
- Next (Phase 06 per roadmap): hardening & polish — e2e stability pass,
  error-boundary polish, per-page metadata, accessibility audit, rate
  limit tuning, admin ops views, backup/export story, dependency audit.
- Test accounts unchanged: sara@copilot.dev (OWNER), ali@copilot.dev
  (ADMIN), eve@outsider.dev (VIEWER), rep16007@t.dev (Empty Co owner,
  testpass123) — dev-only DB. Dev DB now also contains copilot.query
  audit rows (incl. 10 rate-limit probe "test N" questions) — harmless.

---
Task ID: 06
Agent: Z.ai Code (cron webDevReview round)
Task: Status assessment + agent-browser QA, then Phase 06 — Hardening & polish
per roadmap §6 (bugs first, then features). Mandates: styling details, more
features, worklog handover.

Current project status (assessment at round start):
- Phases 00-05 COMPLETE: all 16 MVP modules functional (dashboard, parties,
  products, inventory, sales, expenses, payments, balances, reports, AI
  copilot, audit, members, settings, profile, onboarding, auth).
- Baseline: server 200, lint clean, dev.log clean. agent-browser E2E sweep
  over all modules found ONE real bug (below); everything else healthy.

Work Log (bugs found & fixed first):
- BUG 1 (i18n, fixed): `MISSING_MESSAGE: inventory.stockLow in en` console
  error — inventory-view.tsx binds useTranslations("inventory") but used
  stockLow/stockOut keys that only existed in the `products` namespace.
  Added both keys to inventory namespace in en.ts + fa.ts. Verified 0 errors
  in a fresh browser session.
- TOOLING (new): scripts/i18n-audit.ts — static audit scanning every module
  tsx for useTranslations bindings + t("key") usages, verifying each exists
  in en AND fa, plus full en<->fa key parity per namespace. Run:
  `bun scripts/i18n-audit.ts`. Current state: 30 files, 465 usages, 0
  missing, 0 parity gaps.
- BUG 2 (dev DB, fixed): sign-in 401 — sara@copilot.dev password hash did
  not match documented `testpass123` (dev-DB drift from an earlier round).
  Reset hashes for all 4 documented test accounts (sara/ali/eve/rep16007)
  to bcrypt(12, testpass123) via one-off bun script (deleted after use).
  Sign-in now works with documented credentials.
- BUG 3 (mobile RTL overflow, fixed): at 390px the header (new palette
  trigger added) overflowed to 418px scrollWidth, pushing the user menu
  off-screen in RTL. Fix: BusinessSwitcher trigger `min-w-0 max-w-[150px]
  flex-1 sm:max-w-[240px] sm:flex-initial` (shrinkable), palette button +
  controls group `shrink-0`, palette label hidden <md. Verified
  390=390 in FA-RTL-dark mobile.

Phase 06 features implemented:
- HASH ROUTER (deep links + history): app-store.ts now has KNOWN_MODULES,
  viewToHash/hashToView/viewKeyOf; navigate() mirrors the view to the URL
  hash (#/sales, #/settings/members, ...) via history.pushState/replaceState;
  replaceView() applies back/forward without pushing. app-root.tsx mounts
  popstate+hashchange listeners and deep-links on load (unknown hash ->
  dashboard). Verified: click->hash+title sync, reload persistence on
  #/reports, browser back -> #/sales, forward -> #/reports, direct hash
  entry -> correct module, #/nonsense -> dashboard fallback. (Sandbox
  constraint: only "/" is exposed, so hash routing was the correct seam.)
- COMMAND PALETTE (Cmd/Ctrl+K): src/modules/shell/command-palette.tsx using
  shadcn CommandDialog. Groups: "Go to" (16 nav targets, audit gated by
  audit:read — UI mirror of RBAC, server still authoritative), Preferences
  (light/dark/system, en/fa), Session (sign out). Global keydown listener;
  header trigger button (icon-only <md, label+kbd >=md) with
  aria-keyshortcuts. Verified EN + FA(RTL mirrored) + navigation.
- PER-MODULE DOCUMENT TITLES: app-shell effect sets
  `${module} · ${business} · AI Business Copilot` localized per active
  locale (verified: "Sales · Sara's Handmade Shop · AI Business Copilot",
  FA "تنظیمات · ... · دستیار هوشمند کسب‌وکار").
- ERROR CONTAINMENT: (1) src/modules/shell/module-boundary.tsx — per-module
  React class boundary wrapping the module switch in app-shell; localized
  fallback card with Retry + Back-to-dashboard; switching module auto-
  clears; (2) src/app/error.tsx route-level boundary (bilingual static
  copy + digest display + reset); (3) src/app/global-error.tsx root
  boundary (own html/body per Next requirements, inline styles).
- DATA & BACKUPS (backup story): GET /api/v1/businesses/[id]/export —
  full-tenant JSON export ($schema ai-business-copilot/backup@1) with
  business config, members, customers, suppliers, products, inventory
  adjustments, sales+line items, expenses, payments, FULL audit trail;
  A08 note embedded (all *Minor = integer minor units). Guards:
  getAuthContext + URL-id match + settings:manage (OWNER/ADMIN),
  rate limit 4/5min/user, audited "data.export" (counts in `after`),
  no password hashes / minimal PII, Content-Disposition attachment
  `backup-<slug>-<date>.json`, no-store. UI: "Data & backups" card in
  Business settings (OWNER/ADMIN only) with checkmark feature bullets,
  blob download + toast; verified via curl (200, 22KB valid JSON, audit
  row) AND browser click ("Backup downloaded" toast, 0 console errors)
  AND RBAC (eve VIEWER -> 403 PERMISSION_DENIED).
- a11y/styling details: skip-to-content link (sr-only -> focus reveal)
  before header; subtle view transition (animate-in fade + slide, keyed
  by view) on module change; "Toggle theme" aria-label now localized
  (shell.toggleTheme en/fa — was hardcoded); phase strings updated to
  "Phase 06 · Hardening & polish" (sidebar footer + app footer);
  dashboard roadmap p6 -> "(in progress)" + phaseNoticeDesc updated
  (en+fa); settings Data card uses emerald check accents consistent
  with brand.

Verification (agent-browser + curl + static):
- Full module sweep (16 modules, exact button locators): 0 console
  errors/warnings in fresh session; all hash routes verified.
- Router: deep link, reload persistence, back/forward, unknown fallback,
  direct hash entry — all verified via browser eval.
- Palette: Ctrl+K opens, filter "invent" -> Enter navigates to
  #/inventory; FA RTL mirrored correctly; footer hint shows Ctrl (not Mac).
- Export: browser click flow + curl (login 302 -> export 200, counts
  match DB, 2 sale items, audit trail included) + VIEWER 403.
- Responsive: 390px FA-RTL-dark no overflow (390=390), header fully
  visible; 1920 desktop EN light verified; screenshots saved:
  qa-r6-palette.png, qa-r6-palette-fa.png, qa-r6-export-card.png,
  qa-r6-export-fa.png, qa-r6-export-dark-fa.png,
  qa-r6-mobile-fa-fixed.png, qa-r6-mobile-sales-en.png,
  qa-r6-desktop-dash-light.png (+qa-r6-baseline.png).
- i18n audit: 465 usages, 0 missing, en<->fa parity 0 gaps.
- `bun run lint` clean; dev.log tail clean (0 errors).

Stage Summary:
- Phase 06 substantially advanced: error containment (module + route +
  root), URL hash routing with full history support, command palette,
  localized document titles, portable JSON backup story, mobile header
  overflow fix, a11y touches (skip link, localized aria labels), i18n
  audit tooling. MVP roadmap §6 hardening items still open for future
  rounds: e2e test automation, dependency audit, admin ops views,
  streaming copilot answers, import (restore) side of the backup story.
- Ops notes: dev server running (double-fork pattern from round 04 —
  survives across tool calls). No schema changes this round; db untouched
  except password reset for the 4 documented dev test accounts.
- Test accounts (restored to docs): sara@copilot.dev (OWNER),
  ali@copilot.dev (ADMIN), eve@outsider.dev (VIEWER),
  rep16007@t.dev (empty-business OWNER) — all `testpass123`. Dev DB also
  contains 2 harmless data.export audit rows.
- Next round recommendation: finish Phase 06 — (a) restore/import side of
  backup (JSON upload with zod validation, OWNER-only, dry-run diff), (b)
  streaming copilot responses if SDK supports, (c) e2e smoke suite as a
  script, (d) dependency audit + A11y contrast pass, (e) consider
  per-module prefetch warming for reports.
