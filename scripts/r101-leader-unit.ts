/**
 * scripts/r101-leader-unit.ts — R101 UNIT harness.
 *
 * "The panel cites its own rank 1": the performance panel grows the LEADER
 * STRIP (the R99 throne grammar's fourth surface) and the perf sub-view
 * grows a shareable deep link. Pure-function assertions — NO database,
 * NO server:
 *
 *   [1] the SILENCE LAWS — perfLeaderFact returns null (never a padded
 *       crown) on: a truncated scan (the R98 truncation-silence law), a
 *       cashflow read (rows are keyset-paged — a rank over page 1 is not
 *       the true rank), day/month groupings (chronological buckets —
 *       groups[0] is the OLDEST bucket, not a leader), an empty group
 *       set, a blank rank-1 name, a non-finite rank value or total
 *   [2] the VERBATIM LAW — groups[0] is crowned EXACTLY as the server
 *       ordered it: the extractor NEVER re-ranks (feeding the same rows
 *       in the opposite order crowns the other row — the server's
 *       value-DESC head is the ONE authority and the extractor is its
 *       faithful mouthpiece)
 *   [3] the IDENTITY LAW — the drill rides a STABLE id only: product /
 *       customer / supplier rows drill by id; a null id (unlinked
 *       product, unassigned customer, anonymous supplier) → drill null;
 *       a category is a plain string → ALWAYS drill null; the unassigned
 *       mass is crowned under the caller's fallback name (the dashboard
 *       TileLeaderLine precedent) with no fake destination
 *   [4] the BASIS LAW — the money is the rank's OWN sort key and the
 *       total is the response's OWN total on the SAME basis: product →
 *       netValueMinor over totals.netLineValueMinor (the table's default
 *       sort column), customer → revenueMinor over totals.revenueMinor,
 *       category/supplier → amountMinor over totals.amountMinor
 *   [5] DETERMINISM — 5× byte-identical
 *   [6] STATIC WIRING — the panel imports perfLeaderFact and renders the
 *       strip with the dimension tones (emerald sales / violet expenses);
 *       the strip formats its tooltips INSIDE the component (the R99
 *       FORMATTING_ERROR lesson); the copy button copies
 *       window.location.href (the hash IS the state) with the 2s
 *       inline-swap feedback; BOTH i18n bags carry the six R101 keys with
 *       EN↔FA symmetric placeholders
 *
 * Run: bun --conditions react-server scripts/r101-leader-unit.ts
 * Exit: 0 = all green, 1 = at least one failure.
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
function eq<T>(actual: T, expected: T, name: string) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
}

import { perfLeaderFact, type PerfLeaderInput } from "../src/lib/perf-leader";
import * as fs from "fs";

const FALLBACK = "No customer recorded";

// -- fixtures (the route's EXACT response shapes, field for field) ----------

const salesProduct: PerfLeaderInput = {
  kind: "sales",
  truncated: false,
  groupBy: "product",
  totals: {
    revenueMinor: 2_500_000,
    invoiceCount: 7,
    lineValueMinor: 2_500_000,
    discountMinor: 300_000,
    netLineValueMinor: 2_200_000,
  },
  groups: [
    {
      dimension: "product",
      productId: "p-akar",
      kind: "catalog",
      name: "Akar Widget",
      qtySold: 3,
      invoiceCount: 2,
      lineValueMinor: 1_200_000,
      netValueMinor: 1_000_000,
    },
    {
      dimension: "product",
      productId: "p-bahar",
      kind: "catalog",
      name: "Bahar Gadget",
      qtySold: 5,
      invoiceCount: 3,
      lineValueMinor: 900_000,
      netValueMinor: 900_000,
    },
  ],
};

const salesCustomer: PerfLeaderInput = {
  kind: "sales",
  truncated: false,
  groupBy: "customer",
  totals: { revenueMinor: 2_500_000, invoiceCount: 7, lineValueMinor: 2_500_000, discountMinor: 0, netLineValueMinor: 2_500_000 },
  groups: [
    { dimension: "customer", customerId: "c-1", name: "Akar Trading", invoiceCount: 4, revenueMinor: 1_500_000 },
    { dimension: "customer", customerId: null, name: null, invoiceCount: 3, revenueMinor: 1_000_000 },
  ],
};

const salesCustomerUnassignedLead: PerfLeaderInput = {
  kind: "sales",
  truncated: false,
  groupBy: "customer",
  totals: { revenueMinor: 1_000_000, invoiceCount: 3, lineValueMinor: 1_000_000, discountMinor: 0, netLineValueMinor: 1_000_000 },
  groups: [
    { dimension: "customer", customerId: null, name: null, invoiceCount: 3, revenueMinor: 1_000_000 },
  ],
};

const expensesCategory: PerfLeaderInput = {
  kind: "expenses",
  truncated: false,
  groupBy: "category",
  totals: { amountMinor: 900_000, expenseCount: 5 },
  groups: [
    { dimension: "category", category: "Rent", expenseCount: 1, amountMinor: 400_000 },
    { dimension: "category", category: "Services", expenseCount: 4, amountMinor: 500_000 - 400_000 + 400_000 },
  ],
};

const expensesSupplier: PerfLeaderInput = {
  kind: "expenses",
  truncated: false,
  groupBy: "supplier",
  totals: { amountMinor: 900_000, expenseCount: 5 },
  groups: [
    { dimension: "supplier", supplierId: "s-1", name: "Gadget GmbH", expenseCount: 2, amountMinor: 700_000 },
    { dimension: "supplier", supplierId: null, name: null, expenseCount: 3, amountMinor: 200_000 },
  ],
};

console.log("\n[1] the SILENCE LAWS — honest silence, never a padded crown");
eq(perfLeaderFact({ ...salesProduct, truncated: true }, FALLBACK), null, "1.1 truncated scan → silence (a share of a partial total is a wrong number)");
eq(perfLeaderFact({ ...salesCustomer, truncated: true }, FALLBACK), null, "1.2 truncated customer scan → silence");
eq(perfLeaderFact({ ...expensesCategory, truncated: true }, FALLBACK), null, "1.3 truncated expense scan → silence");
eq(
  perfLeaderFact({ kind: "cashflow", truncated: false }, FALLBACK),
  null,
  "1.4 cashflow → silence (rows are keyset-paged — a rank over page 1 is not the true rank)",
);
eq(
  perfLeaderFact({ kind: "cashflow", truncated: true }, FALLBACK),
  null,
  "1.5 cashflow truncated → silence",
);
eq(
  perfLeaderFact({ ...salesProduct, groupBy: "day", groups: [{ dimension: "day", date: "2026-10-01", invoiceCount: 1, revenueMinor: 9_999_999 }] }, FALLBACK),
  null,
  "1.6 sales day buckets → silence (groups[0] is the OLDEST day, not a leader — even a 9.9M day)",
);
eq(
  perfLeaderFact({ ...salesProduct, groupBy: "month", groups: [{ dimension: "month", month: "2026-10", invoiceCount: 1, revenueMinor: 9_999_999 }] }, FALLBACK),
  null,
  "1.7 sales month buckets → silence",
);
eq(
  perfLeaderFact({ ...expensesCategory, groupBy: "day", groups: [{ dimension: "day", date: "2026-10-01", expenseCount: 1, amountMinor: 9_999_999 }] }, FALLBACK),
  null,
  "1.8 expense day buckets → silence",
);
eq(
  perfLeaderFact({ ...expensesCategory, groupBy: "month", groups: [{ dimension: "month", month: "2026-10", expenseCount: 1, amountMinor: 9_999_999 }] }, FALLBACK),
  null,
  "1.9 expense month buckets → silence",
);
eq(perfLeaderFact({ ...salesProduct, groups: [] }, FALLBACK), null, "1.10 empty sales groups → silence");
eq(perfLeaderFact({ ...expensesCategory, groups: [] }, FALLBACK), null, "1.11 empty expense groups → silence");
eq(
  perfLeaderFact({ ...salesProduct, groups: [{ ...(salesProduct.groups[0] as Extract<(typeof salesProduct.groups)[number], { dimension: "product" }>), name: "   ", productId: null, kind: "unlinked" }] }, FALLBACK),
  null,
  "1.12 blank rank-1 product name → silence (a crown needs a name — the R98 trim law)",
);
eq(
  perfLeaderFact({ ...salesProduct, groups: [{ ...(salesProduct.groups[0] as Extract<(typeof salesProduct.groups)[number], { dimension: "product" }>), netValueMinor: Number.NaN }] }, FALLBACK),
  null,
  "1.13 non-finite rank value → silence",
);
eq(
  perfLeaderFact({ ...salesProduct, totals: { ...salesProduct.totals, netLineValueMinor: Number.POSITIVE_INFINITY } }, FALLBACK),
  null,
  "1.14 non-finite total → silence",
);
eq(
  perfLeaderFact({ ...salesProduct, groups: [{ ...(salesProduct.groups[0] as Extract<(typeof salesProduct.groups)[number], { dimension: "product" }>), netValueMinor: 1_000_000, name: "" }] }, FALLBACK),
  null,
  "1.15 empty-string rank-1 name → silence",
);

console.log("\n[2] the VERBATIM LAW — the server's head is crowned, NEVER re-ranked");
const flipped: PerfLeaderInput = { ...salesProduct, groups: [...salesProduct.groups].reverse() };
eq(
  perfLeaderFact(salesProduct, FALLBACK)?.name,
  "Akar Widget",
  "2.1 the server's head is crowned verbatim (Akar first in the response)",
);
eq(
  perfLeaderFact(flipped, FALLBACK)?.name,
  "Bahar Gadget",
  "2.2 NO re-rank: the reversed input crowns the OTHER head (input-order faithful — the extractor is the server's mouthpiece, not a second ranker)",
);
// A later group with a BIGGER value must NOT steal the crown (the server
// already ranked; a re-ranking extractor would disagree with the table's
// server order under any client sort).
const biggerTail: PerfLeaderInput = {
  ...salesProduct,
  groups: [salesProduct.groups[0], { ...(salesProduct.groups[1] as Extract<(typeof salesProduct.groups)[number], { dimension: "product" }>), netValueMinor: 99_000_000 }],
};
eq(perfLeaderFact(biggerTail, FALLBACK)?.name, "Akar Widget", "2.3 a bigger TAIL group never steals the crown (the response's order IS the rank)");

console.log("\n[3] the IDENTITY LAW — drills ride stable ids only");
eq(
  perfLeaderFact(salesProduct, FALLBACK)?.drill,
  { entity: "product", id: "p-akar" },
  "3.1 catalog product drills by its stable id",
);
eq(
  perfLeaderFact({ ...salesProduct, groups: [{ ...(salesProduct.groups[0] as Extract<(typeof salesProduct.groups)[number], { dimension: "product" }>), productId: null, kind: "unlinked" }] }, FALLBACK)?.drill,
  null,
  "3.2 unlinked product (no id) → citation WITHOUT a fake destination",
);
eq(
  perfLeaderFact(salesCustomer, FALLBACK)?.drill,
  { entity: "customer", id: "c-1" },
  "3.3 customer drills by its stable id",
);
eq(
  perfLeaderFact(salesCustomerUnassignedLead, FALLBACK),
  { name: FALLBACK, valueMinor: 1_000_000, totalMinor: 1_000_000, drill: null },
  "3.4 the unassigned mass CAN lead — crowned under the fallback name, no drill (the TileLeaderLine precedent)",
);
eq(
  perfLeaderFact(expensesCategory, FALLBACK)?.drill,
  null,
  "3.5 a category is a plain string — ALWAYS drill null (no entity exists to fake)",
);
eq(
  perfLeaderFact(expensesSupplier, FALLBACK)?.drill,
  { entity: "supplier", id: "s-1" },
  "3.6 supplier drills by its stable id",
);
eq(
  perfLeaderFact({ ...expensesSupplier, groups: [expensesSupplier.groups[1]] }, FALLBACK),
  { name: FALLBACK, valueMinor: 200_000, totalMinor: 900_000, drill: null },
  "3.7 anonymous supplier leads under the fallback name, no drill",
);

console.log("\n[4] the BASIS LAW — the rank's own sort key over the SAME-basis total");
const pFact = perfLeaderFact(salesProduct, FALLBACK);
ok("4.1 product money = the rank's OWN netValueMinor (the table's default-sort column)", pFact?.valueMinor === 1_000_000);
ok("4.2 product total = totals.netLineValueMinor (SAME basis by construction)", pFact?.totalMinor === 2_200_000);
const cFact = perfLeaderFact(salesCustomer, FALLBACK);
ok("4.3 customer money = revenueMinor over totals.revenueMinor", cFact?.valueMinor === 1_500_000 && cFact?.totalMinor === 2_500_000);
const catFact = perfLeaderFact(expensesCategory, FALLBACK);
ok("4.4 category money = amountMinor over totals.amountMinor", catFact?.valueMinor === 400_000 && catFact?.totalMinor === 900_000);
const sFact = perfLeaderFact(expensesSupplier, FALLBACK);
ok("4.5 supplier money = amountMinor over totals.amountMinor", sFact?.valueMinor === 700_000 && sFact?.totalMinor === 900_000);
// Negative-book honesty: a negative net (discounts exceeding lines) still
// crowns HONESTLY — the value rides verbatim; the share bar's gate is the
// UI's 0<x<=100 law, not the extractor's business.
const negativeNet: PerfLeaderInput = {
  ...salesProduct,
  groups: [{ ...(salesProduct.groups[0] as Extract<(typeof salesProduct.groups)[number], { dimension: "product" }>), netValueMinor: -200_000 }],
};
const nFact = perfLeaderFact(negativeNet, FALLBACK);
ok("4.6 negative net still crowns HONESTLY (value verbatim, not clamped)", nFact?.valueMinor === -200_000 && nFact !== null);

console.log("\n[5] DETERMINISM — 5× byte-identical");
const snap = JSON.stringify(perfLeaderFact(salesProduct, FALLBACK));
let detOk = true;
for (let i = 0; i < 5; i++) {
  if (JSON.stringify(perfLeaderFact(salesProduct, FALLBACK)) !== snap) detOk = false;
}
ok("5.1 five consecutive calls byte-identical", detOk);

console.log("\n[6] STATIC WIRING — panel + subview + i18n both-bag");
const panelSrc = fs.readFileSync("src/modules/reports/performance-panel.tsx", "utf8");
ok("6.1 the panel imports perfLeaderFact (the pure extractor — no re-rank drift)", /import \{ perfLeaderFact/.test(panelSrc));
ok("6.2 the sales branch crowns with the fallback name for the unassigned mass", /perfLeaderFact\(r, t\("perfColNoCustomer"\)\)/.test(panelSrc));
ok("6.3 the expense branch crowns with the supplier fallback", /perfLeaderFact\(r, t\("perfColNoSupplier"\)\)/.test(panelSrc));
ok("6.4 the strip speaks the DIMENSION tones (emerald sales / violet expenses)", /tone="emerald"/.test(panelSrc) && /tone="violet"/.test(panelSrc));
ok("6.5 the share gate is the same-basis law (totalMinor > 0 && valueMinor > 0)", /totalMinor > 0 && valueMinor > 0/.test(panelSrc));
ok("6.6 the strip formats tooltips INSIDE the component (the R99 FORMATTING_ERROR lesson)", /t\("perfLeaderTooltipDrill", \{ name, money \}\)/.test(panelSrc) && /t\("perfLeaderTooltipPlain", \{ name, money \}\)/.test(panelSrc));
ok("6.7 literal keys only — no dynamic template keys (the audit-scanner lesson)", !panelSrc.includes("t(`perfLeader"));
ok("6.8 the strip hides its share bar below sm (the mobile law)", /hidden min-w-0 flex-1 items-center gap-1\.5 sm:flex/.test(panelSrc));
ok("6.9 the chevron is RTL-mirrored with the hover nudge", /rtl:-scale-x-100 group-hover:translate-x-0\.5 rtl:group-hover:-translate-x-0\.5/.test(panelSrc));
ok("6.10 the static citation renders when there is no drill (no button, no fake page)", /cursor-default items-center gap-2 rounded-lg border px-3 py-1\.5/.test(panelSrc));

const viewSrc = fs.readFileSync("src/modules/reports/reports-view.tsx", "utf8");
ok("6.11 the copy button copies window.location.href (the hash IS the state)", /navigator\.clipboard\.writeText\(window\.location\.href\)/.test(viewSrc));
ok("6.12 the feedback is the 2s inline swap (icon + label), failures toast", /setLinkCopied\(true\)/.test(viewSrc) && /setTimeout\(\(\) => setLinkCopied\(false\), 2000\)/.test(viewSrc) && /perfCopyFailed/.test(viewSrc));
ok("6.13 the copied state is cleaned up (the timer resets the label)", /setLinkCopied\(false\), 2000/.test(viewSrc));

console.log("\n[7] i18n BOTH-BAG — 6 new keys, EN/FA symmetric placeholders");
const enSrc = fs.readFileSync("src/i18n/messages/en.ts", "utf8");
const faSrc = fs.readFileSync("src/i18n/messages/fa.ts", "utf8");
const R101_KEYS = [
  "perfLeaderCaption",
  "perfLeaderTooltipDrill",
  "perfLeaderTooltipPlain",
  "perfCopyLink",
  "perfCopiedToast",
  "perfCopyFailed",
];
for (const k of R101_KEYS) {
  const re = new RegExp(`\\b${k}:\\s*"`);
  ok(`7.${R101_KEYS.indexOf(k) + 1} ${k} exists in BOTH bags`, re.test(enSrc) && re.test(faSrc));
}
function placeholdersOf(src: string, key: string): string[] {
  const m = src.match(new RegExp(`\\b${key}:\\s*"([^"]*)"`));
  if (!m) return [];
  return [...m[1].matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
}
["perfLeaderTooltipDrill", "perfLeaderTooltipPlain"].forEach((k, i) => {
  ok(`7.${R101_KEYS.length + i + 1} ${k} placeholder sets match EN↔FA exactly`,
    JSON.stringify(placeholdersOf(enSrc, k)) === JSON.stringify(placeholdersOf(faSrc, k)),
    `en=[${placeholdersOf(enSrc, k)}] fa=[${placeholdersOf(faSrc, k)}]`);
});
ok("7.9 perfShareTooltip (the reused share label) still carries {percent} in BOTH bags",
  JSON.stringify(placeholdersOf(enSrc, "perfShareTooltip")) === JSON.stringify(placeholdersOf(faSrc, "perfShareTooltip"))
    && placeholdersOf(enSrc, "perfShareTooltip").includes("percent"));

console.log(`\n=== r101-leader-unit: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:", failures.join(" | "));
  process.exit(1);
}
