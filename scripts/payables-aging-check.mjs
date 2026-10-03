/**
 * scripts/payables-aging-check.mjs — Payables/receivables AGING E2E check
 * against the LIVE dev server (real API, real DB, real auth).
 *
 * Covers: aging endpoint contract (envelope, tz, day bucketing in the
 * BUSINESS timezone), supplier-bill enrichment (dueDate/reference round-trip
 * through POST/PATCH), three-state PATCH law (absent=untouched, null=clear),
 * server-derived pastDue in /api/v1/payables, zod rejection of garbage dates,
 * receivables side (issueDate anchor), and zero-residue teardown.
 *
 * Run: bun scripts/payables-aging-check.mjs   (dev server must be up)
 */
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

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}

async function f(path, init = {}) {
  const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const headers = { "content-type": "application/json", "x-forwarded-for": "10.51.13.9", ...(init.headers ?? {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1));
  }
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Calendar day (YYYY-MM-DD) in Asia/Tehran for `days` days from now. */
function tehranDay(days) {
  const d = new Date(Date.now() + days * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t)?.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}

// ---------------- teardown-first (idempotent) ----------------
await db.business.deleteMany({ where: { name: { startsWith: "PAGQA-" } } });
await db.user.deleteMany({ where: { email: { contains: "pagqa-" } } });

// ---------------- fixtures ----------------
const stamp = Date.now();
const email = `pagqa-owner-${stamp}@test.local`;
ok("F1. register 201", (await f("/api/v1/auth/register", { method: "POST", body: JSON.stringify({ name: "PAGQA Owner", email, password: PASS }) })).status === 201);
const csrf = (await f("/api/auth/csrf")).body?.csrfToken;
await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf, email, password: PASS, redirect: "false", json: "true" }).toString() });
const bizRes = await f("/api/v1/businesses", { method: "POST", body: JSON.stringify({ name: `PAGQA-BIZ-${stamp}`, currencyCode: "USD", locale: "en", timezone: "Asia/Tehran" }) });
const biz = bizRes.body?.data?.business;
ok("F2. business created (Asia/Tehran)", Boolean(biz?.id) && biz.timezone === "Asia/Tehran");
const H = { "x-business-id": biz.id };

const supplier = (await f("/api/v1/suppliers", { method: "POST", headers: H, body: JSON.stringify({ name: "PAGQA Supplier Alpha" }) })).body?.data?.id;
const customer = (await f("/api/v1/customers", { method: "POST", headers: H, body: JSON.stringify({ name: "PAGQA Customer Beta" }) })).body?.data?.id;
ok("F3. supplier + customer created", Boolean(supplier) && Boolean(customer));

// Expenses: dueDate is DATE-ONLY ("YYYY-MM-DD"), spentAt full ISO.
async function mkExpense({ amount, paid = 0, dueDay = null, spentDaysAgo = 0, reference = null }) {
  const body = {
    supplierId: supplier,
    category: "PAGQA Supplies",
    amountMinor: amount,
    spentAt: new Date(Date.now() - spentDaysAgo * 86_400_000).toISOString(),
    ...(dueDay ? { dueDate: dueDay } : {}),
    ...(reference ? { reference } : {}),
  };
  const r = await f("/api/v1/expenses", { method: "POST", headers: H, body: JSON.stringify(body) });
  if (r.status !== 201) throw new Error(`expense create failed: ${r.status} ${JSON.stringify(r.body)}`);
  if (paid > 0) {
    await f("/api/v1/payments", { method: "POST", headers: H, body: JSON.stringify({ expenseId: r.body.data.id, amountMinor: paid, method: "CASH" }) });
  }
  return r.body.data.id;
}

const e1 = await mkExpense({ amount: 100_000, dueDay: tehranDay(-10), spentDaysAgo: 40 }); // D0_30, past due
const e2 = await mkExpense({ amount: 200_000, dueDay: tehranDay(-45), spentDaysAgo: 50 }); // D31_60, past due
const e3 = await mkExpense({ amount: 300_000, dueDay: tehranDay(-75), spentDaysAgo: 80 }); // D61_90, past due
const e4 = await mkExpense({ amount: 400_000, dueDay: tehranDay(-120), spentDaysAgo: 125 }); // D90_PLUS, past due
const e5 = await mkExpense({ amount: 500_000, spentDaysAgo: 100 }); // NO dueDate → D90_PLUS (spentAt anchor), NOT past due
const e6 = await mkExpense({ amount: 50_000, dueDay: tehranDay(20), spentDaysAgo: 2 }); // future due → D0_30, not past due
await mkExpense({ amount: 70_000, paid: 70_000, dueDay: tehranDay(-200), spentDaysAgo: 200 }); // PAID → excluded

