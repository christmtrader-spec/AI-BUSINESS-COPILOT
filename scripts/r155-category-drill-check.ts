/**
 * scripts/r155-category-drill-check.ts — R155 harness.
 *
 * THE LAST ROW FINDS ITS LIST: the performance panel's category rows (the
 * panel's only drill-less rows) now open the expenses workspace FILTERED to
 * the report's own aggregation key — through the month deep-link's FACET
 * grammar family (#/expenses?category=<name>), NOT entity navigation (a
 * category has no stable id; the §16 law still forbids fabricated ids).
 * The expenses workspace grows the matching facet filter (server `where`
 * exact equality + amber chip family + export mirror + honest empty state),
 * and every navigable table in the perf panel joins the R152 hover
 * unification. Each facet chip clears ONLY ITSELF (the compose/decay law).
 *
 *   [1] the GRAMMAR LAW — #/expenses?category=… parses (trim + the column's
 *       OWN 60 cap, blank drops wholesale, one decode, literal "%" survives),
 *       composes with ?month=, other modules ignore it, round-trips through
 *       the store's hash authority (never a hand-built hash).
 *   [2] the SERVER LAW — the facet is EXACT equality (never contains), the
 *       q-family trim/slice with the schema's own 60 cap, businessId
 *       scoping intact, the shared `where` reaches the month path, the
 *       month 422 contract untouched.
 *   [3] the VIEW LAW — the chip family (amber byte-pattern, Layers icon,
 *       testid), the filter rides the list AND the export (the mirror
 *       law), the cache key grows, each chip clears only itself,
 *       motion-reduce on both clear buttons, the honest empty state, the
 *       page-key reset tracks the facet.
 *   [4] the PANEL LAW — the category gate is the row's own non-blank key,
 *       the store builds the hash (never #/expenses?… literal), the hover
 *       is honest, the ONE hint sits after the table, and ALL five
 *       navigable tables carry the unification hover.
 *   [5] the i18n LAW — EN/FA symmetric, placeholder parity, FA pure
 *       Persian, the guillemet family.
 *   [6] the REGRESSION PIN — R152's reorder precedent, the month chip, the
 *       §16 id law still standing for entity rows, the R145 no-mutation
 *       promise.
 *
 * Run: npx tsx scripts/r155-category-drill-check.ts
 */

import { readFileSync } from "node:fs";
import { viewToHash, hashToView, type AppView } from "../src/store/app-store";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond && info) failures.push(`${name} — ${info}`);
}
function section(title: string) {
  console.log(`\n${title}`);
}

const expensesSrc = readFileSync("src/modules/expenses/expenses-view.tsx", "utf8");
const routeSrc = readFileSync("src/app/api/v1/expenses/route.ts", "utf8");
const perfSrc = readFileSync("src/modules/reports/performance-panel.tsx", "utf8");
const storeSrc = readFileSync("src/store/app-store.ts", "utf8");
const reorderSrc = readFileSync("src/modules/reports/reorder-panel.tsx", "utf8");
const schemaSrc = readFileSync("src/lib/schemas.ts", "utf8");
const enSrc = readFileSync("src/i18n/messages/en.ts", "utf8");
const faSrc = readFileSync("src/i18n/messages/fa.ts", "utf8");

/** Strip comments so doc-comment literals don't trip source needles. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Collapse line-breaks + runs of spaces so multi-line JSX needles match. */
function flat(src: string): string {
  return src.replace(/\s+/g, " ");
}
const expensesFlat = flat(expensesSrc);
const perfFlat = flat(perfSrc);
const expensesCode = stripComments(expensesSrc);
const perfCode = stripComments(perfSrc);
/** R152's row-drill gate, flattened (the multi-line JSX form). */
const expensesFlatReorder =
  'onRowClick={(r) => r.id ? navigate({ kind: "entity", entity: "product", id: r.id }) : undefined }';

// ---------------------------------------------------------------------------
section("[1] the GRAMMAR LAW — parse + serialize round-trips");
// ---------------------------------------------------------------------------

