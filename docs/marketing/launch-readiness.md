# Launch Readiness — Public Surface Audit (Prompt 17)

**Document ID:** LAUNCH-READINESS-v1.0
**Phase:** Prompt 17 (audit/design only — no `src/` changes in this phase)
**Brand (FIXED):** "AI Business Copilot" / "Your business, understood."
(`src/i18n/messages/en.ts:3-4`)

This document inventories what the public sees today, lists what is missing
for a commercial launch, and sets honest-copy rules. It does **not** redesign
the landing.

---

## 1. How the public surface works today (EXISTS)

The app is a **single-origin SPA**: `src/app/page.tsx:1-12` renders
`Providers → AppRoot`; navigation between the auth/landing view and app
modules happens via Zustand views mirrored to URL hashes
(`src/store/app-store.ts:14-17`, hash map `:69-95`). There is no separate
marketing site — the auth view **is** the landing.

### 1.1 Inventory of what EXISTS on the public surface

| Element | Where | Notes |
|---|---|---|
| Brand name | `src/i18n/messages/en.ts:3` (`appName`), rendered in brand panel `src/modules/auth/auth-view.tsx:137-139` | "AI Business Copilot" (fa: "دستیار هوشمند کسب‌وکار", `src/i18n/messages/fa.ts:6`) |
| Tagline | `en.ts:4` (`tagline`) — hero heading `auth-view.tsx:146-148`, brand row `:140` | "Your business, understood." (fa: "کسب‌وکارتان، شفاف و روشن.", `fa.ts:7`) |
| Value-proposition line | `auth-view.tsx:149-152` (hardcoded EN string in component) | "Customers, sales, expenses and cash flow — with an AI copilot that answers from your real numbers." |
| Value bullets (3) | `auth-view.tsx:154-167` | ① per-business data isolation with server-enforced roles ② deterministic financial math (integer minor units, never floats) ③ AI copilot that calculates from recorded business data |
| Sign-up CTA | form panel `auth-view.tsx:176-295`; signup mode `:188-201`, register mutation `:81-102` → `POST /api/v1/auth/register` | Sign in / sign up toggle `:274-286` |
| Privacy note | `auth-view.tsx:288-291` → `t("privacyNote")`; fa: `fa.ts:97` | "Your account is protected by a password and each business's data stays isolated server-side." (paraphrase) |
| Language/quality strip | `auth-view.tsx:170-172` | "English · فارسی · Light / Dark · RTL-first design" |
| Page metadata | `src/app/layout.tsx:25-39` | title, description ("…answers from your real numbers — never invented ones"), keywords, OG title/description (tagline) |
| Viewport/theme meta | `layout.tsx:41-48` | device-width, light/dark theme-color |
| robots.txt | `public/robots.txt` | exists |
| Persian typography + RTL | `layout.tsx:19-23` (Vazirmatn), `layout.tsx:56` (`html lang="en" dir="ltr"` base), RTL applied at app-shell level | fa is first-class (Constitution A05/A06) |

### 1.2 Known gaps *inside* the existing view (for the record, not redesigned here)

- The value-proposition line under the tagline (`auth-view.tsx:149-152`) is a
  hardcoded English string, bypassing the i18n dictionaries (A05 says all
  user-facing strings live in centralized dictionaries). It does not render
  in Persian on the fa UI.
- `layout.tsx:56` hardcodes `lang="en" dir="ltr"`; locale is switched at the
  shell level — acceptable for the SPA, but crawlers see the EN metadata only.

---

## 2. What's MISSING for launch (gap table)

Status: ✅ exists · 🟡 partial · ❌ missing. "Blocking?" = ship-blocker for a
paid launch (Y/N).

| # | Item | Status | Owner-phase | Blocking? | Notes |
|---|---|---|---|---|---|
| 1 | Pricing page (public, honest, no fake numbers) | ❌ | Billing implementation phase (after `docs/billing/billing-architecture.md` is ratified) | **Y** for paid launch | Design exists; no prices decided; must not appear before billing works (Rule 05 — no fake functionality) |
| 2 | FAQ (what it is / is not; data storage; export) | ❌ | Prompt 18+ (content) | N (soft) | Should include "not accounting software" honesty |
| 3 | Contact / support channel | ❌ | Prompt 18+ (content + operator decision) | **Y** | Needs a real, monitored channel before paid users exist |
| 4 | Support email | ❌ | Prompt 18+ (operator decision) | **Y** | One mailbox is enough at MVP scale |
| 5 | Terms of Service | ❌ | Prompt 18+ (legal counsel) | **Y** | Must reflect operator jurisdiction; counsel-reviewed |
| 6 | Privacy Policy | 🟡 | Prompt 18+ (legal counsel) | **Y** | A privacy *note* exists (`auth-view.tsx:288-291`) but not a full policy; must describe actual data flows (SQLite DB, backup JSON export) |
| 7 | Cookie / consent strategy | 🟡 | Prompt 18+ | N (soft) | Current cookies are session-essential (NextAuth JWT session, `src/lib/auth.ts:29-32`); no analytics/tracking cookies exist yet → banner not required today, re-audit if any tracking is added |
| 8 | Changelog / release notes | ❌ | Prompt 18+ (content) | N | `worklog.md` is internal-only; public changelog needs a home |
| 9 | Status page | ❌ | Deployment phase | N | MVP: a monitored health endpoint + comms channel (see `docs/deployment/production-checklist.md` §6) |
| 10 | Refund policy | ❌ | Billing implementation phase (legal counsel) | **Y** for paid launch | Must match chosen payment provider's capabilities |
| 11 | Data-Processing Addendum (DPA) | ❌ | Post-launch (legal counsel) | N | Needed for business customers with compliance demands |
| 12 | Pricing/tax/currency disclosure | ❌ | Billing implementation phase | **Y** for paid launch | A04: each business has its own currency — checkout currency handling must be disclosed |

