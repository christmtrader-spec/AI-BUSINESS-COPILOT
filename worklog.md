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