{
  const view = hashToView("#/expenses?category=Rent");
  ok(
    "1a ?category= parses to the expenses module view with the verbatim value",
    view.kind === "module" && view.module === "expenses" &&
      view.category === "Rent" && view.param === undefined,
    JSON.stringify(view),
  );

  const hash = viewToHash({ kind: "module", module: "expenses", category: "Rent" });
  ok(
    "1b the store's hash authority serializes #/expenses?category=Rent",
    hash === "#/expenses?category=Rent",
    String(hash),
  );
  ok(
    "1b' the round-trip closes (hash → view → hash)",
    viewToHash(hashToView("#/expenses?category=Rent")!) === hash,
  );

  const weird = "R&D & fixtures #1";
  const weirdHash = viewToHash({ kind: "module", module: "expenses", category: weird })!;
  ok(
    "1c free text is ENCODED (no raw &, #, space in the hash)",
    /^#\/expenses\?category=R%26D%20%26%20fixtures%20%231$/.test(weirdHash),
    weirdHash,
  );
  ok(
    "1c' the encoded hash parses back to the verbatim value (ONE decode)",
    hashToView(weirdHash)?.kind === "module" &&
      (hashToView(weirdHash) as Extract<AppView, { kind: "module" }>).category === weird,
  );

  const pct = hashToView("#/expenses?category=50%25%20off");
  ok(
    "1d a literal % survives (no second decode — '50% off' round-trips)",
    pct?.kind === "module" &&
      (pct as Extract<AppView, { kind: "module" }>).category === "50% off",
  );

  const composed = hashToView("#/expenses?month=2026-09&category=Rent");
  ok(
    "1e ?category= composes WITH ?month= (both facets ride)",
    composed?.kind === "module" &&
      (composed as Extract<AppView, { kind: "module" }>).param === "2026-09" &&
      (composed as Extract<AppView, { kind: "module" }>).category === "Rent",
  );
  const composedHash = viewToHash({
    kind: "module",
    module: "expenses",
    param: "2026-09",
    category: "Rent",
  });
  ok(
    "1e' the composed hash serializes month FIRST (canonical order)",
    composedHash === "#/expenses?month=2026-09&category=Rent",
    String(composedHash),
  );

  const blank1 = hashToView("#/expenses?category=");
  const blank2 = hashToView("#/expenses?category=%20%20%20");
  ok(
    "1f a blank/whitespace value drops WHOLESALE (bare expenses, no half state)",
    blank1?.kind === "module" &&
      (blank1 as Extract<AppView, { kind: "module" }>).category === undefined &&
      blank2?.kind === "module" &&
      (blank2 as Extract<AppView, { kind: "module" }>).category === undefined,
  );

  const long = "C".repeat(70);
  const capped = hashToView(`#/expenses?category=${long}`);
  ok(
    "1g an over-cap value is sliced to the column's OWN 60 (the cap authority)",
    capped?.kind === "module" &&
      (capped as Extract<AppView, { kind: "module" }>).category?.length === 60,
  );

  const sales = hashToView("#/sales?category=Rent");
  const reports = hashToView("#/reports?category=Rent");
  ok(
    "1h other modules ignore ?category= (the vocabulary never grows sideways)",
    sales?.kind === "module" &&
      (sales as Extract<AppView, { kind: "module" }>).category === undefined &&
      reports?.kind === "module" &&
      (reports as Extract<AppView, { kind: "module" }>).category === undefined,
  );

  const salesHash = viewToHash({
    kind: "module",
    module: "sales",
    category: "Rent",
  } as AppView);
  ok(
    "1h' an orphan category on another module NEVER serializes",
    salesHash === "#/sales",
    String(salesHash),
  );

  const monthOnly = hashToView("#/expenses?month=2026-09");
  ok(
    "1i the month deep link is unchanged (no category field appears)",
    monthOnly?.kind === "module" &&
      (monthOnly as Extract<AppView, { kind: "module" }>).param === "2026-09" &&
      (monthOnly as Extract<AppView, { kind: "module" }>).category === undefined,
  );

  const blankField = viewToHash({ kind: "module", module: "expenses", category: "   " });
  ok(
    "1i' a blank category never serializes (bare #/expenses)",
    blankField === "#/expenses",
    String(blankField),
  );
}

