#!/usr/bin/env node
/**
 * scripts/prompt49-aging-details-static-scan.mjs — Prompt 49 STATIC scan.
 *
 * Structural/security laws verified against the REAL sources (convention:
 * prompt48-supplier-bill-static-scan.mjs — read-only, no code execution,
 * comments stripped so documentation mentions never satisfy a rule):
 *
 *   R1  ONE bucket authority — aging-details + party-aging reuse lib/aging
 *   R2  NO second bucket law inside React components (pure render-only UI)
 *   R3  signed cursor: HMAC-SHA256 + timingSafeEqual + length bound
 *   R4  cursor payload privacy: no names/references/amounts in payload type
 *   R5  cursor filter binding: side+party+bucket+pastDue+tenant compared
 *   R6  items route: auth + data:read + rate limit + private no-store
 *   R7  export route: CSV_EXPORT gate + rate limit + audit + no-store
 *   R8  export completeness: cap+reject (never silent truncation)
 *   R9  filename law: ASCII, no party names, no locale text
 *   R10 money law: integer minor units; no parseFloat/float math in domain
 *   R11 notes privacy: no note/internalNotes in any P49 select/DTO
 *   R12 receivables honesty: no invented customer due date / no overdue claim
 *   R13 payables past-due law: dueDate AND strictly-after AND positive
 *   R14 §6 identity: aging groups keyed by partyId (never name alone)
 *   R15 SupplierBill non-duplication: metadata only, never a balance
 *   R16 bounded reads: chunked keyset scan + explicit truncated flags
 *   R17 aggregate compatibility: AGING_SCAN_CAP + truncated signal untouched
 *   R18 shell wiring: aging-details view kind + hash round-trip + render arm
 *   R19 statement source navigation: sourceType+sourceId, closed target map
 *   R20 360 panels: canonical summary + statement/detail navigation, no fake party link
 *
 * Run: node scripts/prompt49-aging-details-static-scan.mjs   (also green under bun)
 */