**Minimal viable launch set:** items 3, 4, 5, 6 (+1, 10 for paid).

---

## 3. Honest copy guidelines (claims policy)

### 3.1 Positioning (fixed)

> **AI Business Copilot — AI-powered business management and financial
> insight.** Your business, understood.

- It is **not** accounting software (no double-entry ledger, no tax
  management — those are listed as future direction only,
  `docs/ARCHITECTURE.md:158-164`).
- It is **not** bank-grade security infrastructure; it is a well-isolated
  small-business SaaS (single-node, SQLite; see
  `docs/deployment/production-checklist.md` scaling caveats).

### 3.2 Forbidden claims — never appear in UI, docs, or marketing

| Forbidden | Why |
|---|---|
| "Bank-grade security" / "bank-level encryption" | Overclaims the security posture (A14 scope is app-level: auth, RBAC, tenant isolation — `docs/PROJECT-CONSTITUTION.md:230-240`) |
| "100% secure" / "unhackable" / "bulletproof" | No system can claim this |
| "AI accounting" / "your accountant" | Misrepresents the product; it is management + insight, not bookkeeping of record |
| "Never makes mistakes" / "always accurate" | Violates the product's own honesty model — AI output is *interpretation*, numbers are *computed* (Constitution §1.1, `:30-47`) |
| "Guaranteed uptime" / SLA numbers | No SLA exists |
| Any claim that data is encrypted at rest on the server | Not implemented today |
| Any payment/regulatory compliance claim (PCI, PSD2, …) | No payment integration exists; provider decision is deferred |

### 3.3 Approved claims (may be used — each traceable to code)

| Approved claim | Backed by |
|---|---|
| "Per-business data isolation with server-enforced roles" | Already in UI (`auth-view.tsx:156`); A01/A02 tenant re-verification on every request (`docs/ARCHITECTURE.md:67-77`) |
| "Answers computed from your recorded data" / "answers from your real numbers — never invented ones" | Already in UI (`auth-view.tsx:150-152,158`; `layout.tsx:27-28`); deterministic-metrics-first pipeline (A12, `docs/ARCHITECTURE.md:84-102`) |
| "Deterministic financial math — integer minor units, never floats" | A08 (`docs/PROJECT-CONSTITUTION.md:184-191`); already in UI (`auth-view.tsx:157`) |
| "Your data is exportable — one portable JSON file" | Export endpoint exists (`src/app/api/v1/businesses/[id]/export/route.ts`) |
| "English and Persian, RTL-first" | A05/A06; already in UI (`auth-view.tsx:171`) |
| "The assistant tells you when it doesn't have enough data" | Constitution §1.1 rule 4 (`:41`) |

Rule of thumb: **every public claim must point at shipped code or a ratified
constitution assumption.** If it can't, it's a roadmap item, not a claim.

---

## 4. SEO / i18n basics (no landing redesign)

- **Meta (EXISTS):** EN title/description/OG are set in
  `src/app/layout.tsx:25-39` with the fixed brand and tagline. These are the
  canonical marketing strings today.
- **FA meta (GAP):** metadata is EN-only; Persian-language metadata (or
  hreflang-alternates) does not exist. If FA SEO matters, the cheapest path is
  FA Open Graph fields on the root layout — a later `src/` change, out of
  scope here (audit phase).
- **Locale routing (DECIDED):** heavyweight i18n locale-prefix routing was
  explicitly rejected for this single-origin app
  (`docs/TECH-DECISION-RECORD.md` §3, "Heavyweight i18n routing" row). Deep
  links work via hash views (`#/copilot`, `#/settings`, …,
  `src/store/app-store.ts:69-95`); hash fragments are not indexed as separate
  pages — acceptable for now; revisit only if a real marketing site is added.
- **RTL landing (OK):** the auth view is RTL-correct through logical
  utilities and locale-driven `dir` (A06); FA QA screenshots exist across
  rounds (e.g. `qa-r16-dashboard-fa-kpi.png` project history). Do not
  introduce physical `left/right` classes in future landing edits.
- **robots.txt (EXISTS):** `public/robots.txt`; verify at deploy time that it
  allows indexing on the production origin (and blocks staging).
- **Sitemap/OG image (GAP):** none exists; optional post-launch polish.

---

## 5. Recommendations summary

1. Ship the minimal legal set (ToS, Privacy Policy, support contact) **before
   any paid tier**; counsel-reviewed, operator-jurisdiction-aware.
2. Do not surface pricing UI until billing is implemented (Rule 05) — the
   design lives in `docs/billing/billing-architecture.md`.
3. Adopt §3.3 wording verbatim where possible; it is already code-backed.
4. Fix the hardcoded EN value-proposition string (`auth-view.tsx:149-152`) in
   a future i18n pass (move to `en.ts`/`fa.ts`), not in this phase.
5. Add FA OG/meta + staging robots rules during the deployment phase
   (`docs/deployment/production-checklist.md`).