// ---------------------------------------------------------------------------
section("[2] the SERVER LAW — the facet filter on GET /api/v1/expenses");
// ---------------------------------------------------------------------------

{
  ok(
    "2a the param read is the q family law: trim + slice to 60 + blank → null",
    /searchParams\.get\("category"\)/.test(routeSrc) &&
      /\(categoryRaw \?\? ""\)\.trim\(\)\.slice\(0, 60\) \|\| null/.test(routeSrc),
  );
  ok(
    "2b the facet is EXACT equality (never contains — the report's own key)",
    /\.\.\.\(category \? \{ category \} : \{\}\),/.test(routeSrc) &&
      !/category: \{ contains: category \}/.test(routeSrc),
  );
  ok(
    "2c the q search keeps its own contains (the two semantics stay distinct)",
    /\{ category: \{ contains: q \} \}/.test(routeSrc),
  );
  ok(
    "2d tenant scoping intact (businessId: ctx.businessId in the where)",
    /businessId: ctx\.businessId,/.test(routeSrc) &&
      /deletedAt: null,/.test(routeSrc),
  );
  ok(
    "2e the shared where reaches the month path (the facet composes with month)",
    routeSrc.indexOf("...(category ? { category } : {})") <
      routeSrc.indexOf("const inMonth = all.filter"),
  );
  ok(
    "2f the month 422 contract untouched",
    /Invalid month\. Use YYYY-MM\./.test(routeSrc),
  );
  ok(
    "2g the 60 cap mirrors the category column's OWN schema cap",
    /category: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(60\)/.test(schemaSrc),
  );
}

// ---------------------------------------------------------------------------
section("[3] the VIEW LAW — the expenses workspace's facet chip + filter");
// ---------------------------------------------------------------------------

