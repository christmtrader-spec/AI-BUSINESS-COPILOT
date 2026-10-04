#!/usr/bin/env node
/**
 * Prompt 39 — statement STATIC SCAN (§199). Dependency-free source scan of
 * the statement domain (lib + API routes + UI + docs). 25 rules; every rule
 * must pass → exit 0.
 *
 * Run: node scripts/statement-static-scan.mjs
 */
import { readFileSync, existsSync } from "node:fs";

const results = [];
let passedCount = 0;

function record(name, ok, info = "") {
  results.push({ name, ok });
  if (ok) passedCount += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && info ? ` — ${info}` : ""}`);
}

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function lineOf(src, needle) {
  const idx = src.indexOf(needle);
  if (idx === -1) return -1;
  return src.slice(0, idx).split("\n").length;
}

const LIB = "src/lib/statements";
const FILES = {
  types: `${LIB}/types.ts`,
  schema: `${LIB}/schema.ts`,
  cursor: `${LIB}/cursor.ts`,
  events: `${LIB}/events.ts`,
  formatting: `${LIB}/formatting.ts`,
  engine: `${LIB}/engine.ts`,
  dto: `${LIB}/dto.ts`,
  export: `${LIB}/export.ts`,
  index: `${LIB}/index.ts`,
  routeC: "src/app/api/v1/customers/[id]/statement/route.ts",
  routeS: "src/app/api/v1/suppliers/[id]/statement/route.ts",
  routeCE: "src/app/api/v1/customers/[id]/statement/export/route.ts",
  routeSE: "src/app/api/v1/suppliers/[id]/statement/export/route.ts",
  view: "src/modules/statements/statements-view.tsx",
  viewApi: "src/modules/statements/statements-api.ts",
  store: "src/store/app-store.ts",
  docProduct: "docs/product/party-statements.md",
  docSecurity: "docs/security/party-statements-security.md",
  docAdr: "docs/adr/0039-party-statements.md",
};

const src = {};
for (const [key, path] of Object.entries(FILES)) src[key] = read(path);

function libSource() {
  return Object.entries(FILES)
    .filter(([k]) => ["types", "schema", "cursor", "events", "formatting", "engine", "dto", "export", "index"].includes(k))
    .map(([k]) => src[k] ?? "")
    .join("\n");
}
function routeSource() {
  return [src.routeC, src.routeS, src.routeCE, src.routeSE].join("\n");
}
function statementUiSource() {
  return `${src.view ?? ""}\n${src.viewApi ?? ""}`;
}

// §1 — businessId required
console.log("[rule 1 businessId required]");
record("1a. engine scopes every aggregate with the server businessId", (src.engine ?? "").includes("businessId: req.businessId") && ((src.engine ?? "").match(/businessId: req\.businessId/g) || []).length >= 6);
record("1b. statement routes scope via getAuthContext businessId", ((src.routeC ?? "").includes("ctx.businessId")) && ((src.routeS ?? "").includes("ctx.businessId")));

// §2 — no client business scope
console.log("[rule 2 no client business scope]");
record("2a. routes never read businessId from the query string", !routeSource().includes('searchParams.get("businessId")'));
record("2b. view never sends businessId in the statement query string", !statementUiSource().includes("businessId="));

// §3 — party ID tenant checked
console.log("[rule 3 party id tenant checked]");
record("3a. party load is businessId+deletedAt scoped", (src.engine ?? "").includes("{ id: partyId, businessId, deletedAt: null }"));

// §4 — deleted records excluded
console.log("[rule 4 deleted records excluded]");
record("4a. engine aggregates exclude soft-deleted sources", ((src.engine ?? "").match(/deletedAt: null/g) || []).length >= 8);
record("4b. page-source where-builders exclude soft-deleted", (src.events ?? "").includes("deletedAt: null"));

// §5 — explicit select
console.log("[rule 5 explicit select]");
record("5a. every source page query uses an explicit select", ["select: customerSaleSelect", "select: customerPaymentSelect", "select: supplierExpenseSelect", "select: supplierPaymentSelect"].every((needle) => (src.engine ?? "").includes(needle)));

// §6 — bounded source query
console.log("[rule 6 bounded source query]");
record("6a. source take derives from limit (take bound present)", (src.engine ?? "").includes("statementSourceTake(req.limit)") && (src.engine ?? "").includes("take,"));

// §7 — no full table loading
console.log("[rule 7 no full table loading]");
{
  const engine = src.engine ?? "";
  const occurrences = engine.split("findMany(").length - 1;
  let allBounded = occurrences > 0;
  let cursorIdx = 0;
  for (let i = 0; i < occurrences; i++) {
    const at = engine.indexOf("findMany(", cursorIdx);
    const window = engine.slice(at, at + 500);
    if (!window.includes("take")) allBounded = false;
    cursorIdx = at + 1;
  }
  record("7a. EVERY findMany in the engine carries a take bound", allBounded, `${occurrences} findMany calls found`);
  record("7b. no findFirst/first-or-throw loads without a select", !(engine.includes("findFirst({") && !(engine.includes("select: { id: true, name: true }"))));
}

// §8 — no raw financial object response
console.log("[rule 8 no raw financial object response]");
record("8a. statement routes go through the DTO mapper", (src.routeC ?? "").includes("toStatementResponse") && (src.routeS ?? "").includes("toStatementResponse"));
record("8b. routes contain no direct DB access (engine is the only DB layer)", !/db\.(sale|expense|payment|customer|supplier)/.test(routeSource()));

// §9 — no float money math
console.log("[rule 9 no float money math]");
record("9a. no toFixed/parseFloat/multiplication floats in the statement lib", !/toFixed\(|parseFloat\(|\*\s*0\.\d/.test(libSource()));
record("9b. CSV money uses exact integer string math (formatMinorToDecimal)", (src.formatting ?? "").includes("formatMinorToDecimal"));

// §10 — no arbitrary statement type
console.log("[rule 10 no arbitrary statement type]");
record("10a. hash parsing validates the closed type vocabulary", (src.store ?? "").includes("isStatementTypeToken(type)"));
record("10b. statement API path is built from the closed token ternary (no interpolated type URLs)", statementUiSource().includes('statementType === "customer"') && !statementUiSource().includes("${statementType}/") && !statementUiSource().includes("?type="));

// §11 — no arbitrary cursor object
console.log("[rule 11 no arbitrary cursor object]");
record("11a. cursor is HMAC-signed + constant-time compared", (src.cursor ?? "").includes("createHmac") && (src.cursor ?? "").includes("timingSafeEqual"));
record("11b. engine decodes cursors only via decodeStatementCursor", !(src.engine ?? "").includes("JSON.parse("));
record("11c. no JWT library usage for cursors", !/(from|require)\s+["'][^"']*jwt|jwt\.sign\(|jwt\.verify\(/i.test(src.cursor ?? ""));

// §12 — no arbitrary SQL
console.log("[rule 12 no arbitrary SQL]");
record("12a. no raw SQL in the statement lib", !libSource().includes("$queryRaw") && !libSource().includes("$executeRaw"));

// §13 — no unsafe filename
console.log("[rule 13 no unsafe filename]");
record("13a. filename = type + calendar range only (never the party name)", (src.export ?? "").includes("-statement-${req.from}_${req.to}.csv") && !(src.export ?? "").includes("party.name"));

// §14 — no sensitive logging
console.log("[rule 14 no sensitive logging]");
record("14a. no console logging in lib/routes", !/console\.(log|info|debug|error|warn)/.test(libSource() + routeSource()));

// §15 — no platform model references
console.log("[rule 15 no platform model references]");
record("15a. no subscription/checkout/platform-audit references", !/Subscription|CheckoutSession|PaymentTransaction|PlatformAuditLog/i.test(libSource()));

// §16 — no AI cost model references
console.log("[rule 16 no AI cost model references]");
record("16a. no AI cost references", !/AiCost/i.test(libSource()));

// §17 — no audit payload exposure
console.log("[rule 17 no audit payload exposure]");
record("17a. no AuditLog before/after JSON exposure", !libSource().includes("beforeJson") && !libSource().includes("afterJson"));

// §18 — no notification model exposure
console.log("[rule 18 no notification model exposure]");
record("18a. no notification references", !/notification/i.test(libSource()));

// §19 — export uses the same statement engine
console.log("[rule 19 export uses the same statement engine]");
record("19a. CSV export builds through buildStatement (single source, §132/§133)", (src.export ?? "").includes('from "./engine"') && (src.export ?? "").includes("buildStatement("));

// §20 — running balance server computed
console.log("[rule 20 running balance server computed]");
record("20a. engine applies the running balance server-side", (src.engine ?? "").includes("applyRunningBalance("));
record("20b. view never computes a balance itself", !statementUiSource().includes("movementMinor +") && !statementUiSource().includes("reduce("));

// §21 — payment target party relation validated
console.log("[rule 21 payment target party relation validated]");
record("21a. customer payments filtered through the sale target", (src.events ?? "").includes("sale: { customerId, deletedAt: null }"));
record("21b. supplier payments filtered through the expense target", (src.events ?? "").includes("expense: { supplierId, deletedAt: null }"));

// §22 — no name-based party identity
console.log("[rule 22 no name-based party identity]");
record("22a. cursor carries no name field", !(src.cursor ?? "").includes("name:"));
record("22b. no query scopes a party by name", !/(customer|supplier)\.findFirst\(\{[^}]*where:\s*\{\s*name/.test(libSource()));

// §23 — no statement persistence
console.log("[rule 23 no statement persistence]");
record("23a. no create/upsert/updateMany/delete writes in the statement lib", !/\.create\(|\.createMany\(|\.upsert\(|\.updateMany\(|\.delete\(/.test(libSource()));

// §24 — no balance cache
console.log("[rule 24 no balance cache]");
record("24a. no statement balance snapshot/cache model or redis", !/StatementSnapshot|StatementBalance|balanceCache|redis/i.test(libSource() + statementUiSource()));

// §25 — no double-entry claims in product docs
console.log("[rule 25 no double-entry claims in product docs]");
{
  const product = src.docProduct ?? "";
  const adr = src.docAdr ?? "";
  const security = src.docSecurity ?? "";
  record("25a. product doc exists", existsSync(FILES.docProduct));
  record("25b. ADR exists", existsSync(FILES.docAdr));
  record("25c. security doc exists", existsSync(FILES.docSecurity));
  const forbidden = ["full accounting", "is a general ledger", "double-entry accounting system", "formal balance sheet", "accounting-grade P&L", "دفتر کل"];
  const clean = [...forbidden].every((phrase) => !product.includes(phrase) && !adr.includes(phrase) && !security.includes(phrase));
  record("25d. docs make NO general-ledger/accounting claims (§278)", clean, forbidden.filter((p) => product.includes(p) || adr.includes(p) || security.includes(p)).join(" | "));
  record("25e. docs state the derived-view law", product.includes("derived") && adr.includes("derived"));
}

// ---------------------------------------------------------------------------
const total = results.length;
console.log(`\nSTATEMENT STATIC SCAN: ${passedCount}/${total} ${passedCount === total ? "PASS" : "FAIL"}`);
if (passedCount !== total) {
  console.error("FAILED RULES:");
  for (const r of results) if (!r.ok) console.error("  - " + r.name);
  process.exit(1);
}
console.log("STATIC SCAN GREEN ✓");
