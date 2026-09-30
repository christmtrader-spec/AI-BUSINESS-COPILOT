/**
 * scripts/prompt33-unit.ts — Prompt 33 search UNIT harness (§37).
 *
 * Deterministic, no server required. Covers the PURE search functions:
 *   normalizeSearchText / getSearchVariants / extractInvoiceNumberQuery
 *   parseSearchParams (q/types/limit) · rankCandidate (all five reasons)
 *   deterministic tie-breaks · dedupeCandidates · groupResults
 *
 * Run:  bun scripts/prompt33-unit.ts
 * Exit: 0 = all green · 1 = at least one failure.
 */
import {
  normalizeSearchText,
  getSearchVariants,
  extractInvoiceNumberQuery,
} from "../src/lib/search/normalize";
import {
  parseSearchParams,
  SearchValidationError,
  SEARCH_LIMIT_MAX,
} from "../src/lib/search/schema";
import {
  rankCandidate,
  compareRanked,
  dedupeCandidates,
  RANK_WEIGHTS,
} from "../src/lib/search/rank";
import { groupResults } from "../src/lib/search/group";
import { customerCandidate, saleCandidate, productCandidate } from "../src/lib/search/dto";
import { SEARCH_ENTITY_TYPES, ENTITY_DESTINATION, type SearchCandidate, type SearchResultItem } from "../src/lib/search/types";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, info = "") {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${info ? ` — ${info}` : ""}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown) {
  ok(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
  );
}
function throws(name: string, fn: () => unknown, field?: string) {
  try {
    fn();
    ok(name, false, "expected SearchValidationError");
  } catch (e) {
    if (e instanceof SearchValidationError) {
      ok(name, field === undefined || e.field === field, `field=${e.field}`);
    } else {
      ok(name, false, `wrong error type: ${String(e)}`);
    }
  }
}

function candidate(overrides: Partial<SearchCandidate>): SearchCandidate {
  return {
    id: "c1",
    type: "CUSTOMER",
    title: "Alice",
    titleNorm: "alice",
    subtitle: null,
    identifierNorm: null,
    identifierExtras: [],
    numericIdentifier: null,
    secondaryNorms: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    status: null,
    date: null,
    direction: null,
    method: null,
    ...overrides,
  };
}

/* --------------------------- normalizeSearchText -------------------------- */
console.log("normalizeSearchText");
eq("trims + collapses repeated whitespace", normalizeSearchText("  Ali   Reza "), "ali reza");
eq("NFKC: full-width ALI → ali", normalizeSearchText("ＡＬＩ"), "ali");
eq("lowercases Latin", normalizeSearchText("AliReza"), "alireza");
eq("Persian digits → Latin (۰۱۲۳)", normalizeSearchText("۰۱۲۳"), "0123");
eq("Arabic digits → Latin (٠١٢٣)", normalizeSearchText("٠١٢٣"), "0123");
eq("Arabic ya ي → Persian ی", normalizeSearchText("علي"), "علی");
eq("Arabic kaf ك → Persian ک", normalizeSearchText("كتاب"), "کتاب");
eq("zero-width chars removed", normalizeSearchText("Ali\u200bReza\uFEFF"), "alireza");
eq("control chars removed", normalizeSearchText("al\u0000i\tb"), "ali b");
eq("meaningful content preserved", normalizeSearchText("P33-SEARCH-یک"), "p33-search-یک");
eq("idempotent", normalizeSearchText(normalizeSearchText("علي ۱۲")), normalizeSearchText("علي ۱۲"));

/* ----------------------------- getSearchVariants -------------------------- */
console.log("getSearchVariants");
eq("Latin query → single canonical variant", getSearchVariants("ali"), ["ali"]);
eq("Persian ya → adds Arabic compat variant", getSearchVariants("علی"), ["علی", "علي"]);
eq("Persian kaf → adds Arabic compat variant", getSearchVariants("کتاب"), ["کتاب", "كتاب"]);
eq("variant list bounded (≤2)", getSearchVariants("علی کتاب ۱۲۳").length <= 2, true);

