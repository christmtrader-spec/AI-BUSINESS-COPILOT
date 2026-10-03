/**
 * scripts/prompt37-crm-reminder-check.mjs — Prompt 37 §112 E2E harness.
 *
 * REAL running application + real DB. Task/assignment flows go through the
 * SAME tenant HTTP APIs a user would use; the reminder processor runs
 * through the REAL CLI (scripts/process-crm-task-reminders.mjs) exactly as
 * an operator's cron would. Fixtures use the P37- prefix and are torn down
 * to ZERO leftovers (§183/§184 — fixture-scoped notification deletes).
 *
 * Sections (§112 A–AR + Prompt 37-F §76):
 *   A–B  create-with-assignment → BUSINESS_CRM_TASK_ASSIGNED to staff only
 *   C    self-assignment suppresses            D  reassignment notifies new assignee only
 *   E–I  due reminder disabled/enabled, exact threshold, before/after window
 *   J–L  overdue disabled/enabled + ONE overdue notification
 *   M    repeated processor = duplicate-safe   N  dueAt change = NEW logical reminder
 *   O    disabled reminder after config        P/Q completed/canceled ignored
 *   R    reopened task eligibility             S  unassigned task ignored
 *   T–V  email preference disabled/enabled + unverified recipient behavior
 *   W–Y  notification center visibility, Business filter, action route
 *   Z–AB tenant isolation, cross-business task/assignee
 *   AC–AD notification DTO safety + no description leakage
 *   AE   financial non-interference           AF/AG dry-run vs apply CLI
 *   AM/AN bounded max run + overdue lookback
 *   AI–AK Persian/English notifications + timezone rendering
 *   AO–AQ no scheduler loop + static scans + catalog check
 *   F-CLI   CLI hardening: conflict/unknown/invalid flags BEFORE any run (§5–§9),
 *           zero-write proof (§40), safe output (§46), safe debug output (§47)
 *   F-CONC  CONCURRENT real processor runs: due-soon (§24) + overdue (§25)
 *           dedupe to EXACTLY ONE notification (P37-CONC- fixtures, §23)
 *   F-RACE  defensive re-checks: no task mutation (§64), completion (§31),
 *           cancellation (§32), reminder-disable (§34), deleted context (§36),
 *           soft-deleted task (§63), reassignment dedupe (§26), assignee+dueAt
 *           change (§29), immutable history (§28)
 *   F-HEALTH processor failure independence of /api/health + /api/ready (§68/§97)
 *   AH   cleanup (ZERO P37- leftovers)
 *
 * Run: bun scripts/prompt37-crm-reminder-check.mjs   (dev server on :3000)
 * Exit: 0 = all green · 1 = at least one failure.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.P37_BASE ?? "http://localhost:3000";
const PASS = "testpass123";
const PREFIX = "P37-";
const db = new PrismaClient();

for (const line of readDbEnv()) {
  const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
function readDbEnv() {
  try {
    return readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n");
  } catch {
    return [];
  }
}

const results = [];
let current = "";
let lastBody = null;
function section(name) {
  current = name;
}
function check(name, cond, info = "") {
  results.push({ name, ok: Boolean(cond) });
  console.log(
    `${cond ? "✓" : "✗"} [${current}] ${name}${info ? ` — ${info}` : cond ? "" : ` |last=${JSON.stringify(lastBody)?.slice(0, 240)}`}`,
  );
  return Boolean(cond);
}

/* ------------------------------ fetch helpers ------------------------------ */
function randomXff() {
  return `10.51.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
}
function jarFetch(jar) {
  return async (path, init = {}) => {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const headers = { "x-forwarded-for": randomXff(), ...(init.headers ?? {}) };
    if (init.body && !headers["content-type"]) headers["content-type"] = "application/json";
    const res = await fetch(`${BASE}${path}`, { ...init, headers: cookie ? { ...headers, cookie } : headers });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1));
    }
    return res;
  };
}
async function apiJson(f, path, init = {}) {
  const res = await f(path, init);
  let body = null;
  try {
    body = await res.json();
  } catch {}
  lastBody = body;
  return { res, body };
}
async function login(jar, email, password) {
  const f = jarFetch(jar);
  const { csrfToken } = await (await f("/api/auth/csrf")).json();
  const form = new URLSearchParams({ csrfToken, email, password, redirect: "false", json: "true" });
  await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  return [...jar.keys()].some((k) => k.includes("session-token"));
}
async function register(email, name) {
  return apiJson(jarFetch(new Map()), "/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, email, password: PASS }),
  });
}
async function createBusiness(jar, name) {
  const f = jarFetch(jar);
  const { body } = await apiJson(f, "/api/v1/businesses", {
    method: "POST",
    body: JSON.stringify({ name, currencyCode: "USD", locale: "en" }),
  });
  return body?.data?.business?.id ?? body?.data?.id ?? null;
}
const run = `r${Math.floor(Math.random() * 1e9)}`;
const minFromNow = (m) => new Date(Date.now() + m * 60_000).toISOString();

/* --------------------------- processor CLI helper -------------------------- */
/** Runs the REAL operator CLI. Returns parsed {result} or null on failure. */
function runProcessor(flags = []) {
  const proc = Bun.spawnSync({
    cmd: ["bun", "scripts/process-crm-task-reminders.mjs", ...flags],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const out = proc.stdout.toString();
  const lines = out.split("\n").filter((l) => l.trim().startsWith("{"));
  let parsed = null;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.result) parsed = obj;
    } catch {}
  }
  if (proc.exitCode !== 0) {
    console.log(`  ⚠ CLI exited ${proc.exitCode}: ${proc.stderr.toString().slice(0, 300)}`);
  }
  console.log(`  ↳ CLI ${flags.join(" ")} → ${JSON.stringify(parsed?.result ?? null)}`);
  return { exitCode: proc.exitCode, parsed, out, err: proc.stderr.toString() };
}

/* ================================== SETUP ================================== */
console.log("\n== SETUP ==");
section("SETUP");
await db.business.deleteMany({ where: { name: { startsWith: `${PREFIX}A-` } } });
await db.business.deleteMany({ where: { name: { startsWith: `${PREFIX}B-` } } });
await db.user.deleteMany({ where: { email: { contains: "p37-" } } });

const emailOwner = `p37-owner-${run}@test.local`;
const emailOwnerB = `p37-owner-b-${run}@test.local`;
const emailStaffA = `p37-staff-a-${run}@test.local`;
const emailStaffB = `p37-staff-b-${run}@test.local`;
const jarOwner = new Map();
const jarOwnerB = new Map();
const jarStaffA = new Map();
const jarStaffB = new Map();

check("register owner A", (await register(emailOwner, "P37 Owner")).body?.ok === true);
check("register owner B", (await register(emailOwnerB, "P37 Owner B")).body?.ok === true);
check("register staff A", (await register(emailStaffA, "P37 Staff A")).body?.ok === true);
check("register staff B", (await register(emailStaffB, "P37 Staff B")).body?.ok === true);
check("login owner", await login(jarOwner, emailOwner, PASS));
check("login owner B", await login(jarOwnerB, emailOwnerB, PASS));
check("login staff A", await login(jarStaffA, emailStaffA, PASS));
check("login staff B", await login(jarStaffB, emailStaffB, PASS));

const bizA = await createBusiness(jarOwner, `${PREFIX}A-BIZ`);
const bizB = await createBusiness(jarOwnerB, `${PREFIX}B-BIZ`);
check("business A created", Boolean(bizA));
check("business B created", Boolean(bizB));

const ownerAId = (await db.user.findUnique({ where: { email: emailOwner } }))?.id ?? null;
const ownerBId = (await db.user.findUnique({ where: { email: emailOwnerB } }))?.id ?? null;
const staffAId = (await db.user.findUnique({ where: { email: emailStaffA } }))?.id ?? null;
const staffBId = (await db.user.findUnique({ where: { email: emailStaffB } }))?.id ?? null;

const fA = jarFetch(jarOwner);
const wbA = (path, init = {}) => fA(path, { ...init, headers: { "x-business-id": bizA, ...(init.headers ?? {}) } });
const fB = jarFetch(jarOwnerB);
const wbB = (path, init = {}) => fB(path, { ...init, headers: { "x-business-id": bizB, ...(init.headers ?? {}) } });
const fStaffA = jarFetch(jarStaffA);
const wbStaffA = (path, init = {}) => fStaffA(path, { ...init, headers: { "x-business-id": bizA, ...(init.headers ?? {}) } });
const fStaffB = jarFetch(jarStaffB);
const wbStaffB = (path, init = {}) => fStaffB(path, { ...init, headers: { "x-business-id": bizA, ...(init.headers ?? {}) } });
async function call(wb, path, init = {}) {
  const { res, body } = await apiJson(wb, path, init);
  return { res, status: res.status, body, data: body?.ok ? body.data : null, err: body?.error };
}

// Business A needs 3 members (owner + 2 staff) for the reassignment flow;
// the FREE plan caps at 2. Paid plan changes require real payments, so the
// harness plants the STARTER subscription directly as FIXTURE PREP (the
// entitlement path itself is covered by Prompt 22/24 suites).
const starterPlan = await db.plan.findUnique({ where: { code: "STARTER" }, select: { id: true } });
const subUpdate = await db.subscription.updateMany({
  where: { businessId: bizA },
  data: { planId: starterPlan?.id, status: "ACTIVE", trialStart: null, trialEnd: null },
});
check("business A planted on STARTER (TEAM_MEMBERS_MAX 5, fixture prep)", subUpdate.count === 1, String(subUpdate.count));

// staff A + B join business A as STAFF
for (const [jar, label] of [[jarStaffA, "A"], [jarStaffB, "B"]]) {
  const mint = await call(wbA, `/api/v1/businesses/${bizA}/invites`, { method: "POST", body: JSON.stringify({ role: "STAFF" }) });
  check(`invite minted for staff ${label}`, Boolean(mint.data?.token));
  const accept = await call(jarFetch(jar), `/api/v1/invites/${mint.data?.token}`, { method: "POST" });
  check(`staff ${label} accepted invite`, accept.status === 200 || accept.status === 201, String(accept.status));
}

const cust = await call(wbA, "/api/v1/customers", { method: "POST", body: JSON.stringify({ name: `${PREFIX}Customer` }) });
const custId = cust.data?.id;
check("customer fixture created", Boolean(custId));
const custB = await call(wbB, "/api/v1/customers", { method: "POST", body: JSON.stringify({ name: `${PREFIX}B-Customer` }) });
const custBId = custB.data?.id;
check("business B customer fixture created", Boolean(custBId));

/** Task create helper (owner by default). */
async function createTask(wb, body) {
  return call(wb, "/api/v1/crm/tasks", { method: "POST", body: JSON.stringify({ customerId: custId, ...body }) });
}
/** Count CRM notifications for a user (fixture tasks only, by task id set). */
const CRM_TYPES = ["BUSINESS_CRM_TASK_ASSIGNED", "BUSINESS_CRM_TASK_DUE_SOON", "BUSINESS_CRM_TASK_OVERDUE"];
function crmNotifs(userId) {
  return db.notification.findMany({ where: { userId, type: { in: CRM_TYPES } }, orderBy: { createdAt: "asc" } });
}

/* ------------------------- A/B create with assignment ---------------------- */
console.log("\n== A/B ASSIGNMENT ON CREATE ==");
section("A");
const notifBaselineAll = await db.notification.count();
const tAssign = await createTask(wbA, { title: `${PREFIX}T-assign`, assignedToUserId: staffAId, priority: "HIGH", dueAt: minFromNow(3 * 24 * 60) });
const tAssignId = tAssign.data?.id;
check("A1 task created with staff assignment", tAssign.status === 201 && Boolean(tAssignId), String(tAssign.status));
await new Promise((r) => setTimeout(r, 400)); // fire-safe mapper lands after commit
const assignNotifs = (await crmNotifs(staffAId)).filter((n) => n.dataJson?.includes(tAssignId));
const ownerNotifs = (await crmNotifs(ownerAId)).filter((n) => n.dataJson?.includes(tAssignId));
check("B1 assignee received BUSINESS_CRM_TASK_ASSIGNED", assignNotifs.length === 1, String(assignNotifs.length));
check("B2 owner (actor) received nothing", ownerNotifs.length === 0);
{
  const n = assignNotifs[0];
  check("B3 assigned notification carries closed fields", Boolean(n) && n.category === "BUSINESS" && n.priority === "NORMAL" && n.severity === "INFO" && n.actionRoute === "crmTasks");
  const data = JSON.parse(n?.dataJson ?? "{}");
  check("B4 data has taskTitle/contextTitle/priority/dueAt/tz — no description", data.taskTitle === `${PREFIX}T-assign` && data.contextTitle === `${PREFIX}Customer` && data.priority === "HIGH" && data.businessTimezone === "UTC" && !("description" in data));
  check("B5 sourceEventId deterministic (taskId:assignee:updatedAt)", typeof n?.sourceEventId === "string" && n.sourceEventId.startsWith("crm-task-assigned:") && n.sourceEventId.includes(staffAId));
}

/* ------------------------------- C self-assignment ------------------------- */
console.log("\n== C SELF-ASSIGNMENT ==");
section("C");
const tSelf = await createTask(wbA, { title: `${PREFIX}T-self`, assignedToUserId: ownerAId });
check("C1 self-assigned task created", tSelf.status === 201);
await new Promise((r) => setTimeout(r, 400));
const selfNotifs = (await crmNotifs(ownerAId)).filter((n) => n.dataJson?.includes(tSelf.data?.id));
check("C2 NO assignment notification for self-assignment (§114)", selfNotifs.length === 0, String(selfNotifs.length));

/* ------------------------------- D reassignment ---------------------------- */
console.log("\n== D REASSIGNMENT ==");
section("D");
const beforeD = (await crmNotifs(staffAId)).length;
const reassign = await call(wbA, `/api/v1/crm/tasks/${tSelf.data?.id}`, { method: "PATCH", body: JSON.stringify({ assignedToUserId: staffBId }) });
check("D1 reassignment PATCH ok", reassign.status === 200);
await new Promise((r) => setTimeout(r, 400));
const staffBNotifs = (await crmNotifs(staffBId)).filter((n) => n.dataJson?.includes(tSelf.data?.id));
check("D2 NEW assignee (staff B) notified (§115)", staffBNotifs.length === 1, String(staffBNotifs.length));
check("D3 old assignee (staff A) NOT notified about reassignment (§115)", (await crmNotifs(staffAId)).length === beforeD);

/* --------------------------- E–I due reminder windows ---------------------- */
console.log("\n== E–I DUE-SOON WINDOWS ==");
section("E");
// E: reminder disabled ⇒ processor never notifies.
const tNoRem = await createTask(wbA, { title: `${PREFIX}T-norem`, assignedToUserId: staffAId, dueAt: minFromNow(30) });
check("E1 task without reminder config created", tNoRem.status === 201);
let run1 = runProcessor([`--business-id=${bizA}`]);
check("E2 CLI dry run exits 0", run1.exitCode === 0, run1.err.slice(0, 120));
check("E3 reminder disabled ⇒ no due-soon candidate", run1.parsed?.result?.dueSoonCandidates === 0, JSON.stringify(run1.parsed?.result));
check("E4 reminder disabled ⇒ no due-soon/overdue notification", ((await crmNotifs(staffAId)).filter((n) => n.dataJson?.includes(tNoRem.data?.id) && n.type !== "BUSINESS_CRM_TASK_ASSIGNED").length) === 0);

// F: reminder enabled, well inside the 60-minute window (dueAt now+30m).
const tDue = await createTask(wbA, { title: `${PREFIX}T-due`, assignedToUserId: staffAId, dueAt: minFromNow(30), reminderEnabled: true, reminderMinutesBefore: 60 });
check("F1 reminder task created (offset 60, due in 30m)", tDue.status === 201 && tDue.data?.reminderEnabled === true && tDue.data?.reminderMinutesBefore === 60);
run1 = runProcessor([`--business-id=${bizA}`]);
check("F2 dry run reports 1 due-soon candidate", run1.parsed?.result?.dueSoonCandidates === 1, JSON.stringify(run1.parsed?.result));
check("F3 DRY RUN creates NOTHING (§125)", run1.parsed?.result?.mode === "DRY_RUN" && (await crmNotifs(staffAId)).filter((n) => n.type === "BUSINESS_CRM_TASK_DUE_SOON").length === 0);

// AG/AF: apply mode creates rows; dry-run did not.
console.log("\n== AF/AG APPLY ==");
section("AG");
const apply1 = runProcessor([`--business-id=${bizA}`, "--apply"]);
check("AG1 apply run exits 0", apply1.exitCode === 0);
check("AG2 apply created 1 due-soon notification", apply1.parsed?.result?.created === 1, JSON.stringify(apply1.parsed?.result));
const dueNotifs = (await crmNotifs(staffAId)).filter((n) => n.type === "BUSINESS_CRM_TASK_DUE_SOON" && n.dataJson?.includes(tDue.data?.id));
check("AG3 due-soon row exists with bounded data", dueNotifs.length === 1 && dueNotifs[0].priority === "HIGH" && dueNotifs[0].severity === "WARNING");
check("AG4 due-soon EMAIL delivery row exists (policy: SKIPPED for unverified)", Boolean(await db.notificationDelivery.findFirst({ where: { notificationId: dueNotifs[0]?.id, channel: "EMAIL" } })));

// M: repeated run is duplicate-safe (§27/§116).
console.log("\n== M DUPLICATE SAFETY ==");
section("M");
const apply2 = runProcessor([`--business-id=${bizA}`, "--apply"]);
check("M1 second apply reports duplicate=1", apply2.parsed?.result?.duplicates === 1 && apply2.parsed?.result?.created === 0, JSON.stringify(apply2.parsed?.result));
check("M2 still exactly ONE due-soon row (§27)", (await crmNotifs(staffAId)).filter((n) => n.type === "BUSINESS_CRM_TASK_DUE_SOON" && n.dataJson?.includes(tDue.data?.id)).length === 1);
const apply3 = runProcessor([`--business-id=${bizA}`, "--apply"]);
check("M3 third run still duplicate-safe", apply3.parsed?.result?.duplicates === 1 && apply3.parsed?.result?.created === 0);

// G/H/I: exact threshold semantics (§117) — 61m out ⇒ none; 59m out ⇒ notify.
console.log("\n== G THRESHOLD ==");
section("G");
const tThr = await createTask(wbA, { title: `${PREFIX}T-thr`, assignedToUserId: staffAId, dueAt: minFromNow(61), reminderEnabled: true, reminderMinutesBefore: 60 });
check("G1 threshold task at +61m (outside window)", tThr.status === 201);
const thrRun1 = runProcessor([`--business-id=${bizA}`, "--apply"]);
check("H1 now+61m with offset 60 ⇒ NO due-soon (before threshold, §117)", (await crmNotifs(staffAId)).filter((n) => n.type === "BUSINESS_CRM_TASK_DUE_SOON" && n.dataJson?.includes(tThr.data?.id)).length === 0);
const thrPatch = await call(wbA, `/api/v1/crm/tasks/${tThr.data?.id}`, { method: "PATCH", body: JSON.stringify({ dueAt: minFromNow(59) }) });
check("G2 dueAt moved to +59m (inside window)", thrPatch.status === 200);
await runProcessor([`--business-id=${bizA}`, "--apply"]);
check("I1 now+59m ⇒ ONE due-soon notification (§117)", (await crmNotifs(staffAId)).filter((n) => n.type === "BUSINESS_CRM_TASK_DUE_SOON" && n.dataJson?.includes(tThr.data?.id)).length === 1);

/* ------------------------------- J–L overdue ------------------------------- */
console.log("\n== J–L OVERDUE ==");
section("J");
const tNoOver = await createTask(wbA, { title: `${PREFIX}T-noover`, assignedToUserId: staffAId, dueAt: minFromNow(-5) });
check("J1 overdue task WITHOUT overdue alert created", tNoOver.status === 201);
const noOverRun = runProcessor([`--business-id=${bizA}`, "--apply"]);
check("J2 overdueAlertEnabled=false ⇒ no overdue notification (§77)", ((await crmNotifs(staffAId)).filter((n) => n.dataJson?.includes(tNoOver.data?.id) && n.type === "BUSINESS_CRM_TASK_OVERDUE").length) === 0);

const tOver = await createTask(wbA, { title: `${PREFIX}T-over`, assignedToUserId: staffAId, dueAt: minFromNow(-5), overdueAlertEnabled: true, reminderEnabled: true, reminderMinutesBefore: 60 });
check("K1 overdue task WITH alert + reminder created", tOver.status === 201);
const overRun = runProcessor([`--business-id=${bizA}`, "--apply"]);
check("K2 overdue classified (1 candidate)", overRun.parsed?.result?.overdueCandidates === 1, JSON.stringify(overRun.parsed?.result));
check("L1 exactly ONE overdue notification — and NEVER a due-soon for the same task (§76/§119)", (await crmNotifs(staffAId)).filter((n) => n.type === "BUSINESS_CRM_TASK_OVERDUE" && n.dataJson?.includes(tOver.data?.id)).length === 1 && (await crmNotifs(staffAId)).filter((n) => n.type === "BUSINESS_CRM_TASK_DUE_SOON" && n.dataJson?.includes(tOver.data?.id)).length === 0);

// N: dueAt change ⇒ NEW logical reminder identity (§29/§120).
console.log("\n== N DUE DATE CHANGE ==");
section("N");
const tChange = await createTask(wbA, { title: `${PREFIX}T-change`, assignedToUserId: staffAId, dueAt: minFromNow(30), reminderEnabled: true, reminderMinutesBefore: 60 });
await runProcessor([`--business-id=${bizA}`, "--apply"]);
const beforeN = (await crmNotifs(staffAId)).filter((n) => n.type === "BUSINESS_CRM_TASK_DUE_SOON" && n.dataJson?.includes(tChange.data?.id)).length;
check("N1 reminder fired for T1", beforeN === 1);
await call(wbA, `/api/v1/crm/tasks/${tChange.data?.id}`, { method: "PATCH", body: JSON.stringify({ dueAt: minFromNow(20) }) });
await runProcessor([`--business-id=${bizA}`, "--apply"]);
const afterN = (await crmNotifs(staffAId)).filter((n) => n.type === "BUSINESS_CRM_TASK_DUE_SOON" && n.dataJson?.includes(tChange.data?.id)).length;
check("N2 new dueAt ⇒ NEW due-soon notification for T2 (no stale carry)", afterN === 2, String(afterN));

// O: disabling the reminder stops future notifications (§30).
console.log("\n== O DISABLE REMINDER ==");
section("O");
await call(wbA, `/api/v1/crm/tasks/${tChange.data?.id}`, { method: "PATCH", body: JSON.stringify({ dueAt: minFromNow(25), reminderEnabled: false, reminderMinutesBefore: null }) });
const disabled = await call(wbA, `/api/v1/crm/tasks/${tChange.data?.id}`);
check("O1 server stores reminderEnabled=false + offset null after disable", disabled.data?.reminderEnabled === false && disabled.data?.reminderMinutesBefore === null);
await runProcessor([`--business-id=${bizA}`, "--apply"]);
check("O2 disabled reminder ⇒ no NEW due-soon beyond the 2 historical ones", (await crmNotifs(staffAId)).filter((n) => n.type === "BUSINESS_CRM_TASK_DUE_SOON" && n.dataJson?.includes(tChange.data?.id)).length === 2);

/* ------------------------------- P/Q/R/S status ---------------------------- */
console.log("\n== P/Q/R/S STATUS ELIGIBILITY ==");
section("P");
const tDone = await createTask(wbA, { title: `${PREFIX}T-done`, assignedToUserId: staffAId, dueAt: minFromNow(30), reminderEnabled: true, reminderMinutesBefore: 60 });
await call(wbA, `/api/v1/crm/tasks/${tDone.data?.id}/status`, { method: "POST", body: JSON.stringify({ status: "COMPLETED" }) });
const doneRun = runProcessor([`--business-id=${bizA}`, "--apply"]);
check("P1 COMPLETED task never reminded (§78)", doneRun.parsed?.result && ((await crmNotifs(staffAId)).filter((n) => n.dataJson?.includes(tDone.data?.id) && n.type !== "BUSINESS_CRM_TASK_ASSIGNED").length) === 0);

const tCancel = await createTask(wbA, { title: `${PREFIX}T-cancel`, assignedToUserId: staffAId, dueAt: minFromNow(30), reminderEnabled: true, reminderMinutesBefore: 60 });
await call(wbA, `/api/v1/crm/tasks/${tCancel.data?.id}/status`, { method: "POST", body: JSON.stringify({ status: "CANCELED" }) });
await runProcessor([`--business-id=${bizA}`, "--apply"]);
check("Q1 CANCELED task never reminded (§79)", ((await crmNotifs(staffAId)).filter((n) => n.dataJson?.includes(tCancel.data?.id) && n.type !== "BUSINESS_CRM_TASK_ASSIGNED").length) === 0);

// R: reopen + future dueAt ⇒ eligible again (§9/§122).
await call(wbA, `/api/v1/crm/tasks/${tDone.data?.id}/status`, { method: "POST", body: JSON.stringify({ status: "OPEN" }) });
await call(wbA, `/api/v1/crm/tasks/${tDone.data?.id}`, { method: "PATCH", body: JSON.stringify({ dueAt: minFromNow(29) }) });
await runProcessor([`--business-id=${bizA}`, "--apply"]);
check("R1 reopened task receives a reminder for the NEW dueAt (§122)", (await crmNotifs(staffAId)).filter((n) => n.type === "BUSINESS_CRM_TASK_DUE_SOON" && n.dataJson?.includes(tDone.data?.id)).length === 1);

// S: unassigned task ignored (§10).
const tUn = await createTask(wbA, { title: `${PREFIX}T-unassigned`, dueAt: minFromNow(30), reminderEnabled: true, reminderMinutesBefore: 60 });
check("S1 unassigned reminder task created", tUn.status === 201);
await runProcessor([`--business-id=${bizA}`, "--apply"]);
check("S2 unassigned task ⇒ zero notifications (recipient = assignee only, §10)", ((await crmNotifs(ownerAId)).filter((n) => n.dataJson?.includes(tUn.data?.id)).length) === 0);

/* ------------------------------- T/U/V email ------------------------------- */
console.log("\n== T–V EMAIL PREFERENCES ==");
section("T");
// Disable DUE_SOON email for staff A.
const prefOff = await call(fStaffA, "/api/v1/me/notification-preferences", {
  method: "PUT",
  body: JSON.stringify({ notificationType: "BUSINESS_CRM_TASK_DUE_SOON", channel: "EMAIL", enabled: false }),
});
check("T1 preference API accepted EMAIL=false", prefOff.status === 200 || prefOff.status === 201, String(prefOff.status));
const tPref = await createTask(wbA, { title: `${PREFIX}T-pref`, assignedToUserId: staffAId, dueAt: minFromNow(31), reminderEnabled: true, reminderMinutesBefore: 60 });
await runProcessor([`--business-id=${bizA}`, "--apply"]);
{
  const n = (await crmNotifs(staffAId)).find((x) => x.type === "BUSINESS_CRM_TASK_DUE_SOON" && x.dataJson?.includes(tPref.data?.id));
  check("T2 IN_APP row exists even with EMAIL disabled (§84)", Boolean(n));
  const delivery = n ? await db.notificationDelivery.findFirst({ where: { notificationId: n.id, channel: "EMAIL" } }) : null;
  check("T3 EMAIL delivery row SKIPPED (PREFERENCE_DISABLED) (§84)", delivery?.status === "SKIPPED" && delivery?.failureCode === "PREFERENCE_DISABLED", JSON.stringify(delivery?.failureCode));
}
// Re-enable; a NEW logical reminder then allows EMAIL subject to verification (§110).
await call(fStaffA, "/api/v1/me/notification-preferences", {
  method: "PUT",
  body: JSON.stringify({ notificationType: "BUSINESS_CRM_TASK_DUE_SOON", channel: "EMAIL", enabled: true }),
});
await call(wbA, `/api/v1/crm/tasks/${tPref.data?.id}`, { method: "PATCH", body: JSON.stringify({ dueAt: minFromNow(21) }) });
await runProcessor([`--business-id=${bizA}`, "--apply"]);
{
  const notifs = (await crmNotifs(staffAId)).filter((x) => x.type === "BUSINESS_CRM_TASK_DUE_SOON" && x.dataJson?.includes(tPref.data?.id));
  const newest = notifs[notifs.length - 1];
  const delivery = newest ? await db.notificationDelivery.findFirst({ where: { notificationId: newest.id, channel: "EMAIL" } }) : null;
  check("U1 re-enabled preference: EMAIL attempted for the new logical reminder", Boolean(delivery), JSON.stringify(delivery?.status));
  check("V1 unverified recipient ⇒ EMAIL SKIPPED RECIPIENT_UNVERIFIED (§85)", delivery?.status === "SKIPPED" && delivery?.failureCode === "RECIPIENT_UNVERIFIED", JSON.stringify(delivery?.failureCode));
}

/* ------------------------------- W–Y center ------------------------------- */
console.log("\n== W–Y NOTIFICATION CENTER ==");
section("W");
const center = await call(fStaffA, "/api/v1/me/notifications?category=BUSINESS&pageSize=50");
check("W1 notification center lists CRM entries", center.status === 200 && (center.data?.items ?? []).some((i) => CRM_TYPES.includes(i.type)), String(center.data?.items?.length));
const bizFiltered = await call(fStaffA, "/api/v1/me/notifications?category=BUSINESS&pageSize=50");
check("X1 Business filter includes the CRM task types (§87)", (bizFiltered.data?.items ?? []).filter((i) => CRM_TYPES.includes(i.type)).length >= 1);
const sampleCrm = (center.data?.items ?? []).find((i) => CRM_TYPES.includes(i.type));
check("Y1 action route is the closed crmTasks mapping (§88)", sampleCrm?.action?.route === "#/crm?tab=tasks", sampleCrm?.action?.route);
check("Y2 CTA opens the EXISTING tasks tab (no #/tasks/<id> deep link)", !sampleCrm?.action?.route?.includes("/tasks/"));
check("AC1 DTO exposes no sourceEventId/dataJson/description (§189)", sampleCrm && !("sourceEventId" in sampleCrm) && !("dataJson" in sampleCrm) && !("description" in sampleCrm));

/* ------------------------------ Z–AB tenant ------------------------------- */
console.log("\n== Z–AB TENANT ISOLATION ==");
section("Z");
// B creates a reminder task; processor scoped to B only touches B.
const tB = await createTask(wbB, { title: `${PREFIX}B-task`, assignedToUserId: ownerBId, customerId: custBId, dueAt: minFromNow(30), reminderEnabled: true, reminderMinutesBefore: 60 });
check("Z1 business B reminder task created", tB.status === 201);
const runB = runProcessor([`--business-id=${bizB}`, "--apply"]);
check("Z2 processor scoped to B created 1 notification in B", runB.parsed?.result?.created === 1, JSON.stringify(runB.parsed?.result));
check("Z3 the B reminder went to the B user (never an A user)", (await crmNotifs(ownerBId)).some((n) => n.businessId === bizB && n.type === "BUSINESS_CRM_TASK_DUE_SOON"));
const staffABefore = (await crmNotifs(staffAId)).length;
await runProcessor([`--business-id=${bizB}`, "--apply"]);
check("Z4 scoped-to-B run NEVER creates notifications for A users", (await crmNotifs(staffAId)).length === staffABefore);

const crossTask = await call(wbA, "/api/v1/crm/tasks", {
  method: "POST",
  body: JSON.stringify({ title: `${PREFIX}T-cross`, assignedToUserId: ownerBId, customerId: custId }),
});
check("AA1 cross-business assignee rejected (422)", crossTask.status === 422, String(crossTask.status));

/* --------------------------- AD description leakage ------------------------ */
console.log("\n== AD SENSITIVE DATA ==");
section("AD");
const tSecret = await createTask(wbA, {
  title: `${PREFIX}T-secret <img src=x onerror=alert(1)>`,
  description: "call me at +98912 secret-password api-key-123",
  assignedToUserId: staffAId,
  dueAt: minFromNow(28),
  reminderEnabled: true,
  reminderMinutesBefore: 60,
});
await runProcessor([`--business-id=${bizA}`, "--apply"]);
{
  const notifs = (await crmNotifs(staffAId)).filter((n) => n.dataJson?.includes(tSecret.data?.id) && n.type === "BUSINESS_CRM_TASK_DUE_SOON");
  const blob = JSON.stringify(notifs.map((n) => n.dataJson));
  check("AD1 notification data NEVER contains the task description (§141)", !blob.includes("+98912") && !blob.includes("secret-password") && !blob.includes("api-key-123"), blob.slice(0, 120));
  const dtoResp = await call(fStaffA, "/api/v1/me/notifications?category=BUSINESS&pageSize=50");
  const dtoBlob = JSON.stringify(dtoResp.data);
  check("AD2 rendered notifications contain no description/contact text (§141)", !dtoBlob.includes("secret-password") && !dtoBlob.includes("api-key-123"));
  const secretDto = (dtoResp.data?.items ?? []).find((i) => i.type === "BUSINESS_CRM_TASK_DUE_SOON" && i.body.includes("P37-T-secret"));
check("AD3 platform adds NO HTML structure — titles render as plain text nodes", Boolean(secretDto) && !secretDto.body.includes("<p") && !secretDto.body.includes("<div") && !secretDto.emailHtmlable);
}

/* ------------------------------ AM bounded run ---------------------------- */
console.log("\n== AM BOUNDED MAX RUN ==");
section("AM");
const boundIds = [];
for (let i = 0; i < 12; i++) {
  const t = await createTask(wbA, { title: `${PREFIX}T-bound-${i}`, assignedToUserId: staffBId, dueAt: minFromNow(40 + i), reminderEnabled: true, reminderMinutesBefore: 60 });
  boundIds.push(t.data?.id);
}
const boundRun = runProcessor([`--business-id=${bizA}`, "--apply", "--max=10"]);
const boundCreated = boundRun.parsed?.result?.created ?? 99;
check("AM1 --max=10 caps creation attempts at 10 (§40/§127)", boundCreated <= 10, String(boundCreated));
const boundNotifs = (await crmNotifs(staffBId)).filter((n) => n.type === "BUSINESS_CRM_TASK_DUE_SOON" && boundIds.some((id) => n.dataJson?.includes(id)));
check("AM2 exactly ≤10 notifications created for the batch", boundNotifs.length <= 10, String(boundNotifs.length));
const boundRun2 = runProcessor([`--business-id=${bizA}`, "--apply", "--max=10"]);
check("AM3 next run continues the remainder (§40)", (boundRun2.parsed?.result?.created ?? 0) + (boundRun2.parsed?.result?.duplicates ?? 0) >= 2, JSON.stringify(boundRun2.parsed?.result));

/* ------------------------------- AN lookback ------------------------------ */
console.log("\n== AN OVERDUE LOOKBACK ==");
section("AN");
const tOld = await createTask(wbA, { title: `${PREFIX}T-old`, assignedToUserId: staffBId, dueAt: minFromNow(-300 * 60), overdueAlertEnabled: true }); // 300h ≈ 12.5 days ago
check("AN1 very old overdue task created (due 300h ago)", tOld.status === 201);
const lookRun = runProcessor([`--business-id=${bizA}`, "--apply"]);
check("AN2 beyond the 168h lookback ⇒ not scanned (§41)", (await crmNotifs(staffBId)).filter((n) => n.dataJson?.includes(tOld.data?.id) && n.type !== "BUSINESS_CRM_TASK_ASSIGNED").length === 0, JSON.stringify(lookRun.parsed?.result));

/* --------------------------- AI–AK locale + timezone ----------------------- */
console.log("\n== AI–AK LOCALE + TIMEZONE ==");
section("AI");
const centerFA = await call(fStaffA, "/api/v1/me/notifications?category=BUSINESS&pageSize=50");
const faItems = (centerFA.data?.items ?? []).filter((i) => CRM_TYPES.includes(i.type));
const faOwner = await db.user.update({ where: { id: staffAId }, data: { locale: "fa" } });
check("AI1 staff locale switched to fa", faOwner.locale === "fa");
const centerFA2 = await call(fStaffA, "/api/v1/me/notifications?category=BUSINESS&pageSize=50");
const faItems2 = (centerFA2.data?.items ?? []).filter((i) => CRM_TYPES.includes(i.type));
check("AI2 FA locale renders Persian titles (§133)", faItems2.length > 0 && faItems2.some((i) => /[\u0600-\u06FF]/.test(i.title)), faItems2[0]?.title);
check("AI3 FA body contains no English template sentence (§133)", faItems2.every((i) => !i.body.includes("was assigned to you") && !i.body.includes("is overdue")));
await db.user.update({ where: { id: staffAId }, data: { locale: "en" } });
const centerEN = await call(fStaffA, "/api/v1/me/notifications?category=BUSINESS&pageSize=50");
const enItems = (centerEN.data?.items ?? []).filter((i) => CRM_TYPES.includes(i.type));
check("AJ1 EN locale renders English titles (§134)", enItems.length > 0 && enItems.every((i) => !/[\u0600-\u06FF]/.test(i.title)), enItems[0]?.title);

// AK: Tehran business timezone rendering (§138): 23:30Z → 03:00 (+3:30, next day).
console.log("\n== AK TIMEZONE ==");
section("AK");
await db.business.update({ where: { id: bizA }, data: { timezone: "Asia/Tehran" } });
const tzDue = new Date(Date.now() + 3 * 86_400_000);
tzDue.setUTCHours(23, 30, 0, 0);
const tTz = await createTask(wbA, { title: `${PREFIX}T-tz`, assignedToUserId: staffBId, dueAt: tzDue.toISOString(), reminderEnabled: true, reminderMinutesBefore: 10080 });
check("AK1 Tehran task created (due 23:30Z)", tTz.status === 201);
await runProcessor([`--business-id=${bizA}`, "--apply"]);
{
  const n = (await crmNotifs(staffBId)).find((x) => x.type === "BUSINESS_CRM_TASK_DUE_SOON" && x.dataJson?.includes(tTz.data?.id));
  const dto = await call(fStaffB, "/api/v1/me/notifications?category=BUSINESS&pageSize=50");
  const rendered = (dto.data?.items ?? []).find((i) => i.id === n?.id);
  check("AK2 23:30Z renders as Tehran 03:00 (next day, +3:30 — no browser tz)", Boolean(rendered?.body.includes("03:00")), rendered?.body?.slice(0, 120));
  const data = JSON.parse(n?.dataJson ?? "{}");
  check("AK3 stored data keeps businessTimezone=Asia/Tehran", data.businessTimezone === "Asia/Tehran");
}
await db.business.update({ where: { id: bizA }, data: { timezone: "UTC" } });

/* ------------------------------ AE financial ------------------------------ */
console.log("\n== AE FINANCIAL NON-INTERFERENCE ==");
section("AE");
async function financialSnapshot() {
  const [sales, expenses, receivables, payables] = await Promise.all([
    call(wbA, "/api/v1/sales?pageSize=1"),
    call(wbA, "/api/v1/expenses?pageSize=1"),
    call(wbA, "/api/v1/receivables"),
    call(wbA, "/api/v1/payables"),
  ]);
  return JSON.stringify({
    salesTotal: sales.data?.total ?? null,
    salesSum: sales.data?.items?.reduce?.((a, s) => a + (s.totalMinor ?? 0), 0) ?? 0,
    expensesTotal: expenses.data?.total ?? null,
    receivable: JSON.stringify(receivables.data).slice(0, 400),
    payable: JSON.stringify(payables.data).slice(0, 400),
  });
}
const financeBefore = await financialSnapshot();
await createTask(wbA, { title: `${PREFIX}T-finance`, assignedToUserId: staffAId, dueAt: minFromNow(50), reminderEnabled: true, reminderMinutesBefore: 60, overdueAlertEnabled: true });
await runProcessor([`--business-id=${bizA}`, "--apply"]);
const financeAfter = await financialSnapshot();
check("AE1 financial snapshot EXACT equality (§128)", financeBefore === financeAfter);
const explicitSale = await call(wbA, "/api/v1/sales", {
  method: "POST",
  body: JSON.stringify({ customerId: custId, issueDate: new Date().toISOString(), items: [{ name: "P37 sanity item", qty: 1, unitPriceMinor: 1000 }] }),
});
check("AE2 explicit sale still works after reminder ops", explicitSale.status === 200 || explicitSale.status === 201, String(explicitSale.status));

/* ========================================================================== */
/* PROMPT 37-F — FINALIZATION E2E (§5–§9/§23–§47/§26–§36/§63/§64/§68)         */
/* ========================================================================== */

/** Counts a fixture table snapshot for the §40 dry-run-conflict proof. */
async function snapshotCounts() {
  const [n, d, t, a] = await Promise.all([
    db.notification.count(),
    db.notificationDelivery.count(),
    db.crmTask.count(),
    db.auditLog.count(),
  ]);
  return { n, d, t, a };
}

/* ------------------------- P37-F-1: CLI hardening ------------------------- */
console.log("\n== P37-F CLI HARDENING ==");
section("F-CLI");
{
  // An eligible candidate EXISTS while every invalid invocation runs —
  // proving the conflict/unknown/invalid paths never touch the database.
  const tCli = await createTask(wbA, { title: `${PREFIX}T-cliflag`, assignedToUserId: staffAId, dueAt: minFromNow(30), reminderEnabled: true, reminderMinutesBefore: 60 });
  check("FCLI0 eligible candidate exists for the CLI proofs", tCli.status === 201 && Boolean(tCli.data?.id));

  const before = await snapshotCounts();
  const conflict = runProcessor([`--business-id=${bizA}`, "--apply", "--dry-run"]);
  const after = await snapshotCounts();
  check("FCLI1 --apply --dry-run ⇒ exit 1 BEFORE any run (§5)", conflict.exitCode === 1, String(conflict.exitCode));
  check("FCLI2 conflict run wrote ZERO rows — notifications/deliveries/tasks/audit unchanged (§40)", JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  check("FCLI3 conflict output carries NO task id (validation precedes DB access)", Boolean(tCli.data?.id) && !conflict.out.includes(tCli.data?.id));
  check("FCLI4 conflict error is a clear safe usage error (§5)", conflict.err.includes("CLI_USAGE_INVALID") && conflict.err.includes("CONFLICTING_FLAGS"));

  const unknown = runProcessor(["--foobar"]);
  check("FCLI5 unknown flag ⇒ exit 1, no processor call (§45)", unknown.exitCode === 1 && unknown.err.includes("UNKNOWN_FLAG"));
  check("FCLI6 unknown-flag run created nothing", (await snapshotCounts()).n === before.n);

  const badBiz = runProcessor(["--business-id=xx"]);
  check("FCLI7 malformed --business-id ⇒ exit 1 (§7/§44)", badBiz.exitCode === 1 && badBiz.err.includes("INVALID_BUSINESS_ID"));
  check("FCLI8 malformed business-id run created nothing", (await snapshotCounts()).n === before.n);

  const badMax1 = runProcessor(["--max=abc"]);
  const badMax2 = runProcessor(["--max=10000"]);
  const badMax3 = runProcessor(["--max=9"]);
  check("FCLI9 non-numeric / >500 / <10 --max all ⇒ exit 1 (§8/§43)", badMax1.exitCode === 1 && badMax2.exitCode === 1 && badMax3.exitCode === 1);

  const dupApply = runProcessor([`--business-id=${bizA}`, "--apply", "--apply", "--dry-run"]);
  check("FCLI10 duplicate --apply still conflicts with --dry-run (deterministic §6)", dupApply.exitCode === 1 && dupApply.err.includes("CONFLICTING_FLAGS"));

  // §46 — safe output: a REAL candidate run must not leak fixture content.
  const secretTask = tCli.data?.id;
  const scoped = runProcessor([`--business-id=${bizA}`, "--apply"]);
  const combined = scoped.out + scoped.err;
  check("FCLI11 CLI output carries NO task title/email/phone/task id/business id (§46)", !combined.includes(`${PREFIX}T-cliflag`) && !combined.includes(emailStaffA) && !combined.includes("+98912") && !combined.includes(secretTask) && !combined.includes(bizA));
  check("FCLI12 the eligible candidate was actually processed (counts only)", scoped.exitCode === 0 && (scoped.parsed?.result?.created ?? 0) + (scoped.parsed?.result?.duplicates ?? 0) >= 1, JSON.stringify(scoped.parsed?.result));

  // §47 — safe debug output under CRM_REMINDER_DEBUG=1.
  const dbg = Bun.spawnSync({ cmd: ["bun", "scripts/process-crm-task-reminders.mjs", `--business-id=${bizA}`], cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env, CRM_REMINDER_DEBUG: "1" } });
  const dbgOut = dbg.stdout.toString();
  const dbgLine = dbgOut.split("\n").find((l) => l.includes('"debug"'));
  let dbgObj = null;
  try { dbgObj = JSON.parse(dbgLine ?? ""); } catch {}
  check("FCLI13 debug output is the exact safe aggregate shape (§10)", Boolean(dbgObj) && dbgObj.debug === "crm-task-reminders" && dbgObj.phase === "candidate-scan" && Number.isFinite(dbgObj.dueSoonScanned) && Number.isFinite(dbgObj.overdueScanned) && Number.isFinite(dbgObj.max) && (dbgObj.mode === "DRY_RUN" || dbgObj.mode === "APPLY"), dbgLine?.slice(0, 140));
  check("FCLI14 debug output carries NO task id/business id/dueAt/email (§47)", Boolean(secretTask) && !dbgOut.includes(secretTask) && !dbgOut.includes(bizA) && !dbgOut.includes(emailStaffA) && !dbgOut.includes(`${PREFIX}T-cliflag`));
}

/* ------------------ P37-F-2: CONCURRENT processor runs -------------------- */
console.log("\n== P37-F CONCURRENCY ==");
section("F-CONC");
/** Async twin of runProcessor so TWO real CLI processes overlap. */
async function runProcessorAsync(flags = []) {
  const proc = Bun.spawn({ cmd: ["bun", "scripts/process-crm-task-reminders.mjs", ...flags], cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  let parsed = null;
  for (const line of out.split("\n")) {
    try { const obj = JSON.parse(line); if (obj.result) parsed = obj; } catch {}
  }
  return { exitCode, parsed, out, err };
}
{
  // §24 — dueAt = now + 59m, offset 60 ⇒ both runs see the SAME candidate.
  const tConcDue = await createTask(wbA, { title: `${PREFIX}CONC-due`, assignedToUserId: staffAId, dueAt: minFromNow(59), reminderEnabled: true, reminderMinutesBefore: 60 });
  check("FCONC1 concurrent due-soon fixture created (due +59m, offset 60)", tConcDue.status === 201);
  const [runA, runB] = await Promise.all([
    runProcessorAsync([`--business-id=${bizA}`, "--apply"]),
    runProcessorAsync([`--business-id=${bizA}`, "--apply"]),
  ]);
  check("FCONC2 both concurrent processors exit 0", runA.exitCode === 0 && runB.exitCode === 0, `${runA.exitCode}/${runB.exitCode}`);
  const concDueNotifs = (await crmNotifs(staffAId)).filter((n) => n.type === "BUSINESS_CRM_TASK_DUE_SOON" && n.dataJson?.includes(tConcDue.data?.id));
  check("FCONC3 EXACTLY ONE due-soon notification despite overlapping runs (§23/§24)", concDueNotifs.length === 1, String(concDueNotifs.length));
  const logical = (runA.parsed?.result?.created ?? 0) + (runB.parsed?.result?.created ?? 0) + (runA.parsed?.result?.duplicates ?? 0) + (runB.parsed?.result?.duplicates ?? 0);
  check("FCONC4 both runs report the same logical event (created OR duplicate)", logical >= 1, String(logical));

  // §25 — overdue race: dueAt = now − 5m, alert enabled.
  const tConcOver = await createTask(wbA, { title: `${PREFIX}CONC-over`, assignedToUserId: staffAId, dueAt: minFromNow(-5), overdueAlertEnabled: true });
  check("FCONC5 concurrent overdue fixture created (due −5m)", tConcOver.status === 201);
  const [runC, runD] = await Promise.all([
    runProcessorAsync([`--business-id=${bizA}`, "--apply"]),
    runProcessorAsync([`--business-id=${bizA}`, "--apply"]),
  ]);
  check("FCONC6 both concurrent overdue processors exit 0", runC.exitCode === 0 && runD.exitCode === 0);
  const concOverNotifs = (await crmNotifs(staffAId)).filter((n) => n.type === "BUSINESS_CRM_TASK_OVERDUE" && n.dataJson?.includes(tConcOver.data?.id));
  check("FCONC7 EXACTLY ONE overdue notification despite overlapping runs (§25)", concOverNotifs.length === 1, String(concOverNotifs.length));
}

/* ------------------- P37-F-3: race + regression hardening ------------------ */
console.log("\n== P37-F RACES ==");
section("F-RACE");
{
  // §64 — dynamic no-task-mutation proof across a REAL apply run.
  const tMut = await createTask(wbA, { title: `${PREFIX}T-nomut`, assignedToUserId: staffAId, dueAt: minFromNow(31), reminderEnabled: true, reminderMinutesBefore: 60, overdueAlertEnabled: true, priority: "HIGH" });
  const snapBefore = await db.crmTask.findUnique({ where: { id: tMut.data?.id }, select: { status: true, dueAt: true, reminderEnabled: true, reminderMinutesBefore: true, overdueAlertEnabled: true, assignedToUserId: true, deletedAt: true, completedAt: true } });
  await runProcessor([`--business-id=${bizA}`, "--apply"]);
  const snapAfter = await db.crmTask.findUnique({ where: { id: tMut.data?.id }, select: { status: true, dueAt: true, reminderEnabled: true, reminderMinutesBefore: true, overdueAlertEnabled: true, assignedToUserId: true, deletedAt: true, completedAt: true } });
  check("FRACE1 processor mutated NOTHING on the task row (§64, dynamic)", JSON.stringify(snapBefore) === JSON.stringify(snapAfter), `${JSON.stringify(snapBefore)} → ${JSON.stringify(snapAfter)}`);

  // §31 — completion race: candidate seen, then COMPLETED before the next apply.
  const tRC = await createTask(wbA, { title: `${PREFIX}T-racec`, assignedToUserId: staffAId, dueAt: minFromNow(32), reminderEnabled: true, reminderMinutesBefore: 60 });
  const dryRC = runProcessor([`--business-id=${bizA}`]);
  check("FRACE2 completion race: dry run sees the due-soon candidate (§31)", (dryRC.parsed?.result?.dueSoonCandidates ?? 0) >= 1, JSON.stringify(dryRC.parsed?.result));
  await call(wbA, `/api/v1/crm/tasks/${tRC.data?.id}/status`, { method: "POST", body: JSON.stringify({ status: "COMPLETED" }) });
  await runProcessor([`--business-id=${bizA}`, "--apply"]);
  check("FRACE3 COMPLETED task received NO reminder (§31)", (await crmNotifs(staffAId)).filter((n) => n.dataJson?.includes(tRC.data?.id) && n.type === "BUSINESS_CRM_TASK_DUE_SOON").length === 0);

  // §32 — cancellation race.
  const tRX = await createTask(wbA, { title: `${PREFIX}T-racex`, assignedToUserId: staffAId, dueAt: minFromNow(33), reminderEnabled: true, reminderMinutesBefore: 60 });
  await runProcessor([`--business-id=${bizA}`]);
  await call(wbA, `/api/v1/crm/tasks/${tRX.data?.id}/status`, { method: "POST", body: JSON.stringify({ status: "CANCELED" }) });
  await runProcessor([`--business-id=${bizA}`, "--apply"]);
  check("FRACE4 CANCELED task received NO reminder (§32)", (await crmNotifs(staffAId)).filter((n) => n.dataJson?.includes(tRX.data?.id) && n.type === "BUSINESS_CRM_TASK_DUE_SOON").length === 0);

  // §34/§30 — configuration race: reminder disabled between scan and apply.
  const tRD = await createTask(wbA, { title: `${PREFIX}T-raced`, assignedToUserId: staffAId, dueAt: minFromNow(34), reminderEnabled: true, reminderMinutesBefore: 60 });
  const dryRD = runProcessor([`--business-id=${bizA}`]);
  check("FRACE5 config race: dry run sees the candidate (§34)", (dryRD.parsed?.result?.dueSoonCandidates ?? 0) >= 1);
  await call(wbA, `/api/v1/crm/tasks/${tRD.data?.id}`, { method: "PATCH", body: JSON.stringify({ reminderEnabled: false }) });
  const afterDisable = await call(wbA, `/api/v1/crm/tasks/${tRD.data?.id}`);
  check("FRACE6 disable keeps dueAt but resets offset (§8/§30)", afterDisable.data?.dueAt && afterDisable.data?.reminderEnabled === false && afterDisable.data?.reminderMinutesBefore === null);
  await runProcessor([`--business-id=${bizA}`, "--apply"]);
  check("FRACE7 disabled reminder produced NO stale notification (§34)", (await crmNotifs(staffAId)).filter((n) => n.dataJson?.includes(tRD.data?.id) && n.type === "BUSINESS_CRM_TASK_DUE_SOON").length === 0);

  // §36 — deleted context: the fresh context re-check must skip the task.
  const delCust = await call(wbA, "/api/v1/customers", { method: "POST", body: JSON.stringify({ name: `${PREFIX}C-delctx` }) });
  check("FRACE8 deleted-context fixture customer created", delCust.status === 201 && Boolean(delCust.data?.id));
  const tDC = await createTask(wbA, { title: `${PREFIX}T-delctx`, customerId: delCust.data?.id, assignedToUserId: staffAId, dueAt: minFromNow(35), reminderEnabled: true, reminderMinutesBefore: 60 });
  const delRes = await call(wbA, `/api/v1/customers/${delCust.data?.id}`, { method: "DELETE" });
  check("FRACE9 context customer soft-deleted", delRes.status === 200 || delRes.status === 204 || delRes.status === 201, String(delRes.status));
  await runProcessor([`--business-id=${bizA}`, "--apply"]);
  check("FRACE10 deleted context ⇒ NO due-soon notification (§36)", (await crmNotifs(staffAId)).filter((n) => n.dataJson?.includes(tDC.data?.id) && n.type === "BUSINESS_CRM_TASK_DUE_SOON").length === 0);

  // §63 — soft-deleted task: processor ignores it entirely.
  const tDT = await createTask(wbA, { title: `${PREFIX}T-deltask`, assignedToUserId: staffAId, dueAt: minFromNow(36), reminderEnabled: true, reminderMinutesBefore: 60 });
  await call(wbA, `/api/v1/crm/tasks/${tDT.data?.id}`, { method: "DELETE" });
  await runProcessor([`--business-id=${bizA}`, "--apply"]);
  check("FRACE11 soft-deleted task ⇒ zero reminder notifications (§63)", (await crmNotifs(staffAId)).filter((n) => n.dataJson?.includes(tDT.data?.id) && n.type !== "BUSINESS_CRM_TASK_ASSIGNED").length === 0);

  // §26 — reassignment dedupe: retry of the same event ⇒ no duplicate; B→C ⇒ new event.
  const tRDup = await createTask(wbA, { title: `${PREFIX}T-rededup`, assignedToUserId: staffBId, customerId: custId });
  await new Promise((r) => setTimeout(r, 500));
  const bCount1 = (await crmNotifs(staffBId)).filter((n) => n.dataJson?.includes(tRDup.data?.id) && n.type === "BUSINESS_CRM_TASK_ASSIGNED").length;
  check("FRACE12 assignment created for staff B exactly once", bCount1 === 1, String(bCount1));
  await call(wbA, `/api/v1/crm/tasks/${tRDup.data?.id}`, { method: "PATCH", body: JSON.stringify({ assignedToUserId: staffBId }) });
  await new Promise((r) => setTimeout(r, 500));
  const bCount2 = (await crmNotifs(staffBId)).filter((n) => n.dataJson?.includes(tRDup.data?.id) && n.type === "BUSINESS_CRM_TASK_ASSIGNED").length;
  check("FRACE13 unchanged-assignment retry ⇒ NO duplicate for B (§26)", bCount2 === 1, String(bCount2));
  await call(wbA, `/api/v1/crm/tasks/${tRDup.data?.id}`, { method: "PATCH", body: JSON.stringify({ assignedToUserId: staffAId }) });
  await new Promise((r) => setTimeout(r, 500));
  const aCount = (await crmNotifs(staffAId)).filter((n) => n.dataJson?.includes(tRDup.data?.id) && n.type === "BUSINESS_CRM_TASK_ASSIGNED").length;
  check("FRACE14 B→A reassignment notifies the NEW assignee exactly once (§26)", aCount === 1, String(aCount));
  check("FRACE15 B still holds exactly ONE assignment row from the ORIGINAL event", (await crmNotifs(staffBId)).filter((n) => n.dataJson?.includes(tRDup.data?.id) && n.type === "BUSINESS_CRM_TASK_ASSIGNED").length === 1);

  // §29 — assignee + dueAt change together: future reminder uses B + T2.
  const tBoth = await createTask(wbA, { title: `${PREFIX}T-both`, assignedToUserId: staffAId, dueAt: minFromNow(37), reminderEnabled: true, reminderMinutesBefore: 60 });
  await runProcessor([`--business-id=${bizA}`, "--apply"]);
  const aBefore = (await crmNotifs(staffAId)).filter((n) => n.dataJson?.includes(tBoth.data?.id) && n.type === "BUSINESS_CRM_TASK_DUE_SOON").length;
  check("FRACE16 T1 reminder fired for A (assignee A + dueAt T1)", aBefore === 1, String(aBefore));
  await call(wbA, `/api/v1/crm/tasks/${tBoth.data?.id}`, { method: "PATCH", body: JSON.stringify({ assignedToUserId: staffBId, dueAt: minFromNow(21) }) });
  await runProcessor([`--business-id=${bizA}`, "--apply"]);
  const bForTask = (await crmNotifs(staffBId)).filter((n) => n.dataJson?.includes(tBoth.data?.id) && n.type === "BUSINESS_CRM_TASK_DUE_SOON");
  const aForTask = (await crmNotifs(staffAId)).filter((n) => n.dataJson?.includes(tBoth.data?.id) && n.type === "BUSINESS_CRM_TASK_DUE_SOON");
  check("FRACE17 future reminder uses B + T2 — exactly one for B (§29)", bForTask.length === 1, String(bForTask.length));
  check("FRACE18 NO reminder to A for T2 (identity changed)", aForTask.length === 1 && aForTask[0].sourceEventId !== bForTask[0]?.sourceEventId);
  await runProcessor([`--business-id=${bizA}`, "--apply"]);
  check("FRACE19 repeat apply stays duplicate-safe for B + T2", (await crmNotifs(staffBId)).filter((n) => n.dataJson?.includes(tBoth.data?.id) && n.type === "BUSINESS_CRM_TASK_DUE_SOON").length === 1);

  // §28 — due date change: new identity, history immutable.
  const tHist = (await crmNotifs(staffAId)).filter((n) => n.dataJson?.includes(tBoth.data?.id) && n.type === "BUSINESS_CRM_TASK_DUE_SOON")[0];
  const histId = tHist?.id;
  const histCreatedAt = tHist?.createdAt;
  await call(wbA, `/api/v1/crm/tasks/${tBoth.data?.id}`, { method: "PATCH", body: JSON.stringify({ dueAt: minFromNow(15), reminderEnabled: true, reminderMinutesBefore: 60 }) });
  await runProcessor([`--business-id=${bizA}`, "--apply"]);
  const histRow = await db.notification.findUnique({ where: { id: histId }, select: { id: true, createdAt: true } });
  check("FRACE20 historical T1 notification REMAINS immutable after dueAt change (§28)", Boolean(histRow) && histRow.createdAt.getTime() === histCreatedAt.getTime());
}

/* ------------------------- P37-F-4: health honesty ------------------------- */
console.log("\n== P37-F HEALTH ==");
section("F-HEALTH");
{
  const health = await apiJson(jarFetch(new Map()), "/api/health");
  check("FHEALTH1 /api/health = 200 (§97)", health.res.status === 200, String(health.res.status));
  const ready = await apiJson(jarFetch(new Map()), "/api/ready");
  check("FHEALTH2 /api/ready answers honestly (§97/§68)", ready.res.status === 200 || ready.res.status === 503, String(ready.res.status));
  check("FHEALTH3 readiness body carries an explicit status (scheduler NOT a dependency)", typeof ready.body?.status === "string" || typeof ready.body?.data?.status === "string", JSON.stringify(ready.body)?.slice(0, 120));
}

/* ------------------------------ AO–AQ scans ------------------------------- */
console.log("\n== AO–AQ SCANS ==");
section("AO");
function runScan(script) {
  const p = Bun.spawnSync({ cmd: ["bun", script], cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  return p.exitCode;
}
check("AO1 crm-activity-task-static-scan green (no scheduler regressions, §98)", runScan("scripts/crm-activity-task-static-scan.mjs") === 0);
check("AO2 crm-reminder-static-scan green (26 rules incl. Prompt 37-F safe logging, §97/§12/§144)", runScan("scripts/crm-reminder-static-scan.mjs") === 0);
check("AO3 notification-static-scan green (§143)", runScan("scripts/notification-static-scan.mjs") === 0);
check("AQ1 notification-catalog-check green (§142)", runScan("scripts/notification-catalog-check.mjs") === 0);
{
  // AP search regression — CRM tasks must not enter global search vocabulary.
  const p = Bun.spawnSync({ cmd: ["bun", "scripts/search-static-scan.mjs"], cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  check("AP1 search-static-scan green (no TASK/ACTIVITY in search, §148)", p.exitCode === 0);
}

/* ------------------------------- reminder-summary API ---------------------- */
console.log("\n== SUMMARY API ==");
section("SUM");
const sum = await call(wbA, "/api/v1/crm/tasks/reminder-summary");
check("SUM1 reminder-summary endpoint answers", sum.status === 200, String(sum.status));
check("SUM2 counts are configuration counts (not notifications)", typeof sum.data?.dueSoonEnabledCount === "number" && typeof sum.data?.overdueAlertsEnabledCount === "number" && typeof sum.data?.dueSoonNext24hCount === "number");
const anonSum = await apiJson(jarFetch(new Map()), "/api/v1/crm/tasks/reminder-summary");
check("SUM3 unauthenticated reminder-summary → 401", anonSum.res.status === 401);
const staffSum = await call(wbStaffA, "/api/v1/crm/tasks/reminder-summary");
check("SUM4 viewer-class member can read (data:read)", staffSum.status === 200);

/* -------------------------------- AH cleanup ------------------------------- */
console.log("\n== AH CLEANUP ==");
section("AH");
// Fixture-scoped notification deletes: ONLY P37 task-anchored notifications (§184).
const p37TaskIds = (await db.crmTask.findMany({ where: { businessId: bizA, title: { startsWith: PREFIX } }, select: { id: true } })).map((r) => r.id);
const p37BTaskIds = (await db.crmTask.findMany({ where: { businessId: bizB, title: { startsWith: PREFIX } }, select: { id: true } })).map((r) => r.id);
const anchorIds = [...p37TaskIds, ...p37BTaskIds];
const p37Notifs = await db.notification.findMany({
  where: { OR: [{ businessId: bizA }, { businessId: bizB }] },
  select: { id: true, dataJson: true, type: true },
});
const deletable = p37Notifs.filter((n) => CRM_TYPES.includes(n.type) && anchorIds.some((id) => n.dataJson?.includes(id))).map((n) => n.id);
const delNotifs = await db.notification.deleteMany({ where: { id: { in: deletable } } });
check("AH1 fixture notifications deleted by identity", delNotifs.count === deletable.length, `${delNotifs.count}/${deletable.length}`);
await db.notificationDelivery.deleteMany({ where: { notificationId: { in: deletable } } }).catch(() => undefined);
// Audit rows are fixture-scoped deletes too (P37 tasks only).
await db.auditLog.deleteMany({ where: { businessId: { in: [bizA, bizB] }, entityId: { in: anchorIds } } }).catch(() => undefined);
await db.business.deleteMany({ where: { name: { startsWith: `${PREFIX}A-` } } });
await db.business.deleteMany({ where: { name: { startsWith: `${PREFIX}B-` } } });
await db.user.deleteMany({ where: { email: { contains: "p37-" } } });
const [b, u, c, t, nLeft] = await Promise.all([
  db.business.count({ where: { name: { startsWith: `${PREFIX}` } } }),
  db.user.count({ where: { email: { contains: "p37-" } } }),
  db.customer.count({ where: { name: { startsWith: `${PREFIX}` } } }),
  db.crmTask.count({ where: { title: { startsWith: `${PREFIX}` } } }),
  db.notification.count({ where: { type: { in: CRM_TYPES }, dataJson: { contains: PREFIX } } }),
]);
check("AH2 zero P37- leftovers", b + u + c + t + nLeft === 0, `biz=${b} users=${u} cust=${c} tasks=${t} notifs=${nLeft}`);
check("AH3 no dangling notification rows for deleted fixtures", (await db.notification.count({ where: { id: { in: deletable } } })) === 0);

/* --------------------------------- summary --------------------------------- */
const failedChecks = results.filter((r) => !r.ok);
console.log(`\nprompt37-crm-reminder-check: ${results.length - failedChecks.length}/${results.length} PASS`);
if (failedChecks.length > 0) {
  console.log("FAILURES:");
  for (const f of failedChecks) console.log(`  - ${f.name}`);
  process.exit(1);
}
console.log("P37 E2E GREEN ✓");
process.exit(0);
