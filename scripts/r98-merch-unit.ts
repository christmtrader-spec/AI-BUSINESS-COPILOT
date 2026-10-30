/**
 * scripts/r98-merch-unit.ts — R98 PURE-ENGINE + WIRING LAWS (persists).
 *
 * The BEST-SELLER tier's unit proofs:
 *  [1] topProductOf — the report's own rank 1 VERBATIM (never re-ranks:
 *      a bigger entry at [1] does NOT win), 60 randomized shuffled lists
 *      → entries[0] byte-for-byte, guards (null/absent/empty/unnamed/
 *      non-finite → honest silence), the shape law (exactly 3 fields),
 *      determinism 5×.
 *  [2] topCategoryOf — the same law family for the expense side.
 *  [3] ZERO-IMPORT static: src/lib/merch-facts.ts has no import/export-
 *      from statements (client-safe by construction).
 *  [4] WIRING static: snapshot.ts maps meta.topProduct/topExpenseCategory
 *      from the ONE extractor pair; the 6e prompt law exists; the meta
 *      type carries both fields OPTIONAL (the additive law); copilot-view
 *      gates the chips on the meta (pickMerchFollowUps) + renders the
 *      Trophy/Wallet chips with the testids; performance-panel mounts the
 *      share column ONLY on a complete scan (4 spread sites, all gated by
 *      `r.truncated ? [] :`) and reads the response's OWN totals.
 *  [5] i18n BOTH-BAG: the 6 new keys exist in BOTH en/fa and the
 *      placeholder sets match exactly per key.
 *
 * Run: bun scripts/r98-merch-unit.ts
 * Exit: 0 = all green, 1 = at least one failure.
 */