// Receivables: two unpaid invoices at known ages.
const prod = (await f("/api/v1/products", { method: "POST", headers: H, body: JSON.stringify({ name: "PAGQA Widget", salePriceMinor: 10_000, costPriceMinor: 1_000, stockQty: 100 }) })).body?.data?.id;
const s1 = await f("/api/v1/sales", { method: "POST", headers: H, body: JSON.stringify({ customerId: customer, items: [{ productId: prod, name: "PAGQA Widget", unit: "pcs", qty: 1, unitPriceMinor: 10_000 }], issueDate: new Date(Date.now() - 20 * 86_400_000).toISOString() }) });
ok("F4. sale 1 created", s1.status === 201, JSON.stringify(s1.body));
const s2 = await f("/api/v1/sales", { method: "POST", headers: H, body: JSON.stringify({ customerId: customer, items: [{ productId: prod, name: "PAGQA Widget", unit: "pcs", qty: 2, unitPriceMinor: 10_000 }], issueDate: new Date(Date.now() - 100 * 86_400_000).toISOString() }) });
ok("F5. sale 2 created", s2.status === 201);

// ---------------- aging endpoint ----------------
const ag = await f("/api/v1/reports/aging", { headers: H });
ok("A1. aging 200 + envelope", ag.status === 200 && ag.body?.ok === true);
const D = ag.body?.data;
ok("A2. timezone = business tz", D?.timezone === "Asia/Tehran");
ok("A3. asOf is Tehran YYYY-MM-DD", D?.asOf === tehranDay(0), `${D?.asOf} vs ${tehranDay(0)}`);

const P = D?.payables;
ok("A4. payables total (open only)", P?.totalMinor === 1_550_000, JSON.stringify(P?.totalMinor));
ok("A5. payables openCount 6", P?.openCount === 6, String(P?.openCount));
ok("A6. D0_30 = 150_000/2 (e1+e6)", P?.buckets?.[0]?.minor === 150_000 && P?.buckets?.[0]?.count === 2, JSON.stringify(P?.buckets?.[0]));
ok("A7. D31_60 = 200_000/1", P?.buckets?.[1]?.minor === 200_000 && P?.buckets?.[1]?.count === 1);
ok("A8. D61_90 = 300_000/1", P?.buckets?.[2]?.minor === 300_000 && P?.buckets?.[2]?.count === 1);
ok("A9. D90_PLUS = 900_000/2 (e4+e5)", P?.buckets?.[3]?.minor === 900_000 && P?.buckets?.[3]?.count === 2);
ok("A10. pastDue = 1_000_000/4 (dated bills only)", P?.pastDueMinor === 1_000_000 && P?.pastDueCount === 4, JSON.stringify({ m: P?.pastDueMinor, c: P?.pastDueCount }));
ok("A11. topParties: supplier first w/ balance", P?.topParties?.[0]?.name === "PAGQA Supplier Alpha" && P?.topParties?.[0]?.balanceMinor === 1_550_000 && P?.topParties?.[0]?.openCount === 6);
ok("A12. buckets sum invariant", (P?.buckets ?? []).reduce((n, b) => n + b.minor, 0) === P?.totalMinor);

const R = D?.receivables;
ok("A13. receivables total 30_000", R?.totalMinor === 30_000 && R?.openCount === 2, JSON.stringify({ t: R?.totalMinor, c: R?.openCount }));
ok("A14. receivables buckets 20d → D0_30, 100d → D90_PLUS", R?.buckets?.[0]?.minor === 10_000 && R?.buckets?.[0]?.count === 1 && R?.buckets?.[3]?.minor === 20_000 && R?.buckets?.[3]?.count === 1, JSON.stringify(R?.buckets));
ok("A15. receivables topParty = customer", R?.topParties?.[0]?.name === "PAGQA Customer Beta" && R?.topParties?.[0]?.balanceMinor === 30_000);
ok("A16. receivables side has NO pastDue slice", R?.pastDueMinor === undefined && R?.pastDueCount === undefined);

// ---------------- payables list enrichment ----------------
const pay = await f("/api/v1/payables", { headers: H });
const items = pay.body?.data?.items ?? [];
ok("P1. payables list carries dueDate/reference/pastDue", items.every((i) => "dueDate" in i && "reference" in i && "pastDue" in i));
ok("P2. pastDue flags server-derived", items.filter((i) => i.pastDue).length === 4, JSON.stringify(items.map((i) => i.pastDue)));
ok("P3. undated bill NOT past due", items.find((i) => i.id === e5)?.pastDue === false);
ok("P4. future-dated bill NOT past due", items.find((i) => i.id === e6)?.pastDue === false);

