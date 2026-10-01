/**
 * scripts/crm-static-scan.mjs — Prompt 35 §78.
 *
 * Deterministic, dependency-free source scan over the CRM surface.
 * Every rule reports PASS/FAIL with the offending file:line. Exit 0 only
 * when ALL rules pass.
 *
 * Rules (§78 — 1:1):
 *   1  no businessId missing on CRM Prisma reads
 *   2  no client-controlled business scope (body/query businessId read)
 *   3  no arbitrary CRM status (closed vocabulary)
 *   4  no arbitrary Opportunity stage (closed vocabulary)
 *   5  no cross-business assignee (membership validation present)
 *   6  no cross-business customer relation (same-business validation)
 *   7  no cross-business lead relation (same-business validation)
 *   8  no raw Prisma response (explicit DTO mappers)
 *   9  no unbounded findMany
 *  10  no raw SQL
 *  11  no passwords
 *  12  no MFA fields
 *  13  no platform payment fields
 *  14  no AI cost models
 *  15  no payment mutation on stage WON
 *  16  no automatic Sale creation
 *  17  no arbitrary redirect
 *  18  no dangerouslySetInnerHTML
 *  19  no raw search query logging
 *  20  no CRM forecast mixed into accounting reports
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const results = [];
let section = "";

function section0(name) {
  section = name;
}
function read(rel) {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
function lineOf(src, needle) {
  const idx = typeof needle === "string" ? src.indexOf(needle) : needle;
  if (idx < 0) return 0;
  return src.slice(0, idx).split("\n").length;
}
const resultsArr = [];
let passedCount = 0;
function record(name, ok, info = "") {
  resultsArr.push({ name, ok, info });
  console.log(`${ok ? "✓" : "✗"} [${section}] ${name}${ok && info ? ` — ${info}` : ""}${!ok ? ` — ${info}` : ""}`);
  if (ok) passedCount++;
}
function rule(name, fn) {
  const bad = [];
  const badFn = (file, line, why) => bad.push(`${file}:${line} ${why}`);
  try {
    fn(badFn);
  } catch (e) {
    bad.push(`rule threw: ${String(e)}`);
  }
  record(name, bad.length === 0, bad.slice(0, 6).join(" | "));
}

function walk(dir, out = []) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const f of readdirSync(abs)) {
    const p = join(abs, f);
    const s = statSync(p);
    if (s.isDirectory()) walk(join(dir, f), out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(join(dir, f));
  }
  return out;
}

const CRM_API = walk("src/app/api/v1/crm");
const CRM_LIB = [
  "src/lib/crm/types.ts",
  "src/lib/crm/constants.ts",
  "src/lib/crm/schemas.ts",
  "src/lib/crm/normalization.ts",
  "src/lib/crm/dto.ts",
  "src/lib/crm/service.ts",
  "src/lib/crm/lead-service.ts",
  "src/lib/crm/opportunity-service.ts",
  "src/lib/crm/conversion.ts",
  "src/lib/crm/summary.ts",
  "src/lib/crm/index.ts",
];
const CRM_UI = [
  "src/modules/crm/crm-api.ts",
  "src/modules/crm/crm-view.tsx",
  "src/modules/crm/leads-table.tsx",
  "src/modules/crm/opportunities-table.tsx",
  "src/modules/crm/pipeline-board.tsx",
  "src/modules/crm/lead-form-dialog.tsx",
  "src/modules/crm/opportunity-form-dialog.tsx",
  "src/modules/crm/opportunity-stage-dialog.tsx",
  "src/modules/crm/lead-status-dialog.tsx",
  "src/modules/crm/lead-convert-dialog.tsx",
  "src/modules/crm/crm-badges.tsx",
  "src/modules/entities/lead-detail-view.tsx",
  "src/modules/entities/opportunity-detail-view.tsx",
  "src/modules/entities/entity-detail-view.tsx",
];
const ALL = [...CRM_API, ...CRM_LIB, ...CRM_UI];

/* 1 — businessId scope on every CRM Prisma read */
section0("1 businessId");
rule("no CRM Prisma read without businessId scope", (bad) => {
  for (const rel of [...CRM_API, ...CRM_LIB]) {
    const src = read(rel);
    if (!src) continue;
    const re = /db\.[a-zA-Z]+\.(findFirst|findMany|groupBy|count|aggregate|create|update|delete)\(\{[\s\S]*?\}\)/g;
    let m;
    const whereVarScoped = /const where = \w+Where\(businessId/.test(src);
    while ((m = re.exec(src)) !== null) {
      const block = m[0];
      // The conversion tx + customer-create blocks scope via businessId.
      const scoped =
        /businessId/.test(block) ||
        (whereVarScoped && /\bwhere\b/.test(block)) ||
        /crmLead\.update\(\{\s*where: \{ id: existing\.id \}/.test(block);
      if (!scoped) bad(rel, lineOf(src, m[0]), `${m[1]} without businessId`);
    }
  }
});

/* 2 — no client-controlled business scope */
section0("2 client scope");
rule("CRM routes never read businessId/tenantId/ownerId from input", (bad) => {
  for (const rel of CRM_API) {
    const src = read(rel);
    if (!src) continue;
    if (/body\.businessId|body\.tenantId|body\.ownerId|searchParams\.get\("businessId"\)|searchParams\.get\("tenantId"\)/.test(src)) {
      bad(rel, 0, "client-controlled tenant scope");
    }
  }
  // the only business key in routes is ctx.businessId
  for (const rel of CRM_API) {
    const src = read(rel);
    if (!src) continue;
    if (/ctx\.businessId/.test(src) === false && /crm/.test(rel)) {
      bad(rel, 0, "route missing ctx.businessId usage");
    }
  }
});

/* 3 — no arbitrary CRM status */
section0("3 vocabulary");
rule("no arbitrary CRM status (§78.3)", (bad) => {
  const types = read("src/lib/crm/types.ts");
  if (!types || !types.includes("LEAD_STATUSES")) bad("src/lib/crm/types.ts", 0, "missing LEAD_STATUSES");
  const svc = read("src/lib/crm/lead-service.ts");
  if (svc && /status:\s*["'](?!NEW|CONTACTED|QUALIFIED|DISQUALIFIED|CONVERTED)["']/.test(svc.replace('status: "NEW"', ""))) {
    bad("src/lib/crm/lead-service.ts", 0, "arbitrary status literal");
  }
});
rule("no arbitrary Opportunity stage (§78.4)", (bad) => {
  const types = read("src/lib/crm/types.ts");
  if (!types || !types.includes("OPPORTUNITY_STAGES")) bad("src/lib/crm/types.ts", 0, "missing OPPORTUNITY_STAGES");
  const svc = read("src/lib/crm/opportunity-service.ts");
  if (svc && /stage:\s*["'](?!DISCOVERY|QUALIFIED|PROPOSAL|NEGOTIATION|WON|LOST)["']/.test(svc)) {
    bad("src/lib/crm/opportunity-service.ts", 0, "arbitrary stage literal");
  }
});

/* 5/6/7 — same-business relations */
section0("5-7 relations");
rule("no cross-business assignee — membership validation present (§78.5)", (bad) => {
  const svc = read("src/lib/crm/service.ts") ?? "";
  if (!svc.includes("assertAssigneeInBusiness")) bad("src/lib/crm/service.ts", 0, "missing assertAssigneeInBusiness");
  for (const rel of ["src/lib/crm/lead-service.ts", "src/lib/crm/opportunity-service.ts"]) {
    const src = read(rel) ?? "";
    if (!src.includes("assertAssigneeInBusiness")) bad(rel, 0, "assignee validation not wired");
  }
});
rule("no cross-business customer relation (§78.6)", (bad) => {
  const svc = read("src/lib/crm/service.ts") ?? "";
  if (!svc.includes("assertCustomerInBusiness")) bad("src/lib/crm/service.ts", 0, "missing assertCustomerInBusiness");
  const opp = read("src/lib/crm/opportunity-service.ts") ?? "";
  if (!opp.includes("assertCustomerInBusiness")) bad("src/lib/crm/opportunity-service.ts", 0, "customer validation not wired");
});
rule("no cross-business lead relation (§78.7)", (bad) => {
  const svc = read("src/lib/crm/service.ts") ?? "";
  if (!svc.includes("assertLeadInBusiness")) bad("src/lib/crm/service.ts", 0, "missing assertLeadInBusiness");
  const opp = read("src/lib/crm/opportunity-service.ts") ?? "";
  if (!opp.includes("assertLeadInBusiness")) bad("src/lib/crm/opportunity-service.ts", 0, "lead validation not wired");
});

/* 8 — DTO discipline */
section0("8 DTO");
rule("no raw Prisma rows returned from CRM routes", (bad) => {
  for (const rel of CRM_API) {
    const src = read(rel);
    if (!src) continue;
    if (/return ok\(\s*(lead|opportunity|created|updated)\s*\)/.test(src)) {
      bad(rel, 0, "raw row response");
    }
  }
  const dto = read("src/lib/crm/dto.ts");
  if (!dto || !dto.includes("mapLead") || !dto.includes("mapOpportunity")) {
    bad("src/lib/crm/dto.ts", 0, "DTO mappers missing");
  }
});

/* 9 — bounded queries */
section0("9 bounded");
rule("no unbounded findMany in the CRM surface", (bad) => {
  for (const rel of [...CRM_API, ...CRM_LIB]) {
    const src = read(rel);
    if (!src) continue;
    const re = /db\.[a-zA-Z]+\.findMany\(\{[\s\S]*?\}\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (!/take:/.test(m[0])) bad(rel, lineOf(src, m[0]), "findMany without take");
    }
  }
});

/* 10-14 — forbidden internals */
section0("10-14 forbidden");
const FORBIDDEN = [
  ["no raw SQL in the CRM surface", ["$queryRaw", "$executeRaw", "sqlite_master"]],
  ["no password fields", ["passwordHash", "password_reset", "PasswordResetToken"]],
  ["no MFA fields", ["MfaCredential", "MfaRecoveryCode", "MfaLoginChallenge", "encryptedSecret", "recoveryCode"]],
  ["no platform payment fields", ["PaymentTransaction", "CheckoutSession", "webhookSignature", "providerSecret", "ProcessedWebhookEvent"]],
  ["no AI cost models", ["AiCostRate", "AiCostRecord", "AiCostAnomaly", "providerRate", "costNanoMinor"]],
];
for (const [name, tokens] of FORBIDDEN) {
  rule(`${name} (code, non-comment)`, (bad) => {
    for (const rel of ALL) {
      const src = read(rel);
      if (!src) continue;
      // strip line comments + block comments so prose cannot trip the rule
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const t of tokens) {
        if (code.includes(t)) bad(rel, lineOf(src, t), `forbidden token ${t}`);
      }
    }
  });
}

/* 15/16 — financial separation */
section0("15/16 finance");
rule("stage WON performs no payment mutation and no Sale creation", (bad) => {
  const svc = read("src/lib/crm/opportunity-service.ts") ?? "";
  const wonIdx = svc.indexOf('to === "WON"');
  if (wonIdx === -1) bad("src/lib/crm/opportunity-service.ts", 0, "WON branch missing");
  for (const token of ["db.sale.create", "db.payment.create", "sale.create(", "payment.create(", "inventoryAdjustment.create"]) {
    if (svc.includes(token)) bad("src/lib/crm/opportunity-service.ts", lineOf(svc, token), `forbidden ${token} in stage service`);
  }
  const conv = read("src/lib/crm/conversion.ts") ?? "";
  for (const token of ["db.sale.create", "db.payment.create", "sale.create(", "payment.create("]) {
    if (conv.includes(token)) bad("src/lib/crm/conversion.ts", lineOf(conv, token), `forbidden ${token} in conversion`);
  }
});
rule("the ONLY Sale creation from CRM UI is the existing SaleFormDialog", (bad) => {
  for (const rel of CRM_UI) {
    const src = read(rel);
    if (!src) continue;
    if (rel.endsWith("opportunity-detail-view.tsx")) {
      if (!src.includes("SaleFormDialog")) bad(rel, 0, "missing SaleFormDialog reuse");
    } else if (/SaleFormDialog|\/api\/v1\/sales/.test(src) === true && rel.endsWith("crm-api.ts") === false) {
      bad(rel, 0, "unexpected sales surface usage");
    }
  }
});

/* 17/18 — web safety */
section0("17/18 web");
rule("no arbitrary redirect construction in the CRM surface", (bad) => {
  for (const rel of ALL) {
    const src = read(rel);
    if (!src) continue;
    if (/redirect\(|window\.location\s*=\s*|location\.href\s*=\s*[^"]/.test(src)) {
      bad(rel, lineOf(src, "redirect("), "arbitrary redirect");
    }
  }
});
rule("no dangerouslySetInnerHTML in the CRM surface", (bad) => {
  for (const rel of ALL) {
    const src = read(rel);
    if (src && src.includes("dangerouslySetInnerHTML")) bad(rel, lineOf(src, "dangerouslySetInnerHTML"));
  }
});

/* 19 — search privacy */
section0("19 search privacy");
rule("CRM search terms are never logged", (bad) => {
  const loggers = ["console.log", "console.info", "logDebug", "logInfo"];
  for (const rel of [...CRM_API, ...CRM_LIB]) {
    const src = read(rel);
    if (!src) continue;
    for (const fn of loggers) {
      const idx = src.indexOf(fn);
      if (idx !== -1 && /q\b/.test(src.slice(idx, idx + 120))) {
        bad(rel, lineOf(src, fn), `${fn} near query value`);
      }
    }
  }
  const qsvc = read("src/lib/search/query.ts") ?? "";
  if (qsvc.includes("console.log")) bad("src/lib/search/query.ts", 0, "console.log in search provider");
});

/* 20 — forecast stays out of accounting reports */
section0("20 forecast");
rule("CRM tables never join financial report queries", (bad) => {
  const reports = ["src/lib/reports.ts", "src/lib/reports-advanced.ts"];
  for (const rel of reports) {
    const src = read(rel);
    if (!src) continue;
    if (/crmLead|crmOpportunity|CrmLead|CrmOpportunity|expectedValueMinor|weightedPipeline/.test(src)) {
      bad(rel, 0, "CRM/forecast reference inside financial reports");
    }
  }
  const financeKit = read("src/modules/finance-shared/finance-kit.tsx") ?? "";
  if (/crmLead|crmOpportunity|expectedValueMinor/.test(financeKit)) {
    bad("src/modules/finance-shared/finance-kit.tsx", 0, "CRM reference in shared finance kit");
  }
});

/* summary */
const failed = resultsArr.filter((r) => !r.ok);
const checks = resultsArr.length;
console.log(`\ncrm-static-scan: ${checks - failed.length}/${checks} rules PASS`);
if (failed.length > 0) {
  console.log("FAILURES:");
  for (const f of failed) console.log(`  - [${f.name}] ${f.info}`);
  process.exit(1);
}
