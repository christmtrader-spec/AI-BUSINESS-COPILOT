/**
 * scripts/p36qa-fixtures.mjs — ephemeral browser-QA fixtures (setup | teardown).
 *
 *   bun scripts/p36qa-fixtures.mjs setup
 *   bun scripts/p36qa-fixtures.mjs teardown
 *
 * Fixtures are prefixed P36QA- / p36qa- and created through the REAL tenant
 * APIs exactly as the UI would. Includes a customer, lead, opportunity plus
 * pre-seeded activities/tasks so the timeline/work queue render immediately.
 * Teardown removes business (cascade) + user and verifies zero leftovers.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const BASE = "http://localhost:3000";
const PASS = "testpass123";
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

function randomXff() {
  return `10.47.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
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
  return { res, body };
}
async function login(jar, email, password) {
  const f = jarFetch(jar);
  const csrfRes = await f("/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const form = new URLSearchParams({ csrfToken, email, password, redirect: "false", json: "true" });
  await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  return [...jar.keys()].some((k) => k.includes("session-token"));
}
async function call(f, path, init = {}) {
  const { body } = await apiJson(f, path, init);
  return body?.ok ? body.data : null;
}

async function setup() {
  await db.business.deleteMany({ where: { name: { startsWith: "P36QA-" } } });
  await db.user.deleteMany({ where: { email: { contains: "p36qa-" } } });

  const email = `p36qa-owner-${Date.now()}@test.local`;
  const jar = new Map();
  const f = jarFetch(jar);
  const reg = await apiJson(f, "/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "P36QA Owner", email, password: PASS }),
  });
  if (!reg.body?.ok) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  if (!(await login(jar, email, PASS))) throw new Error("login failed");

  const ownerId = (await db.user.findUnique({ where: { email } }))?.id ?? null;

  // Business timezone Asia/Tehran (§119 timezone display check).
  const biz = await call(f, "/api/v1/businesses", {
    method: "POST",
    body: JSON.stringify({ name: `P36QA-${Date.now()}`, currencyCode: "USD", locale: "en", timezone: "Asia/Tehran" }),
  });
  const businessId = biz?.business?.id ?? biz?.id;
  if (!businessId) throw new Error("business create failed");
  const withBiz = (path, init = {}) =>
    f(path, { ...init, headers: { "x-business-id": businessId, ...(init.headers ?? {}) } });
  const post = async (path, body) => call(withBiz, path, { method: "POST", body: JSON.stringify(body) });

  const c1 = await post("/api/v1/customers", { name: "P36QA Alice", phone: "+989121111111", email: "alice@p36qa.test" });
  const customerId = c1?.customer?.id ?? c1?.id;
  const lead = await post("/api/v1/crm/leads", { name: "P36QA Dora Lead", source: "REFERRAL" });
  const leadId = lead?.id;
  const opp = await post("/api/v1/crm/opportunities", { title: "P36QA Enterprise Deal", customerId, expectedValueMinor: 250000 });
  const opportunityId = opp?.id;

  const now = Date.now();
  const act1 = await post("/api/v1/crm/activities", {
    type: "CALL",
    title: "P36QA Discovery call",
    description: "Discussed the migration plan and pricing.",
    occurredAt: new Date(now - 3600_000 * 26).toISOString(),
    durationMinutes: 30,
    customerId,
  });
  const act2 = await post("/api/v1/crm/activities", {
    type: "MEETING",
    title: "P36QA Kickoff meeting",
    description: "On-site kickoff with the ops team.",
    occurredAt: new Date(now - 3600_000 * 4).toISOString(),
    durationMinutes: 60,
    leadId,
  });
  const taskOverdue = await post("/api/v1/crm/tasks", {
    title: "P36QA Follow up with Alice",
    description: "Second call about the proposal.",
    priority: "URGENT",
    dueAt: new Date(now - 3600_000 * 2).toISOString(),
    customerId,
    assignedToUserId: ownerId,
  });
  const taskToday = await post("/api/v1/crm/tasks", {
    title: "P36QA Prepare proposal",
    priority: "HIGH",
    dueAt: new Date(now + 3600_000 * 3).toISOString(),
    leadId,
    assignedToUserId: ownerId,
  });
  const taskLater = await post("/api/v1/crm/tasks", {
    title: "P36QA Schedule demo",
    priority: "NORMAL",
    dueAt: new Date(now + 86400_000 * 3).toISOString(),
    opportunityId,
    assignedToUserId: ownerId,
  });
  const taskOpen = await post("/api/v1/crm/tasks", {
    title: "P36QA Send recap email",
    priority: "LOW",
    opportunityId,
    assignedToUserId: ownerId,
  });
  // One COMPLETED task for the reopen check.
  const taskDone = await post("/api/v1/crm/tasks", {
    title: "P36QA Draft agenda",
    priority: "NORMAL",
    customerId,
    assignedToUserId: ownerId,
  });
  if (taskDone?.id) {
    await call(withBiz, `/api/v1/crm/tasks/${taskDone.id}/status`, { method: "POST", body: JSON.stringify({ status: "COMPLETED" }) });
  }

  console.log(JSON.stringify({
    email, password: PASS, businessId,
    customerId, leadId, opportunityId,
    activityIds: [act1?.id, act2?.id],
    taskIds: { overdue: taskOverdue?.id, today: taskToday?.id, later: taskLater?.id, open: taskOpen?.id, done: taskDone?.id },
  }, null, 2));
}

async function teardown() {
  await db.business.deleteMany({ where: { name: { startsWith: "P36QA-" } } });
  await db.user.deleteMany({ where: { email: { contains: "p36qa-" } } });
  const [b, u, c, l, o, a, t] = await Promise.all([
    db.business.count({ where: { name: { startsWith: "P36QA-" } } }),
    db.user.count({ where: { email: { contains: "p36qa-" } } }),
    db.customer.count({ where: { name: { startsWith: "P36QA " } } }),
    db.crmLead.count({ where: { name: { startsWith: "P36QA " } } }),
    db.crmOpportunity.count({ where: { title: { startsWith: "P36QA " } } }),
    db.crmActivity.count({ where: { title: { startsWith: "P36QA " } } }),
    db.crmTask.count({ where: { title: { startsWith: "P36QA " } } }),
  ]);
  const leftover = b + u + c + l + o + a + t;
  console.log(leftover === 0 ? "TEARDOWN CLEAN ✓ (zero leftovers)" : `TEARDOWN LEFTOVERS: ${leftover}`);
  process.exit(leftover === 0 ? 0 : 1);
}

const mode = process.argv[2] ?? "setup";
if (mode === "teardown") await teardown();
else await setup();
