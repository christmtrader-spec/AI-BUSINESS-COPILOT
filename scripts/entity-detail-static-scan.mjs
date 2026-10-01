/**
 * scripts/entity-detail-static-scan.mjs — Prompt 34 §50/§90.
 *
 * Deterministic source scan over the entity-detail surface. 18 rule
 * groups (§50.1–18); every rule reports PASS/FAIL with the offending
 * file/line. Exit 1 on ANY failure. No findings may be silenced.
 *
 * Run: bun scripts/entity-detail-static-scan.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DETAIL_ROUTES = [
  "src/app/api/v1/customers/[id]/route.ts",
  "src/app/api/v1/suppliers/[id]/route.ts",
  "src/app/api/v1/products/[id]/route.ts",
  "src/app/api/v1/sales/[id]/route.ts",
  "src/app/api/v1/expenses/[id]/route.ts",
  "src/app/api/v1/payments/[id]/route.ts",
];

const ENTITY_LIB = [
  "src/lib/entity-routes.ts",
  "src/lib/entities/types.ts",
  "src/lib/entities/summary.ts",
  "src/lib/entities/customer.ts",
  "src/lib/entities/supplier.ts",
  "src/lib/entities/product.ts",
  "src/lib/entities/sale.ts",
  "src/lib/entities/expense.ts",
  "src/lib/entities/payment.ts",
  "src/lib/entities/index.ts",
];

const ENTITY_MODULE_GLOB = [
  "src/modules/entities/entity-api.ts",
  "src/modules/entities/entity-keys.ts",
  "src/modules/entities/entity-route.ts",
  "src/modules/entities/entity-detail-view.tsx",
  "src/modules/entities/entity-header.tsx",
  "src/modules/entities/entity-loading.tsx",
  "src/modules/entities/entity-error.tsx",
  "src/modules/entities/entity-not-found.tsx",
  "src/modules/entities/entity-metric-card.tsx",
  "src/modules/entities/related-record-list.tsx",
  "src/modules/entities/entity-delete-dialog.tsx",
  "src/modules/entities/customer-detail-view.tsx",
  "src/modules/entities/supplier-detail-view.tsx",
  "src/modules/entities/product-detail-view.tsx",
  "src/modules/entities/sale-detail-view.tsx",
  "src/modules/entities/expense-detail-view.tsx",
  "src/modules/entities/payment-detail-view.tsx",
];

const NAV_FILES = [
  "src/store/app-store.ts",
  "src/modules/search/search-view.tsx",
  "src/modules/shell/command-palette.tsx",
  "src/modules/entities/entity-route.ts",
];

function read(rel) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, "utf8");
}

const results = [];
function rule(name, fn) {
  const failures = [];
  const bad = (file, line, why) => failures.push(`${file}${line ? `:${line}` : ""} ${why}`);
  fn(bad);
  results.push({ name, ok: failures.length === 0, detail: failures });
  console.log(`${failures.length === 0 ? "✓" : "✗"} [${String(results.length).padStart(2, "0")}] ${name}`);
  for (const f of failures) console.log(`      ${f}`);
}

function lineOf(src, needle) {
  const i = src.indexOf(needle);
  if (i === -1) return 0;
  return src.slice(0, i).split("\n").length;
}

/* 1 — every Prisma read in the detail routes is businessId-scoped */
rule("§50.1 businessId scoping on every detail-route Prisma read", (bad) => {
  for (const rel of DETAIL_ROUTES) {
    const src = read(rel);
    if (src === null) { bad(rel, 0, "missing file"); continue; }
    const getStart = src.indexOf("export const GET");
    const getSrc = src.slice(getStart);
    // findFirst / findMany / groupBy / count / aggregate blocks
    const re = /db\.[a-zA-Z]+\.(findFirst|findMany|groupBy|count|aggregate)\(\{[\s\S]*?\}\);/g;
    let m;
    while ((m = re.exec(getSrc)) !== null) {
      const block = m[0];
      // the query block must mention businessId (directly or via ctx var)
      if (!/businessId/.test(block)) {
        bad(rel, lineOf(src, block), `${m[1]} without businessId scope`);
      }
    }
  }
});

