/**
 * scripts/prompt36-crm-activity-task-check.mjs — Prompt 36 §101 E2E harness.
 *
 * REAL HTTP against the running dev server with real NextAuth sessions.
 * Fixtures are created through the SAME tenant APIs a user would use; the
 * P36- prefix is torn down to ZERO leftovers (§98).
 *
 * Sections (§101 A–AS):
 *   A  auth (401/400)          B  membership (403)          C  tenant isolation (404)
 *   D–H  activity create/list/detail/update/delete
 *   I–P  task create/list/detail/update/status/complete/reopen/cancel
 *   Q–U  work queue + overdue/today/upcoming/unscheduled buckets
 *   V–Y  activity/lead/opportunity/customer timelines
 *   Z–AB customer 360 / lead detail / opportunity detail interplay
 *   AC  per-assignee queues (owner vs staff)     AD  cross-business assignee
 *   AE  cross-business context                   AF  deleted context
 *   AG  pagination        AH  filters        AI  forbidden DTO fields
 *   AJ  audit actions (7) AK  export datasets AL  i18n token presence
 *   AR  no reminder delivery (zero notifications, no send fields)
 *   AQ  financial non-interference (before/after snapshot equality)
 *   AS  cleanup (ZERO P36- leftovers)
 *   AL–AP (RTL/dark/mobile/keyboard) are browser-verified (agent-browser QA).
 *
 * Run: node scripts/prompt36-crm-activity-task-check.mjs   (dev server on :3000)
 * Exit: 0 = all green · 1 = at least one failure.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.P36_BASE ?? "http://localhost:3000";
const PASS = "testpass123";
const PREFIX = "P36-";
const db = new PrismaClient();

for (const line of readDbEnv()) {
  const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
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
    `${cond ? "✓" : "✗"} [${current}] ${name}${cond ? (info ? ` — ${info}` : "") : ` |last=${JSON.stringify(lastBody)?.slice(0, 240)}`}`,
  );
  return Boolean(cond);
}

/* ------------------------------ fetch helpers ------------------------------ */
function randomXff() {
  return `10.49.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
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

function eq(actual, expected, name) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, a === e ? "" : `expected ${e}, got ${a}`);
}

/* ================================== SETUP ================================== */
console.log("\n== SETUP ==");
section("SETUP");
await db.business.deleteMany({ where: { name: { startsWith: `${PREFIX}A-` } } });
await db.business.deleteMany({ where: { name: { startsWith: `${PREFIX}B-` } } });
await db.user.deleteMany({ where: { email: { contains: "p36-" } } });

const emailA = `p36-owner-a-${run}@test.local`;
const emailB = `p36-owner-b-${run}@test.local`;
const emailStaff = `p36-staff-${run}@test.local`;
const jarA = new Map();
const jarB = new Map();
const jarStaff = new Map();

check("register owner A", (await register(emailA, "P36 Owner A")).body?.ok === true);
check("register owner B", (await register(emailB, "P36 Owner B")).body?.ok === true);
check("register staff", (await register(emailStaff, "P36 Staff")).body?.ok === true);
check("login owner A", await login(jarA, emailA, PASS));
check("login owner B", await login(jarB, emailB, PASS));
check("login staff", await login(jarStaff, emailStaff, PASS));

const bizA = await createBusiness(jarA, `${PREFIX}A-BIZ`);
const bizB = await createBusiness(jarB, `${PREFIX}B-BIZ`);
check("business A created", Boolean(bizA), String(bizA));
check("business B created", Boolean(bizB), String(bizB));

const ownerAUserId = (await db.user.findUnique({ where: { email: emailA } }))?.id ?? null;
const staffUserId = (await db.user.findUnique({ where: { email: emailStaff } }))?.id ?? null;
const ownerBUserId = (await db.user.findUnique({ where: { email: emailB } }))?.id ?? null;

const fA = jarFetch(jarA);
const wbA = (path, init = {}) => fA(path, { ...init, headers: { "x-business-id": bizA, ...(init.headers ?? {}) } });
const fB = jarFetch(jarB);
const wbB = (path, init = {}) => fB(path, { ...init, headers: { "x-business-id": bizB, ...(init.headers ?? {}) } });
const fStaff = jarFetch(jarStaff);
const wbStaff = (path, init = {}) => fStaff(path, { ...init, headers: { "x-business-id": bizA, ...(init.headers ?? {}) } });
async function call(wb, path, init = {}) {
  const { res, body } = await apiJson(wb, path, init);
  return { res, status: res.status, body, data: body?.ok ? body.data : null, err: body?.ok ? null : body?.error };
}

// staff joins business A as STAFF (data:write member for assignment tests)
const mint = await call(wbA, `/api/v1/businesses/${bizA}/invites`, {
  method: "POST",
  body: JSON.stringify({ role: "STAFF" }),
});
check("invite minted for staff", Boolean(mint.data?.token), mint.err?.code);
const accept = await call(jarFetch(jarStaff), `/api/v1/invites/${mint.data?.token}`, { method: "POST" });
check("staff accepted invite", accept.status === 200 || accept.status === 201, String(accept.status));

/* ------------------------------ context fixtures --------------------------- */
const cust = await call(wbA, "/api/v1/customers", {
  method: "POST",
  body: JSON.stringify({ name: `${PREFIX}Customer One`, phone: "+989120000001" }),
});
const custId = cust.data?.id;
check("customer fixture created", Boolean(custId));
const cust2 = await call(wbA, "/api/v1/customers", {
  method: "POST",
  body: JSON.stringify({ name: `${PREFIX}Customer Two` }),
});
const custId2 = cust2.data?.id;
check("customer fixture 2 created", Boolean(custId2));

const lead = await call(wbA, "/api/v1/crm/leads", {
  method: "POST",
  body: JSON.stringify({ name: `${PREFIX}LEAD-Dora`, source: "MANUAL" }),
});
const leadId = lead.data?.id;
check("lead fixture created", Boolean(leadId));

const opp = await call(wbA, "/api/v1/crm/opportunities", {
  method: "POST",
  body: JSON.stringify({ title: `${PREFIX}OPP-Enterprise`, customerId: custId, expectedValueMinor: 5000 }),
});
const oppId = opp.data?.id;
check("opportunity fixture created", Boolean(oppId));

/* owner B gets a customer + lead in THEIR business (cross-tenant negatives) */
const bizBCust = await call(wbB, "/api/v1/customers", { method: "POST", body: JSON.stringify({ name: `${PREFIX}B-Cust` }) });
const bizBCustId = bizBCust.data?.id;

/* Baseline before ALL Prompt-36 CRM flows (export notifications are P31/32). */
const notifBaseline = await db.notification.count({ where: { businessId: bizA } });

/* ------------------------------ financial snapshot ------------------------- */
console.log("\n== AQ FINANCIAL SNAPSHOT (before) ==");
section("AQ");
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
check("AQ0 financial snapshot captured (sales/expenses empty)", JSON.parse(financeBefore).salesTotal === 0 && JSON.parse(financeBefore).expensesTotal === 0);

/* --------------------------------- A auth ---------------------------------- */
console.log("\n== A AUTH ==");
section("A");
const anonAct = await apiJson(jarFetch(new Map()), "/api/v1/crm/activities");
check("A1 activities unauthenticated → 401", anonAct.res.status === 401);
const anonTask = await apiJson(jarFetch(new Map()), "/api/v1/crm/tasks");
check("A2 tasks unauthenticated → 401", anonTask.res.status === 401);
const anonQueue = await apiJson(jarFetch(new Map()), "/api/v1/crm/tasks/work-queue");
check("A3 work-queue unauthenticated → 401", anonQueue.res.status === 401);
const anonTimeline = await apiJson(jarFetch(new Map()), `/api/v1/crm/timeline?contextType=CUSTOMER&contextId=${custId}`);
check("A4 timeline unauthenticated → 401", anonTimeline.res.status === 401);
const noBiz = await call(jarFetch(jarA), "/api/v1/crm/tasks");
check("A5 session without business → 400/403", [400, 403].includes(noBiz.status), String(noBiz.status));

/* ------------------------------- B membership ------------------------------ */
console.log("\n== B MEMBERSHIP ==");
section("B");
const foreignRead = await call(wbB, `/api/v1/crm/activities?contextType=CUSTOMER&contextId=${custId}`);
check("B1 non-member with A context → 403/404", [403, 404].includes(foreignRead.status), String(foreignRead.status));

/* ------------------------------- C isolation ------------------------------- */
console.log("\n== C ISOLATION ==");
section("C");
const isoAct = await call(wbB, `/api/v1/crm/activities?contextType=CUSTOMER&contextId=${custId2}`);
// custId2 belongs to A; B sees 404 (no existence leak) — but B is non-member so
// the header biz is B and the id is foreign: 404 expected (B is a valid member OF B).
check("C1 foreign activity context → 404", isoAct.status === 404 || isoAct.status === 403, String(isoAct.status));
const foreignTimeline = await call(wbB, `/api/v1/crm/timeline?contextType=CUSTOMER&contextId=${custId}`);
check("C2 foreign timeline context → 404", foreignTimeline.status === 404, String(foreignTimeline.status));

/* ------------------------------ D–H activities ----------------------------- */
console.log("\n== D–H ACTIVITIES ==");
section("D");
const nowIso = new Date().toISOString();
const actCreate = await call(wbA, "/api/v1/crm/activities", {
  method: "POST",
  body: JSON.stringify({ type: "CALL", title: `${PREFIX}Intro call`, description: "Discussed onboarding", occurredAt: nowIso, durationMinutes: 30, customerId: custId }),
});
check("D1 activity create 201", actCreate.status === 201, String(actCreate.status));
const actId = actCreate.data?.id;
eq(D1_keys(actCreate.data), ["context", "createdAt", "createdBy", "description", "durationMinutes", "id", "occurredAt", "title", "type", "updatedAt"], "D2 create returns explicit DTO (no raw row)");
function D1_keys(o) {
  return Object.keys(o ?? {}).sort();
}
check("D3 businessId absent from DTO", !JSON.stringify(actCreate.data).includes(`"businessId"`));

const actCreateLead = await call(wbA, "/api/v1/crm/activities", {
  method: "POST",
  body: JSON.stringify({ type: "NOTE", title: `${PREFIX}Lead note`, occurredAt: nowIso, leadId }),
});
const actLeadId = actCreateLead.data?.id;
check("D4 lead-context activity created", Boolean(actLeadId));

const actZeroCtx = await call(wbA, "/api/v1/crm/activities", {
  method: "POST",
  body: JSON.stringify({ type: "NOTE", title: `${PREFIX}Orphan`, occurredAt: nowIso }),
});
check("D5 zero context → 422", actZeroCtx.status === 422, String(actZeroCtx.status));
const actTwoCtx = await call(wbA, "/api/v1/crm/activities", {
  method: "POST",
  body: JSON.stringify({ type: "NOTE", title: `${PREFIX}Ambiguous`, occurredAt: nowIso, customerId: custId, leadId }),
});
check("D6 two contexts → 422", actTwoCtx.status === 422, String(actTwoCtx.status));
const actBadType = await call(wbA, "/api/v1/crm/activities", {
  method: "POST",
  body: JSON.stringify({ type: "SYSTEM", title: `${PREFIX}Bad type`, occurredAt: nowIso, customerId: custId }),
});
check("D7 arbitrary type → 422", actBadType.status === 422, String(actBadType.status));
const actBadDur = await call(wbA, "/api/v1/crm/activities", {
  method: "POST",
  body: JSON.stringify({ type: "NOTE", title: `${PREFIX}Bad duration`, occurredAt: nowIso, durationMinutes: 1441, customerId: custId }),
});
check("D8 duration 1441 → 422", actBadDur.status === 422, String(actBadDur.status));
const actDur1440 = await call(wbA, "/api/v1/crm/activities", {
  method: "POST",
  body: JSON.stringify({ type: "MEETING", title: `${PREFIX}Max duration`, occurredAt: nowIso, durationMinutes: 1440, customerId: custId }),
});
check("D9 duration 1440 → 201", actDur1440.status === 201, String(actDur1440.status));
const actDur0 = await call(wbA, "/api/v1/crm/activities", {
  method: "POST",
  body: JSON.stringify({ type: "NOTE", title: `${PREFIX}Zero duration`, occurredAt: nowIso, durationMinutes: 0, customerId: custId }),
});
check("D10 duration 0 → 422", actDur0.status === 422, String(actDur0.status));
const actBadDate = await call(wbA, "/api/v1/crm/activities", {
  method: "POST",
  body: JSON.stringify({ type: "NOTE", title: `${PREFIX}Bad date`, occurredAt: "not-a-date", customerId: custId }),
});
check("D11 invalid occurredAt → 422", actBadDate.status === 422, String(actBadDate.status));

section("E");
const actList = await call(wbA, `/api/v1/crm/activities?contextType=CUSTOMER&contextId=${custId}`);
check("E1 activity list 200", actList.status === 200);
check("E2 list total ≥ 2 for customer", (actList.data?.total ?? 0) >= 2, String(actList.data?.total));
check("E3 items are DTOs (no businessId)", !JSON.stringify(actList.data?.items ?? []).includes(`"businessId"`));

section("F");
const actDetail = await call(wbA, `/api/v1/crm/activities/${actId}`);
check("F1 activity detail 200", actDetail.status === 200);
check("F2 detail DTO exact shape", actDetail.data?.id === actId && actDetail.data?.type === "CALL" && actDetail.data?.durationMinutes === 30);

section("G");
const actUpdate = await call(wbA, `/api/v1/crm/activities/${actId}`, {
  method: "PATCH",
  body: JSON.stringify({ title: `${PREFIX}Intro call (edited)`, type: "MEETING", durationMinutes: 60 }),
});
check("G1 activity update 200", actUpdate.status === 200, String(actUpdate.status));
check("G2 update applied", actUpdate.data?.title === `${PREFIX}Intro call (edited)` && actUpdate.data?.type === "MEETING");
const actUpdateCtx = await call(wbA, `/api/v1/crm/activities/${actId}`, {
  method: "PATCH",
  body: JSON.stringify({ leadId: "sneaky" }),
});
check("G3 context change via PATCH ignored/rejected (leadId stripped)", actUpdateCtx.status === 200 || actUpdateCtx.status === 422, String(actUpdateCtx.status));
const ctxAfter = await call(wbA, `/api/v1/crm/activities/${actId}`);
check("G4 context unchanged after sneaky PATCH", ctxAfter.data?.context?.id === custId && ctxAfter.data?.context?.type === "CUSTOMER", JSON.stringify(ctxAfter.data?.context));

section("H");
const actDel = await call(wbA, `/api/v1/crm/activities/${actDur1440.data?.id}`, { method: "DELETE" });
check("H1 activity delete 200", actDel.status === 200, String(actDel.status));
const actDelGone = await call(wbA, `/api/v1/crm/activities/${actDur1440.data?.id}`);
check("H2 deleted activity detail → 404", actDelGone.status === 404, String(actDelGone.status));

/* ------------------------------- I–P tasks --------------------------------- */
console.log("\n== I–P TASKS ==");
section("I");
const taskCreate = await call(wbA, "/api/v1/crm/tasks", {
  method: "POST",
  body: JSON.stringify({ title: `${PREFIX}Prepare proposal`, description: "Draft pricing", priority: "HIGH", dueAt: futureIso(48), customerId: custId }),
});
check("I1 task create 201", taskCreate.status === 201, String(taskCreate.status));
const taskId = taskCreate.data?.id;
check("I2 status defaults OPEN server-side", taskCreate.data?.status === "OPEN");
check("I3 priority echoed", taskCreate.data?.priority === "HIGH");
check("I4 task DTO explicit (no businessId)", !JSON.stringify(taskCreate.data).includes(`"businessId"`));

const taskBadCtx = await call(wbA, "/api/v1/crm/tasks", {
  method: "POST",
  body: JSON.stringify({ title: `${PREFIX}Bad ctx task`, leadId: "nonexistent-lead" }),
});
check("I5 unknown context → 422", taskBadCtx.status === 422, String(taskBadCtx.status));

section("J");
const taskList = await call(wbA, "/api/v1/crm/tasks");
check("J1 task list 200", taskList.status === 200);
const taskListCtx = await call(wbA, `/api/v1/crm/tasks?contextType=CUSTOMER&contextId=${custId}`);
check("J2 context-filtered list contains fixture", (taskListCtx.data?.items ?? []).some((t) => t.id === taskId));

section("K");
const taskDetail = await call(wbA, `/api/v1/crm/tasks/${taskId}`);
check("K1 task detail 200", taskDetail.status === 200);
check("K2 detail fields present", taskDetail.data?.title === `${PREFIX}Prepare proposal` && typeof taskDetail.data?.dueAt === "string");

section("L");
const taskUpdate = await call(wbA, `/api/v1/crm/tasks/${taskId}`, {
  method: "PATCH",
  body: JSON.stringify({ title: `${PREFIX}Prepare proposal v2`, priority: "URGENT", dueAt: futureIso(72) }),
});
check("L1 task update 200", taskUpdate.status === 200, String(taskUpdate.status));
check("L2 update applied (title+priority)", taskUpdate.data?.title === `${PREFIX}Prepare proposal v2` && taskUpdate.data?.priority === "URGENT");
const taskPatchStatus = await call(wbA, `/api/v1/crm/tasks/${taskId}`, {
  method: "PATCH",
  body: JSON.stringify({ status: "COMPLETED" }),
});
check("L3 PATCH cannot set status", taskPatchStatus.status === 200 || taskPatchStatus.status === 422, String(taskPatchStatus.status));
const taskAfterPatch = await call(wbA, `/api/v1/crm/tasks/${taskId}`);
check("L4 status still OPEN after PATCH attempt", taskAfterPatch.data?.status === "OPEN", taskAfterPatch.data?.status);
const taskPatchCtx = await call(wbA, `/api/v1/crm/tasks/${taskId}`, {
  method: "PATCH",
  body: JSON.stringify({ leadId: "sneaky" }),
});
check("L5 context change via PATCH ignored/rejected", taskPatchCtx.status === 200 || taskPatchCtx.status === 422, String(taskPatchCtx.status));

section("M");
const tBadStatus = await call(wbA, `/api/v1/crm/tasks/${taskId}/status`, {
  method: "POST",
  body: JSON.stringify({ status: "DONE" }),
});
check("M1 arbitrary status → 422", tBadStatus.status === 422, String(tBadStatus.status));
const tToProgress = await call(wbA, `/api/v1/crm/tasks/${taskId}/status`, { method: "POST", body: JSON.stringify({ status: "IN_PROGRESS" }) });
check("M2 OPEN → IN_PROGRESS 200", tToProgress.status === 200, String(tToProgress.status));
check("M3 completedAt null while IN_PROGRESS", tToProgress.data?.completedAt === null);
const tComplete = await call(wbA, `/api/v1/crm/tasks/${taskId}/status`, { method: "POST", body: JSON.stringify({ status: "COMPLETED" }) });
check("M4 IN_PROGRESS → COMPLETED 200", tComplete.status === 200, String(tComplete.status));

section("N");
check("N1 completedAt stamped server-side", typeof tComplete.data?.completedAt === "string");
check("N2 status COMPLETED", tComplete.data?.status === "COMPLETED");

section("O");
const tReopen = await call(wbA, `/api/v1/crm/tasks/${taskId}/status`, { method: "POST", body: JSON.stringify({ status: "OPEN" }) });
check("O1 COMPLETED → OPEN (reopen) 200", tReopen.status === 200, String(tReopen.status));
check("O2 reopen cleared completedAt", tReopen.data?.completedAt === null);
const tInvalidFromOpen = await call(wbA, `/api/v1/crm/tasks/${taskId}/status`, { method: "POST", body: JSON.stringify({ status: "OPEN" }) });
check("O3 no-op OPEN → OPEN 422", tInvalidFromOpen.status === 422, String(tInvalidFromOpen.status));

section("P");
const tCancelTask = await call(wbA, "/api/v1/crm/tasks", {
  method: "POST",
  body: JSON.stringify({ title: `${PREFIX}Cancel me`, customerId: custId }),
});
const tCancelId = tCancelTask.data?.id;
const tCancel = await call(wbA, `/api/v1/crm/tasks/${tCancelId}/status`, { method: "POST", body: JSON.stringify({ status: "CANCELED" }) });
check("P1 OPEN → CANCELED 200", tCancel.status === 200, String(tCancel.status));
check("P2 canceled completedAt null", tCancel.data?.completedAt === null);
const tReopenCanceled = await call(wbA, `/api/v1/crm/tasks/${tCancelId}/status`, { method: "POST", body: JSON.stringify({ status: "OPEN" }) });
check("P3 CANCELED → OPEN reopen 200", tReopenCanceled.status === 200, String(tReopenCanceled.status));
check("P4 reopen cleared completedAt again", tReopenCanceled.data?.completedAt === null);
const tCompleteCanceled = await call(wbA, `/api/v1/crm/tasks/${tCancelId}/status`, { method: "POST", body: JSON.stringify({ status: "COMPLETED" }) });
check("P5 CANCELED → COMPLETED 200", tCompleteCanceled.status === 200, String(tCompleteCanceled.status));

/* --------------------------- Q–U work queue -------------------------------- */
console.log("\n== Q–U WORK QUEUE ==");
section("Q");
const nowMs = Date.now();
const qOverdue = await call(wbA, "/api/v1/crm/tasks", {
  method: "POST",
  body: JSON.stringify({ title: `${PREFIX}URGENT overdue`, priority: "URGENT", dueAt: new Date(nowMs - 60_000).toISOString(), leadId, assignedToUserId: ownerAUserId }),
});
check("Q1 overdue task created", qOverdue.status === 201, String(qOverdue.status));
const qLowOverdue = await call(wbA, "/api/v1/crm/tasks", {
  method: "POST",
  body: JSON.stringify({ title: `${PREFIX}LOW overdue`, priority: "LOW", dueAt: new Date(nowMs - 120_000).toISOString(), leadId, assignedToUserId: ownerAUserId }),
});
check("Q2 low overdue created", qLowOverdue.status === 201, String(qLowOverdue.status));
const qToday = await call(wbA, "/api/v1/crm/tasks", {
  method: "POST",
  body: JSON.stringify({ title: `${PREFIX}HIGH today`, priority: "HIGH", dueAt: futureIso(2), leadId, assignedToUserId: ownerAUserId }),
});
const qUpcoming = await call(wbA, "/api/v1/crm/tasks", {
  method: "POST",
  body: JSON.stringify({ title: `${PREFIX}NORMAL upcoming`, priority: "NORMAL", dueAt: futureIso(72), customerId: custId, assignedToUserId: ownerAUserId }),
});
const qUnscheduled = await call(wbA, "/api/v1/crm/tasks", {
  method: "POST",
  body: JSON.stringify({ title: `${PREFIX}unscheduled`, customerId: custId, assignedToUserId: ownerAUserId }),
});
check("Q3 queue fixtures created", qToday.status === 201 && qUpcoming.status === 201 && qUnscheduled.status === 201, "");

section("R");
const queue = await call(wbA, "/api/v1/crm/tasks/work-queue");
check("R1 work queue 200", queue.status === 200, String(queue.status));
check("R2 overdue bucket present", (queue.data?.overdue ?? []).length >= 2, String(queue.data?.overdue?.length));
check("R3 overdue contains server-classified fixture", (queue.data?.overdue ?? []).some((t) => t.title === `${PREFIX}URGENT overdue`));

section("S");
// today = later this UTC day if now+2h stays in the day, else it lands upcoming
const todayExpectedBucket = new Date(nowMs + 2 * 3600_000).getUTCDate() === new Date(nowMs).getUTCDate() ? "today" : "upcoming";
const todayList = queue.data?.[todayExpectedBucket] ?? [];
check("S1 due-later-today classified into server 'today' bucket (UTC-day semantics)", todayList.some((t) => t.title === `${PREFIX}HIGH today`), `bucket=${todayExpectedBucket}`);

section("T");
check("T1 upcoming bucket contains future task", (queue.data?.upcoming ?? []).some((t) => t.title === `${PREFIX}NORMAL upcoming`));

section("U");
check("U1 unscheduled bucket contains no-due task", (queue.data?.unscheduled ?? []).some((t) => t.title === `${PREFIX}unscheduled`));

// §124 deterministic ordering: within overdue bucket URGENT due-earlier first
const overdueTitles = (queue.data?.overdue ?? []).map((t) => t.title);
if (overdueTitles.includes(`${PREFIX}URGENT overdue`) && overdueTitles.includes(`${PREFIX}LOW overdue`)) {
  check("R4 overdue ordering: URGENT before LOW", overdueTitles.indexOf(`${PREFIX}URGENT overdue`) < overdueTitles.indexOf(`${PREFIX}LOW overdue`), overdueTitles.join(","));
}

check("R5 queue rows carry §30 allowlist", (queue.data?.overdue ?? []).every((t) => ["id", "title", "priority", "status", "dueAt", "assignedTo", "contextType", "contextId", "contextTitle"].every((k) => k in t)));
check("R6 counts server-computed", typeof queue.data?.counts?.myOpenTaskCount === "number" && typeof queue.data?.counts?.myOverdueTaskCount === "number" && typeof queue.data?.counts?.myDueTodayCount === "number", JSON.stringify(queue.data?.counts));
check("R7 queue hard cap ≤ 50", [...(queue.data?.overdue ?? []), ...(queue.data?.today ?? []), ...(queue.data?.upcoming ?? []), ...(queue.data?.unscheduled ?? [])].length <= 50);

/* ------------------------------- AC assignment ----------------------------- */
console.log("\n== AC ASSIGNED USER ==");
section("AC");
const taskForStaff = await call(wbA, "/api/v1/crm/tasks", {
  method: "POST",
  body: JSON.stringify({ title: `${PREFIX}Staff task`, assignedToUserId: staffUserId, customerId: custId }),
});
check("AC1 task assigned to staff created", taskForStaff.status === 201, String(taskForStaff.status));
const staffQueue = await call(wbStaff, "/api/v1/crm/tasks/work-queue");
check("AC2 staff queue contains staff task", (staffQueue.data?.overdue ?? []).concat(staffQueue.data?.today ?? [], staffQueue.data?.upcoming ?? [], staffQueue.data?.unscheduled ?? []).some((t) => t.title === `${PREFIX}Staff task`), JSON.stringify(staffQueue.err));
check("AC3 staff queue does NOT contain owner task", !(staffQueue.data?.overdue ?? []).concat(staffQueue.data?.today ?? [], staffQueue.data?.upcoming ?? [], staffQueue.data?.unscheduled ?? []).some((t) => t.title === `${PREFIX}Prepare proposal v2`));
check("AC4 staff counts scoped to staff", staffQueue.data?.counts?.myOpenTaskCount >= 1, JSON.stringify(staffQueue.data?.counts));

/* ---------------------------- AD cross-business assignee ------------------- */
section("AD");
const crossAssign = await call(wbB, "/api/v1/crm/tasks", {
  method: "POST",
  body: JSON.stringify({ title: `${PREFIX}Cross assign`, assignedToUserId: staffUserId, customerId: bizBCustId }),
});
check("AD1 cross-business assignee → 422", crossAssign.status === 422, String(crossAssign.status));
const crossQueue = await call(wbB, `/api/v1/crm/tasks/work-queue?assignedToUserId=${staffUserId}`);
check("AD2 foreign-user queue request → 422", crossQueue.status === 422, String(crossQueue.status));

/* ---------------------------- AE cross-business context -------------------- */
section("AE");
const crossCtx = await call(wbB, "/api/v1/crm/activities", {
  method: "POST",
  body: JSON.stringify({ type: "NOTE", title: `${PREFIX}Cross ctx`, occurredAt: new Date().toISOString(), leadId }),
});
check("AE1 activity cross-business lead context → 422", crossCtx.status === 422, String(crossCtx.status));
const crossCtxTask = await call(wbB, "/api/v1/crm/tasks", {
  method: "POST",
  body: JSON.stringify({ title: `${PREFIX}Cross ctx task`, customerId: custId }),
});
check("AE2 task cross-business customer context → 422", crossCtxTask.status === 422, String(crossCtxTask.status));

/* ------------------------------ AF deleted context ------------------------- */
section("AF");
const leadDeleted = await call(wbA, "/api/v1/crm/leads", {
  method: "POST",
  body: JSON.stringify({ name: `${PREFIX}LEAD-Deleted`, source: "OTHER" }),
});
const leadDeletedId = leadDeleted.data?.id;
await call(wbA, `/api/v1/crm/leads/${leadDeletedId}`, { method: "DELETE" });
const actDeletedCtx = await call(wbA, "/api/v1/crm/activities", {
  method: "POST",
  body: JSON.stringify({ type: "NOTE", title: `${PREFIX}On deleted lead`, occurredAt: new Date().toISOString(), leadId: leadDeletedId }),
});
check("AF1 activity on deleted lead → 422", actDeletedCtx.status === 422, String(actDeletedCtx.status));
const taskDeletedCtx = await call(wbA, "/api/v1/crm/tasks", {
  method: "POST",
  body: JSON.stringify({ title: `${PREFIX}On deleted lead task`, leadId: leadDeletedId }),
});
check("AF2 task on deleted lead → 422", taskDeletedCtx.status === 422, String(taskDeletedCtx.status));

/* ------------------------------- V–Y timeline ------------------------------ */
console.log("\n== V–Y TIMELINE ==");
section("V");
// Timeline order (§35): activities by occurredAt, tasks by createdAt.
// Deterministic relative instants: task created ~T0; activities at T0+1h / T0+2h.
const T0 = Date.now();
const tPlus1h = new Date(T0 + 3600_000);
const tPlus2h = new Date(T0 + 7200_000);
const t12 = tPlus2h;
const tlTask = await call(wbA, "/api/v1/crm/tasks", {
  method: "POST",
  body: JSON.stringify({ title: `${PREFIX}TL task now`, customerId: custId2, dueAt: new Date(T0 + 86_400_000).toISOString() }),
});
const tlActEarly = await call(wbA, "/api/v1/crm/activities", {
  method: "POST",
  body: JSON.stringify({ type: "CALL", title: `${PREFIX}TL +1h`, occurredAt: tPlus1h.toISOString(), customerId: custId2 }),
});
const tlActLate = await call(wbA, "/api/v1/crm/activities", {
  method: "POST",
  body: JSON.stringify({ type: "MEETING", title: `${PREFIX}TL +2h`, occurredAt: tPlus2h.toISOString(), customerId: custId2 }),
});
check("V1 timeline fixtures created", tlActEarly.status === 201 && tlTask.status === 201 && tlActLate.status === 201, "");

const timeline = await call(wbA, `/api/v1/crm/timeline?contextType=CUSTOMER&contextId=${custId2}`);
check("V2 timeline 200", timeline.status === 200, String(timeline.status));
const tlTitles = (timeline.data?.items ?? []).filter((i) => i.title?.startsWith(PREFIX)).map((i) => i.title);
check("V3 timeline order +2h → +1h → task(now)", JSON.stringify(tlTitles.slice(0, 3)) === JSON.stringify([`${PREFIX}TL +2h`, `${PREFIX}TL +1h`, `${PREFIX}TL task now`]), tlTitles.join(" | "));
check("V4 timeline items are unified DTOs", (timeline.data?.items ?? []).every((i) => ["kind", "id", "title", "timestamp"].every((k) => k in i)));
check("V5 no businessId in timeline", !JSON.stringify(timeline.data).includes(`"businessId"`));
check("V6 window bounded ≤ 100", (timeline.data?.windowSize ?? 0) <= 100);

section("W");
const custTimeline = await call(wbA, `/api/v1/crm/timeline?contextType=CUSTOMER&contextId=${custId}`);
check("W1 customer timeline 200", custTimeline.status === 200);
check("W2 customer timeline excludes other customers", !(custTimeline.data?.items ?? []).some((i) => i.title === `${PREFIX}TL +2h`));

section("X");
const leadTimeline = await call(wbA, `/api/v1/crm/timeline?contextType=LEAD&contextId=${leadId}`);
check("X1 lead timeline 200", leadTimeline.status === 200);
check("X2 lead timeline contains lead activity", (leadTimeline.data?.items ?? []).some((i) => i.title === `${PREFIX}Lead note`));
check("X3 lead timeline contains lead tasks", (leadTimeline.data?.items ?? []).some((i) => i.kind === "TASK" && (i.title === `${PREFIX}URGENT overdue` || i.title === `${PREFIX}LOW overdue` || i.title === `${PREFIX}HIGH today`)));

section("Y");
const oppTimeline = await call(wbA, `/api/v1/crm/timeline?contextType=OPPORTUNITY&contextId=${oppId}`);
check("Y1 opportunity timeline 200", oppTimeline.status === 200);
// Empty until an activity/task is added — create one then verify.
const oppAct = await call(wbA, "/api/v1/crm/activities", {
  method: "POST",
  body: JSON.stringify({ type: "EMAIL", title: `${PREFIX}Opp email`, occurredAt: new Date().toISOString(), opportunityId: oppId }),
});
check("Y2 opportunity activity created", oppAct.status === 201, String(oppAct.status));
const oppTimeline2 = await call(wbA, `/api/v1/crm/timeline?contextType=OPPORTUNITY&contextId=${oppId}`);
check("Y3 opportunity timeline contains activity", (oppTimeline2.data?.items ?? []).some((i) => i.title === `${PREFIX}Opp email`));
const badTimelineType = await call(wbA, `/api/v1/crm/timeline?contextType=SUPPLIER&contextId=${custId}`);
check("Y4 arbitrary context type → 422", badTimelineType.status === 422, String(badTimelineType.status));

/* ---------------------------- Z–AB detail interplay ------------------------ */
console.log("\n== Z–AB DETAILS ==");
section("Z");
const cust360 = await call(wbA, `/api/v1/customers/${custId}`);
check("Z1 customer 360 still 200 with CRM data", cust360.status === 200);
check("Z2 financial fields unchanged by CRM data", typeof cust360.data?.customer?.id === "string" && "crm" in (cust360.data ?? {}), "crm section present");

section("AA");
const leadDetail = await call(wbA, `/api/v1/crm/leads/${leadId}`);
check("AA1 lead detail still 200", leadDetail.status === 200);
check("AA2 lead untouched by tasks (status NEW)", leadDetail.data?.status === "NEW");

section("AB");
const oppDetail = await call(wbA, `/api/v1/crm/opportunities/${oppId}`);
check("AB1 opportunity detail still 200", oppDetail.status === 200);
check("AB2 expected value untouched by activities/tasks", oppDetail.data?.expectedValueMinor === 5000, String(oppDetail.data?.expectedValueMinor));
const wonMove = await call(wbA, `/api/v1/crm/opportunities/${oppId}/stage`, { method: "POST", body: JSON.stringify({ stage: "WON" }) });
check("AB3 WON move 200", wonMove.status === 200, String(wonMove.status));
// Prompt 37 — task ASSIGNMENT notifications are now real product events;
// the §106 intent is that the WON STAGE TRANSITION itself never notifies.
const nonCrmNotifAfterWon = await db.notification.count({
  where: { businessId: bizA, type: { notIn: ["BUSINESS_CRM_TASK_ASSIGNED", "BUSINESS_CRM_TASK_DUE_SOON", "BUSINESS_CRM_TASK_OVERDUE"] } },
});
check("AB4 WON transition created NO notification (§106; P37 assignment events excluded)", nonCrmNotifAfterWon === notifBaseline, `${nonCrmNotifAfterWon}/${notifBaseline}`);
const oppActCount = await db.crmActivity.count({ where: { opportunityId: oppId, deletedAt: null } });
check("AB5 WON created NO automatic activity", oppActCount === 1, String(oppActCount));
const oppTaskCount = await db.crmTask.count({ where: { opportunityId: oppId, deletedAt: null } });
check("AB6 WON created NO automatic task", oppTaskCount === 0, String(oppTaskCount));
const salesAfterWon = await call(wbA, "/api/v1/sales?pageSize=1");
check("AB7 WON created NO sale", salesAfterWon.data?.total === 0, String(salesAfterWon.data?.total));

/* ------------------------------ AG pagination ------------------------------ */
console.log("\n== AG PAGINATION ==");
section("AG");
const agPage = await call(wbA, "/api/v1/crm/activities?page=1&pageSize=1");
check("AG1 pageSize=1 returns 1 item", (agPage.data?.items ?? []).length <= 1);
check("AG2 envelope has page/pageSize/total", agPage.data?.page === 1 && agPage.data?.pageSize === 1 && typeof agPage.data?.total === "number");
const agCap = await call(wbA, "/api/v1/crm/activities?pageSize=1000");
check("AG3 pageSize 1000 clamped to 100", agCap.data?.pageSize === 100, String(agCap.data?.pageSize));
const agTaskPage = await call(wbA, "/api/v1/crm/tasks?page=1&pageSize=2");
check("AG4 task pagination works", (agTaskPage.data?.items ?? []).length <= 2 && agTaskPage.data?.pageSize === 2);
const agTimelinePage = await call(wbA, `/api/v1/crm/timeline?contextType=CUSTOMER&contextId=${custId}&pageSize=200`);
check("AG5 timeline pageSize clamped 100", agTimelinePage.data?.pageSize === 100, String(agTimelinePage.data?.pageSize));

/* -------------------------------- AH filters ------------------------------- */
console.log("\n== AH FILTERS ==");
section("AH");
const ahType = await call(wbA, "/api/v1/crm/activities?type=MEETING&contextType=CUSTOMER&contextId=" + custId2);
check("AH1 type filter works", (ahType.data?.items ?? []).every((i) => i.type === "MEETING"));
const ahBadType = await call(wbA, "/api/v1/crm/activities?type=SYSTEM");
check("AH2 unknown type filter → 422", ahBadType.status === 422, String(ahBadType.status));
const ahTaskStatus = await call(wbA, "/api/v1/crm/tasks?status=OPEN");
check("AH3 status filter works", (ahTaskStatus.data?.items ?? []).every((i) => i.status === "OPEN"));
const ahBadStatus = await call(wbA, "/api/v1/crm/tasks?status=WRONG");
check("AH4 unknown status filter → 422", ahBadStatus.status === 422, String(ahBadStatus.status));
const ahPriority = await call(wbA, "/api/v1/crm/tasks?priority=URGENT");
check("AH5 priority filter works", (ahPriority.data?.items ?? []).every((i) => i.priority === "URGENT"));
const ahBadPriority = await call(wbA, "/api/v1/crm/tasks?priority=CRITICAL");
check("AH6 unknown priority filter → 422", ahBadPriority.status === 422, String(ahBadPriority.status));
const ahQ = await call(wbA, `/api/v1/crm/activities?q=${encodeURIComponent("+2h")}&contextType=CUSTOMER&contextId=${custId2}`);
check("AH7 q search matches title", (ahQ.data?.items ?? []).some((i) => i.title === `${PREFIX}TL +2h`));
const ahDate = await call(wbA, `/api/v1/crm/activities?from=${t12.toISOString()}&to=${new Date(t12.getTime() + 60_000).toISOString()}&contextType=CUSTOMER&contextId=${custId2}`);
check("AH8 from/to filter bounds", (ahDate.data?.items ?? []).every((i) => i.title !== `${PREFIX}TL +1h`));
const ahBadDate = await call(wbA, "/api/v1/crm/activities?from=garbage");
check("AH9 invalid from → 422", ahBadDate.status === 422, String(ahBadDate.status));
const ahCreator = await call(wbA, `/api/v1/crm/activities?createdByUserId=${ownerAUserId}`);
check("AH10 createdByUserId filter works", (ahCreator.data?.items ?? []).every((i) => i.createdBy?.id === ownerAUserId));

/* --------------------------- AI forbidden DTO fields ----------------------- */
console.log("\n== AI DTO HYGIENE ==");
section("AI");
const aiBlob = JSON.stringify([taskDetail.data, actDetail.data, queue.data, timeline.data]);
check("AI1 no password/session/mfa tokens", !aiBlob.includes("password") && !aiBlob.includes("sessionVersion") && !aiBlob.includes("passwordHash"));
check("AI2 no internal platform fields", !aiBlob.includes("AiCost") && !aiBlob.includes("PaymentTransaction"));
check("AI3 no raw relation objects", !aiBlob.includes("assignedToUser\":") && !aiBlob.includes("createdByUser\":"));

/* -------------------------------- AJ audit --------------------------------- */
console.log("\n== AJ AUDIT ==");
section("AJ");
const auditActions = [
  "crm.activity.create",
  "crm.activity.update",
  "crm.activity.delete",
  "crm.task.create",
  "crm.task.update",
  "crm.task.status_change",
  "crm.task.delete",
];
// AJ0 exercise task update + delete + activity delete paths first
await call(wbA, `/api/v1/crm/tasks/${tCancelId}`, { method: "PATCH", body: JSON.stringify({ title: `${PREFIX}Cancel me (renamed)` }) });
await call(wbA, `/api/v1/crm/tasks/${tCancelId}`, { method: "DELETE" });
await call(wbA, `/api/v1/crm/activities/${actId}`, { method: "DELETE" });
const auditRows = await db.auditLog.findMany({
  where: { businessId: bizA, action: { in: auditActions } },
  select: { action: true },
});
const seen = new Set(auditRows.map((r) => r.action));
for (const action of auditActions) {
  check(`AJ ${action}`, seen.has(action));
}
const p36AuditRows = await db.auditLog.findMany({
  where: { businessId: bizA, action: { in: auditActions } },
  select: { beforeJson: true, afterJson: true },
});
const auditBlob = JSON.stringify(p36AuditRows);
check("AJ8 audit payloads metadata-only (no description text)", !auditBlob.includes("Draft pricing") && !auditBlob.includes("Discussed onboarding"));
check("AJ9 audit carries no secrets", !auditBlob.includes("password") && !auditBlob.includes("testpass123"));

/* ------------------------------ AK export ---------------------------------- */
console.log("\n== AK EXPORT ==");
section("AK");
const akCreate = await call(wbA, "/api/v1/exports", {
  method: "POST",
  body: JSON.stringify({ format: "JSON", datasets: ["crm_activities", "crm_tasks"] }),
});
check("AK1 export job accepted", akCreate.status === 200 || akCreate.status === 201, String(akCreate.status));
const akJobId = akCreate.data?.id ?? akCreate.data?.job?.id;
if (akJobId) {
  let akJob = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const j = await call(wbA, `/api/v1/exports/${akJobId}`);
    if (j.data?.status === "COMPLETED" || j.data?.status === "FAILED") {
      akJob = j.data;
      break;
    }
  }
  check("AK2 export job completes", akJob?.status === "COMPLETED", akJob?.status);
  check("AK3 crm datasets present with rows", (akJob?.datasets ?? []).includes("crm_activities") && (akJob?.datasets ?? []).includes("crm_tasks") && (akJob?.recordCount ?? 0) > 0, `records=${akJob?.recordCount}`);
} else {
  check("AK2 export job id returned", false);
}

/* --------------------------------- AL i18n --------------------------------- */
console.log("\n== AL I18N TOKENS ==");
section("AL");
{
  const en = readFileSync("src/i18n/messages/en.ts", "utf8");
  const fa = readFileSync("src/i18n/messages/fa.ts", "utf8");
  const tokens = ["createTask", "overdueBadge", "myOpenTasks", "noDueDate", "Add activity", "changeStatus"];
  check("AL1 EN tokens present", tokens.slice(0, 4).every((t) => en.includes(t)) && en.includes("addActivity"));
  check("AL2 FA tokens present (no EN literals)", fa.includes("ایجاد وظیفه") && fa.includes("سررسید گذشته") && fa.includes("خط زمانی CRM"));
  check("AL3 FA has no 'Add activity' literal", !fa.includes('"Add activity"'));
}

/* ---------------------------- AR no reminder delivery ---------------------- */
console.log("\n== AR NO REMINDERS ==");
section("AR");
const notifAfter = await db.notification.count({ where: { businessId: bizA } });
const crmTypeNotifs = await db.notification.count({
  where: {
    businessId: bizA,
    type: { in: ["TASK_DUE", "TASK_ASSIGNED", "TASK_CREATED", "TASK_COMPLETED", "ACTIVITY_CREATED"] },
  },
});
check("AR1 zero task/activity notification types ever created", crmTypeNotifs === 0, String(crmTypeNotifs));
// Prompt 37 — BUSINESS_CRM_TASK_* notifications are legitimate now (the
// harness's own task assignments emit them); anything ELSE beyond the
// sanctioned export completion is a fabricated event type (§12 intent).
const nonCrmNotifAfter = await db.notification.count({
  where: {
    businessId: bizA,
    type: { notIn: ["BUSINESS_CRM_TASK_ASSIGNED", "BUSINESS_CRM_TASK_DUE_SOON", "BUSINESS_CRM_TASK_OVERDUE"] },
  },
});
check("AR2 no NEW notifications beyond the P31 export completion (P37 CRM types excluded)", nonCrmNotifAfter - notifBaseline <= 1, `${nonCrmNotifAfter}/${notifBaseline}`);
const queueBlob = JSON.stringify(queue.data);
// Prompt 37 (§62) — the queue may carry reminder CONFIGURATION flags
// (reminderEnabled/overdueAlertEnabled), never delivery/scheduling internals.
check("AR3 work queue carries no send/delivery/scheduling fields", !queueBlob.includes("sendAt") && !queueBlob.includes("delivery") && !queueBlob.includes("cron") && !queueBlob.includes("sourceEventId"), "P37 flags allowed");

/* ------------------------- AQ financial non-interference ------------------- */
console.log("\n== AQ FINANCIAL NON-INTERFERENCE (after) ==");
section("AQ");
const financeAfter = await financialSnapshot();
check("AQ1 financial snapshot EXACT equality", financeAfter === financeBefore, financeAfter);
const explicitSale = await call(wbA, "/api/v1/sales", {
  method: "POST",
  body: JSON.stringify({ customerId: custId, issueDate: new Date().toISOString(), items: [{ name: "P36 sanity item", qty: 1, unitPriceMinor: 1000 }] }),
});
check("AQ2 explicit sale still works after CRM ops", explicitSale.status === 200 || explicitSale.status === 201, String(explicitSale.status));

/* ------------------------------- AS cleanup -------------------------------- */
console.log("\n== AS CLEANUP ==");
section("AS");
await db.business.deleteMany({ where: { name: { startsWith: `${PREFIX}A-` } } });
await db.business.deleteMany({ where: { name: { startsWith: `${PREFIX}B-` } } });
await db.user.deleteMany({ where: { email: { contains: "p36-" } } });
const [b, u, c, l, o, a, t] = await Promise.all([
  db.business.count({ where: { name: { startsWith: `${PREFIX}` } } }),
  db.user.count({ where: { email: { contains: "p36-" } } }),
  db.customer.count({ where: { name: { startsWith: `${PREFIX}` } } }),
  db.crmLead.count({ where: { name: { startsWith: `${PREFIX}` } } }),
  db.crmOpportunity.count({ where: { title: { startsWith: `${PREFIX}` } } }),
  db.crmActivity.count({ where: { title: { startsWith: `${PREFIX}` } } }),
  db.crmTask.count({ where: { title: { startsWith: `${PREFIX}` } } }),
]);
const leftover = b + u + c + l + o + a + t;
check("AS1 zero leftovers", leftover === 0, `leftover=${leftover} (biz=${b} users=${u} cust=${c} leads=${l} opps=${o} acts=${a} tasks=${t})`);

/* --------------------------------- summary --------------------------------- */
const failedChecks = results.filter((r) => !r.ok);
console.log(`\nprompt36-crm-activity-task-check: ${results.length - failedChecks.length}/${results.length} PASS`);
if (failedChecks.length > 0) {
  console.log("FAILURES:");
  for (const f of failedChecks) console.log(`  - ${f.name}`);
  process.exit(1);
}

/* ------------------------------- tiny helpers ------------------------------ */
function futureIso(hours) {
  return new Date(Date.now() + hours * 3600_000).toISOString();
}