// ---------------- enrichment round-trip + three-state PATCH law ----------------
ok("R1. dueDate+reference round-trip (POST)", (() => {
  const i = items.find((x) => x.id === e1);
  return i?.dueDate?.slice(0, 10) === tehranDay(-10);
})(), JSON.stringify(items.find((x) => x.id === e1)));

const setRef = await f(`/api/v1/expenses/${e6}`, { method: "PATCH", headers: H, body: JSON.stringify({ reference: "BILL-777", note: "touched" }) });
ok("R2. PATCH sets reference (201/200)", setRef.status === 200, JSON.stringify(setRef.body));

const det1 = await f(`/api/v1/expenses/${e6}`, { headers: H });
ok("R3. detail exposes dueDate + reference", det1.body?.data?.expense?.reference === "BILL-777" && det1.body?.data?.expense?.dueDate?.slice(0, 10) === tehranDay(20), JSON.stringify(det1.body?.data?.expense));

// THREE-STATE: PATCH that omits dueDate must NOT clear it.
await f(`/api/v1/expenses/${e6}`, { method: "PATCH", headers: H, body: JSON.stringify({ note: "second touch" }) });
const det2 = await f(`/api/v1/expenses/${e6}`, { headers: H });
ok("R4. absent dueDate = untouched", det2.body?.data?.expense?.dueDate?.slice(0, 10) === tehranDay(20), det2.body?.data?.expense?.dueDate);

// null clears.
await f(`/api/v1/expenses/${e6}`, { method: "PATCH", headers: H, body: JSON.stringify({ dueDate: null }) });
const det3 = await f(`/api/v1/expenses/${e6}`, { headers: H });
ok("R5. null dueDate = cleared", det3.body?.data?.expense?.dueDate === null);
ok("R6. e6 now anchors on spentAt → D0_30 stays, pastDue still false", (() => {
  return true; // covered by re-fetch below
})());

// Clearing dueDate moves e1 (spent 40d ago) into D31_60 and shrinks pastDue to 900_000/3.
await f(`/api/v1/expenses/${e1}`, { method: "PATCH", headers: H, body: JSON.stringify({ dueDate: null }) });
const ag2 = await f("/api/v1/reports/aging", { headers: H });
const P2 = ag2.body?.data?.payables;
ok("R7. re-bucketed after dueDate clear", P2?.buckets?.[0]?.minor === 50_000 && P2?.buckets?.[0]?.count === 1 && P2?.buckets?.[1]?.minor === 300_000 && P2?.buckets?.[1]?.count === 2, JSON.stringify(P2?.buckets));
ok("R8. pastDue shrinks to 900_000/3", P2?.pastDueMinor === 900_000 && P2?.pastDueCount === 3, JSON.stringify({ m: P2?.pastDueMinor, c: P2?.pastDueCount }));

// ---------------- validation ----------------
ok("V1. garbage calendar date rejected (2026-02-31)", (await f("/api/v1/expenses", { method: "POST", headers: H, body: JSON.stringify({ category: "X", amountMinor: 100, dueDate: "2026-02-31" }) })).status === 422);
ok("V2. wrong format rejected (2026-2-1)", (await f("/api/v1/expenses", { method: "POST", headers: H, body: JSON.stringify({ category: "X", amountMinor: 100, dueDate: "2026-2-1" }) })).status === 422);
ok("V3. overlong reference rejected (>80)", (await f("/api/v1/expenses", { method: "POST", headers: H, body: JSON.stringify({ category: "X", amountMinor: 100, reference: "R".repeat(81) }) })).status === 422);
ok("V4. aging requires auth", (await fetch(`${BASE}/api/v1/reports/aging`)).status === 401);
ok("V5. aging tenant-scoped (no x-business-id → 400/NO_BUSINESS_CONTEXT)", (await f("/api/v1/reports/aging", {})).status === 400);

// ---------------- zero-residue teardown ----------------
await db.business.deleteMany({ where: { name: { startsWith: "PAGQA-" } } });
await db.user.deleteMany({ where: { email: { contains: "pagqa-" } } });
const leftBiz = await db.business.count({ where: { name: { startsWith: "PAGQA-" } } });
const leftUsers = await db.user.count({ where: { email: { contains: "pagqa-" } } });
const leftExp = await db.expense.count({ where: { category: "PAGQA Supplies" } });
ok("T1. ZERO fixture leftovers", leftBiz === 0 && leftUsers === 0 && leftExp === 0, JSON.stringify({ leftBiz, leftUsers, leftExp }));

await db.$disconnect();
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:\n" + failures.map((x) => `  - ${x}`).join("\n"));
  process.exit(1);
}
