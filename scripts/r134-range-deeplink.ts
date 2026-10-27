/**
 * scripts/r134-range-deeplink.ts — R134 harness.
 *
 * The trend panel's window labels become REAL deep links and the CSV
 * export grows the previous-window section:
 *
 *   [1] the RANGE HASH LAW — #/reports?from=&to= parses to the closed
 *       range sub-state and serializes back byte-identical; BOTH or
 *       nothing (half / inverted / malformed → dropped WHOLESALE, never a
 *       half-open range); the fragment never rides another module; the
 *       parse-precedence law holds (month → inventory → reorder → perf →
 *       range — a perf URL consumes from/to as ITS window and never leaks
 *       range state); garbage month falls through honestly (the range
 *       still parses); orphan fields never serialize.
 *   [2] the RE-ENTRY LAW — sameView compares the range sub-state, so a
 *       different window re-enters an ALREADY-MOUNTED reports view
 *       instead of being swallowed as "the same view" (and the R100 perf
 *       law still holds).
 *   [3] the CSV SECTION LAW — live HTTP against dev:3000 as the both-
 *       window QA persona: the export grows an additive previous_window
 *       section AFTER the inventory rows, whose from/to equal the summary
 *       API's trend.previousRange (ONE authority) and whose values equal
 *       the seeded both-window facts ($200 sale / $50 expense / $40 OUT);
 *       field names mirror the kpi section (column-by-column diff); the
 *       pre-existing sections stay byte-identical.
 *
 * Run: bun scripts/r134-range-deeplink.ts   (Part 2 needs dev:3000 UP)
 */

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}
function eq(actual: unknown, expected: unknown, name: string) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
}

import { hashToView, viewToHash, sameView, type AppView } from "../src/store/app-store";

const FROM = "2026-08-29";
const TO = "2026-09-27";

// [1] the RANGE HASH LAW -------------------------------------------------------
console.log("\n== [1] range hash law ==");

{
  const v = hashToView(`#/reports?from=${FROM}&to=${TO}`);
  eq(v, { kind: "module", module: "reports", rangeFrom: FROM, rangeTo: TO }, "1a. valid ordered window parses to the closed range sub-state");
  eq(viewToHash(v), `#/reports?from=${FROM}&to=${TO}`, "1b. canonical serialize is byte-identical (from → to)");
}
eq(hashToView(`#/reports?from=${FROM}`), { kind: "module", module: "reports" }, "1c. half window (from only) drops WHOLESALE");
eq(hashToView(`#/reports?to=${TO}`), { kind: "module", module: "reports" }, "1d. half window (to only) drops WHOLESALE");
eq(hashToView("#/reports?from=&to="), { kind: "module", module: "reports" }, "1e. empty keys drop WHOLESALE");
eq(hashToView(`#/reports?from=${TO}&to=${FROM}`), { kind: "module", module: "reports" }, "1f. inverted window drops WHOLESALE (never a lying boundary)");
eq(hashToView("#/reports?from=2026-8-9&to=2026-09-27"), { kind: "module", module: "reports" }, "1g. non-padded ISO drops WHOLESALE");
eq(hashToView("#/reports?from=2026-13-40&to=2026-12-01"), { kind: "module", module: "reports" }, "1h. impossible calendar keys drop (Date NaN guard)");
eq(hashToView("#/reports?from=%3Cscript%3E&to=..%2Fetc"), { kind: "module", module: "reports" }, "1i. script-y / traversal garbage drops WHOLESALE");
{
  const v = hashToView("#/sales?from=2026-08-29&to=2026-09-27");
  ok("1j. the range fragment NEVER rides another module", v.kind === "module" && v.module === "sales" && (v as { rangeFrom?: string }).rangeFrom === undefined, JSON.stringify(v));
}
{
  const v = hashToView(`#/reports?inventory=1&from=${FROM}&to=${TO}`);
  eq(v, { kind: "module", module: "reports", param: "inventory" }, "1k. precedence: inventory wins, range never leaks into the sub-view");
}
{
  const v = hashToView(`#/reports?perf=sales&from=${FROM}&to=${TO}`);
  eq(v, { kind: "module", module: "reports", param: "perf-sales", perfFrom: FROM, perfTo: TO }, "1l. precedence: perf consumes from/to as ITS window (no range state)");
}
{
  const v = hashToView(`#/reports?month=2026-09&from=${FROM}&to=${TO}`);
  eq(v, { kind: "module", module: "reports", param: "2026-09" }, "1m. precedence: a VALID month wins, range never leaks");
}
{
  // The month branch is SHAPE-based (YYYY-MM): "9999-99" IS month-shaped,
  // so it consumes the route and the impossible month 404s downstream
  // (the documented E10 law). The range only parses when NO month-shaped
  // key exists — a genuinely malformed month (e.g. "9999-9") falls through.
  const v = hashToView(`#/reports?month=9999-99&from=${FROM}&to=${TO}`);
  eq(v, { kind: "module", module: "reports", param: "9999-99" }, "1n. month-SHAPED key wins by the documented E10 law (404 downstream), range never leaks");
  const v2 = hashToView(`#/reports?month=9999-9&from=${FROM}&to=${TO}`);
  eq(v2, { kind: "module", module: "reports", rangeFrom: FROM, rangeTo: TO }, "1n2. truly malformed month falls through honestly — the range still parses");
}
{
  const v = hashToView("#/reports?reorder=1&from=2026-08-29&to=2026-09-27");
  eq(v, { kind: "module", module: "reports", param: "reorder" }, "1o. precedence: reorder wins, range never leaks");
}