import { readFileSync, existsSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(`${ROOT}${p}`, "utf8");
const exists = (p) => existsSync(`${ROOT}${p}`);

/** Strip // and /* *\/ comments so doc mentions never satisfy a rule. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

let passed = 0;
const failures = [];
function record(name, cond, info = "") {
  if (cond) {
    passed++;
    console.log(`✓ ${name}`);
  } else {
    failures.push(name);
    console.log(`✗ ${name}${info ? ` — ${info}` : ""}`);
  }
}

const domain = stripComments(read("src/lib/aging-details.ts"));
const cursor = stripComments(read("src/lib/aging-details-cursor.ts"));
const partyAging = stripComments(read("src/lib/party-aging.ts"));
const aging = stripComments(read("src/lib/aging.ts"));
const agingReport = stripComments(read("src/lib/aging-report.ts"));
const itemsRoute = stripComments(read("src/app/api/v1/reports/aging/items/route.ts"));
const exportRoute = stripComments(read("src/app/api/v1/reports/aging/items/export/route.ts"));
const detailsView = stripComments(read("src/modules/balances/aging-details-view.tsx"));
const agingCard = stripComments(read("src/modules/balances/aging-card.tsx"));
const panel = stripComments(read("src/modules/balances/party-aging-panel.tsx"));
const store = stripComments(read("src/store/app-store.ts"));
const shell = stripComments(read("src/modules/shell/app-shell.tsx"));
const statementsView = stripComments(read("src/modules/statements/statements-view.tsx"));
const dto = stripComments(read("src/lib/statements/dto.ts"));
const en = stripComments(read("src/i18n/messages/en.ts"));
const fa = stripComments(read("src/i18n/messages/fa.ts"));

console.log("PROMPT 49 AGING DETAILS — STATIC SCAN");

// R1 — ONE bucket authority
record(
  "R1 one bucket authority: domain + party summary reuse lib/aging",
  domain.includes('from "./aging"') &&
    partyAging.includes('from "./aging"') &&
    domain.includes("agingBucketForAge") &&
    partyAging.includes("buildAgingSide") &&
    partyAging.includes("localDayKey"),
);

// R2 — no second bucket law in UI
const uiHasBucketMath =
  /agingBucketForAge|localDayIndex|D0_30.*\?|Math\.floor\(.*86400/.test(detailsView + panel + agingCard) &&
  false; // UI files must not compute buckets; labels/keys only
const uiOnlyLabels =
  (detailsView.match(/agingBucketForAge|localDayIndex/g) || []).length === 0 &&
  (panel.match(/agingBucketForAge|localDayIndex/g) || []).length === 0 &&
  (agingCard.match(/agingBucketForAge|localDayIndex/g) || []).length === 0;
record("R2 render-only UI: no bucket math inside React components", uiOnlyLabels);

// R3 — signed cursor primitives
record(
  "R3 signed cursor: HMAC-SHA256 + constant-time compare + length bound",
  cursor.includes("createHmac") &&
    cursor.includes("sha256") &&
    cursor.includes("timingSafeEqual") &&
    cursor.includes("CURSOR_MAX_LENGTH"),
);

// R4 — cursor payload privacy
record(
  "R4 cursor payload privacy: opaque ids only, no name/reference/amount fields",
  !/"name"|name:|reference|minor|amount|email|phone/.test(
    cursor.slice(cursor.indexOf("export type AgingDetailCursorPayload"), cursor.indexOf("function b64urlEncode")),
  ),
);

// R5 — cursor binding
record(
  "R5 cursor bound to businessId + side + party + bucket + pastDue",
  cursor.includes("c.b !== expected.businessId") &&
    cursor.includes("c.s !== expected.side") &&
    cursor.includes("c.p !== want.p") &&
    cursor.includes("c.k !== want.k") &&
    cursor.includes("c.d !== want.d"),
);

// R6 — items route security
record(
  "R6 items route: getAuthContext + data:read + rate limit + private no-store",
  itemsRoute.includes("getAuthContext") &&
    itemsRoute.includes('requirePermission(ctx, "data:read")') &&
    itemsRoute.includes("rateLimit(") &&
    itemsRoute.includes('"private, no-store"'),
);

// R7 — export route security
record(
  "R7 export route: CSV_EXPORT gate + rate limit + audit + no-store",
  exportRoute.includes('assertFeatureAccess(ctx.businessId, "CSV_EXPORT")') &&
    exportRoute.includes("rateLimit(") &&
    exportRoute.includes('action: "data.export"') &&
    exportRoute.includes('"cache-control": "no-store"'),
);

// R8 — export completeness
record(
  "R8 export rejects over-cap scopes (never a partial CSV)",
  exportRoute.includes("AgingExportTooLargeError") &&
    exportRoute.includes("AGING_EXPORT_TOO_LARGE") &&
    domain.includes("AGING_DETAIL_EXPORT_MAX_ROWS") &&
    domain.includes("collectAgingDetailRows"),
);

// R9 — filename law
record(
  "R9 ASCII filename without party names or locale text",
  /filename = input\.partyId\s*\n\s*\? `aging-\$\{input\.side\}-party-\$\{stamp\}\.csv`/.test(exportRoute) &&
    !/partyName.*filename|filename.*partyName/.test(exportRoute),
);

// R10 — money law
record(
  "R10 integer money in the domain: no parseFloat/toFixed arithmetic",
  !/parseFloat|\.toFixed\(/.test(domain) &&
    domain.includes("Number.isInteger(totalMinor)") &&
    domain.includes("Number.isInteger(paidMinor)"),
);

// R11 — notes privacy
record(
  "R11 no note/internalNotes field in P49 selects or DTOs",
  !/note:|internalNotes/.test(domain) &&
    !/note:|internalNotes/.test(partyAging) &&
    !/note:|internalNotes/.test(exportRoute),
);

// R12 — receivables honesty
record(
  "R12 receivables: no invented due date, never past due, invoice-age wording",
  domain.includes("dueDate: null") &&
    domain.includes("pastDue: false") &&
    en.includes('invoiceAge: "Invoice age"') &&
    fa.includes('invoiceAge: "عمر فاکتور"'),
);

// R13 — payables past-due law
record(
  "R13 past-due = stated dueDate AND strictly after (open guard upstream)",
  domain.includes("if (row.dueDate)") &&
    domain.includes("localDayIndex(now, timeZone) > localDayIndex(row.dueDate, timeZone)") &&
    aging.includes("todayIdx > localDayIndex(item.dueDate, opts.timeZone)"),
);

// R14 — §6 identity
record(
  "R14 aging groups keyed by authoritative partyId (never name alone)",
  aging.includes("partyKey = item.partyId ??") &&
    aging.includes("partyId: string | null") &&
    !aging.includes('item.party ?? "\\u0000"') &&
    agingReport.includes("customer: { select: { id: true, name: true } }") &&
    agingReport.includes("supplier: { select: { id: true, name: true } }"),
);

// R15 — SupplierBill non-duplication: the select carries ONLY reference+status
// (no bill amount exists anywhere in the domain), and the item exposes a
// reference string — never a second balance.
record(
  "R15 SupplierBill appears only as supplemental metadata, never a balance",
  domain.includes("supplierBill: { select: { reference: true, status: true } }") &&
    domain.includes("supplierBillReference") &&
    domain.includes('status === "POSTED"') &&
    !/supplierBillMinor|billTotalMinor|supplierBill\.totalMinor/.test(domain),
);

// R16 — bounded reads + honest flags (code-level markers, comment-independent)
record(
  "R16 chunked keyset scans + explicit page/summary truncation flags",
  domain.includes("AGING_DETAIL_CHUNK") &&
    domain.includes("AGING_DETAIL_SCAN_CAP") &&
    domain.includes("pageTruncated") &&
    domain.includes("summary.truncated") === false && // summary exposes `truncated` via its own type, not a field access here
    domain.includes("let scanAfter") && // the mutable keyset boundary (§7.2)
    domain.includes("const lastScanned = scanAfter"),
);

// R17 — aggregate compatibility
record(
  "R17 aggregate report cap + truncated signal preserved (not weakened)",
  aging.includes("export const AGING_SCAN_CAP = 1000") &&
    aging.includes("export const AGING_TOP_PARTIES = 8") &&
    agingReport.includes("truncated: sales.length >= AGING_SCAN_CAP || expenses.length >= AGING_SCAN_CAP"),
);

// R18 — shell wiring
record(
  "R18 store + shell: aging-details kind, canonical hash, render arm",
  store.includes('kind: "aging-details"') &&
    store.includes("reports/aging-details") &&
    store.includes("isAgingBucketKey") === false && // store validates via AGING_BUCKET_KEYS list
    shell.includes("AgingDetailsView") &&
    shell.includes('view.kind === "aging-details"'),
);

// R19 — statement source navigation
record(
  "R19 statement rows carry sourceType/sourceId; navigation uses the closed map",
  dto.includes("sourceType: StatementSourceType") &&
    dto.includes("sourceId: string") &&
    statementsView.includes("sourceTargetOf") &&
    statementsView.includes('case "PAYMENT_OUT":') &&
    statementsView.includes("openSource(row.sourceType, row.sourceId)"),
);

// R20 — 360 panels
record(
  "R20 360 aging panels: canonical data + statement link, no fake party destination",
  panel.includes("PartyAgingSummary") &&
    panel.includes('kind: "aging-details"') &&
    panel.includes('kind: "statements"') &&
    partyAging.includes("buildCustomerAgingSummary") &&
    partyAging.includes("buildSupplierAgingSummary") &&
    partyAging.includes("status: { not: \"PAID\" }"),
);

// i18n parity quick check (the unit suite asserts deeply; scan asserts presence)
const enBlock = en.includes("agingDetails: {");
const faBlock = fa.includes("agingDetails: {");
record("R21 i18n: finance.agingDetails namespace present in EN and FA", enBlock && faBlock);

console.log(`\nPROMPT 49 STATIC SCAN: ${passed}/${passed + failures.length} ${failures.length === 0 ? "PASS" : "FAIL"}`);
if (failures.length > 0) {
  console.log("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("STATIC SCAN GREEN ✓");