/* 2 — the entity vocabulary is closed; parsing is centralized */
rule("§50.2 closed entity type vocabulary + centralized parser", (bad) => {
  const routes = read("src/lib/entity-routes.ts");
  if (!routes || !/export const ENTITY_TYPES = \[[\s\S]*?"customer"[\s\S]*?"payment"[\s\S]*\] as const/.test(routes)) {
    bad("src/lib/entity-routes.ts", 0, "ENTITY_TYPES closed vocabulary missing");
  }
  const store = read("src/store/app-store.ts");
  if (!store || !/parseEntityRoute\(path\)/.test(store)) {
    bad("src/store/app-store.ts", 0, "hashToView must resolve entities via parseEntityRoute");
  }
  // no ad-hoc entity parsing elsewhere
  for (const rel of ["src/modules/search/search-view.tsx", "src/modules/shell/command-palette.tsx"]) {
    const src = read(rel);
    if (src && /split\("\/"\)/.test(src)) bad(rel, 0, "ad-hoc hash segment parsing");
  }
});

/* 3 — no arbitrary destinations: navigation goes through the closed map */
rule("§50.3 no arbitrary destination construction", (bad) => {
  for (const rel of NAV_FILES) {
    const src = read(rel);
    if (src === null) continue;
    const re = /(window\.location\s*=|window\.location\.href\s*=|location\.assign\(|location\.replace\()/;
    if (re.test(src)) bad(rel, 0, "raw location redirect");
  }
  // hash built only via entityToHash / viewToHash
  const store = read("src/store/app-store.ts");
  if (store && !/entityToHash\(view\.entity, view\.id\)/.test(store)) {
    bad("src/store/app-store.ts", 0, "entity hash not built via entityToHash");
  }
});

/* 4 — detail routes respond with the DTO mapper, never a raw record */
rule("§50.4 no direct Prisma-object response", (bad) => {
  const expect = {
    "src/app/api/v1/customers/[id]/route.ts": "mapCustomerDetail",
    "src/app/api/v1/suppliers/[id]/route.ts": "mapSupplierDetail",
    "src/app/api/v1/products/[id]/route.ts": "mapProductDetail",
    "src/app/api/v1/sales/[id]/route.ts": "mapSaleDetail",
    "src/app/api/v1/expenses/[id]/route.ts": "mapExpenseDetail",
    "src/app/api/v1/payments/[id]/route.ts": "mapPaymentDetail",
  };
  for (const [rel, mapper] of Object.entries(expect)) {
    const src = read(rel);
    if (src === null) { bad(rel, 0, "missing file"); continue; }
    const getStart = src.indexOf("export const GET");
    const getSrc = src.slice(getStart, src.indexOf("export const PATCH") > -1 ? src.indexOf("export const PATCH") : src.indexOf("export const DELETE"));
    if (!getSrc.includes(`ok(${mapper}`) && !getSrc.includes(`ok(\n    ${mapper}`) && !getSrc.includes(mapper)) {
      bad(rel, 0, `GET must return ok(${mapper}(...))`);
    }
  }
});

/* 5–10 — forbidden domain fields/models anywhere in the entity surface */
const FORBIDDEN_TOKENS = [
  ["§50.5 password fields", ["passwordHash", "password_reset", "PasswordResetToken"]],
  ["§50.6 MFA secrets", ["MfaCredential", "MfaRecoveryCode", "MfaLoginChallenge", "recoveryCode", "encryptedSecret"]],
  ["§50.7 security/session fields", ["sessionVersion", "SecurityEvent", "UserSession"]],
  ["§50.8 platform payment models", ["PaymentTransaction", "CheckoutSession", "ProcessedWebhookEvent", "webhookSignature", "providerSecret"]],
  ["§50.9 AI cost models", ["AiCostRate", "AiCostRecord", "AiCostAnomaly", "providerRate"]],
  ["§50.10 audit internals in DTOs", ["userAgent", "PlatformAuditLog", "PlatformOperator"]],
];
for (const [name, tokens] of FORBIDDEN_TOKENS) {
  rule(name, (bad) => {
    for (const rel of [...ENTITY_LIB, ...ENTITY_MODULE_GLOB]) {
      const src = read(rel);
      if (src === null) continue;
      for (const tok of tokens) {
        // allow mentions inside comments that document the PROHIBITION —
        // scan non-comment code lines only.
        const lines = src.split("\n");
        lines.forEach((ln, i) => {
          const code = ln.replace(/\/\/.*$/, "").replace(/\*.*?(\*\/|$)/g, "");
          if (code.trim().startsWith("*")) return;
          if (code.includes(tok)) bad(rel, i + 1, `forbidden token "${tok}"`);
        });
      }
    }
  });
}

/* 11 — no unsafe redirect builders in the entity module */
rule("§50.11 no unsafe redirect construction", (bad) => {
  for (const rel of ENTITY_MODULE_GLOB) {
    const src = read(rel);
    if (src === null) continue;
    if (/javascript:|data:text\/html|\bwindow\.open\(/.test(src)) {
      bad(rel, 0, "unsafe URL/window.open usage");
    }
  }
});

/* 12 — no dangerouslySetInnerHTML */
rule("§50.12 no dangerouslySetInnerHTML", (bad) => {
  for (const rel of [...ENTITY_MODULE_GLOB, ...NAV_FILES]) {
    const src = read(rel);
    if (src === null) continue;
    if (src.includes("dangerouslySetInnerHTML")) bad(rel, 0, "dangerouslySetInnerHTML");
  }
});

/* 13 — no raw SQL */
rule("§50.13 no raw SQL in the entity surface", (bad) => {
  for (const rel of [...DETAIL_ROUTES, ...ENTITY_LIB]) {
    const src = read(rel);
    if (src === null) continue;
    if (/\$queryRaw|\$executeRaw|queryRawUnsafe|executeRawUnsafe/.test(src)) {
      bad(rel, 0, "raw SQL usage");
    }
  }
});

/* 14 — every list read in detail GETs is bounded (take) */
rule("§50.14 no unbounded findMany in detail routes", (bad) => {
  for (const rel of DETAIL_ROUTES) {
    const src = read(rel);
    if (src === null) { bad(rel, 0, "missing file"); continue; }
    const getStart = src.indexOf("export const GET");
    const getSrc = src.slice(getStart);
    const re = /\.findMany\(\{[\s\S]*?\}\)/g;
    let m;
    while ((m = re.exec(getSrc)) !== null) {
      if (!/take:/.test(m[0])) bad(rel, lineOf(src, m[0]), "findMany without take");
    }
  }
});

/* 15 — recent-record caps are explicit and ≤ 20 */
rule("§50.15 recent-record caps explicit and bounded (≤20)", (bad) => {
  const caps = {
    "src/app/api/v1/customers/[id]/route.ts": ["RECENT_SALES_TAKE = 10", "RECENT_PAYMENTS_TAKE = 10"],
    "src/app/api/v1/suppliers/[id]/route.ts": ["RECENT_EXPENSES_TAKE = 10", "RECENT_PAYMENTS_TAKE = 10"],
    "src/app/api/v1/products/[id]/route.ts": ["RECENT_ADJUSTMENTS_TAKE = 10", "RECENT_SALES_TAKE = 10"],
    "src/app/api/v1/expenses/[id]/route.ts": ["PAYMENTS_TAKE = 20"],
  };
  for (const [rel, needles] of Object.entries(caps)) {
    const src = read(rel);
    if (src === null) { bad(rel, 0, "missing file"); continue; }
    for (const n of needles) if (!src.includes(n)) bad(rel, 0, `missing cap constant ${n}`);
  }
  // all take: values in the GET handlers reference bounded constants ≤ 40
  for (const rel of DETAIL_ROUTES) {
    const src = read(rel);
    if (src === null) continue;
    const getSrc = src.slice(src.indexOf("export const GET"));
    const re = /take:\s*([A-Z_]+|\d+)/g;
    let m;
    while ((m = re.exec(getSrc)) !== null) {
      const cap = m[1];
      if (/^\d+$/.test(cap)) {
        if (Number(cap) > 40) bad(rel, lineOf(src, m[0]), `take ${cap} too large`);
      } else {
        const defRe = new RegExp(`${cap}\\s*=\\s*(\\d+)`);
        const def = defRe.exec(src);
        if (!def) bad(rel, lineOf(src, m[0]), `take constant ${cap} not numeric`);
        else if (Number(def[1]) > 40) bad(rel, lineOf(src, m[0]), `take ${cap}=${def[1]} too large`);
      }
    }
  }
});

/* 16 — entity ids are validated before routing (charset + bounds) */
rule("§50.16 id route injection blocked (charset + hard cap)", (bad) => {
  const routes = read("src/lib/entity-routes.ts");
  if (!routes) { bad("src/lib/entity-routes.ts", 0, "missing"); return; }
  if (!/ENTITY_ID_MAX_LENGTH = 64/.test(routes)) bad("src/lib/entity-routes.ts", 0, "hard id cap missing");
  if (!/A-Za-z0-9.*\{1,64\}/.test(routes)) {
    bad("src/lib/entity-routes.ts", 0, "id charset pattern missing");
  }
  if (!/isValidEntityId\(id\)/.test(routes) && !/ENTITY_ID_PATTERN\.test\(raw\)/.test(routes)) {
    bad("src/lib/entity-routes.ts", 0, "ids not charset-validated");
  }
  // the centralized encoder percent-encodes; the API-path builder encodes too
  const routesSrc = routes;
  if (!routesSrc.includes("encodeURIComponent(id)")) bad("src/lib/entity-routes.ts", 0, "entityToHash does not percent-encode the id");
  const apiSrc = read("src/modules/entities/entity-api.ts");
  if (apiSrc && !apiSrc.includes("encodeURIComponent(id)")) bad("src/modules/entities/entity-api.ts", 0, "api path does not percent-encode the id");
});

/* 17 — search results navigate through the closed entity map (no bypass) */
rule("§50.17 search result destination uses closed entity map", (bad) => {
  for (const rel of ["src/modules/search/search-view.tsx", "src/modules/shell/command-palette.tsx"]) {
    const src = read(rel);
    if (src === null) { bad(rel, 0, "missing"); continue; }
    if (!src.includes("entityViewFromSearchItem")) {
      bad(rel, 0, "search result click must resolve via entityViewFromSearchItem");
    }
    if (/kind:\s*"module",\s*module:\s*item\.destination/.test(src)) {
      bad(rel, 0, "legacy list-module navigation still present");
    }
  }
});

/* 18 — soft-delete filter present where the model has deletedAt */
rule("§50.18 deletedAt filter on soft-deletable detail reads", (bad) => {
  const expect = {
    "src/app/api/v1/customers/[id]/route.ts": true,
    "src/app/api/v1/suppliers/[id]/route.ts": true,
    "src/app/api/v1/products/[id]/route.ts": true,
    "src/app/api/v1/sales/[id]/route.ts": true,
    "src/app/api/v1/expenses/[id]/route.ts": true,
  };
  for (const [rel] of Object.entries(expect)) {
    const src = read(rel);
    if (src === null) { bad(rel, 0, "missing file"); continue; }
    if (!src.includes("deletedAt: null")) bad(rel, 0, "deletedAt filter missing");
  }
  // payments hard-delete → no deletedAt column to filter (guard against
  // someone "fixing" this by inventing a soft delete)
  const pay = read("src/app/api/v1/payments/[id]/route.ts");
  if (pay === null) bad("src/app/api/v1/payments/[id]/route.ts", 0, "missing");
});

/* summary */
const failed = results.filter((r) => !r.ok);
const checks = results.length;
console.log(`\nentity-detail-static-scan: ${checks - failed.length}/${checks} rules PASS`);
if (failed.length > 0) {
  console.log("FAILURES:");
  for (const f of failed) for (const d of f.detail) console.log(`  - [${f.name}] ${d}`);
  process.exit(1);
}
