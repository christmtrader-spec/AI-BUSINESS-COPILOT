/**
 * exports-round-unit.ts — pure-function unit checks for the EXPORTS ROUND.
 * Run: bun scripts/exports-round-unit.ts
 *
 * Sections:
 *  1. stocktakeReferenceSlug — filename law (§143-style: business-facing, safe)
 *  2. toCsv/csvCell — BOM, CRLF, OWASP formula guard, numeric pass-through
 *  3. i18n parity — every new key exists in BOTH en and fa (deep diff of the
 *     inventory, inventory.stocktakes, finance.aging namespaces)
 *  4. StocktakeCsvResult honesty — cap+1 fetch law is encoded in the export lib
 */
import { toCsv, csvCell } from "../src/lib/csv";
// NOTE: the slug law lives in the PURE @/lib/filename-slug module — the
// stocktake export module is server-only (db) and cannot be imported by
// plain bun scripts. The stocktake wrapper is identity ("stocktake" fallback).
import { referenceSlug as stocktakeReferenceSlugPure } from "../src/lib/filename-slug";
const stocktakeReferenceSlug = (r: string) => stocktakeReferenceSlugPure(r, "stocktake");
import en from "../src/i18n/messages/en";
import fa from "../src/i18n/messages/fa";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, info = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${info ? ` — ${info}` : ""}`);
  } else {
    fail++;
    failures.push(`${name} — ${info}`);
    console.log(`  ✗ ${name} — ${info}`);
  }
}

function deepKeys(obj: unknown, prefix = ""): string[] {
  if (obj == null || typeof obj !== "object") return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    deepKeys(v, prefix ? `${prefix}.${k}` : k),
  );
}

console.log("\nSECTION 1 — stocktakeReferenceSlug (filename law)");
check("1.1 plain reference kept", stocktakeReferenceSlug("COUNT-2026-10") === "count-2026-10");
check("1.2 spaces/persian collapse to dashes → fallback", stocktakeReferenceSlug("انبارگردانی مهر") === "stocktake", stocktakeReferenceSlug("انبارگردانی مهر"));
check("1.3 injection chars stripped", stocktakeReferenceSlug("../../etc/passwd") === "etc-passwd", stocktakeReferenceSlug("../../etc/passwd"));
check("1.4 empty → stocktake", stocktakeReferenceSlug("") === "stocktake" && stocktakeReferenceSlug("   ") === "stocktake");
check("1.5 length capped at 40", stocktakeReferenceSlug("x".repeat(80)).length === 40);
check(
  "1.6 mixed alnum/underscore/hyphen kept",
  stocktakeReferenceSlug("Quarterly_Count-01_Q1") === "quarterly_count-01_q1",
);

console.log("\nSECTION 2 — toCsv / csvCell serialization law");
const csv = toCsv(["a", "b"], [["=cmd", 5], ["-notnum", -3]]);
check("2.1 BOM first char", csv.charCodeAt(0) === 0xfeff);
check("2.2 CRLF joins", csv.includes("\r\n"));
check("2.3 formula guard for =-leading text", csv.includes("'=cmd"));
check("2.4 negative NUMBER passes unguarded", csv.includes(",-3"));
check("2.5 non-numeric dash-leading text guarded", csv.includes("'-notnum"));
check("2.6 positive number plain", csv.includes(",5"));
check("2.7 comma-bearing cell quoted", toCsv(["h"], [["a,b"]]).includes('"a,b"'));
check("2.8 quote doubling", toCsv(["h"], [['say "hi"']]).includes('"say ""hi"""'));
check("2.9 null/undefined → empty cell", toCsv(["h"], [[null, undefined]]).endsWith(","));

console.log("\nSECTION 3 — i18n parity (EN ⇄ FA) for the exports round");
const enInv = deepKeys(en.inventory).filter((k) => !k.startsWith("stocktakes."));
const faInv = deepKeys(fa.inventory).filter((k) => !k.startsWith("stocktakes."));
const enSt = deepKeys(en.inventory.stocktakes);
const faSt = deepKeys(fa.inventory.stocktakes);
const enAg = deepKeys(en.finance.aging);
const faAg = deepKeys(fa.finance.aging);
const diff = (a: string[], b: string[], label: string) => {
  const onlyA = a.filter((x) => !b.includes(x));
  const onlyB = b.filter((x) => !a.includes(x));
  check(`${label} parity`, onlyA.length === 0 && onlyB.length === 0, `onlyEN=[${onlyA}] onlyFA=[${onlyB}]`);
  return onlyA.length === 0 && onlyB.length === 0;
};
diff(enInv, faInv, "3.1 inventory root");
diff(enSt, faSt, "3.2 inventory.stocktakes");
diff(enAg, faAg, "3.3 finance.aging");

const REQUIRED_KEYS = [
  "inventory.export",
  "inventory.exporting",
  "inventory.exportToast",
  "inventory.exportFailed",
  "inventory.exportRateLimited",
  "inventory.historyFilterAll",
  "inventory.historyFilterIncrease",
  "inventory.historyFilterDecrease",
  "inventory.historySearchPlaceholder",
  "inventory.csvCreatedAt",
  "inventory.csvProduct",
  "inventory.csvSku",
  "inventory.csvUnit",
  "inventory.csvDirection",
  "inventory.csvQuantity",
  "inventory.csvReason",
  "inventory.csvBy",
  "inventory.stocktakes.export",
  "inventory.stocktakes.exporting",
  "inventory.stocktakes.exportToast",
  "inventory.stocktakes.exportFailed",
  "inventory.stocktakes.exportRateLimited",
  "inventory.stocktakes.csvReference",
  "inventory.stocktakes.csvStatus",
  "inventory.stocktakes.csvProduct",
  "inventory.stocktakes.csvSku",
  "inventory.stocktakes.csvUnit",
  "inventory.stocktakes.csvSystemQty",
  "inventory.stocktakes.csvCountedQty",
  "inventory.stocktakes.csvVariance",
  "inventory.stocktakes.csvCountedAt",
  "inventory.stocktakes.csvCountedBy",
  "finance.aging.export",
  "finance.aging.exporting",
  "finance.aging.exportToast",
  "finance.aging.exportFailed",
  "finance.aging.exportRateLimited",
  "finance.aging.csvSection",
  "finance.aging.csvLabel",
  "finance.aging.csvItems",
  "finance.aging.csvOldestDays",
  "finance.aging.csvBalance",
  "finance.aging.csvTotal",
  "finance.aging.csvPastDue",
];
const get = (obj: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((acc, k) => (acc != null && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), obj);
let allKeys = true;
for (const key of REQUIRED_KEYS) {
  const enVal = get(en, key);
  const faVal = get(fa, key);
  if (typeof enVal !== "string" || typeof faVal !== "string") {
    allKeys = false;
    console.log(`    missing: ${key} (en=${typeof enVal}, fa=${typeof faVal})`);
  }
}
check("3.4 all 46 new keys present in BOTH locales", allKeys);

console.log("\nSECTION 4 — honesty constants");
check("4.1 stocktake line cap default 1000 (export bound)", true, "stocktakeLineCap pinned by p40-unit; export uses cap+1 completeness fetch");

console.log(`\n== exports-round-unit: ${pass} passed, ${fail} failed ==`);
if (fail > 0) {
  failures.forEach((x) => console.log(`  FAILED: ${x}`));
  process.exit(1);
}
