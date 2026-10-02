/**
 * scripts/crm-activity-task-static-scan.mjs — Prompt 36 §99.
 *
 * Deterministic, dependency-free source scan over the Prompt 36 surface
 * (activities/tasks/timeline/work queue). Every rule reports ✓/✗ with the
 * offending file:line. Exit 0 only when ALL rules pass.
 *
 * Rules (§99 — 1:1):
 *   1  activity/task reads carry businessId scope
 *   2  no client-controlled businessId (body/query tenant params read)
 *   3  no arbitrary activity type (closed vocabulary)
 *   4  no arbitrary task status (closed vocabulary)
 *   5  no arbitrary task priority (closed vocabulary)
 *   6  context validated same-business (customer guard)
 *   7  context validated same-business (lead/opportunity guards)
 *   8  no raw Prisma response (DTO mappers used)
 *   9  no unbounded findMany
 *  10  no raw SQL
 *  11  no description logging (console + audit payload hygiene)
 *  12  no password fields
 *  13  no MFA fields
 *  14  no platform payment models
 *  15  no AI cost models
 *  16  no notification delivery leakage
 *  17  no AuditLog used as public timeline
 *  18  no fake reminder scheduler
 *  19  no setInterval reminder loops
 *  20  no dangerouslySetInnerHTML
 *  21  no arbitrary redirects
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
let section = "";
const resultsArr = [];
let passedCount = 0;

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
function record(name, ok, info = "") {
  resultsArr.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} [${section}] ${name}${info ? ` — ${info}` : ""}`);
  if (ok) passedCount++;
}
function rule(name, fn) {
  const bad = [];
  const badFn = (file, line, why) => bad.push(`${file}:${line} ${why}`);
  try {
    fn(badFn);
  } catch (e) {
    bad.push(`rule error: ${e?.message ?? e}`);
  }
  record(name, bad.length === 0, bad.length === 0 ? "" : bad.join(" · "));
}

/** Collect a file list for a directory tree with an extension filter. */
function walk(dir, exts, acc = []) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return acc;
  for (const entry of readdirSync(abs)) {
    const p = join(abs, entry);
    const rel = `${dir}/${entry}`;
    if (statSync(p).isDirectory()) walk(rel, exts, acc);
    else if (exts.some((e) => entry.endsWith(e))) acc.push(rel);
  }
  return acc;
}

const SERVER_FILES = walk("src/lib/crm", [".ts"]).filter((f) =>
  /activity-service|task-service|work-queue|timeline|service\.ts/.test(f),
);
const ROUTE_FILES = walk("src/app/api/v1/crm", [".ts"]).filter((f) =>
  /activities|tasks|timeline/.test(f),
);
const UI_FILES = walk("src/modules/crm", [".tsx", ".ts"]);

/* ----------------------------- rules 1–2 ---------------------------------- */