/* -------------------------- extractInvoiceNumber -------------------------- */
console.log("extractInvoiceNumberQuery");
eq("INV-0001 → 1", extractInvoiceNumberQuery(normalizeSearchText("INV-0001")), 1);
eq("inv-25 → 25", extractInvoiceNumberQuery(normalizeSearchText("inv-25")), 25);
eq("25 → 25", extractInvoiceNumberQuery(normalizeSearchText("25")), 25);
eq("001 → 1", extractInvoiceNumberQuery(normalizeSearchText("001")), 1);
eq("Persian digits ۲۵ → 25", extractInvoiceNumberQuery(normalizeSearchText("۲۵")), 25);
eq("abc → null", extractInvoiceNumberQuery(normalizeSearchText("abc")), null);
eq("INV- (no digits) → null", extractInvoiceNumberQuery(normalizeSearchText("INV-")), null);
eq("10+ digits → null (bounded)", extractInvoiceNumberQuery(normalizeSearchText("1234567890")), null);
eq("0 → null", extractInvoiceNumberQuery(normalizeSearchText("0")), null);

/* ------------------------------ parseSearchParams ------------------------- */
console.log("parseSearchParams");
throws("missing q → validation error", () => parseSearchParams(new URLSearchParams("types=CUSTOMER")), "q");
throws("1-char q → validation error", () => parseSearchParams(new URLSearchParams("q=a")), "q");
eq("2-char q accepted", parseSearchParams(new URLSearchParams("q=al")).q, "al");
eq("q trimmed + collapsed", parseSearchParams(new URLSearchParams("q=%20%20ali%20%20reza")).q, "ali reza");
eq("64+ char q clamped to 64", parseSearchParams(new URLSearchParams(`q=${"x".repeat(100)}`)).q.length, 64);
eq("null bytes stripped from q", parseSearchParams(new URLSearchParams("q=al%00i")).q, "ali");
eq("types parsed (comma list)", parseSearchParams(new URLSearchParams("q=ali&types=CUSTOMER,PRODUCT")).types, ["CUSTOMER", "PRODUCT"]);
eq("types deduplicated", parseSearchParams(new URLSearchParams("q=ali&types=CUSTOMER,CUSTOMER")).types, ["CUSTOMER"]);
eq("types case-normalized", parseSearchParams(new URLSearchParams("q=ali&types=customer")).types, ["CUSTOMER"]);
eq("empty types → all six", parseSearchParams(new URLSearchParams("q=ali")).types, [...SEARCH_ENTITY_TYPES]);
throws("unknown type rejected (PlatformOperator)", () => parseSearchParams(new URLSearchParams("q=ali&types=PlatformOperator")), "types");
throws("unknown type rejected (AiCostRecord)", () => parseSearchParams(new URLSearchParams("q=ali&types=AiCostRecord")), "types");
throws("unknown type rejected (NotificationDelivery)", () => parseSearchParams(new URLSearchParams("q=ali&types=NotificationDelivery")), "types");
eq("limit clamped low (5 → 6)", parseSearchParams(new URLSearchParams("q=ali&limit=5")).limit, 6);
eq("limit clamped high (100 → 30)", parseSearchParams(new URLSearchParams("q=ali&limit=100")).limit, SEARCH_LIMIT_MAX);
eq("limit default 20", parseSearchParams(new URLSearchParams("q=ali")).limit, 20);
eq("limit non-numeric → default", parseSearchParams(new URLSearchParams("q=ali&limit=abc")).limit, 20);

/* -------------------------------- ranking --------------------------------- */
console.log("rankCandidate");
{
  const c = candidate({ titleNorm: "ali" });
  eq("EXACT: title equality", rankCandidate(c, ["ali"], null), "EXACT");
  const prefix = candidate({ titleNorm: "alice smith" });
  eq("PREFIX: title startsWith", rankCandidate(prefix, ["ali"], null), "PREFIX");
  const contains = candidate({ titleNorm: "x-ali-x" });
  eq("TITLE_CONTAINS: title includes", rankCandidate(contains, ["ali"], null), "TITLE_CONTAINS");
  const secondary = candidate({ titleNorm: "zzz", secondaryNorms: ["ali@example.com"] });
  eq("SECONDARY_CONTAINS: email field", rankCandidate(secondary, ["ali"], null), "SECONDARY_CONTAINS");
  const sku = candidate({ type: "PRODUCT", titleNorm: "iphone", identifierNorm: "abc-100" });
  eq("IDENTIFIER_EXACT: sku equality", rankCandidate(sku, ["abc-100"], null), "IDENTIFIER_EXACT");
  const inv = candidate({
    type: "SALE",
    titleNorm: "inv-0042",
    identifierNorm: "inv-0042",
    identifierExtras: ["42"],
    numericIdentifier: 42,
  });
  eq("IDENTIFIER_EXACT: numeric invoice form", rankCandidate(inv, ["42"], 42), "IDENTIFIER_EXACT");
  eq("EXACT outranks identifier when query equals the formatted title", rankCandidate(inv, ["inv-0042"], null), "EXACT");
  eq("no match → null", rankCandidate(candidate({ titleNorm: "zzz" }), ["ali"], null), null);
  const multi = candidate({ titleNorm: "ali", secondaryNorms: ["ali@x.com"] });
  eq("best reason wins (EXACT over SECONDARY)", rankCandidate(multi, ["ali"], null), "EXACT");
}

