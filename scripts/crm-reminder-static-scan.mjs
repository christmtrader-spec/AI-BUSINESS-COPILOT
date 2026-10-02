/**
 * scripts/crm-reminder-static-scan.mjs — Prompt 37 §97.
 *
 * Deterministic, dependency-free source scan over the CRM reminder surface.
 * Every rule reports ✓/✗ with the offending file:line. Exit 0 only when ALL
 * rules pass.
 *
 * Rules (§97 — 1:1):
 *   1  no setInterval in reminder code (app runtime)
 *   2  no setTimeout in reminder code (app runtime)
 *   3  no browser polling / hidden page timers in CRM modules
 *   4  no direct nodemailer/SMTP from CRM code
 *   5  no direct Notification Prisma writes from CRM UI
 *   6  no client-controlled recipient (notification userId from request)
 *   7  no client-controlled businessId (tenant scope is server-derived)
 *   8  no arbitrary reminder minutes (closed vocabulary enforced)
 *   9  no unbounded task query in the reminder processor
 *  10  no raw task description logging
 *  11  no passwords in the reminder surface
 *  12  no MFA fields in the reminder surface
 *  13  no platform payment models in the reminder surface
 *  14  no AI cost models in the reminder surface
 *  15  no sourceEventId generated from raw user input (titles/descriptions)
 *  16  no arbitrary actionRoute (closed catalog key only)
 *  17  notification never created BEFORE the task commit (mappers fire after)
 *  18  no public HTTP scheduler endpoint (CLI talks to the DB directly)
 *  19  no fake distributed locking
 *  20  no task mutation during reminder processing (notification-only)
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

const PROCESSOR = "src/lib/crm/task-reminder-processor.ts";
const CLI = "scripts/process-crm-task-reminders.mjs";
const TASK_SERVICE = "src/lib/crm/task-service.ts";
const MAPPERS = "src/lib/notifications/event-mappers.ts";
const REMINDER_FILES = [
  PROCESSOR,
  "src/lib/crm/task-types.ts",
  "src/lib/crm/task-schemas.ts",
  "src/lib/crm/reminder-summary.ts",
  TASK_SERVICE,
].filter((f) => existsSync(join(ROOT, f)));
const CRM_UI_FILES = walk("src/modules/crm", [".tsx", ".ts"]);
const CRM_API_FILES = walk("src/app/api/v1/crm", [".ts"]);

/* ----------------------------- rules 1–3 ---------------------------------- */

section0("no in-process scheduling");
rule("1 no setInterval in reminder code", (bad) => {
  for (const f of [...REMINDER_FILES, ...CRM_UI_FILES]) {
    const src = read(f);
    if (!src) continue;
    const lines = src.split("\n");
    lines.forEach((l, i) => {
      if (/setInterval/.test(l) && !l.trim().startsWith("//") && !l.trim().startsWith("*")) {
        bad(f, i + 1, "setInterval in reminder surface");
      }
    });
  }
});

rule("2 no setTimeout in reminder code", (bad) => {
  for (const f of [...REMINDER_FILES, CLI]) {
    const src = read(f);
    if (!src) continue;
    const lines = src.split("\n");
    lines.forEach((l, i) => {
      if (/setTimeout/.test(l) && !l.trim().startsWith("//") && !l.trim().startsWith("*")) {
        bad(f, i + 1, "setTimeout in reminder surface");
      }
    });
  }
});

rule("3 no browser polling / hidden timers in CRM modules", (bad) => {
  for (const f of CRM_UI_FILES) {
    const src = read(f);
    if (!src) continue;
    if (/requestAnimationFrame|Service\s*Worker\s*registration|navigator\.serviceWorker|EventSource|new\s+WebSocket/.test(src)) {
      bad(f, 1, "browser polling/timer pattern in CRM UI");
    }
    const lines = src.split("\n");
    lines.forEach((l, i) => {
      if (/setInterval/.test(l)) {
        bad(f, i + 1, "setInterval polling in CRM UI");
      }
    });
  }
});

/* ----------------------------- rules 4–7 ---------------------------------- */

section0("notification boundaries");
rule("4 no direct nodemailer/SMTP from CRM code", (bad) => {
  for (const f of [...REMINDER_FILES, ...CRM_UI_FILES, MAPPERS, CLI]) {
    const src = read(f);
    if (!src) continue;
    if (/nodemailer|createTransport|smtp-client|tls\.connect/i.test(src)) {
      bad(f, 1, "direct SMTP usage in CRM reminder path");
    }
  }
});

rule("5 no direct Notification Prisma writes from CRM UI", (bad) => {
  for (const f of CRM_UI_FILES) {
    const src = read(f);
    if (!src) continue;
    if (/notification\.(create|update|upsert|delete)|notificationDelivery\./.test(src)) {
      bad(f, 1, "UI writes notification rows directly");
    }
  }
});

