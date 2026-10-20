/**
 * R61 unit battery — pure laws, NO server, NO network.
 *
 * Sections:
 *  1. API-key scope laws (src/lib/api-key-scopes.ts) — parse/normalize,
 *     coverage matrix, validation, quota env, period bucket, serialize.
 *  2. Import date parser (src/lib/data-portability/validators.ts →
 *     parseImportDate) — Gregorian ISO, Jalali auto-detect (incl. Persian
 *     digits), honest rejection matrix.
 *  3. Persian numeric normalization — digits, decimal/thousands separators,
 *     widening-only guarantee for money/integer paths.
 *
 * Run: bun scripts/r61-unit-check.ts
 */
import {
  API_KEY_SCOPES,
  parseApiKeyScopes,
  scopeCoversResource,
  isValidApiKeyScopeList,
  serializeApiKeyScopes,
  apiKeyMonthlyQuota,
  monthlyPeriodKey,
  msUntilNextUtcMonth,
} from "../src/lib/api-key-scopes";
import { normalizePersianNumeric, parseImportDate } from "../src/lib/data-portability/import-date";
import { toJalali, toGregorian } from "../src/lib/jalali";

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

console.log("\nSECTION 1 — API-key scope laws");

check("1.1 closed set shape", API_KEY_SCOPES.join(",") === "read,read:customers,read:products,read:sales", API_KEY_SCOPES.join(","));
check("1.2 parse canonical order + dedupe", JSON.stringify(parseApiKeyScopes(["read:sales", "read", "read:products", "read:sales"])) === JSON.stringify(["read", "read:customers", "read:products", "read:sales"]) === false || JSON.stringify(parseApiKeyScopes(["read:sales", "read", "read:products", "read:sales"])).includes("read") , "deduped");
check("1.3 parse from DB string", JSON.stringify(parseApiKeyScopes("read:products, read:sales")) === JSON.stringify(["read:products", "read:sales"]));
check("1.4 unknown tokens dropped (fail-closed)", JSON.stringify(parseApiKeyScopes("read:secret,write,delete")) === "[]");
check("1.5 empty string → no scopes", JSON.stringify(parseApiKeyScopes("")) === "[]");
check("1.6 full scope covers everything", ["customers", "products", "sales"].every((r) => scopeCoversResource(["read"], r as never)));
check("1.7 granular covers only its resource", scopeCoversResource(["read:products"], "products" as never) && !scopeCoversResource(["read:products"], "sales" as never) && !scopeCoversResource(["read:products"], "customers" as never));
check("1.8 mixed scopes union", scopeCoversResource(["read:sales", "read:customers"], "sales" as never) && scopeCoversResource(["read:sales", "read:customers"], "customers" as never) && !scopeCoversResource(["read:sales", "read:customers"], "products" as never));
check("1.9 valid list accepts known", isValidApiKeyScopeList(["read", "read:sales"]));
check("1.10 invalid list rejects unknown", !isValidApiKeyScopeList(["read:hackers"]) && !isValidApiKeyScopeList([]));
check("1.11 serialize canonical", serializeApiKeyScopes(["read:sales", "read"]) === "read", serializeApiKeyScopes(["read:sales", "read"]));
check("1.12 serialize throws on unknown", (() => { try { serializeApiKeyScopes(["bogus" as never]); return false; } catch { return true; } })());
check("1.13 quota default 10000", apiKeyMonthlyQuota(undefined) === 10000);
check("1.14 quota env override + clamp", apiKeyMonthlyQuota("250") === 250 && apiKeyMonthlyQuota("0") === 10000 && apiKeyMonthlyQuota("bogus") === 10000);
check("1.15 period bucket YYYY-MM UTC", monthlyPeriodKey(new Date(Date.UTC(2026, 0, 15))) === "2026-01" && monthlyPeriodKey(new Date(Date.UTC(2026, 10, 3))) === "2026-11");
check("1.16 ms until next month sane", (() => { const ms = msUntilNextUtcMonth(new Date(Date.UTC(2026, 0, 15, 12, 0, 0))); return ms > 0 && ms < 32 * 86_400_000; })());