export {}; // the module law — top-level await needs a module

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}
function eq(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const { topProductOf, topCategoryOf } = await import("../src/lib/merch-facts");
const fs = await import("node:fs");

function randList(n: number) {
  const names = ["Akar Widget", "Bahar Gadget", "Chinar Tool", "Dena Kit", "Eyvan Set"];
  const out: Array<{ name: string; qty: number; revenueMinor: number }> = [];
  for (let i = 0; i < n; i++) {
    out.push({
      name: names[i % names.length] + (i >= names.length ? ` #${i}` : ""),
      qty: 1 + ((i * 7) % 13),
      revenueMinor: 100_000 + i * 111_111,
    });
  }
  return out;
}

console.log("\n[1] topProductOf — the report's OWN rank 1, verbatim");
const crafted = [
  { name: "Akar Widget", qty: 3, revenueMinor: 1_000_000 },
  { name: "Bahar Gadget", qty: 9, revenueMinor: 9_999_999 },
  { name: "Chinar Tool", qty: 1, revenueMinor: 500 },
];
const picked = topProductOf(crafted);
ok("1.1 the FIRST entry wins even when a later entry is bigger (never re-ranks)",
  picked !== null && picked.name === "Akar Widget" && picked.revenueMinor === 1_000_000 && picked.unitsSold === 3,
  JSON.stringify(picked));
ok("1.2 the shape law — exactly 4 fields {name, unitsSold, revenueMinor, productId} (R153 grew the drill id — additive)",
  picked !== null && eq(Object.keys(picked).sort(), ["name", "productId", "revenueMinor", "unitsSold"]),
  picked ? JSON.stringify(Object.keys(picked)) : "null");
ok("1.2b rows without an id degrade to productId null (the unlinked mass — carried, never drilled)",
  picked !== null && picked.productId === null);

let shuffledOk = true;
let shuffledInfo = "";
for (let t = 0; t < 60; t++) {
  const list = randList(5 + (t % 6));
  // a deterministic shuffle seeded by t (Fisher-Yates with an LCG)
  let seed = t * 2654435761 + 1;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  const got = topProductOf(list);
  if (
    !got ||
    got.name !== list[0].name ||
    got.unitsSold !== list[0].qty ||
    got.revenueMinor !== list[0].revenueMinor ||
    got.productId !== null ||
    eq(Object.keys(got).sort(), ["name", "productId", "revenueMinor", "unitsSold"]) === false
  ) {
    shuffledOk = false;
    shuffledInfo = `t=${t} got=${JSON.stringify(got)} want=${JSON.stringify(list[0])}`;
    break;
  }
}
ok("1.3 60 randomized shuffled lists → entries[0] VERBATIM (byte-for-byte, shape intact, id-less rows → null id)", shuffledOk, shuffledInfo);

ok("1.4 guards: null → null", topProductOf(null) === null);
ok("1.5 guards: undefined → null", topProductOf(undefined) === null);
ok("1.6 guards: empty list → null", topProductOf([]) === null);
ok("1.7 guards: unnamed rank 1 (empty name) → honest silence",
  topProductOf([{ name: "", qty: 1, revenueMinor: 5 }]) === null);
ok("1.8 guards: non-string name → honest silence",
  topProductOf([{ name: 42 as unknown as string, qty: 1, revenueMinor: 5 }]) === null);
ok("1.9 guards: non-finite revenue → honest silence",
  topProductOf([{ name: "X", qty: 1, revenueMinor: Number.NaN }]) === null);
ok("1.10 guards: non-finite qty → honest silence",
  topProductOf([{ name: "X", qty: Number.POSITIVE_INFINITY, revenueMinor: 5 }]) === null);
const det1 = topProductOf(crafted);
ok("1.11 determinism 5×", [1, 2, 3, 4, 5].every(() => eq(topProductOf(crafted), det1)));

console.log("\n[2] topCategoryOf — the expense twin");
const cats = [
  { category: "Rent", totalMinor: 400_000 },
  { category: "Utilities", totalMinor: 900_000 },
];
const pickedCat = topCategoryOf(cats);
ok("2.1 the FIRST entry wins (never re-ranks)", pickedCat !== null && pickedCat.category === "Rent" && pickedCat.totalMinor === 400_000, JSON.stringify(pickedCat));
ok("2.2 the shape law — exactly 2 fields {category, totalMinor}",
  pickedCat !== null && eq(Object.keys(pickedCat).sort(), ["category", "totalMinor"]));
ok("2.3 guards: null/undefined/empty → null",
  topCategoryOf(null) === null && topCategoryOf(undefined) === null && topCategoryOf([]) === null);
ok("2.4 guards: blank category → honest silence",
  topCategoryOf([{ category: "  ", totalMinor: 5 }]) === null);
ok("2.5 guards: non-finite total → honest silence",
  topCategoryOf([{ category: "Rent", totalMinor: Number.NaN }]) === null);
ok("2.6 determinism 5×", [1, 2, 3, 4, 5].every(() => eq(topCategoryOf(cats), pickedCat)));

console.log("\n[3] ZERO-IMPORT static (client-safe by construction)");
const merchSrc = fs.readFileSync("src/lib/merch-facts.ts", "utf8");
ok("3.1 no import statements in merch-facts.ts",
  !/^import\s/m.test(merchSrc) && !/from\s+["']/.test(merchSrc.replace(/^\s*\*/gm, "")));
ok("3.2 no dynamic import either", !merchSrc.includes("await import"));

console.log("\n[4] WIRING static — one authority end to end");
const snapSrc = fs.readFileSync("src/lib/ai/snapshot.ts", "utf8");
ok("4.1 snapshot.ts imports the ONE extractor pair",
  snapSrc.includes('from "@/lib/merch-facts"') &&
  snapSrc.includes("topProductOf(report.topProducts)") &&
  snapSrc.includes("topCategoryOf(report.expensesByCategory)"));
ok("4.2 the meta type carries both fields OPTIONAL (the additive law)",
  /topProduct\?:\s*TopProductView \| null/.test(snapSrc) &&
  /topExpenseCategory\?:\s*TopCategoryView \| null/.test(snapSrc));
ok("4.3 the 6e prompt law exists (windowed + verbatim + never re-rank + empty honesty)",
  snapSrc.includes("6e. TOP PRODUCTS & EXPENSE CATEGORIES") &&
  snapSrc.includes("cover ONLY the data window") &&
  snapSrc.includes("never compute or re-rank them yourself"));
ok("4.4 zero new queries — the mapping sits AFTER the existing Promise.all (no new db calls in the meta block)",
  !/topProduct:\s*await/.test(snapSrc) && !/topExpenseCategory:\s*await/.test(snapSrc));

const copilotSrc = fs.readFileSync("src/modules/copilot/copilot-view.tsx", "utf8");
// R153 RE-PIN (honest archaeology): the R98-era merch follow-up chips
// (pickMerchFollowUps / Trophy / Wallet / merchWindowLabel) were replaced
// by the R118 suggestion system (FOLLOW_UP_KEYS + FOLLOW_UP_MATCHERS +
// followUpRelevant) in a later round and these pins went stale unnoticed
// (r98 was not in the running family). Re-pinned to CURRENT reality —
// the best-seller question stays suggestable through the products
// matcher, and the R153 product chip now carries the drill itself.
ok("4.5 the follow-up pool exists with the relevance law (followUpRelevant — propose only when the subject exists)",
  copilotSrc.includes("const FOLLOW_UP_KEYS") &&
  copilotSrc.includes("function followUpRelevant") &&
  copilotSrc.includes("return counts.receivableCount > 0"));
ok("4.6 the products matcher keeps the best-seller questions suggestable (the merch tier's descendent)",
  /followUpProducts[^\n]*re:\s*\/product\|best\.\?seller\|top\|محصول\|پرفروش\/i/.test(copilotSrc.replace(/\n\s+/g, " ")));
ok("4.7 the follow-up block renders with the stable testid + the Sparkles label",
  copilotSrc.includes('data-testid="copilot-followups"') &&
  copilotSrc.includes('t("followUpsLabel")') &&
  copilotSrc.includes("askFollowUp(t(key))"));
ok("4.8 the follow-up pool ranks by live server counts (SummaryLite — never the model)",
  copilotSrc.includes("type SummaryLite") &&
  copilotSrc.includes("topProducts?: unknown[]"));

const perfSrc = fs.readFileSync("src/modules/reports/performance-panel.tsx", "utf8");
// R153 RE-PIN: the four table share columns became the ONE share law —
// a single honest share bar on the LeaderStrip (stockSharePercent),
// rendered only on a same-basis denominator.
ok("4.9 the ONE share law — stockSharePercent drives the leader strip's bar (never per-column shares)",
  perfSrc.includes("const share = stockSharePercent(valueMinor, totalMinor)") &&
  perfSrc.includes("stockSharePercent"));
ok("4.10 the share bar renders only on an honest same-basis denominator",
  perfSrc.includes("The share bar renders only on an honest same-basis denominator") &&
  /share !== null/.test(perfSrc));
ok("4.11 the share tooltip cites the EXACT percent (formatted inside the component)",
  perfSrc.includes('t("perfShareTooltip", { percent: fmtCount(uiLocale, share) })'));

console.log("\n[5] i18n BOTH-BAG — the CURRENT keys, EN/FA symmetric placeholders (R153 re-pin: the R98-era followUpTop*/perfColShare keys are DEAD — replaced by the R118 followUp* bag)");
const enSrc = fs.readFileSync("src/i18n/messages/en.ts", "utf8");
const faSrc = fs.readFileSync("src/i18n/messages/fa.ts", "utf8");
const R98_KEYS = [
  "followUpsLabel",
  "followUpOutstanding",
  "followUpProducts",
  "perfShareTooltip",
];
for (const k of R98_KEYS) {
  const re = new RegExp(`\\b${k}:\\s*"`);
  ok(`5.${R98_KEYS.indexOf(k) + 1} ${k} exists in BOTH bags`,
    re.test(enSrc) && re.test(faSrc));
}
ok("5.5 the DEAD R98 keys stay dead (no zombie strings)",
  !enSrc.includes("followUpTopProductQ") && !faSrc.includes("followUpTopProductQ") &&
  !enSrc.includes("followUpTopExpenseQ") && !faSrc.includes("followUpTopExpenseQ"));
function placeholdersOf(src: string, key: string): string[] {
  const m = src.match(new RegExp(`\\b${key}:\\s*"([^"]*)"`));
  if (!m) return [];
  return [...m[1].matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
}
const phKeys = ["perfShareTooltip"];
phKeys.forEach((k, i) => {
  ok(`5.${R98_KEYS.length + i + 1} ${k} placeholder sets match EN↔FA exactly`,
    eq(placeholdersOf(enSrc, k), placeholdersOf(faSrc, k)),
    `en=[${placeholdersOf(enSrc, k)}] fa=[${placeholdersOf(faSrc, k)}]`);
});
ok("5.7 the R153 actionProduct keys exist in BOTH bags with matching placeholders",
  /\bactionProduct:\s*"/.test(enSrc) && /\bactionProduct:\s*"/.test(faSrc) &&
  eq(placeholdersOf(enSrc, "actionProductTitle"), placeholdersOf(faSrc, "actionProductTitle")));

console.log(`\n=== r98-merch-unit: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:", failures.join(" | "));
  process.exit(1);
}
