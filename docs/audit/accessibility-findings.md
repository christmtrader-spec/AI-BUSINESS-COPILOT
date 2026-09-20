# Accessibility Findings — Manual Audit

**Document ID:** AUDIT-P17-A11Y
**Round:** Prompt 17 (r18)
**Method:** Manual code inspection + grep-verified counts + agent-browser QA of primary views (360–1920 px, light/dark, LTR en / RTL fa per Constitution §8). **No automated a11y scanner (axe-core or equivalent) is installed** — every statement below traces to code or was checked in the browser by hand.

---

## 1. What is in place (verified)

| Area | Evidence |
|---|---|
| Skip-to-content link, keyboard-reachable, localized en/fa | `src/modules/shell/app-shell.tsx:113-119` (`sr-only focus:not-sr-only focus:fixed …`, `href="#main-content"`); strings at `src/i18n/messages/en.ts:29`, `fa.ts:32` |
| Landmarks: `<header>`, `<main id="main-content">`, `<footer>` | `src/modules/shell/header.tsx:199`, `app-shell.tsx:121,170` |
| Semantic table headers: real `<th>` inside `<thead>` with `aria-sort` (`ascending`/`descending`/`none`) managed by the shared `DataTable` | `src/components/shared/data-table.tsx:233-244` |
| sr-only table captions when `ariaLabel` is passed | `data-table.tsx:220` (`<caption className="sr-only">`) |
| Sort affordance is a **native `<button>`** with a visible header label + `aria-hidden` direction icons | `data-table.tsx:247-268` |
| Dialogs/sheets/popovers via Radix primitives (focus trap, Esc, focus restore for free) | `src/components/ui/dialog.tsx:4` (`@radix-ui/react-dialog`, `package.json:29`), same pattern for alert-dialog, select, dropdown-menu |
| Form labels via shadcn `Label` (Radix `LabelPrimitive.Root`, `htmlFor` wiring in views, e.g. `onboarding-view.tsx:157`) | `src/components/ui/label.tsx:4,13` |
| Decorative icons suppressed from the a11y tree; aria attributes broadly used | 294 `aria-*` occurrences across 43 files; e.g. `data-table.tsx:258-266` (`aria-hidden="true"` on sort arrows) |
| Async/busy regions announced | `aria-busy="true"` on report skeletons (`src/modules/reports/reports-view.tsx:497`); `role="group"` + `aria-label` on the copilot window selector (`src/modules/copilot/copilot-view.tsx:1115`) |
| Icon-only buttons carry sr-only text | e.g. CSV export button `reports-view.tsx:481` |
| RTL parity | `dir` driven by locale at the shell; Tailwind logical utilities throughout (`docs/PROJECT-CONSTITUTION.md` A06); table header alignment fix documented in `src/components/ui/table.tsx:70-75` |
| Keyboard operability of core flows | Primary controls (nav, sort, dialogs, forms, command palette) are native buttons/inputs verified by manual keyboard walk of Dashboard, tables, Sales, Reports, Copilot, Settings |

Usage counts (grep, current tree): `aria-*` → 294 occurrences / 43 files; `sr-only` → 16 occurrences / 11 files (`app-shell.tsx`, `data-table.tsx`, `reports-view.tsx` ×3, `business-settings-view.tsx`, plus shadcn primitives like `dialog.tsx`, `pagination.tsx`, `breadcrumb.tsx`).

## 2. Known gaps (verified, stated precisely)

1. **Chart SVGs have no text alternatives.** Recharts figures rendered through `ChartContainer` — e.g. dashboard performance chart (`src/modules/dashboard/dashboard-view.tsx:275`) and the reports timeline (`src/modules/reports/reports-view.tsx:554`) — carry **no** `aria-label`, `role="img"` + description, or adjacent sr-only summary. Precise status of the earlier "sr-only summaries in some views" claim: **it does not hold for charts**; the sr-only spans in `reports-view.tsx` (lines 481, 771, 799) label the export button and a month-over-month indicator, not the charts. Screen-reader users currently get no account of any chart's content. **Highest-impact gap.**
2. **Chart tooltips are pointer-oriented** (Recharts default); the underlying figures are otherwise reachable only via the tables/exports that coexist on those views, not via the chart itself.
3. **Sort buttons rely on `title` for their accessible name** (`data-table.tsx:250-252`). `title` is an unreliable accessible name (not surfaced by many AT/keyboard setups); an `aria-label` should carry "Sort by {column}".
4. **No explicit `scope="col"` on table headers.** `TableHead` renders a bare `<th>` (`src/components/ui/table.tsx:65-79`); column association is implicit via `<thead>` only. Low risk for these simple tables, trivial to fix in one file.
5. **Nested `<main>` landmarks.** `SidebarInset` renders its own `<main>` (`src/components/ui/sidebar.tsx:307-309`) and the shell nests another `<main id="main-content">` inside it (`app-shell.tsx:121`). Screen readers report two main landmarks; the outer one should be demoted to a `<div>`.
6. **No `<nav>` landmark for the sidebar.** Sidebar menus are `div`/`ul` composites tagged `data-sidebar="menu"` (`src/components/ui/sidebar.tsx:458`) without a `<nav>` element or `role="navigation"`.
7. **Color contrast has not been machine-verified** for theme tokens (light/dark × en/fa). No failures observed manually, but no WCAG contrast measurement was taken — unverified, not asserted-passing.
8. **No automated a11y tooling.** No axe-core/jest-axe/playwright-axe dependency; ESLint (`eslint-config-next`) provides only partial jsx-a11y rule coverage. Manual QA is the only barrier.

## 3. Recommendations (priority order)

1. Add text alternatives to all `ChartContainer` usages: `aria-label` summarizing the chart + an sr-only list/summary of key series values (start with `dashboard-view.tsx:275`, `reports-view.tsx:554`).
2. Replace `title`-only naming of sort buttons with `aria-label={t("sortBy", { column })}` in `data-table.tsx`.
3. Add `scope="col"` to `TableHead` in `src/components/ui/table.tsx` (one-line fix).
4. Demote `SidebarInset`'s `<main>` to `<div>` (or render the shell's `<main>` outside it) to remove nested main landmarks; wrap the sidebar menu tree in `<nav aria-label>`.
5. Install axe-core automation once the test framework lands (scorecard #15): `@axe-core/playwright` smoke over the QA-matrix routes, plus contrast verification of both themes.
6. Machine-verify contrast for the four theme/locale combinations used in QA and record results in `docs/deployment/production-checklist.md`.

## 4. Verdict

PARTIALLY READY (matches scorecard #16). Structure, semantics of tables, dialogs, forms, keyboard operability, and RTL are solid and verified in code; charts lack any non-visual representation, sort-button naming relies on `title`, and nothing is machine-verified yet. No WCAG 2.x conformance level is claimed — the audit was manual and no scanner output exists.
