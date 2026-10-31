/**
 * scripts/r136-topup-qa-activity.mjs — one-shot: add the r131 both-window
 * activity to an ALREADY-EXISTING QA persona/business (the seed crashed
 * mid-way on the OOM-cycling dev server; the persona + business survived,
 * the records did not). Same record shapes as r131-qa-seed.mjs —
 * current: sale $100 + expense $30 + IN $40; previous: sale $200 +
 * expense $50 + OUT $40.
 *
 * Run: bun scripts/r136-topup-qa-activity.mjs
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const BASE = "http://localhost:3000";
const EMAIL = process.env.R136_QA_EMAIL ?? "r131-qa-mvuulsrx@test.local";
const PW = "R131-QA-2026!";
const BID = process.env.R136_QA_BID ?? "cmvuullx6000bqaph0tkqv2fm";

const jar = new Map();
const f = async (path, init = {}, bizId) => {
  const headers = { "content-type": "application/json" };
  if (bizId) headers["x-business-id"] = bizId;
  if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
  const raw = res.headers.get("set-cookie");
  if (raw) for (const piece of raw.split(/,(?=[^;]+=)/)) {
    const [pair] = piece.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return res;
};

const noonOf = (key) => `${key}T12:00:00.000Z`;
const addDays = (key, n) => {
  const dt = new Date(`${key}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};

const csrfRes = await f("/api/auth/csrf");
const { csrfToken } = await csrfRes.json();
const login = await f("/api/auth/callback/credentials", {
  method: "POST",
  body: JSON.stringify({ csrfToken, email: EMAIL, password: PW, redirect: false }),
});
if (login.status >= 400) throw new Error(`login failed: ${login.status}`);

const empty = await (await f("/api/v1/reports/summary?days=30", {}, BID)).json();
const from = empty?.data?.range?.from;
if (!from) throw new Error(`no anchor range: ${JSON.stringify(empty).slice(0, 160)}`);
const todayKey = addDays(from, 29);
const edgeKey = addDays(from, -1);

const cust = await (await f("/api/v1/customers", { method: "POST", body: JSON.stringify({ name: "Trend Labs" }) }, BID)).json();
const mkSale = (date, qty, name) =>
  f("/api/v1/sales", { method: "POST", body: JSON.stringify({ customerId: cust.data.id, issueDate: noonOf(date), items: [{ name, unit: "pcs", qty, unitPriceMinor: 10000 }] }) }, BID);
const saleNow = await (await mkSale(todayKey, 1, "Now widget")).json();
const salePrev = await (await mkSale(edgeKey, 2, "Edge widget")).json();
const expNow = await (await f("/api/v1/expenses", { method: "POST", body: JSON.stringify({ description: "Now rent", amountMinor: 3000, spentAt: noonOf(todayKey), category: "rent" }) }, BID)).json();
const expPrev = await (await f("/api/v1/expenses", { method: "POST", body: JSON.stringify({ description: "Edge rent", amountMinor: 5000, spentAt: noonOf(edgeKey), category: "rent" }) }, BID)).json();
const payInNow = await f("/api/v1/payments", { method: "POST", body: JSON.stringify({ saleId: saleNow?.data?.id ?? saleNow?.data?.sale?.id, amountMinor: 4000, method: "CASH", paidAt: noonOf(todayKey) }) }, BID);
const payOutPrev = await f("/api/v1/payments", { method: "POST", body: JSON.stringify({ expenseId: expPrev?.data?.id ?? expPrev?.data?.expense?.id, amountMinor: 4000, method: "BANK_TRANSFER", paidAt: noonOf(edgeKey) }) }, BID);

const sum = await (await f("/api/v1/reports/summary?days=30", {}, BID)).json();
console.log(JSON.stringify({
  seeded: { saleNow: saleNow?.ok, salePrev: salePrev?.ok, expNow: expNow?.ok, expPrev: expPrev?.ok, payIn: payInNow.status, payOut: payOutPrev.status },
  trend: sum?.data?.trend ? { revenue: sum.data.kpis?.revenueMinor, prevRevenue: sum.data.trend.revenuePrevMinor } : null,
}, null, 1));
await db.$disconnect();