// [2] the RE-ENTRY LAW ---------------------------------------------------------
console.log("\n== [2] re-entry law ==");

const bare: AppView = { kind: "module", module: "reports" };
const rangeA: AppView = { kind: "module", module: "reports", rangeFrom: FROM, rangeTo: TO };
const rangeB: AppView = { kind: "module", module: "reports", rangeFrom: "2026-07-01", rangeTo: "2026-07-30" };
ok("2a. sameView(bare, range) — a landing deep link RE-ENTERS the mounted view", !sameView(bare, rangeA));
ok("2b. sameView(rangeA, rangeB) — a DIFFERENT window re-enters (never swallowed)", !sameView(rangeA, rangeB));
ok("2c. sameView(rangeA, rangeA) — identical range is the same view", sameView(rangeA, rangeA));
ok("2d. sameView ignores an ORPHAN rangeFrom flip (cannot exist by parser law, but never lies)", sameView(rangeA, { ...rangeA, rangeFrom: undefined } as AppView) === false);
{
  const perf1: AppView = { kind: "module", module: "reports", param: "perf-sales", perfFrom: FROM, perfTo: TO };
  const perf2: AppView = { kind: "module", module: "reports", param: "perf-sales", perfFrom: "2026-07-01", perfTo: "2026-07-30" };
  ok("2e. R100 regression: perf window flips still re-enter", !sameView(perf1, perf2));
}
// Orphan serialization: state can only ever come from the parser, but the
// serializer's defensive re-check must still hold.
eq(viewToHash({ kind: "module", module: "reports", rangeFrom: FROM } as AppView), "#/reports", "2f. orphan rangeFrom NEVER serializes (one lying boundary is impossible)");
eq(viewToHash({ kind: "module", module: "reports", rangeFrom: TO, rangeTo: FROM } as AppView), "#/reports", "2g. inverted state NEVER serializes");
eq(viewToHash({ kind: "module", module: "sales", rangeFrom: FROM, rangeTo: TO } as AppView), "#/sales", "2h. range fields on ANOTHER module never serialize");
// Round-trip through the REAL window keys the panel produces (MM-DD labels
// are rendered from these exact keys).
{
  const hash = viewToHash({ kind: "module", module: "reports", rangeFrom: "2026-09-28", rangeTo: "2026-10-27" });
  ok("2i. current-window keys round-trip", hash === "#/reports?from=2026-09-28&to=2026-10-27", String(hash));
  if (hash) {
    eq(hashToView(hash), { kind: "module", module: "reports", rangeFrom: "2026-09-28", rangeTo: "2026-10-27" }, "2j. ...and re-parse to the same state");
  }
}
// Regression: every pre-existing reports/sales fragment serializes unchanged.
eq(viewToHash({ kind: "module", module: "reports", param: "perf-cashflow", perfFrom: FROM, perfTo: TO, perfDirection: "OUT" }), `#/reports?perf=cashflow&from=${FROM}&to=${TO}&direction=OUT`, "2k. R100 canonical perf order unchanged");
eq(viewToHash({ kind: "module", module: "reports", param: "2026-09" }), "#/reports?month=2026-09", "2l. month round-trip unchanged");
eq(viewToHash({ kind: "module", module: "reports", param: "inventory" }), "#/reports?inventory=1", "2m. inventory round-trip unchanged");

// [3] the CSV SECTION LAW — live HTTP ------------------------------------------
console.log("\n== [3] CSV previous_window section (dev:3000) ==");

const BASE = "http://localhost:3000";
const EMAIL = process.env.R134_QA_EMAIL ?? "";
const PW = process.env.R134_QA_PW ?? "";
const BID = process.env.R134_QA_BID ?? "";