rule("6 no client-controlled recipient", (bad) => {
  for (const f of [...REMINDER_FILES, ...CRM_API_FILES]) {
    const src = read(f);
    if (!src) continue;
    const lines = src.split("\n");
    lines.forEach((l, i) => {
      // Recipient for reminders/assignments must come from task.assignedToUserId.
      if (/userId\s*[:=]\s*(body|input|query|searchParams)/.test(l)) {
        bad(f, i + 1, "notification recipient derived from request data");
      }
    });
  }
});

rule("7 no client-controlled businessId", (bad) => {
  for (const f of [...CRM_API_FILES, TASK_SERVICE]) {
    const src = read(f);
    if (!src) continue;
    const lines = src.split("\n");
    lines.forEach((l, i) => {
      if (/searchParams\.get\(["'](businessId|tenantId|ownerId)["']\)/.test(l)) {
        bad(f, i + 1, "tenant param read from client query");
      }
      if (/body\.businessId|input\.businessId/.test(l)) {
        bad(f, i + 1, "client body drives business scope");
      }
    });
  }
});

/* ----------------------------- rules 8–12 --------------------------------- */

section0("vocabulary + query discipline");
rule("8 no arbitrary reminder minutes", (bad) => {
  const schemas = read("src/lib/crm/task-schemas.ts") ?? "";
  if (!schemas.includes("REMINDER_OFFSET_MINUTES")) {
    bad("src/lib/crm/task-schemas.ts", 1, "offset schema lacks the closed vocabulary");
  }
  const types = read("src/lib/crm/task-types.ts") ?? "";
  if (!types.includes("10080") || !types.includes("isReminderOffset")) {
    bad("src/lib/crm/task-types.ts", 1, "closed offset vocabulary missing");
  }
});

rule("9 no unbounded task query in the reminder processor", (bad) => {
  const src = read(PROCESSOR) ?? "";
  if (!src) {
    bad(PROCESSOR, 1, "processor missing");
    return;
  }
  let idx = src.indexOf("findMany");
  while (idx !== -1) {
    const after = src.slice(idx, idx + 600);
    if (!/take\s*:/.test(after)) {
      bad(PROCESSOR, lineOf(src, idx), "findMany without take");
    }
    idx = src.indexOf("findMany", idx + 1);
  }
});

rule("10 no raw task description logging", (bad) => {
  for (const f of [...REMINDER_FILES, CLI, MAPPERS]) {
    const src = read(f);
    if (!src) continue;
    const lines = src.split("\n");
    lines.forEach((l, i) => {
      if (/console\.(log|info|debug|error|warn)/.test(l) && /description/i.test(l)) {
        bad(f, i + 1, "logs description content");
      }
      if (/log(Info|Error|Warn)\(/.test(l) && /(taskTitle|contextTitle|notification body|dataJson)/.test(l)) {
        bad(f, i + 1, "logs notification content");
      }
    });
  }
});

rule("11 no passwords in the reminder surface", (bad) => {
  for (const f of [...REMINDER_FILES, ...CRM_API_FILES]) {
    const src = read(f);
    if (!src) continue;
    if (/password/i.test(src)) bad(f, 1, "password reference");
  }
});

rule("12 no MFA fields in the reminder surface", (bad) => {
  for (const f of [...REMINDER_FILES, ...CRM_API_FILES]) {
    const src = read(f);
    if (!src) continue;
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    if (/mfa|totp|recovery/i.test(stripped)) bad(f, 1, "MFA reference");
  }
});

/* ---------------------------- rules 13–16 --------------------------------- */

section0("payload + route safety");
rule("13 no platform payment models in the reminder surface", (bad) => {
  for (const f of [...REMINDER_FILES, ...CRM_API_FILES]) {
    const src = read(f);
    if (!src) continue;
    if (/PaymentTransaction|CheckoutSession|ProcessedWebhook|PlatformAudit/.test(src)) {
      bad(f, 1, "platform payment model referenced");
    }
  }
});

rule("14 no AI cost models in the reminder surface", (bad) => {
  for (const f of [...REMINDER_FILES, ...CRM_API_FILES]) {
    const src = read(f);
    if (!src) continue;
    if (/AiCost|aiCost/.test(src)) bad(f, 1, "AI cost model referenced");
  }
});

rule("15 no sourceEventId generated from raw user input", (bad) => {
  const svc = read(TASK_SERVICE) ?? "";
  const mappers = read(MAPPERS) ?? "";
  const proc = read(PROCESSOR) ?? "";
  const composed = [svc, mappers, proc].join("\n");
  // Identity strings must be built ONLY from task id / dueAt / assignee /
  // updatedAt markers — never title/description/context text.
  const badCompose = composed.match(/composeSourceEventId\(([^)]*)\)/gs) ?? [];
  for (const call of badCompose) {
    if (/title|description|contextTitle/i.test(call)) {
      bad(MAPPERS, 1, "source event id includes user-controlled text");
    }
  }
  if (/sourceEventId\s*[:=]\s*(input\.)?(taskTitle|description|contextTitle)/.test(composed)) {
    bad(MAPPERS, 1, "source event id from raw text");
  }
});

rule("16 no arbitrary actionRoute", (bad) => {
  const catalog = read("src/lib/notifications/catalog.ts") ?? "";
  const idx = catalog.indexOf("BUSINESS_CRM_TASK_ASSIGNED: {");
  const slice = catalog.slice(idx, catalog.indexOf("SYSTEM_ANNOUNCEMENT: {", idx));
  const routes = [...slice.matchAll(/actionRoute:\s*([^,\n]+)/g)].map((m) => m[1].trim());
  if (routes.length === 0) {
    bad("src/lib/notifications/catalog.ts", 1, "CRM entries lack actionRoute");
  }
  for (const r of routes) {
    if (r !== '"crmTasks"') {
      bad("src/lib/notifications/catalog.ts", 1, `unexpected actionRoute ${r}`);
    }
  }
  // The task payload never determines the route.
  const mappers = read(MAPPERS) ?? "";
  if (/actionRoute\s*:\s*input/.test(mappers)) {
    bad(MAPPERS, 1, "actionRoute taken from payload");
  }
});

/* ---------------------------- rules 17–20 --------------------------------- */

section0("execution semantics");
rule("17 notification created only AFTER the task commit", (bad) => {
  const svc = read(TASK_SERVICE) ?? "";
  // The notify helper is invoked after the create/update + audit — verify
  // the calls come after the db writes in the function bodies.
  const createFn = svc.slice(svc.indexOf("export async function createTask"), svc.indexOf("/** Generic update"));
  const updateFn = svc.slice(svc.indexOf("export async function updateTask"), svc.indexOf("/**\n * Status transition"));
  for (const [name, fn] of [["createTask", createFn], ["updateTask", updateFn]]) {
    const dbWrite = fn.indexOf("db.crmTask.");
    const notifyCall = fn.indexOf("notifyAssignmentSafe");
    if (dbWrite === -1) {
      bad(TASK_SERVICE, 1, `${name}: no DB write found`);
      continue;
    }
    if (notifyCall !== -1 && notifyCall < dbWrite) {
      bad(TASK_SERVICE, 1, `${name}: notification fired BEFORE the DB write`);
    }
  }
});

rule("18 no public HTTP scheduler endpoint", (bad) => {
  const apiTree = walk("src/app/api", [".ts"]);
  for (const f of apiTree) {
    if (/reminder/i.test(f)) {
      // The ONLY reminder-flavored API allowed is the read-only summary.
      const src = read(f);
      if (!src) continue;
      if (f.includes("reminder-summary")) {
        if (/export const (POST|PATCH|DELETE)/.test(src)) {
          bad(f, 1, "reminder-summary exposes mutations");
        }
        continue;
      }
      bad(f, 1, "reminder HTTP endpoint outside the closed summary route");
    }
  }
  const cli = read(CLI) ?? "";
  if (!cli || !cli.includes("processCrmTaskReminders")) {
    bad(CLI, 1, "CLI missing processor invocation");
  }
});

rule("19 no fake distributed locking", (bad) => {
  for (const f of [PROCESSOR, CLI]) {
    const src = read(f);
    if (!src) continue;
    if (/redis|Redlock|bullmq|distribute[dD]\s*[Ll]ock|lease\s*table/i.test(src)) {
      bad(f, 1, "fake distributed lock pattern");
    }
  }
});

rule("20 no task mutation during reminder processing", (bad) => {
  const src = read(PROCESSOR) ?? "";
  if (!src) {
    bad(PROCESSOR, 1, "processor missing");
    return;
  }
  if (/crmTask\.(update|updateMany|delete|deleteMany|create|upsert)/.test(src)) {
    bad(PROCESSOR, 1, "processor mutates task rows");
  }
  if (/completedAt|status\s*[:=]\s*"(COMPLETED|CANCELED|OPEN|IN_PROGRESS)"/.test(src.replace(/\/\*[\s\S]*?\*\//g, ""))) {
    bad(PROCESSOR, 1, "processor writes task state fields");
  }
});

/* -------------------------------- report ---------------------------------- */

const failed = resultsArr.length - passedCount;
console.log(`\ncrm-reminder-static-scan: ${passedCount}/${resultsArr.length} ${failed === 0 ? "PASS" : `FAIL (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