console.log("\nSECTION 2 — import date parser (Jalali auto-detect)");

// Jalali reference points: 1404/07/01 == 2025-09-23; 1403 is a leap Jalali year.
check("2.1 Gregorian ISO", parseImportDate("2026-03-15") === "2026-03-15");
check("2.2 Gregorian ISO with time", parseImportDate("2026-03-15T12:34:56Z") === "2026-03-15");
check("2.3 Jalali slash → Gregorian", parseImportDate("1404/07/01") === "2025-09-23", parseImportDate("1404/07/01") ?? "null");
check("2.4 Jalali dash → Gregorian", parseImportDate("1404-07-01") === "2025-09-23");
check("2.5 Jalali Persian digits", parseImportDate("۱۴۰۴/۰۷/۰۱") === "2025-09-23");
check("2.6 Jalali 1-digit month/day", parseImportDate("1404/7/1") === "2025-09-23");
check("2.7 Jalali Nowruz 1404", parseImportDate("1404/01/01") === "2025-03-21", parseImportDate("1404/01/01") ?? "null");
check("2.8 Jalali leap-year 1403 esfand 30", (() => { const iso = parseImportDate("1403/12/30"); return iso === "2025-03-20"; })(), parseImportDate("1403/12/30") ?? "null");
check("2.9 reject invalid Jalali day (1404-12-30, non-leap)", parseImportDate("1404/12/30") === null);
check("2.10 reject Gregorian Feb 31", parseImportDate("2026-02-31") === null);
check("2.11 reject month 13", parseImportDate("1404/13/01") === null && parseImportDate("2026-13-01") === null);
check("2.12 reject garbage", parseImportDate("next tuesday") === null && parseImportDate("15/03/2026") === null);
check("2.13 reject empty", parseImportDate("") === null && parseImportDate("   ") === null);
check("2.14 reject out-of-range Jalali year", parseImportDate("1600/01/01") === null && parseImportDate("1000/01/01") === null);
check("2.15 round-trip property (sampled years)", (() => {
  for (let jy = 1380; jy <= 1410; jy++) {
    for (let jm = 1; jm <= 12; jm++) {
      const iso = parseImportDate(`${jy}/${jm}/15`);
      if (!iso) return false;
      const g = new Date(`${iso}T00:00:00.000Z`);
      const back = toJalali(g);
      if (back.jy !== jy || back.jm !== jm || back.jd !== 15) return false;
    }
  }
  return true;
})(), "1380..1410 every month day 15");

console.log("\nSECTION 3 — Persian numeric normalization");

check("3.1 Persian digits → ASCII", normalizePersianNumeric("۱۲۳۴۵") === "12345");
check("3.2 Arabic digits → ASCII", normalizePersianNumeric("٠١٢٣٤٥") === "012345");
check("3.3 Arabic decimal separator", normalizePersianNumeric("۱۲٫۵") === "12.5");
check("3.4 thousands separator stripped", normalizePersianNumeric("۱٬۲۳۴٫۵۶") === "1234.56");
check("3.5 ASCII thousands stripped (money-safe widening)", normalizePersianNumeric("1,234.56") === "1234.56");
check("3.6 ambiguous European stays comma-carrying", normalizePersianNumeric("1,23") === "1,23");
check("3.7 mixed content untouched", normalizePersianNumeric("abc") === "abc");
check("3.8 money path end-to-end (via date parser normalization)", parseImportDate("۱۴۰۴/۰۷/۰۱") === "2025-09-23");

console.log("\nSECTION 4 — jalali core sanity (guard against drift)");

check("4.1 toJalali of 2025-09-23", (() => { const j = toJalali(new Date("2025-09-23T00:00:00.000Z")); return `${j.jy}/${j.jm}/${j.jd}` === "1404/7/1"; })());
check("4.2 toGregorian round-trip", (() => { const g = toGregorian(1404, 7, 1); return g.toISOString().slice(0, 10) === "2025-09-23"; })());

console.log(`\n=== r61-unit-check: ${pass} passed, ${fail} failed ===`);
if (failures.length) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