function mkJar() {
  const jar = new Map<string, string>();
  return async (path: string, init: RequestInit = {}, bizId?: string) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (bizId) headers["x-business-id"] = bizId;
    if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
    const raw = res.headers.get("set-cookie");
    if (raw) for (const piece of raw.split(/,(?=[^;]+=)/)) {
      const [pair] = piece.split(";");
      const eqi = pair.indexOf("=");
      if (eqi > 0) jar.set(pair.slice(0, eqi).trim(), pair.slice(eqi + 1).trim());
    }
    return res;
  };
}

if (EMAIL && PW && BID) {
  const f = mkJar();
  const csrf = (await (await f("/api/auth/csrf")).json()) as { csrfToken: string };
  const login = await f("/api/auth/callback/credentials", {
    method: "POST",
    body: JSON.stringify({ csrfToken: csrf.csrfToken, email: EMAIL, password: PW, redirect: false }),
  });
  ok("3a. persona login", login.status < 400, String(login.status));

  const summary = (await (await f("/api/v1/reports/summary?days=30", {}, BID)).json()) as {
    data?: { range?: { from: string; to: string }; trend?: { previousRange?: { from: string; to: string }; revenuePrevMinor?: number } };
  };
  const prev = summary.data?.trend?.previousRange;
  ok("3b. summary carries the trend block with previousRange", !!prev, JSON.stringify(prev));

  const exp = await f("/api/v1/reports/export?days=30", {}, BID);
  ok("3c. export 200", exp.status === 200, String(exp.status));
  const bytes = new Uint8Array(await exp.arrayBuffer());
  const csv = new TextDecoder().decode(bytes);
  ok("3d. BOM + CRLF intact (additive section never broke the envelope)", bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf && csv.includes("\r\n"));

  // ONE authority: the CSV's window keys MUST equal the summary API's
  // trend.previousRange (never a client-side recomputation).
  ok("3e. previous_window.from == summary.trend.previousRange.from", csv.includes(`previous_window,from,${prev?.from}`), prev?.from);
  ok("3f. previous_window.to == summary.trend.previousRange.to", csv.includes(`previous_window,to,${prev?.to}`), prev?.to);

  // The seeded both-window facts (prev: $200 sale / $50 expense / $40 OUT).
  const money = (minor: number) => (minor / 100).toFixed(2);
  ok("3g. prev revenue 200.00", csv.includes(`previous_window,revenue_issued_USD,${money(20000)}`));
  ok("3h. prev sales_count 1", csv.includes("previous_window,sales_count,1"));
  ok("3i. prev collected 0.00 (honest zero)", csv.includes(`previous_window,cash_collected_USD,${money(0)}`));
  ok("3j. prev expenses 50.00", csv.includes(`previous_window,expenses_USD,${money(5000)}`));
  ok("3k. prev expenses_count 1", csv.includes("previous_window,expenses_count,1"));
  ok("3l. prev paid_out 40.00", csv.includes(`previous_window,paid_out_USD,${money(4000)}`));
  ok("3m. prev net_cash -40.00 (signed, never a fabricated pct)", csv.includes(`previous_window,net_cash_USD,${money(-4000)}`));

  // Field-name mirror law: the previous_window rows use the EXACT kpi names.
  const kpiNames = [...csv.matchAll(/^kpi,([^,]+),/gm)].map((m) => m[1]);
  const pwNames = [...csv.matchAll(/^previous_window,([^,]+),/gm)].map((m) => m[1]).filter((n) => n !== "from" && n !== "to");
  ok("3n. previous_window field names mirror the kpi section (minus dates)", kpiNames.length === pwNames.length && kpiNames.every((n, i) => n === pwNames[i]), `kpi=${kpiNames.join("|")} pw=${pwNames.join("|")}`);

  // Additive-at-end: the section sits AFTER the inventory rows.
  ok("3o. section order: previous_window comes after the inventory rows", csv.indexOf("inventory,low_stock_items") !== -1 && csv.indexOf("inventory,low_stock_items") < csv.indexOf("previous_window,from"));

  // The pre-existing sections stay byte-identical: current KPIs untouched.
  ok("3p. current kpi revenue 100.00 unchanged", csv.includes(`kpi,revenue_issued_USD,${money(10000)}`));
  ok("3q. current kpi net_cash 40.00 unchanged", csv.includes(`kpi,net_cash_USD,${money(4000)}`));
  // TextDecoder strips the BOM by default — the BOM itself is already
  // asserted byte-wise in 3d; here the DECODED text starts at the header.
  ok("3r. header row unchanged", csv.startsWith("section,field,value"));
} else {
  console.log("(part 3 skipped — set R134_QA_EMAIL / R134_QA_PW / R134_QA_BID)");
}

console.log(`\n== r134: ${passed} passed, ${failed} failed ==`);
if (failed > 0) {
  console.log("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