/* ------------------------------ tie-breaking ------------------------------ */
console.log("deterministic tie-breaks");
{
  const mk = (id: string, createdAt: string, titleNorm = "ali"): SearchCandidate =>
    candidate({ id, createdAt: new Date(createdAt), titleNorm });
  const a = mk("a", "2026-01-02T00:00:00Z");
  const b = mk("b", "2026-01-01T00:00:00Z");
  const ranked = [
    { candidate: b, score: RANK_WEIGHTS.EXACT },
    { candidate: a, score: RANK_WEIGHTS.EXACT },
  ];
  ranked.sort(compareRanked);
  eq("same score → createdAt desc", ranked[0].candidate.id, "a");
  const c1 = mk("b2", "2026-01-01T00:00:00Z");
  const c2 = mk("a2", "2026-01-01T00:00:00Z");
  const ranked2 = [
    { candidate: c1, score: RANK_WEIGHTS.EXACT },
    { candidate: c2, score: RANK_WEIGHTS.EXACT },
  ];
  ranked2.sort(compareRanked);
  eq("same score+date → id asc", ranked2[0].candidate.id, "a2");
}

/* ------------------------------ dedupe ------------------------------------ */
console.log("dedupeCandidates");
{
  const dupes = [
    candidate({ id: "x", titleNorm: "ali" }),
    candidate({ id: "x", titleNorm: "ali" }),
    candidate({ id: "y", type: "PRODUCT", title: "P", titleNorm: "p" }),
  ];
  eq("same type+id appears once", dedupeCandidates(dupes).length, 2);
  eq("different type same id both kept", dedupeCandidates([
    candidate({ id: "x" }),
    candidate({ id: "x", type: "SALE", title: "INV", titleNorm: "inv" }),
  ]).length, 2);
}

/* ------------------------------ grouping ---------------------------------- */
console.log("groupResults");
{
  const toItems = (candidates: SearchCandidate[]): SearchResultItem[] =>
    candidates.map((c) => ({
      id: c.id,
      type: c.type,
      title: c.title,
      subtitle: c.subtitle,
      destination: ENTITY_DESTINATION[c.type],
      status: c.status,
      date: c.date,
      direction: c.direction,
      method: c.method,
    }));
  const items = toItems([
    candidate({ id: "s1", type: "SALE", title: "INV-0001", titleNorm: "inv-0001" }),
    candidate({ id: "c1", titleNorm: "ali" }),
    candidate({ id: "c2", titleNorm: "alice2" }),
  ]);
  const groups = groupResults(items);
  eq("non-empty groups only", groups.map((g) => g.type), ["CUSTOMER", "SALE"]);
  eq("canonical order CUSTOMER before SALE", groups[0].type, "CUSTOMER");
  eq("group count matches items", groups[0].count, 2);
  eq("group items carry closed destinations", groups[1].items[0].destination, "sales");
}

/* --------------------------- DTO data minimization ------------------------ */
console.log("DTO mappers");
{
  const sale = saleCandidate({
    id: "s9",
    number: 42,
    status: "PARTIAL",
    issueDate: new Date("2026-01-05T00:00:00Z"),
    note: "priority",
    createdAt: new Date("2026-01-05T00:00:00Z"),
    customer: { name: "Alice" },
  });
  eq("sale title uses existing formatter", sale.title, "INV-0042");
  eq("sale subtitle = customer name", sale.subtitle, "Alice");
  eq("sale status token", sale.status, "PARTIAL");
  const cust = customerCandidate({ id: "c9", name: "Ali", phone: "+49123", email: null, createdAt: new Date() });
  eq("customer subtitle prefers phone", cust.subtitle, "+49123");
  const prod = productCandidate({ id: "p9", name: "iPhone", sku: "IP15", isActive: false, createdAt: new Date() });
  eq("inactive ≠ deleted → searchable INACTIVE", prod.status, "INACTIVE");
  const raw = JSON.stringify([sale, cust, prod]);
  ok("no amounts/prices in candidates", !raw.includes("Minor"));
}

console.log(`\nPrompt 33 unit harness: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
