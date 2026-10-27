/**
 * R131 — browser-QA fixture: fresh persona + business seeded via REAL APIs
 * with activity in BOTH windows so the trend chips exercise every state:
 *   current:  sale $100 + expense $30 + IN $40           (net cash +$40)
 *   previous: sale $200 + expense $50 + OUT $40 (edge day, net cash −$40)
 *   → revenue −50% (rose ↓), collected "New" (prev 0)... 
 *     NOTE: previous collected = 0 → collected chip = muted "New";
 *           expenses −40% (emerald ↓ — spending less is GOOD);
 *           net cash pct null on the −$40 baseline → muted "—".
 * Prints the credentials + summary for the browser QA step. Self-cleaning:
 * the persona email matches the r104 sweep patterns via %r131-qa@test.local.
 */
import { PrismaClient } from "@prisma/client";
import { hashSync } from "bcryptjs";

const db = new PrismaClient();
const BASE = "http://localhost:3000";
const EMAIL = `r131-qa-${Date.now().toString(36)}@test.local`;
const PW = "R131-QA-2026!";

function mkJar() {
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
  return { jar, f };
}

const noonOf = (key) => `${key}T12:00:00.000Z`;
const addDays = (key, n) => {
  const dt = new Date(`${key}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};

const user = mkJar();
// 1) user via Prisma (battery pattern) + session via the REAL CSRF callback
await db.user.upsert({
  where: { email: EMAIL },
  update: {},
  create: { email: EMAIL, name: "R131 QA", passwordHash: hashSync(PW, 10), emailVerifiedAt: new Date() },
});
const csrfRes = await user.f("/api/auth/csrf");
const { csrfToken } = await csrfRes.json();
const login = await user.f("/api/auth/callback/credentials", {
  method: "POST",
  body: JSON.stringify({ csrfToken, email: EMAIL, password: PW, redirect: false }),
});
if (login.status >= 400) throw new Error(`login failed: ${login.status}`);
// 2) business
const biz = await user.f("/api/v1/businesses", {
  method: "POST",
  body: JSON.stringify({ name: `R131 QA Ventures trend-${Date.now().toString(36)}`, currencyCode: "USD", locale: "en", timezone: "UTC" }),
});
const bizJson = await biz.json();
const BID = bizJson?.data?.business?.id;
if (!BID) throw new Error(`business create failed: ${biz.status}`);
// 3) anchor window
const empty = await (await user.f("/api/v1/reports/summary?days=30", {}, BID)).json();
const from = empty?.data?.range?.from;
if (!from) throw new Error("no anchor range");
const todayKey = addDays(from, 29);
const edgeKey = addDays(from, -1);
// 4) seed
const cust = await (await user.f("/api/v1/customers", { method: "POST", body: JSON.stringify({ name: "Trend Labs" }) }, BID)).json();
const mkSale = (date, qty, name) =>
  user.f("/api/v1/sales", { method: "POST", body: JSON.stringify({ customerId: cust.data.id, issueDate: noonOf(date), items: [{ name, unit: "pcs", qty, unitPriceMinor: 10000 }] }) }, BID);
const saleNow = await (await mkSale(todayKey, 1, "Now widget")).json();
const salePrev = await (await mkSale(edgeKey, 2, "Edge widget")).json();
const expNow = await (await user.f("/api/v1/expenses", { method: "POST", body: JSON.stringify({ description: "Now rent", amountMinor: 3000, spentAt: noonOf(todayKey), category: "rent" }) }, BID)).json();
const expPrev = await (await user.f("/api/v1/expenses", { method: "POST", body: JSON.stringify({ description: "Edge rent", amountMinor: 5000, spentAt: noonOf(edgeKey), category: "rent" }) }, BID)).json();
const payInNow = await user.f("/api/v1/payments", { method: "POST", body: JSON.stringify({ saleId: saleNow?.data?.id ?? saleNow?.data?.sale?.id, amountMinor: 4000, method: "CASH", paidAt: noonOf(todayKey) }) }, BID);
const payOutPrev = await user.f("/api/v1/payments", { method: "POST", body: JSON.stringify({ expenseId: expPrev?.data?.id ?? expPrev?.data?.expense?.id, amountMinor: 4000, method: "BANK_TRANSFER", paidAt: noonOf(edgeKey) }) }, BID);
// 5) verify the trend block
const sum = await (await user.f("/api/v1/reports/summary?days=30", {}, BID)).json();
console.log(JSON.stringify({
  email: EMAIL,
  password: PW,
  businessId: BID,
  seeded: { saleNow: !!saleNow, salePrev: !!salePrev, payIn: payInNow.status, payOut: payOutPrev.status },
  trend: sum?.data?.trend,
}, null, 2));
await db.$disconnect();
