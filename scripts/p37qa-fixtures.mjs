/** P37 browser-QA fixtures: user + business (Tehran) + customers + tasks with reminders. */
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
const BASE = "http://localhost:3000";
const PASS = "testpass123";
const jar = new Map();

async function f(path, init = {}) {
  const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const headers = { "content-type": "application/json", "x-forwarded-for": "10.51.11.7", ...(init.headers ?? {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1));
  }
  return { status: res.status, body: await res.json().catch(() => null) };
}

// Teardown-first (idempotent)
await db.business.deleteMany({ where: { name: { startsWith: "P37QA-" } } });
await db.user.deleteMany({ where: { email: { contains: "p37qa-" } } });

const email = `p37qa-owner-${Date.now()}@test.local`;
await f("/api/v1/auth/register", { method: "POST", body: JSON.stringify({ name: "P37QA Owner", email, password: PASS }) });
const csrf = (await f("/api/auth/csrf")).body?.csrfToken;
await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf, email, password: PASS, redirect: "false", json: "true" }).toString() });
const biz = (await f("/api/v1/businesses", { method: "POST", body: JSON.stringify({ name: `P37QA-BIZ-${Date.now()}`, currencyCode: "USD", locale: "en", timezone: "Asia/Tehran" }) })).body?.data?.business;
console.log("QA business:", biz?.id, "timezone:", biz?.timezone);
const cust = (await f("/api/v1/customers", { method: "POST", headers: { "x-business-id": biz.id }, body: JSON.stringify({ name: "P37QA Acme GmbH" }) })).body?.data?.id;
const ownerId = (await db.user.findUnique({ where: { email } })).id;

const H = { "x-business-id": biz.id };
const due = (m) => new Date(Date.now() + m * 60_000).toISOString();
// Overdue + alert
await f("/api/v1/crm/tasks", { method: "POST", headers: H, body: JSON.stringify({ title: "P37QA Overdue call", customerId: cust, assignedToUserId: ownerId, dueAt: due(-30), reminderEnabled: true, reminderMinutesBefore: 60, overdueAlertEnabled: true, priority: "URGENT" }) });
// Due soon (reminder window open)
await f("/api/v1/crm/tasks", { method: "POST", headers: H, body: JSON.stringify({ title: "P37QA Proposal follow-up", customerId: cust, assignedToUserId: ownerId, dueAt: due(45), reminderEnabled: true, reminderMinutesBefore: 60, priority: "HIGH" }) });
// Upcoming reminder (window opens later today-ish)
await f("/api/v1/crm/tasks", { method: "POST", headers: H, body: JSON.stringify({ title: "P37QA Contract review", customerId: cust, assignedToUserId: ownerId, dueAt: due(60 * 30), reminderEnabled: true, reminderMinutesBefore: 10080 }) });
// Plain task
await f("/api/v1/crm/tasks", { method: "POST", headers: H, body: JSON.stringify({ title: "P37QA Plain task", customerId: cust, assignedToUserId: ownerId }) });
// Generate the assignment notification rows for the QA owner (fire-safe landed)
await new Promise((r) => setTimeout(r, 600));

// Reminder summary check
const sum = await f("/api/v1/crm/tasks/reminder-summary", { headers: H });
console.log("reminder-summary:", JSON.stringify(sum.body?.data));

console.log("QA_LOGIN_EMAIL=" + email);
console.log("QA_BIZ=" + biz.id);
await db.$disconnect();
