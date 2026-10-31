/**
 * scripts/r152-reorder-drill-check.ts — R152 harness.
 *
 * THE THIRD LEVEL OF THE LOW-STOCK JOURNEY + the TOO-SHORT honesty win:
 * the reorder suggestions table's rows now OPEN the product's own surface
 * (the entity detail — where the StockDialog adjusts stock and the
 * threshold is edited), completing the drill chain dashboard alert (R151)
 * → reorder panel (R151) → product (R152). Navigation is NOT mutation —
 * the R145 promise (never an order, never a stock change) stands. And the
 * search center's TOO-SHORT state finally names the minimum with an
 * honest inline example (the standing deferred copy win, done).
 *
 *   [1] the GRAMMAR LAW (store + entity-route unit) — the product entity
 *       view round-trips through entityToHash authority; invalid ids never
 *       become a hash; parse round-trips.
 *   [2] the PANEL LAW (source) — the row drill rides the row's own id
 *       proof (the perf-panel gate grammar), the store builds the hash
 *       (never a hand-built #/products/…), the hover tint is honest +
 *       motion-safe, the ONE discovery hint sits after the table, the
 *       R145 ask block + the no-mutation promise intact.
 *   [3] the SEARCH LAW — the too-short branch unchanged in structure, the
 *       copy names the minimum with an example in BOTH locales, the
 *       server-side schema message (the API contract) untouched.
 *   [4] the i18n LAW — reorderDrillHint EN/FA symmetric, FA pure Persian.
 *   [5] the REGRESSION PIN — R151 amber alert + R150 doors + R149 pill +
 *       the ONE 500 authority + the DataTable rowClassName prop + the
 *       perf-panel precedent grammar.
 *
 * Run: npx tsx scripts/r152-reorder-drill-check.ts
 */

import { readFileSync } from "node:fs";
import { viewToHash, type AppView } from "../src/store/app-store";
import { entityToHash, parseEntityRoute } from "../src/lib/entity-routes";

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

const reorderSrc = readFileSync("src/modules/reports/reorder-panel.tsx", "utf8");
const searchSrc = readFileSync("src/modules/search/search-view.tsx", "utf8");
const schemaSrc = readFileSync("src/lib/search/schema.ts", "utf8");
const dataTableSrc = readFileSync("src/components/shared/data-table.tsx", "utf8");
const perfSrc = readFileSync("src/modules/reports/performance-panel.tsx", "utf8");
const dashSrc = readFileSync("src/modules/dashboard/dashboard-view.tsx", "utf8");
const storeSrc = readFileSync("src/store/app-store.ts", "utf8");
const enSrc = readFileSync("src/i18n/messages/en.ts", "utf8");
const faSrc = readFileSync("src/i18n/messages/fa.ts", "utf8");

// The panel source with line-breaks+indent collapsed — the same normalize
// the r151 battery uses for multi-line JSX attributes.
const reorderFlat = reorderSrc.replace(/\n\s+/g, " ");

section("[1] the GRAMMAR LAW — the product entity view round-trips (store unit)");
{
  const pid = "cmvvab6xw0002qac4w2r33haz";
  const view = { kind: "entity", entity: "product", id: pid } as AppView;
  const hash = viewToHash(view);
  ok("1a {entity product} → #/products/<id>", hash === `#/products/${pid}`, hash ?? "null");
  ok("1b the store delegates to entityToHash (the ONE builder)", storeSrc.includes("return entityToHash(view.entity, view.id);"));
  ok("1c entityToHash rejects an invalid id (never a hash)", entityToHash("product", "../evil") === null && entityToHash("product", "") === null);
  ok("1d entityToHash rejects an over-long id (64 = the cap)", entityToHash("product", "a".repeat(65)) === null && entityToHash("product", "a".repeat(64)) !== null);
  const parsed = parseEntityRoute(`products/${pid}`);
  ok("1e parseEntityRoute round-trips the drill", parsed !== null && parsed.entity === "product" && parsed.id === pid, JSON.stringify(parsed));
  ok("1f parseEntityRoute refuses a path traversal", parseEntityRoute("products/../evil") === null);
}

