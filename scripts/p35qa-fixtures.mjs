/**
 * scripts/p35qa-fixtures.mjs — ephemeral browser-QA fixtures (setup | teardown).
 *
 *   bun scripts/p35qa-fixtures.mjs setup
 *   bun scripts/p35qa-fixtures.mjs teardown
 *
 * Fixtures are prefixed P35QA- / p35qa- and created through the REAL tenant
 * APIs exactly as the UI would. Teardown removes business (cascade) + user
 * and verifies zero leftovers (same protocol as the P34 E2E harness).
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
  return `10.46.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
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
  await db.business.deleteMany({ where: { name: { startsWith: "P35QA-" } } });
  await db.user.deleteMany({ where: { email: { contains: "p35qa-" } } });

  const email = `p35qa-owner-${Date.now()}@test.local`;
  const jar = new Map();
  const f = jarFetch(jar);
  const reg = await apiJson(f, "/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "P35QA Owner", email, password: PASS }),
  });
  if (!reg.body?.ok) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  if (!(await login(jar, email, PASS))) throw new Error("login failed");

  const biz = await call(f, "/api/v1/businesses", {
    method: "POST",
    body: JSON.stringify({ name: `P35QA-${Date.now()}`, currencyCode: "USD", locale: "en" }),
  });
  const businessId = biz?.business?.id ?? biz?.id;
  if (!businessId) throw new Error("business create failed");
  const withBiz = (path, init = {}) =>
    f(path, { ...init, headers: { "x-business-id": businessId, ...(init.headers ?? {}) } });
  const post = async (path, body) => call(withBiz, path, { method: "POST", body: JSON.stringify(body) });

  const c1 = await post("/api/v1/customers", { name: "P35QA Alice", phone: "+989121111111", email: "alice@p35qa.test" });
  const c2 = await post("/api/v1/customers", { name: "P35QA Bob", phone: "+989122222222" });
  const sup = await post("/api/v1/suppliers", { name: "P35QA Acme Supply", phone: "+989123333333" });
  const p1 = await post("/api/v1/products", { name: "P35QA Phone Case", sku: "P35QA-CASE-1", salePriceMinor: 120000, costPriceMinor: 70000, stockQty: 8, lowStockAt: 10 });
  const p2 = await post("/api/v1/products", { name: "P35QA Charger", sku: "P35QA-CHG-2", salePriceMinor: 250000, costPriceMinor: 150000, stockQty: 0, lowStockAt: 5 });
  const sale = await post("/api/v1/sales", {
    customerId: c1?.customer?.id ?? c1?.id,
    items: [{ productId: p1?.product?.id ?? p1?.id, name: "P35QA Phone Case", qty: 2, unitPriceMinor: 120000 }],
    issueDate: new Date().toISOString(),
  });
  const saleId = sale?.sale?.id ?? sale?.id;
  const exp = await post("/api/v1/expenses", {
    supplierId: sup?.supplier?.id ?? sup?.id,
    category: "P35QA Rent",
    amountMinor: 90000,
    spentAt: new Date().toISOString(),
  });
  const expId = exp?.expense?.id ?? exp?.id;
  const pay = saleId ? await post("/api/v1/payments", { saleId, amountMinor: 60000, method: "CASH", paidAt: new Date().toISOString() }) : null;

  console.log(JSON.stringify({
    email, password: PASS, businessId,
    customerId: c1?.customer?.id ?? c1?.id,
    customer2Id: c2?.customer?.id ?? c2?.id,
    supplierId: sup?.supplier?.id ?? sup?.id,
    productId: p1?.product?.id ?? p1?.id,
    product2Id: p2?.product?.id ?? p2?.id,
    saleId, expenseId: expId, paymentId: pay?.payment?.id ?? pay?.id,
  }, null, 2));
}

async function teardown() {
  await db.business.deleteMany({ where: { name: { startsWith: "P35QA-" } } });
  await db.user.deleteMany({ where: { email: { contains: "p35qa-" } } });
  const [b, u, c, p, s, e] = await Promise.all([
    db.business.count({ where: { name: { startsWith: "P35QA-" } } }),
    db.user.count({ where: { email: { contains: "p35qa-" } } }),
    db.customer.count({ where: { name: { startsWith: "P35QA " } } }),
    db.product.count({ where: { sku: { startsWith: "P35QA-" } } }),
    db.sale.count({ where: { customer: { name: { startsWith: "P35QA " } } } }),
    db.expense.count({ where: { category: { startsWith: "P35QA " } } }),
  ]);
  const leftover = b + u + c + p + s + e;
  console.log(leftover === 0 ? "TEARDOWN CLEAN ✓ (zero leftovers)" : `TEARDOWN LEFTOVERS: ${leftover}`);
  process.exit(leftover === 0 ? 0 : 1);
}

const mode = process.argv[2] ?? "setup";
if (mode === "teardown") await teardown();
else await setup();
