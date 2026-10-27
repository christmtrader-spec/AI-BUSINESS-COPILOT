/**
 * R117 — browser-QA fixture, PHASE 1: fresh tenant + business with activity
 * ONLY inside the current 30d window (sale $120 + expense $50 today, NO
 * previous-window activity). Expected state:
 *   - Reports KPI chips: muted "New" ×4 (prev=0 & cur≠0 — L8 honest);
 *   - copilot trend follow-up HIDDEN (revenueChangePct null → hasTrendPct false).
 * PHASE 2 (r117-qa-backfill.ts) adds a 40-day-ago baseline so the chips turn
 * numeric and the follow-up appears.
 *
 * Output: JSON {email, password, businessId} for the browser step.
 * Sweep: "r117-qa@test.local" + prefix "R117 QA Ventures" are registered.
 */
import { PrismaClient } from "@prisma/client";
import { hashSync } from "bcryptjs";

const db = new PrismaClient();
const BASE = "http://localhost:3000";
const STAMP = Date.now().toString(36);
const EMAIL = "r117-qa@test.local";
const PW = "R117-Qa-2026!";
const BIZ = `R117 QA Ventures ${STAMP}`;

const DAY = 86_400_000;
const noonOf = (ms: number) => new Date(Math.floor(ms / DAY) * DAY + 12 * 3600_000).toISOString();

const existing = await db.user.findUnique({ where: { email: EMAIL } });
const user =
  existing ??
  (await db.user.create({
    data: { email: EMAIL, name: "R117 QA", passwordHash: hashSync(PW, 10), emailVerifiedAt: new Date() },
  }));

const jar = new Map<string, string>();
async function f(path: string, init: RequestInit = {}, bizId?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k, String(v)])) as Record<string, string>),
  };
  if (bizId) headers["x-business-id"] = bizId;
  if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
  const raw = res.headers.get("set-cookie");
  if (raw) {
    for (const piece of raw.split(/,(?=[^;]+=)/)) {
      const [pair] = piece.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  return res;
}
await f("/api/auth/csrf");
const csrfRes = await f("/api/auth/csrf");
const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
const loginRes = await f("/api/auth/callback/credentials", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ csrfToken, email: EMAIL, password: PW }).toString(),
});
const loc = loginRes.headers.get("location") ?? "";
if ((loginRes.status !== 302 && loginRes.status !== 200) || loc.includes("error=") || !jar.has("next-auth.session-token")) {
  console.error(`login failed: ${loginRes.status} ${loc.slice(0, 120)}`);
  process.exit(1);
}

const bizRes = await f("/api/v1/businesses", {
  method: "POST",
  body: JSON.stringify({ name: BIZ, currencyCode: "USD", locale: "en", timezone: "UTC" }),
});
const bizJson: any = await bizRes.json();
const BID = bizJson?.data?.business?.id;
if (!BID) {
  console.error(`business failed: ${bizRes.status} ${JSON.stringify(bizJson).slice(0, 160)}`);
  process.exit(1);
}

const cust = await f("/api/v1/customers", { method: "POST", body: JSON.stringify({ name: "Nimbus Labs", email: "billing@nimbus.test" }) }, BID);
const custJson: any = await cust.json();
const sale = await f(
  "/api/v1/sales",
  { method: "POST", body: JSON.stringify({ customerId: custJson?.data?.id, issueDate: noonOf(Date.now()), items: [{ name: "QA widget", unit: "pcs", qty: 3, unitPriceMinor: 4000 }] }) },
  BID,
);
const exp = await f(
  "/api/v1/expenses",
  { method: "POST", body: JSON.stringify({ description: "QA supplies", amountMinor: 5000, spentAt: noonOf(Date.now()), category: "supplies" }) },
  BID,
);

const ok = cust.status === 201 && sale.status === 201 && exp.status === 201;
console.log(JSON.stringify({ ok, phase: 1, email: EMAIL, password: PW, businessId: BID, businessName: BIZ, statuses: { cust: cust.status, sale: sale.status, exp: exp.status } }));
await db.$disconnect();
if (!ok) process.exit(1);
