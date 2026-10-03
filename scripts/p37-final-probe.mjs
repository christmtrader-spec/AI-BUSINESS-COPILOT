/**
 * p37-final-probe.mjs — DIAGNOSTIC-ONLY (Prompt 37-F §77).
 *
 * NOT part of the test suite and NOT a substitute for the real E2E harness
 * (scripts/prompt37-crm-reminder-check.mjs). Contains NO production logic:
 * it drives the same HTTP APIs a user would, prints a fresh PATCH→CLI dump
 * window for manual diagnosis of dueAt/reminder persistence, and cleans up
 * every fixture it creates (P37FINAL- prefix + its own user's notifications).
 * It prints only ephemeral fixture ids — no secrets, no real tenant data.
 *
 * Run: bun scripts/p37-final-probe.mjs   (dev server on :3000)
 */
/** DEFINITIVE: HTTP PATCH → parallel fresh dump + CLI debug. */
import { readFileSync } from "node:fs";
const BASE = "http://localhost:3000";
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const jar = new Map();
async function f(path, init = {}) {
  const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const headers = { "content-type": "application/json", "x-forwarded-for": "10.51.9.9", ...(init.headers ?? {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1));
  }
  return { status: res.status, body: await res.json().catch(() => null) };
}

const email = `p37final-${Date.now()}@test.local`;
await f("/api/v1/auth/register", { method: "POST", body: JSON.stringify({ name: "final", email, password: "testpass123" }) });
const csrf = (await f("/api/auth/csrf")).body?.csrfToken;
await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf, email, password: "testpass123", redirect: "false", json: "true" }).toString() });
const bizBody = (await f("/api/v1/businesses", { method: "POST", body: JSON.stringify({ name: `P37FINAL-${Date.now()}`, currencyCode: "USD", locale: "en" }) })).body;
const biz = bizBody?.data?.business?.id;
const ownerId = bizBody?.data?.business?.ownerId;
console.log("biz:", biz, "owner:", ownerId);
const cust = (await f("/api/v1/customers", { method: "POST", headers: { "x-business-id": biz }, body: JSON.stringify({ name: "P37FINAL-C" }) })).body?.data?.id;
const task = (await f("/api/v1/crm/tasks", { method: "POST", headers: { "x-business-id": biz }, body: JSON.stringify({ title: "P37FINAL-T", customerId: cust, assignedToUserId: ownerId, dueAt: new Date(Date.now() + 61 * 60_000).toISOString(), reminderEnabled: true, reminderMinutesBefore: 60 }) })).body?.data;
console.log("task:", task?.id, "due:", task?.dueAt, "assigned:", Boolean(task?.assignedTo));

const newDue = new Date(Date.now() + 59 * 60_000).toISOString();
const patch = await f(`/api/v1/crm/tasks/${task.id}`, { method: "PATCH", headers: { "x-business-id": biz }, body: JSON.stringify({ dueAt: newDue }) });
console.log("PATCH:", patch.status, "dueAt:", patch.body?.data?.dueAt, "expected:", newDue);

// Immediately: dump AND CLI in sequence with timestamps.
const dumpScript = `
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
db.crmTask.findFirst({ where: { id: "${task.id}" }, select: { dueAt: true, reminderEnabled: true, assignedToUserId: true } }).then(async (r) => { console.log("DUMP:", JSON.stringify(r)); await db.$disconnect(); });`;
const d1 = Bun.spawnSync({ cmd: ["bun", "-e", dumpScript], cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
console.log("t+0ms  ", d1.stdout.toString().trim());
const c1 = Bun.spawnSync({ cmd: ["bun", "scripts/process-crm-task-reminders.mjs", `--business-id=${biz}`], cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env, CRM_REMINDER_DEBUG: "1" } });
const debugLine = c1.stdout.toString().split("\n").find((l) => l.includes('"debug"'));
console.log("t+?ms  CLI:", debugLine?.slice(0, 260) ?? c1.stderr.toString().slice(0, 200));
const d2 = Bun.spawnSync({ cmd: ["bun", "-e", dumpScript], cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
console.log("t+after", d2.stdout.toString().trim());

// Cleanup
const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
await db.notification.deleteMany({ where: { userId: ownerId } });
await db.business.deleteMany({ where: { name: { startsWith: "P37FINAL-" } } });
await db.user.deleteMany({ where: { email: { contains: "p37final-" } } });
await db.$disconnect();
console.log("cleaned");