{
  ok(
    "3a the view reads the facet defensively (non-blank string only)",
    /typeof view\.category === "string" && view\.category\.trim\(\)\.length > 0/.test(expensesSrc),
  );
  ok(
    "3b the filter rides the LIST query",
    /categoryQs = category \? `&category=\$\{encodeURIComponent\(category\)\}` : ""/.test(expensesSrc),
  );
  ok(
    "3b' the filter rides the EXPORT too (the CSV mirrors the ACTIVE filters)",
    expensesSrc.split("categoryQs}`,").length >= 2 ||
      (expensesSrc.match(/categoryQs/g) ?? []).length >= 3,
  );
  ok(
    "3c the cache key grows the facet (no stale list across facets)",
    /\[\.\.\.txKeys\.expenses, q, page, status, month, category\]/.test(expensesSrc),
  );
  ok(
    "3d the chip carries the family testid + the Layers icon",
    expensesSrc.includes('data-testid="expenses-category-chip"') &&
      /<Layers className="size-3\.5 shrink-0" aria-hidden="true" \/>/.test(expensesSrc),
  );
  const amber =
    "border-amber-500/30 bg-amber-500/5 text-amber-800 dark:text-amber-300 inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium";
  ok(
    "3e the chip joins the month chip's amber family BYTE-PATTERN",
    expensesSrc.split(amber).length >= 3,
    "the amber geometry must appear for month + category chips",
  );
  ok(
    "3f the label is the honest filtered copy with the verbatim category",
    expensesSrc.includes('t("categoryFiltered", { category })'),
  );
  ok(
    "3g the month chip's clear preserves the sibling category (decay law)",
    /navigate\(\{\s*kind: "module",\s*module: "expenses",\s*\.\.\.\(category \? \{ category \} : \{\}\),\s*\}\)/.test(
      expensesSrc,
    ),
  );
  ok(
    "3g' the category chip's clear preserves the sibling month",
    /\.\.\.\(month \? \{ param: month \} : \{\}\)/.test(expensesSrc),
  );
  ok(
    "3h BOTH clear buttons carry motion-reduce (the unification family)",
    (expensesSrc.match(/hover:bg-amber-500\/15 -me-1 rounded-full p-0\.5 transition-colors motion-reduce:transition-none/g) ?? []).length === 2,
  );
  ok(
    "3i the honest empty state exists (title + desc + clear action, Layers icon)",
    expensesSrc.includes('t("categoryEmptyTitle")') &&
      expensesSrc.includes('t("categoryEmptyDesc", { category })') &&
      /category \? \(\s*<EmptyState\s*icon=\{Layers\}/.test(expensesSrc),
  );
  ok(
    "3i' the book-empty branch now requires the facet absent too",
    /!q && status === "ALL" && !month && !category \?/.test(expensesSrc),
  );
  ok(
    "3j the page-key reset tracks the facet (a new facet flips to page 1)",
    /const \[pageKey, setPageKey\] = useState\(`\$\{month \?\? ""\}\|\$\{category \?\? ""\}`\)/.test(
      expensesSrc,
    ),
  );
  ok(
    "3k no hand-built hash in the view's CODE (the store builds every hash)",
    !expensesCode.includes("#/expenses?"),
  );
  ok(
    "3l the facet read is expenses-module-scoped (view.module === 'expenses')",
    (expensesSrc.match(/view\.module === "expenses"/g) ?? []).length >= 2,
  );
}

// ---------------------------------------------------------------------------
section("[4] the PANEL LAW — the category rows find their list");
// ---------------------------------------------------------------------------

{
  ok(
    "4a the gate is the row's own non-blank key; the destination rides the store",
    perfFlat.includes(
      'onRowClick={(row) => row.category.trim() ? navigate({ kind: "module", module: "expenses", category: row.category }) : undefined }',
    ),
  );
  const catBranch = perfFlat.slice(
    perfFlat.indexOf('r.groupBy === "category" ? ('),
    perfFlat.indexOf('r.groupBy === "supplier" ? ('),
  );
  ok(
    "4b the category branch never rides openEntity (a facet is not an entity)",
    catBranch.includes('module: "expenses", category: row.category') &&
      !catBranch.includes("openEntity"),
  );
  ok(
    "4c the hover tint is HONEST (row rides the R152 unification string)",
    perfSrc.includes(
      'rowClassName={() => "transition-colors hover:bg-muted/40 motion-reduce:transition-none"}',
    ),
  );
  ok(
    "4d ALL SEVEN navigable tables carry the hover (product/customer/sales-month/category/supplier/expenses-month/cashflow — R156 grew the two month tables)",
    (perfSrc.match(/transition-colors hover:bg-muted\/40 motion-reduce:transition-none/g) ?? []).length === 7,
  );
  ok(
    "4e the ONE discovery hint sits AFTER the table (the R152 grammar)",
    perfSrc.includes('data-testid="perf-category-drill-hint"') &&
      perfSrc.includes("t(\"perfCategoryDrillHint\")") &&
      perfSrc.indexOf("perf-category-drill-hint") > perfSrc.indexOf('getRowId={(row) => row.category}'),
  );
  ok(
    "4e' the hint lives inside the category branch only (one hint per table)",
    !/groupBy === "supplier"[\s\S]{0,1600}perf-category-drill-hint/.test(perfFlat),
  );
  ok(
    "4f PerfBody's navigate rides the store hook (the hash authority)",
    /const navigate = useAppStore\(\(s\) => s\.navigate\);/.test(perfSrc),
  );
  ok(
    "4g no hand-built hash in the panel's CODE",
    !perfCode.includes("#/expenses?") && !perfCode.includes("#/products/"),
  );
  ok(
    "4h the §16 doc-comment names the facet exception (the law is written down)",
    /the ONE exception is the FACET family/.test(perfSrc) &&
      /never a fabricated id, never a\s+\* navigation that rides a name into an ENTITY route/.test(perfSrc),
  );
}

// ---------------------------------------------------------------------------
section("[5] the i18n LAW — EN/FA symmetry");
// ---------------------------------------------------------------------------

{
  const enExpenses = enSrc.slice(enSrc.indexOf('monthFiltered: "Showing {month} only"'));
  const faExpenses = faSrc.slice(faSrc.indexOf('monthFiltered: "نمایش فقط {month}"'));
  const enBlock = enExpenses.slice(0, enExpenses.indexOf("colDue:"));
  const faBlock = faExpenses.slice(0, faExpenses.indexOf("colDue:"));
  for (const key of ["categoryFiltered", "categoryFilterClear", "categoryEmptyTitle", "categoryEmptyDesc"]) {
    ok(
      `5a ${key} exists exactly once in each locale`,
      (enBlock.match(new RegExp(`${key}:`, "g")) ?? []).length === 1 &&
        (faBlock.match(new RegExp(`${key}:`, "g")) ?? []).length === 1,
    );
  }
  ok(
    "5b placeholder parity: {category} rides both sides of categoryFiltered/Desc",
    enBlock.includes("categoryFiltered: \"Showing expenses in category «{category}»\"") &&
      faBlock.includes("categoryFiltered: \"نمایش هزینه‌های دستهٔ «{category}»\"") &&
      enBlock.includes("«{category}» here. Clear the filter") &&
      faBlock.includes("دستهٔ «{category}» در اینجا نیست"),
  );
  ok(
    "5c the perf hint exists once per locale, placeholder-free",
    (enSrc.match(/perfCategoryDrillHint:/g) ?? []).length === 1 &&
      (faSrc.match(/perfCategoryDrillHint:/g) ?? []).length === 1 &&
      !/perfCategoryDrillHint: "[^"]*\{/.test(enSrc) &&
      !/perfCategoryDrillHint: "[^"]*\{/.test(faSrc),
  );
  const faPurity = (s: string) =>
    s.replace(/\{\w+\}/g, "").replace(/[«»]/g, "").trim();
  ok(
    "5d FA purity: the new FA strings carry no Latin letters",
    !/[A-Za-z]/.test(faPurity("نمایش هزینه‌های دستهٔ «{category}»")) &&
      !/[A-Za-z]/.test(faPurity("برداشتن فیلتر دسته")) &&
      !/[A-Za-z]/.test(faPurity("در این دسته هزینه‌ای نیست")) &&
      !/[A-Za-z]/.test(faPurity("برای دیدن همهٔ هزینه‌های ثبت‌شدهٔ آن دسته ردیفی را باز کنید.")),
  );
  ok(
    "5e the guillemet family: the filtered copy quotes the value with «» in BOTH locales",
    enBlock.includes("«{category}»") && faBlock.includes("«{category}»"),
  );
}

// ---------------------------------------------------------------------------
section("[6] the REGRESSION PIN — the precedents stand");
// ---------------------------------------------------------------------------

{
  ok(
    "6a R152's reorder row drill intact (the gate grammar + honest hover + hint)",
    flat(reorderSrc).includes(expensesFlatReorder),
  );
  ok(
    "6a' the reorder hint + testid still in place",
    reorderSrc.includes('data-testid="reorder-drill-hint"') &&
      reorderSrc.includes('rowClassName={() => "transition-colors hover:bg-muted/40 motion-reduce:transition-none"}'),
  );
  ok(
    "6b the month chip intact (testid + the MONTH_RE gate + its label)",
    expensesSrc.includes('data-testid="expenses-month-chip"') &&
      /MONTH_RE\.test\(view\.param\)/.test(expensesSrc) &&
      expensesSrc.includes('t("monthFiltered", { month: monthLabel ?? month })'),
  );
  ok(
    "6c the §16 id law still standing: the entity rows keep their id gates",
    perfSrc.includes('row.productId ? openEntity("product", row.productId) : undefined') &&
      perfSrc.includes('row.customerId ? openEntity("customer", row.customerId) : undefined') &&
      perfSrc.includes('row.supplierId ? openEntity("supplier", row.supplierId) : undefined'),
  );
  ok(
    "6d the store's view type documents the facet (the law is written down)",
    /R155 — the expenses-only category facet \(#\/expenses\?category=…\)/.test(storeSrc) &&
      /category\?: string; \}/.test(storeSrc),
  );
  ok(
    "6e the R145 no-mutation promise intact on the reorder panel",
    reorderSrc.includes("useQuery") && !reorderSrc.includes("useMutation") &&
      !reorderSrc.includes("purchase-orders"),
  );
  ok(
    "6f the parser's sales month branch untouched (overdue/customer compose)",
    /overdueRaw === "1" \|\| overdueRaw === "true" \? true : undefined/.test(storeSrc),
  );
}

// ---------------------------------------------------------------------------
console.log(`\nr155-category-drill-check: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
