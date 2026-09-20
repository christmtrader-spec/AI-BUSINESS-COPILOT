# Risk Register

**Document ID:** RISK-v1.0
**Phase:** Prompt 00
**Review cadence:** revisited at the end of every phase; severity/probability
re-scored as mitigations land.

Severity: Critical / High / Medium / Low
Probability: High / Medium / Low

---

## 1. Register

| # | Risk | Severity | Probability | Mitigation |
|---|------|----------|-------------|------------|
| R1 | Tenant data leakage (cross-business reads/writes) | Critical | Medium | Backend-only authorization; `businessId` scope on every Prisma query; session→membership re-verification per request; authorization tests; audit on access anomalies |
| R2 | Financial calculation error (wrong totals, rounding drift) | Critical | Medium | Integer minor units only (A08); deterministic `lib/money.ts` helpers; no float math in feature code; strongest test coverage on money/metrics layer; audit trail for corrections |
| R3 | AI hallucination (invented numbers / fake facts) | High | Medium | Deterministic-first pipeline (A12); AI narrates structured app-computed results only (A11); explicit insufficient-data refusals; provenance labels; read-only MVP copilot |
| R4 | Vendor lock-in (AI provider, storage, DB) | Medium | Medium | `AIProvider` + `StorageAdapter` abstractions (A10/A15); portable schema; Prisma as single DB surface |
| R5 | Poor mobile usability | High | Medium | Mobile-first responsive UX; 44px touch targets; QA matrix 360/390/412 widths each phase |
| R6 | Excessive architecture complexity | High | Medium | Modular monolith (Rule 06); no infra beyond app + db; ADR required for any infra addition |
| R7 | Security vulnerabilities (injection, XSS, auth bypass, secret leakage) | Critical | Medium | zod validation everywhere; Prisma parameterization; bcrypt passwords; server-only secrets; consistent error envelope without internals; audit logging; security pass in Phase 06 |
| R8 | SQLite write contention / scaling ceiling | Medium | Medium | Acceptable for MVP single-node; short transactions; indexed queries; documented Postgres migration path (TDR D3); monitor for lock timeouts |
| R9 | Data loss (single-file DB, no backup) | High | Medium | Documented db-file backup routine; soft-delete for financial records; migration safety (`db:push` only in dev; migrate discipline before production) |
| R10 | i18n / RTL regression drift (en fixed, fa broken) | Medium | High | Centralized dictionaries (no hardcoded strings); logical CSS utilities; RTL+LTR in per-phase QA; fa treated as first-class |
| R11 | AI cost/latency spikes | Medium | Medium | Rate limiting on copilot endpoint; deterministic answers for numeric questions (short prompts); metric snapshot reuse; provider timeout + graceful degradation |
| R12 | Demo/seed data leaking into production paths | Medium | Low | Rule 05 (no fake financial data); seeds only behind explicit dev guard; empty states designed as first-class |
| R13 | Incremental-session regressions (multi-round development stepping on each other) | High | Medium | Worklog handover each round (Rule 08); Rule 02 smallest-safe-change; lint + browser QA each round; constitution as change contract |
| R14 | Auth/session weaknesses (weak passwords, session fixation, brute force) | Critical | Medium | bcrypt hashing; JWT session rotation on sign-in; rate limiting on auth routes; lockout backoff; security headers |
| R15 | Permission model drift (frontend-only hiding) | High | Medium | RBAC enforced server-side in API pipeline (A02); permission matrix single source (`lib/rbac.ts`); authorization tests |
| R16 | Timezone/locale bugs corrupting day-boundary reports | High | Medium | UTC storage (A07); business timezone applied only at aggregation/display boundaries; date-boundary unit tests for metrics |
| R17 | Schema drift around money fields (new dev adds Float) | High | Low | Constitution + TDR guardrails; code review checklist; money helpers are the only sanctioned math path |

---

## 2. Top Risks Summary (watchlist)

1. **R1 Tenant leakage** — the #1 product-killer; mitigation is mandatory
   from the first DB migration (Phase 01), not retrofitted.
2. **R2 Financial calculation error** — the money layer is the highest-test
   priority in the whole system.
3. **R7 Security vulnerabilities** — pipeline-level controls (validation,
   auth, audit) land with the first API routes.
4. **R13 Multi-round regressions** — this project develops in incremental
   sessions; the worklog + QA loop is the primary defense.

---

## 3. Accepted Risks (for MVP)

- R8 (SQLite ceiling) — accepted until scale signals appear; migration path
  documented.
- R11 partial (AI cost) — accepted for MVP with rate limiting; revisit with
  usage data.