section0("tenant scope");
rule("1 activity/task service reads carry businessId", (bad) => {
  for (const f of SERVER_FILES) {
    const src = read(f);
    if (!src) continue;
    const calls = src.match(/db\.(crmActivity|crmTask)\.(findMany|findFirst|count|update|create)\(/g) ?? [];
    if (calls.length > 0 && !src.includes("businessId")) {
      bad(f, 1, "uses CRM task/activity queries without businessId");
    }
  }
});

rule("2 no client-controlled businessId", (bad) => {
  for (const f of [...ROUTE_FILES, ...SERVER_FILES]) {
    const src = read(f);
    if (!src) continue;
    const lines = src.split("\n");
    lines.forEach((l, i) => {
      if (/searchParams\.get\(["'](businessId|tenantId|ownerId)["']\)/.test(l)) {
        bad(f, i + 1, "reads tenant param from client query");
      }
      if (/body\.businessId|input\.businessId|\bbusinessId\s*[:=]\s*(body|input)\./.test(l)) {
        bad(f, i + 1, "client body drives business scope");
      }
    });
  }
});

/* ----------------------------- rules 3–7 ---------------------------------- */

section0("closed vocabularies + relations");
rule("3 no arbitrary activity type strings in routes", (bad) => {
  for (const f of ROUTE_FILES) {
    if (!f.includes("activities")) continue;
    const src = read(f);
    if (!src) continue;
    // Closed enum enforced either directly (isActivityType) or via zod schema.
    if (src.includes("activityCreateSchema") || src.includes("activityUpdateSchema") || src.includes("isActivityType")) continue;
    bad(f, 1, "activity route lacks schema/isActivityType validation");
  }
});

rule("4 no arbitrary task status in routes", (bad) => {
  const route = read("src/app/api/v1/crm/tasks/route.ts") ?? "";
  if (route.includes("status") && !route.includes("isTaskStatus")) {
    bad("tasks/route.ts", 1, "task list route handles status without isTaskStatus");
  }
  // The generic [id] PATCH must never write status.
  const detail = read("src/app/api/v1/crm/tasks/[id]/route.ts") ?? "";
  if (/data\.status\s*=|status:\s*input|updateTaskStatus/.test(detail)) {
    bad("tasks/[id]/route.ts", 1, "generic PATCH writes status");
  }
  // Status transition endpoint must route through the state machine.
  const statusRoute = read("src/app/api/v1/crm/tasks/[id]/status/route.ts") ?? "";
  if (!statusRoute.includes("changeTaskStatus")) {
    bad("tasks/[id]/status/route.ts", 1, "status route bypasses the state machine");
  }
});

rule("5 no arbitrary task priority in routes", (bad) => {
  const src = read("src/app/api/v1/crm/tasks/route.ts") ?? "";
  if (src.includes("priority") && !src.includes("isTaskPriority")) {
    bad("tasks/route.ts", 1, "priority filter lacks isTaskPriority guard");
  }
});

rule("6 context validated same-business (customer)", (bad) => {
  const src = read("src/lib/crm/service.ts") ?? "";
  if (!src.includes("assertCustomerInBusiness") || !src.includes("resolveCrmContextInBusiness")) {
    bad("src/lib/crm/service.ts", 1, "customer context guard missing");
  }
});

rule("7 context validated same-business (lead/opportunity)", (bad) => {
  const src = read("src/lib/crm/service.ts") ?? "";
  if (!src.includes("assertLeadInBusiness") || !src.includes("assertOpportunityInBusiness")) {
    bad("src/lib/crm/service.ts", 1, "lead/opportunity context guards missing");
  }
  const svc = read("src/lib/crm/activity-service.ts") ?? "";
  if (!svc.includes("resolveCrmContextInBusiness")) {
    bad("src/lib/crm/activity-service.ts", 1, "create path skips context resolution");
  }
});

/* ----------------------------- rules 8–10 --------------------------------- */

section0("DTO + query discipline");
rule("8 no raw Prisma response", (bad) => {
  for (const f of ROUTE_FILES) {
    const src = read(f);
    if (!src) continue;
    if (/ok\(\s*await\s+db\./.test(src) || /\.findMany\(\)\s*\)\s*\)/.test(src)) {
      bad(f, 1, "raw Prisma row returned");
    }
  }
  for (const f of SERVER_FILES) {
    const src = read(f);
    if (!src) continue;
    if (/return\s+rows;|return\s+row;|return\s+created;/.test(src) && !src.includes("map")) {
      bad(f, 1, "service returns unmapped rows");
    }
  }
});

rule("9 no unbounded findMany", (bad) => {
  for (const f of SERVER_FILES) {
    const src = read(f);
    if (!src) continue;
    let idx = src.indexOf("findMany");
    while (idx !== -1) {
      const after = src.slice(idx, idx + 600);
      if (!/take\s*:/.test(after)) {
        bad(f, lineOf(src, idx), "findMany without take");
      }
      idx = src.indexOf("findMany", idx + 1);
    }
  }
});

rule("10 no raw SQL", (bad) => {
  for (const f of [...SERVER_FILES, ...ROUTE_FILES]) {
    const src = read(f);
    if (!src) continue;
    if (/queryRaw|executeRaw|\$queryRaw/.test(src)) {
      bad(f, 1, "raw SQL in CRM activity/task path");
    }
  }
});

/* ---------------------------- rules 11–16 --------------------------------- */

section0("privacy");
rule("11 no description logging", (bad) => {
  for (const f of [...SERVER_FILES, ...ROUTE_FILES]) {
    const src = read(f);
    if (!src) continue;
    const lines = src.split("\n");
    lines.forEach((l, i) => {
      if (/console\.(log|info|debug|error|warn)/.test(l) && /description/i.test(l)) {
        bad(f, i + 1, "logs description content");
      }
      if (/audit\(/.test(l)) return;
      if (/after:\s*\{[^}]*(description|desc)\s*:/s.test(src.slice(src.indexOf(l), src.indexOf(l) + 400))) {
        // audit payload contains description — violation (metadata only, §59)
        bad(f, i + 1, "audit payload carries description");
      }
    });
  }
});

rule("12 no password fields", (bad) => {
  for (const f of [...SERVER_FILES, ...ROUTE_FILES, ...UI_FILES]) {
    const src = read(f);
    if (!src) continue;
    if (/password/i.test(src)) bad(f, 1, "password reference");
  }
});

rule("13 no MFA fields", (bad) => {
  for (const f of [...SERVER_FILES, ...ROUTE_FILES]) {
    const src = read(f);
    if (!src) continue;
    if (/mfa|totp|recovery/i.test(src)) bad(f, 1, "MFA reference");
  }
});

rule("14 no platform payment models", (bad) => {
  for (const f of [...SERVER_FILES, ...ROUTE_FILES]) {
    const src = read(f);
    if (!src) continue;
    if (/PaymentTransaction|CheckoutSession|ProcessedWebhook|PlatformAudit/.test(src)) {
      bad(f, 1, "platform payment model referenced");
    }
  }
});

rule("15 no AI cost models", (bad) => {
  for (const f of [...SERVER_FILES, ...ROUTE_FILES]) {
    const src = read(f);
    if (!src) continue;
    if (/AiCost|aiCost/.test(src)) bad(f, 1, "AI cost model referenced");
  }
});

rule("16 no notification delivery leakage", (bad) => {
  for (const f of [...SERVER_FILES, ...ROUTE_FILES]) {
    const src = read(f);
    if (!src) continue;
    if (/NotificationDelivery|notificationDelivery|createNotification/.test(src)) {
      bad(f, 1, "notification internals referenced from CRM activity/task path");
    }
  }
});

/* ---------------------------- rules 17–21 --------------------------------- */

section0("boundaries");
rule("17 no AuditLog used as public timeline", (bad) => {
  const src = read("src/lib/crm/timeline.ts") ?? "";
  if (/db\.auditLog|auditLog\.find|prisma\.auditLog/i.test(src)) {
    bad("src/lib/crm/timeline.ts", 1, "timeline reads AuditLog rows");
  }
});

rule("18 no fake reminder scheduler", (bad) => {
  const offenders = [
    "src/lib/crm/work-queue.ts",
    "src/lib/crm/task-service.ts",
    "src/modules/crm/tasks-view.tsx",
    "src/modules/crm/task-form-dialog.tsx",
  ];
  for (const f of offenders) {
    const src = read(f);
    if (!src) continue;
    if (/setTimeout|cron|scheduleReminder|sendReminder|nodemailer/i.test(src)) {
      bad(f, 1, "fake reminder scheduler pattern");
    }
  }
});

rule("19 no setInterval reminder loops", (bad) => {
  for (const f of [...SERVER_FILES, ...UI_FILES]) {
    const src = read(f);
    if (!src) continue;
    const lines = src.split("\n");
    lines.forEach((l, i) => {
      if (/setInterval/.test(l) && /remind|due/i.test(src)) {
        bad(f, i + 1, "setInterval loop in CRM task surface");
      }
    });
  }
});

rule("20 no dangerouslySetInnerHTML", (bad) => {
  for (const f of UI_FILES) {
    const src = read(f);
    if (!src) continue;
    if (/dangerouslySetInnerHTML/.test(src)) bad(f, 1, "raw HTML injection");
  }
});

rule("21 no arbitrary redirects", (bad) => {
  for (const f of UI_FILES) {
    const src = read(f);
    if (!src) continue;
    if (/window\.location\s*=\s*(?!["'])|location\.href\s*=\s*(?!["'])/.test(src)) {
      bad(f, 1, "dynamic redirect target");
    }
  }
});

/* -------------------------------- report ---------------------------------- */

const failed = resultsArr.length - passedCount;
console.log(`\ncrm-activity-task-static-scan: ${passedCount}/${resultsArr.length} ${failed === 0 ? "PASS" : `FAIL (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