section("[2] the PANEL LAW — the row opens the product's own surface");
{
  ok(
    "2a the row drill rides the row's own id proof (perf-panel gate grammar)",
    /onRowClick=\{\(r\) => r\.id \? navigate\(\{ kind: "entity", entity: "product", id: r\.id \}\) : undefined\s?\}/.test(reorderFlat),
  );
  ok("2b no hand-built product hash anywhere in the panel", !/["'`]#\/products/.test(reorderSrc));
  ok("2c no raw href in the panel (navigation goes through the store)", !/href=/.test(reorderSrc));
  ok(
    "2d the hover tint is honest + motion-safe (the unification family)",
    reorderFlat.includes('rowClassName={() => "transition-colors hover:bg-muted/40 motion-reduce:transition-none"}'),
  );
  ok("2e the ONE discovery hint rides the new key", reorderSrc.includes('data-testid="reorder-drill-hint"') && reorderSrc.includes('t("reorderDrillHint")'));
  ok("2f the hint sits AFTER the table it describes", reorderSrc.indexOf('data-testid="reorder-drill-hint"') > reorderSrc.indexOf("onRowClick="));
  ok(
    "2g the R145 ask block intact (the SECOND producer untouched)",
    /R145 — the SECOND \?ask= producer[\s\S]*?data-testid="reorder-ask-copilot"[\s\S]*?\/>/.test(reorderSrc),
  );
  ok("2h the panel still never mutates (useQuery only — the R145 promise)", !reorderSrc.includes("useMutation") && !/api\("\/api\/v1\/purchase-orders/.test(reorderSrc));
  ok("2i the singular ask testid stays singular", (reorderSrc.match(/reorder-ask-copilot/g) ?? []).length === 1);
}

section("[3] the SEARCH LAW — the TOO-SHORT state names the minimum honestly");
{
  ok("3a the too-short branch structure unchanged (client-side gate + one key)", searchSrc.includes("const tooShort = q.length > 0 && q.length < SEARCH_Q_MIN;") && searchSrc.includes('text={tSearch("minChars")}'));
  ok("3b EN minChars names the minimum AND an inline example", enSrc.includes('minChars: "Enter at least 2 characters — a short word like “rug” is enough."'));
  ok("3c FA minChars names the minimum AND an inline example", faSrc.includes('minChars: "حداقل ۲ نویسه وارد کنید — یک واژهٔ کوتاه مثل «قالیچه» کافی است."'));
  ok("3d the server-side schema message untouched (the API contract)", schemaSrc.includes("Enter at least ${SEARCH_Q_MIN} characters."));
  ok("3e the example itself would pass the gate (honesty)", schemaSrc.includes("export const SEARCH_Q_MIN = 2;") && "rug".length >= 2 && "قالیچه".length >= 2);
  ok("3f no {placeholder} in minChars", !/minChars: "[^"]*\{/.test(enSrc) && !/minChars: "[^"]*\{/.test(faSrc));
}

section("[4] the i18n LAW — the drill hint symmetric in both locales");
{
  ok("4a EN reorderDrillHint present exactly once", (enSrc.match(/reorderDrillHint:/g) ?? []).length === 1 && enSrc.includes('reorderDrillHint: "Open a row to review the product — stock and thresholds live on the product itself."'));
  ok("4b FA reorderDrillHint present exactly once", (faSrc.match(/reorderDrillHint:/g) ?? []).length === 1);
  ok("4c the FA hint is pure Persian (no Latin letters)", (() => {
    const m = faSrc.match(/reorderDrillHint: "([^"]+)"/);
    return m !== null && !/[A-Za-z]/.test(m[1]);
  })());
  ok("4d no {placeholder} in the drill hint", !/reorderDrillHint: "[^"]*\{/.test(enSrc) && !/reorderDrillHint: "[^"]*\{/.test(faSrc));
}

section("[5] the REGRESSION PIN — the family this round must not disturb");
{
  ok("5a the R151 amber alert still lands reorder", /navigate\(\{ kind: "module", module: "reports", param: "reorder" \}\)/.test(dashSrc));
  ok("5b the R149 dashboard pill untouched (ONE producer per surface)", /data-testid="dash-ask-copilot"/.test(dashSrc) && (dashSrc.match(/module: "copilot", ask:/g) ?? []).length === 1);
  ok("5c the R150 search door untouched", /data-testid="search-ask-copilot"/.test(searchSrc) && /navigate\(\{ kind: "module", module: "copilot", ask: seed \}\)/.test(searchSrc));
  ok("5d the store keeps exactly ONE 500 slice authority", (storeSrc.match(/slice\(0, 500\)/g) ?? []).length === 1);
  ok("5e the perf-panel precedent grammar untouched", perfSrc.includes('row.productId ? openEntity("product", row.productId) : undefined'));
  ok("5f the DataTable rowClassName prop exists (the shared table)", dataTableSrc.includes("rowClassName?: (row: T) => string;"));
  ok("5g the interactive-row guard still protects the drill (§31)", dataTableSrc.includes("INTERACTIVE_ROW_SELECTOR"));
}

console.log(`\nr152-reorder-drill-check: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
