# AI-BUSINESS-COPILOT

دستیار هوشمند کسب‌وکار — a complete, production-grade ERP-style business management application with an AI copilot, bilingual (English / فارسی) UI, and a full Jalali (Persian) calendar system.

## What it is

A single-tenant business ERP that grows with its operator: invoices, payments, expenses, products, customers, inventory, advanced reports and statements, an AI copilot that reads the business's own financial truth, team invites with role gates, and a QA discipline that has kept the whole system green across 178+ development rounds.

## Technology

| Layer | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router) + TypeScript 5 |
| Styling | Tailwind CSS 4 + shadcn/ui (New York) + Lucide icons |
| Database | Prisma ORM + SQLite (`db/custom.db`) |
| Auth | NextAuth.js v4 (credentials, invite tokens, MFA) |
| State | Zustand (client) + TanStack Query (server) |
| AI | z-ai-web-dev-sdk — backend-only, structured DTO boundary (see `src/lib/ai/`) |
| i18n | EN + FA with full RTL, bidi isolation, Jalali-first date grammar |

## Highlights

- **Jalali-native date system** — presets, custom ranges, adjacent-window paging and deep links all ride one applied-range state; the server's range grammar (`422 INVALID_REPORT_RANGE`) is mirrored honestly in the UI.
- **AI copilot with a secret-free boundary** — snapshot queries never touch auth/payment/cost tables; DTO serialization is explicit; `scripts/ai-context-secret-scan.mjs` proves the boundary (11 checks) on every audit.
- **Three-tier self-healing dev chain** — `dev-watchdog.cjs` (supervisor) keeps `dev-rss-guard.cjs` (OOM guard) alive, and the guard's down-selfheal revives the dev server; single-responsibility laws and three-lock hygiene documented in `scripts/`.
- **One-command dev data recovery** — `scripts/recover-dev-data.sh` rebuilds the fixture contract (persona + QA shop) idempotently.
- **Test discipline** — `scripts/run-family.sh` runs the whole family: per-round batteries (family-census assertRegistered), REAL-HTTP proofs, e2e-smoke, i18n/motion audits, tsc + eslint; two-pass union coverage.

## Development

```bash
bun install
bun run dev        # http://localhost:3000
bun run lint
bun run db:push    # sync prisma/schema.prisma
```

## Repository discipline

- `worklog.md` carries one detailed entry per development round (178+ rounds and counting).
- Every round of progress is committed and pushed here with full detail — the history IS the project's diary.
- QA screenshots per round live under `download/qa-rN*/`.
