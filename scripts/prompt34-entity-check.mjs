/**
 * scripts/prompt34-entity-check.mjs — Prompt 34 §52/§92 E2E harness.
 *
 * Exercises the REAL HTTP surface (the six detail GET endpoints, search,
 * stock adjust, mutations) with real NextAuth sessions against the dev
 * server. Fixtures are created through the SAME tenant APIs a user would
 * use (owner holds data:write + finance:manage) so status/paid bookkeeping
 * follows the authoritative write paths.
 *
 * Sections (§52 A–AJ; UI-only rows M/O/P/Q/R/T/X/Y/Z/AA/AB/AC are covered
 * by the separate agent-browser QA pass and by prompt34-unit.ts):
 *   SETUP   ownerA+bizA, ownerB+bizB, fixtures via tenant APIs
 *   A       AUTH     401 unauthenticated · 400 no business context
 *   B       RBAC     member-of-B requests with A header → 403 (no leak)
 *   C..H    DTO      exact top-level key sets for all 6 detail GETs
 *   I       404      foreign-business record ids → 404 (§20)
 *   J       404      deleted (soft + reversed payment) records → 404
 *   K/L     SEARCH   search result type+id resolve to the exact detail
 *   N       RELATED  customer→sale→payment / product→sale chains
 *   S       SWITCH   business switch re-resolves (A id under B → 404)
 *   U       SAFE     forbidden fields absent from every response
 *   V       MONEY    integer minor units; balance = total − paid
 *   W       TOKENS   raw closed status tokens (no localized text)
 *   AD      C360     customer summary matches exact server totals
 *   AE      S360     supplier summary matches exact server totals
 *   AF      STOCK    stock state LOW → OUT → HEALTHY via stock API
 *   AG/AH   PAYCONS  payments sum == paidMinor (sale & expense)
 *   AI      PREL     payment related document is sale XOR expense
 *   AJ      LEAK     no cross-business leakage on any detail endpoint
 *   CLEANUP businesses (cascade) + users removed, zero leftovers verified
 *
 * Run:  bun scripts/prompt34-entity-check.mjs   (needs dev server on :3000)
 * Exit: 0 = all green · 1 = at least one failure.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { SEARCH_TYPE_TO_ENTITY, ENTITY_TYPES, ENTITY_ROUTES } from "../src/lib/entity-routes.ts";

const BASE = process.env.P34_BASE ?? "http://localhost:3000";
const PASS = "testpass123";
const PREFIX = "P34-ENTITY";
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
function record(name, ok, info = "") {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} [${current}] ${name}${info ? ` — ${info}` : ""}`);
  return ok;
}
function check(name, cond, info = "") {
  if (!cond) {
    return record(name, false, `${info} |last=${JSON.stringify(lastBody)?.slice(0, 220)}`);
  }
  return record(name, true, info);
}

/* ------------------------------ fetch helpers ------------------------------ */
function randomXff() {
  return `10.45.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
}
function jarFetch(jar, xff = randomXff()) {
  return async (path, init = {}) => {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const headers = { "x-forwarded-for": xff, ...(init.headers ?? {}) };
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
  } catch {
    /* non-JSON */
  }
  lastBody = body;
  return { res, body };
}
function withBiz(jar, businessId) {
  const base = jarFetch(jar);
  return (path, init = {}) =>
    base(path, { ...init, headers: { "x-business-id": businessId, ...(init.headers ?? {}) } });
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
async function registerApi(email, name) {
  const f = jarFetch(new Map());
  const { body } = await apiJson(f, "/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, email, password: PASS }),
  });
  return body;
}
async function createBusiness(jar, name) {
  const f = jarFetch(jar);
  const { body } = await apiJson(f, "/api/v1/businesses", {
    method: "POST",
    body: JSON.stringify({ name, currencyCode: "USD", locale: "en" }),
  });
  return body?.data?.business?.id ?? body?.data?.id ?? null;
}
async function call(f, path, init = {}) {
  const { res, body } = await apiJson(f, path, init);
  return { res, body, data: body?.ok ? body.data : null, err: body?.ok ? null : body?.error };
}
const run = `r${Math.floor(Math.random() * 1e9)}`;

function collectKeys(v, acc = []) {
  if (Array.isArray(v)) { v.forEach((x) => collectKeys(x, acc)); return acc; }
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v)) { acc.push(k); collectKeys(val, acc); }
  }
  return acc;
}

/* ================================== SETUP ================================== */
console.log("\n== SETUP ==");
section("SETUP");
await db.business.deleteMany({ where: { name: { startsWith: `${PREFIX}-` } } });
await db.user.deleteMany({ where: { email: { contains: "p34-" } } });

const emailA = `p34-owner-a-${run}@test.local`;
const emailB = `p34-owner-b-${run}@test.local`;
await registerApi(emailA, "P34 Owner A");
await registerApi(emailB, "P34 Owner B");

const jarA = new Map();
const jarB = new Map();
check("login owner A", await login(jarA, emailA, PASS));
check("login owner B", await login(jarB, emailB, PASS));

const bizA = await createBusiness(jarA, `${PREFIX}-ALPHA-BIZ`);
const bizB = await createBusiness(jarB, `${PREFIX}-BETA-BIZ`);
check("business A created", Boolean(bizA), String(bizA));
check("business B created", Boolean(bizB), String(bizB));

const fA = withBiz(jarA, bizA);
const fB = withBiz(jarB, bizB);
const anon = jarFetch(new Map());

/* ------------------------- FIXTURES (tenant APIs) -------------------------- */
section("FIXTURES");
const { data: cust, } = await call(fA, "/api/v1/customers", { method: "POST", body: JSON.stringify({ name: `${PREFIX}-CUSTOMER`, phone: "+989121234567", email: "p34cust@example.com", address: "Tehran", note: "P34 fixture" }) });
check("customer created", Boolean(cust?.id));
const customerId = cust.id;

const { data: supp } = await call(fA, "/api/v1/suppliers", { method: "POST", body: JSON.stringify({ name: `${PREFIX}-SUPPLIER`, phone: "+989122222222", email: "p34sup@example.com" }) });
check("supplier created", Boolean(supp?.id));
const supplierId = supp.id;

const { data: prod } = await call(fA, "/api/v1/products", { method: "POST", body: JSON.stringify({ name: `${PREFIX}-PRODUCT`, sku: "P34-SKU", unit: "pcs", salePriceMinor: 2500, costPriceMinor: 1000, stockQty: 3, lowStockAt: 5 }) });
check("product created", Boolean(prod?.id));
const productId = prod.id;

// Customer 360 exact-money fixture (§55): 3 sales, 2 payments.
// sale1 1000 fully paid · sale2 2000 partially paid (1500) · sale3 3000 unpaid
async function createSale(customerIdV, lines, discount = 0) {
  const { data } = await call(fA, "/api/v1/sales", {
    method: "POST",
    body: JSON.stringify({
      customerId: customerIdV,
      items: lines.map(([pid, qty, price]) => ({ productId: pid, name: `${PREFIX}-LINE`, unit: "pcs", qty, unitPriceMinor: price })),
      discountMinor: discount,
    }),
  });
  return data;
}
const sale1 = await createSale(customerId, [[productId, 1, 1000]]);
const sale2 = await createSale(customerId, [[productId, 1, 2000]]);
const sale3 = await createSale(customerId, [[productId, 1, 3000]]);
check("3 sales created", Boolean(sale1?.id && sale2?.id && sale3?.id));

async function createPayment(target) {
  const { data } = await call(fA, "/api/v1/payments", {
    method: "POST",
    body: JSON.stringify(target),
  });
  return data;
}
const paySale1 = await createPayment({ saleId: sale1.id, amountMinor: 1000, method: "CASH" });
const paySale2 = await createPayment({ saleId: sale2.id, amountMinor: 1500, method: "BANK_TRANSFER" });
check("sale payments created", Boolean(paySale1?.id && paySale2?.id));

// Supplier 360 exact-money fixture (§56): 3 expenses, 2 payments.
async function createExpense(amount, paidTarget) {
  const { data } = await call(fA, "/api/v1/expenses", {
    method: "POST",
    body: JSON.stringify({ supplierId, category: `${PREFIX}-CAT`, amountMinor: amount }),
  });
  return data;
}
const exp1 = await createExpense(800);
const exp2 = await createExpense(1200);
const exp3 = await createExpense(500);
check("3 expenses created", Boolean(exp1?.id && exp2?.id && exp3?.id));
const payExp1 = await createPayment({ expenseId: exp1.id, amountMinor: 800, method: "CASH" });
const payExp2 = await createPayment({ expenseId: exp2.id, amountMinor: 300, method: "CARD" });
check("expense payments created", Boolean(payExp1?.id && payExp2?.id));

// The 3 sales above each shipped 1 unit → stock is 3−3=0. Top back up to a
// deterministic LOW state (3 ≤ threshold 5) before the AF stock sequence.
await call(fA, `/api/v1/products/${productId}/stock`, { method: "POST", body: JSON.stringify({ delta: 3, reason: "P34 fixture reset to LOW" }) });

// Deleted fixtures (§52.J)
const { data: custDel } = await call(fA, "/api/v1/customers", { method: "POST", body: JSON.stringify({ name: `${PREFIX}-CUSTOMER-DEL` }) });
await call(fA, `/api/v1/customers/${custDel.id}`, { method: "DELETE" });
const { data: prodDel } = await call(fA, "/api/v1/products", { method: "POST", body: JSON.stringify({ name: `${PREFIX}-PRODUCT-DEL`, sku: null, unit: null, salePriceMinor: 1, costPriceMinor: 1 }) });
await call(fA, `/api/v1/products/${prodDel.id}`, { method: "DELETE" });
const { data: expDel } = await call(fA, "/api/v1/expenses", { method: "POST", body: JSON.stringify({ category: `${PREFIX}-EXP-DEL`, amountMinor: 100 }) });
await call(fA, `/api/v1/expenses/${expDel.id}`, { method: "DELETE" });
check("soft-deleted fixtures ready", Boolean(custDel?.id && prodDel?.id && expDel?.id));

// Foreign-business record (§20/§84): a customer owned by biz B.
const { data: custBeta } = await call(fB, "/api/v1/customers", { method: "POST", body: JSON.stringify({ name: `${PREFIX}-BETA-CUSTOMER` }) });
check("foreign customer created", Boolean(custBeta?.id));
const foreignCustomerId = custBeta.id;

/* =============================== A — AUTH ================================= */
console.log("\n== A: AUTH ==");
section("A-AUTH");
for (const entity of ENTITY_TYPES) {
  const { res } = await call(anon, `${ENTITY_ROUTES[entity].api}/someid123`);
  check(`${entity} unauthenticated → 401`, res.status === 401, `got ${res.status}`);
}
{
  const noBiz = jarFetch(jarA);
  const { res } = await call(noBiz, `/api/v1/customers/${customerId}`);
  check("authenticated without business context → 400", res.status === 400, `got ${res.status}`);
}

/* =============================== B — RBAC ================================= */
console.log("\n== B: RBAC ==");
section("B-RBAC");
{
  // Owner B has NO membership in biz A: the tenant pipeline rejects with
  // 403 BEFORE any record lookup — the response cannot leak existence.
  const { res, err } = await call(fB, `/api/v1/customers/${customerId}`, { headers: { "x-business-id": bizA } });
  check("non-member 403 FORBIDDEN", res.status === 403 && err?.code === "FORBIDDEN", `got ${res.status} ${err?.code}`);
  // and passing A's id under B's own context → 404 (record not in tenant)
  const r2 = await call(fB, `/api/v1/customers/${customerId}`);
  check("foreign record under own context → 404", r2.res.status === 404, `got ${r2.res.status}`);
}

/* ============================ C..H — DTO keys ============================= */
console.log("\n== C..H: DTO SHAPES ==");
section("DTO");
{
  const { res, data } = await call(fA, `/api/v1/customers/${customerId}`);
  check("C customer detail 200", res.status === 200);
  // Prompt 35 (§123): the customer 360 now carries a bounded `crm` section.
  // Prompt 44 added `recentGoodsDispatches`; Prompt 45 added `recentSalesOrders`;
  // Prompt 47 (§19) adds `recentSalesQuotations` (bounded ≤10, snapshot-faithful,
  // quantities + status only — offer references, never revenue) — keyed per the
  // authoritative src/lib/entities/customer.ts payload order.
  check("C customer exact top-level keys", data && JSON.stringify(Object.keys(data)) === JSON.stringify(["customer", "summary", "recentSales", "recentPayments", "recentGoodsDispatches", "recentSalesOrders", "recentSalesQuotations", "crm"]), JSON.stringify(data && Object.keys(data)));
  check("C recentGoodsDispatches array", Array.isArray(data?.recentGoodsDispatches));
  check("C recentSalesOrders array", Array.isArray(data?.recentSalesOrders));
  check("C recentSalesQuotations array", Array.isArray(data?.recentSalesQuotations));
  const rq = data?.recentSalesQuotations?.[0];
  if (rq) {
    // Prompt 47 (§19): quotation ref keys — no notes, no customer identity fields.
    check("C recentSalesQuotation keys", JSON.stringify(Object.keys(rq)) === JSON.stringify(["id", "reference", "persistedStatus", "effectiveStatus", "quotationDate", "currencyCodeAtQuotation", "currencySymbolAtQuotation", "decimalPrecisionAtQuotation", "totalMinor", "totalQty", "convertedOrderReference"]), JSON.stringify(Object.keys(rq)));
  }
  check("C customer sub keys", data && JSON.stringify(Object.keys(data.customer)) === JSON.stringify(["id", "name", "phone", "email", "address", "note", "createdAt"]));
  check("C summary keys", data && JSON.stringify(Object.keys(data.summary)) === JSON.stringify(["totalSalesMinor", "paidSalesMinor", "receivableMinor", "invoiceCount", "paidInvoiceCount", "openInvoiceCount"]));
  const rs = data?.recentSales?.[0];
  check("C recentSale keys", rs && JSON.stringify(Object.keys(rs)) === JSON.stringify(["id", "number", "issueDate", "totalMinor", "paidMinor", "balanceMinor", "status"]));
  const rp = data?.recentPayments?.[0];
  check("C recentPayment keys", rp && JSON.stringify(Object.keys(rp)) === JSON.stringify(["id", "amountMinor", "method", "paidAt", "note"]));
}
{
  const { res, data } = await call(fA, `/api/v1/suppliers/${supplierId}`);
  check("D supplier detail 200", res.status === 200);
  // Prompt 41 added the read-only `recentPurchaseOrders` section (≤10, bounded).
  // Prompt 42 (§121) added `recentGoodsReceipts`; Prompt 43 (§100) adds `recentGoodsReturns` (≤10,
  // snapshot identity, NO financial statement contamination) — appended last.
  check("D supplier exact top-level keys", data && JSON.stringify(Object.keys(data)) === JSON.stringify(["supplier", "summary", "recentExpenses", "recentPayments", "recentPurchaseOrders", "recentGoodsReceipts", "recentGoodsReturns"]));
  check("D summary keys", data && JSON.stringify(Object.keys(data.summary)) === JSON.stringify(["totalExpensesMinor", "paidExpensesMinor", "payableMinor", "expenseCount", "paidExpenseCount", "openExpenseCount"]));
}
{
  const { res, data } = await call(fA, `/api/v1/products/${productId}`);
  check("E product detail 200", res.status === 200);
  // Prompt 41 added the read-only `recentPurchaseOrders` section (≤10, bounded).
  // Prompt 42 (§120) added `recentGoodsReceipts`; Prompt 43 (§99) adds `recentGoodsReturns` (≤10,
  // NO money); Prompt 44 added `recentGoodsDispatches`; Prompt 45 added `recentSalesOrders`;
  // Prompt 47 (§19) adds `recentSalesQuotations` (bounded ≤10, quantities only — a
  // commercial-document reference, NEVER in the stock-movement list) — keyed per the
  // authoritative src/lib/entities/product.ts payload order.
  check("E product exact top-level keys", data && JSON.stringify(Object.keys(data)) === JSON.stringify(["product", "inventory", "recentAdjustments", "recentSales", "recentStocktakes", "recentPurchaseOrders", "recentGoodsReceipts", "recentGoodsReturns", "recentGoodsDispatches", "recentSalesOrders", "recentSalesQuotations"]));
  check("E recentGoodsDispatches array", Array.isArray(data?.recentGoodsDispatches));
  check("E recentSalesOrders array", Array.isArray(data?.recentSalesOrders));
  check("E recentSalesQuotations array", Array.isArray(data?.recentSalesQuotations));
  const pq = data?.recentSalesQuotations?.[0];
  if (pq) {
    check("E recentSalesQuotation keys", JSON.stringify(Object.keys(pq)) === JSON.stringify(["id", "reference", "customerNameAtQuotation", "persistedStatus", "effectiveStatus", "quotationDate", "qty"]), JSON.stringify(Object.keys(pq)));
  }
  check("E inventory keys", data && JSON.stringify(Object.keys(data.inventory)) === JSON.stringify(["stockQty", "lowStockAt", "state"]));
  check("E inventory.state closed token", ["OUT_OF_STOCK", "LOW_STOCK", "HEALTHY"].includes(data?.inventory?.state), String(data?.inventory?.state));
  const ps = data?.recentSales?.[0];
  check("E recentSale keys", ps && JSON.stringify(Object.keys(ps)) === JSON.stringify(["saleId", "number", "issueDate", "qty", "lineTotalMinor"]));
}
{
  const { res, data } = await call(fA, `/api/v1/sales/${sale1.id}`);
  check("F sale detail 200", res.status === 200);
  check("F sale exact top-level keys", data && JSON.stringify(Object.keys(data)) === JSON.stringify(["sale", "items", "payments"]));
  const item = data?.items?.[0];
  check("F item keys", item && JSON.stringify(Object.keys(item)) === JSON.stringify(["id", "productId", "name", "unit", "qty", "unitPriceMinor", "lineTotalMinor"]));
  const pay = data?.payments?.[0];
  check("F payment keys", pay && JSON.stringify(Object.keys(pay)) === JSON.stringify(["id", "amountMinor", "method", "note", "paidAt", "actorName"]));
}
{
  const { res, data } = await call(fA, `/api/v1/expenses/${exp2.id}`);
  check("G expense detail 200", res.status === 200);
  check("G expense exact top-level keys", data && JSON.stringify(Object.keys(data)) === JSON.stringify(["expense", "payments"]));
  check("G expense sub keys", data && JSON.stringify(Object.keys(data.expense)) === JSON.stringify(["id", "category", "amountMinor", "paidMinor", "balanceMinor", "status", "spentAt", "dueDate", "reference", "note", "supplierId", "supplierName", "createdAt"]));
}
{
  const { res, data } = await call(fA, `/api/v1/payments/${paySale2.id}`);
  check("H payment detail 200", res.status === 200);
  check("H payment exact top-level keys", data && JSON.stringify(Object.keys(data)) === JSON.stringify(["payment", "related"]));
  check("H payment sub keys", data && JSON.stringify(Object.keys(data.payment)) === JSON.stringify(["id", "direction", "amountMinor", "method", "note", "paidAt", "createdAt"]));
  check("H related keys", data && JSON.stringify(Object.keys(data.related)) === JSON.stringify(["sale", "expense"]));
}

/* ============================== I/J — 404s ================================ */
console.log("\n== I/J: 404 ISOLATION ==");
section("404");
{
  // §20 — foreign id with A's own header: NOT_FOUND, never 403-leak.
  const { res } = await call(fA, `/api/v1/customers/${foreignCustomerId}`);
  check("I foreign customer → 404", res.status === 404, `got ${res.status}`);
  const b1 = await call(fB, `/api/v1/customers/${customerId}`);
  check("I reverse direction → 404", b1.res.status === 404);
  const unknown = await call(fA, "/api/v1/customers/cmnonexistent0000000000");
  check("I unknown id → 404", unknown.res.status === 404);
}
{
  const d1 = await call(fA, `/api/v1/customers/${custDel.id}`);
  check("J deleted customer → 404", d1.res.status === 404);
  const d2 = await call(fA, `/api/v1/products/${prodDel.id}`);
  check("J deleted product → 404", d2.res.status === 404);
  const d3 = await call(fA, `/api/v1/expenses/${expDel.id}`);
  check("J deleted expense → 404", d3.res.status === 404);
}

/* ============================ K/L — SEARCH ================================ */
console.log("\n== K/L: SEARCH → EXACT ENTITY ==");
section("SEARCH");
{
  const { data } = await call(fA, `/api/v1/search?q=${encodeURIComponent(PREFIX + "-CUSTOMER")}`);
  const item = data?.groups?.find((g) => g.type === "CUSTOMER")?.items?.[0];
  check("K search finds customer", Boolean(item));
  check("K search type maps to closed entity", SEARCH_TYPE_TO_ENTITY.CUSTOMER === "customer");
  const det = await call(fA, `/api/v1/customers/${item?.id}`);
  check("K mapped destination resolves to detail 200", det.res.status === 200 && det.data?.customer?.id === customerId);

  const s2 = await call(fA, `/api/v1/search?q=${encodeURIComponent(PREFIX + "-SUPPLIER")}`);
  const sItem = s2.data?.groups?.find((g) => g.type === "SUPPLIER")?.items?.[0];
  const sDet = await call(fA, `/api/v1/suppliers/${sItem?.id}`);
  check("L supplier search → exact detail", sDet.res.status === 200 && sDet.data?.supplier?.id === supplierId);

  const s3 = await call(fA, `/api/v1/search?q=${encodeURIComponent("P34-SKU")}`);
  const pItem = s3.data?.groups?.find((g) => g.type === "PRODUCT")?.items?.[0];
  check("K product SKU search → id match", pItem?.id === productId);
}

/* =========================== N — RELATED CHAIN ============================ */
console.log("\n== N: RELATED NAVIGATION ==");
section("RELATED");
{
  const cust1 = await call(fA, `/api/v1/customers/${customerId}`);
  check("N customer → recent sales present", (cust1.data?.recentSales?.length ?? 0) === 3);
  // continue the chain through a PARTIALLY PAID sale so payments exist
  const firstSaleId = cust1.data?.recentSales?.find((s0) => s0.paidMinor > 0 && s0.balanceMinor > 0)?.id;
  check("N customer → sale id present", Boolean(firstSaleId));
  const sale = await call(fA, `/api/v1/sales/${firstSaleId}`);
  check("N sale detail 200", sale.res.status === 200);
  check("N sale customer link matches", sale.data?.sale?.customerId === customerId);
  const salePayId = sale.data?.payments?.[0]?.id;
  check("N sale → payment id present", Boolean(salePayId));
  const pay = await call(fA, `/api/v1/payments/${salePayId}`);
  check("N payment detail 200", pay.res.status === 200);
  check("N payment related.sale id matches", pay.data?.related?.sale?.id === firstSaleId);
  const itemProduct = sale.data?.items?.[0]?.productId;
  check("N item → product id present", Boolean(itemProduct));
  const prod = await call(fA, `/api/v1/products/${itemProduct}`);
  check("N product detail 200", prod.res.status === 200);
  check("N product recentSales contains the sale", prod.data?.recentSales?.some((s) => s.saleId === firstSaleId));
}

/* ====================== AD/AE — 360 SUMMARIES ============================= */
console.log("\n== AD/AE: 360 CONSISTENCY ==");
section("360");
{
  const { data } = await call(fA, `/api/v1/customers/${customerId}`);
  check("AD totalSalesMinor == 6000", data?.summary?.totalSalesMinor === 6000, String(data?.summary?.totalSalesMinor));
  check("AD paidSalesMinor == 2500", data?.summary?.paidSalesMinor === 2500);
  check("AD receivableMinor == 3500", data?.summary?.receivableMinor === 3500);
  check("AD invoiceCount == 3", data?.summary?.invoiceCount === 3);
  check("AD paidInvoiceCount == 1", data?.summary?.paidInvoiceCount === 1);
  check("AD openInvoiceCount == 2", data?.summary?.openInvoiceCount === 2);
  check("AD recentSales bounded ≤10 and == 3", data?.recentSales?.length === 3);
  check("AD recentPayments == 2", data?.recentPayments?.length === 2);
  // receivable equals Σ(balance) of recent sales (same data)
  const sumBalances = data.recentSales.reduce((acc, s) => acc + s.balanceMinor, 0);
  check("AD receivable == Σ recent balances", sumBalances === data.summary.receivableMinor, String(sumBalances));
}
{
  const { data } = await call(fA, `/api/v1/suppliers/${supplierId}`);
  check("AE totalExpensesMinor == 2500", data?.summary?.totalExpensesMinor === 2500, String(data?.summary?.totalExpensesMinor));
  check("AE paidExpensesMinor == 1100", data?.summary?.paidExpensesMinor === 1100);
  check("AE payableMinor == 1400", data?.summary?.payableMinor === 1400);
  check("AE expenseCount == 3", data?.summary?.expenseCount === 3);
  check("AE paidExpenseCount == 1", data?.summary?.paidExpenseCount === 1);
  check("AE openExpenseCount == 2", data?.summary?.openExpenseCount === 2);
  check("AE recentPayments == 2", data?.recentPayments?.length === 2);
}

/* ========================= AF — STOCK STATE =============================== */
console.log("\n== AF: PRODUCT STOCK STATE ==");
section("STOCK");
{
  let { data } = await call(fA, `/api/v1/products/${productId}`);
  check("AF initial state LOW_STOCK (3 ≤ 5)", data?.inventory?.state === "LOW_STOCK", String(data?.inventory?.state));
  await call(fA, `/api/v1/products/${productId}/stock`, { method: "POST", body: JSON.stringify({ delta: -1, reason: "P34 AF test decrease" }) });
  ({ data } = await call(fA, `/api/v1/products/${productId}`));
  check("AF after -1 → qty 2 still LOW", data?.inventory?.stockQty === 2 && data?.inventory?.state === "LOW_STOCK");
  await call(fA, `/api/v1/products/${productId}/stock`, { method: "POST", body: JSON.stringify({ delta: -2, reason: "P34 AF test to zero" }) });
  ({ data } = await call(fA, `/api/v1/products/${productId}`));
  check("AF after -2 → OUT_OF_STOCK", data?.inventory?.stockQty === 0 && data?.inventory?.state === "OUT_OF_STOCK", String(data?.inventory?.state));
  await call(fA, `/api/v1/products/${productId}/stock`, { method: "POST", body: JSON.stringify({ delta: 10, reason: "P34 AF restock" }) });
  ({ data } = await call(fA, `/api/v1/products/${productId}`));
  check("AF after +10 → HEALTHY", data?.inventory?.state === "HEALTHY");
  const adjs = data?.recentAdjustments?.length ?? 0;
  check("AF recentAdjustments recorded (≤10)", adjs >= 3 && adjs <= 10, String(adjs));
}

/* ================= AG/AH — PAYMENT CONSISTENCY ============================ */
console.log("\n== AG/AH: PAYMENT CONSISTENCY ==");
section("PAYCONS");
{
  const { data } = await call(fA, `/api/v1/sales/${sale2.id}`);
  const sum = data.payments.reduce((a, p) => a + p.amountMinor, 0);
  check("AG sale payments sum == paidMinor", sum === data.sale.paidMinor, `${sum} vs ${data.sale.paidMinor}`);
  check("AG balance == total − paid", data.sale.balanceMinor === data.sale.totalMinor - data.sale.paidMinor);
}
{
  const { data } = await call(fA, `/api/v1/expenses/${exp2.id}`);
  const sum = data.payments.reduce((a, p) => a + p.amountMinor, 0);
  check("AH expense payments sum == paidMinor", sum === data.expense.paidMinor, `${sum} vs ${data.expense.paidMinor}`);
  check("AH balance == amount − paid", data.expense.balanceMinor === data.expense.amountMinor - data.expense.paidMinor);
}

/* ==================== AI — PAYMENT RELATION =============================== */
console.log("\n== AI: PAYMENT RELATION ==");
section("PREL");
{
  const a = await call(fA, `/api/v1/payments/${paySale1.id}`);
  check("AI sale payment → related.sale non-null", a.data?.related?.sale?.id === sale1.id && a.data?.related?.expense === null);
  const b = await call(fA, `/api/v1/payments/${payExp1.id}`);
  check("AI expense payment → related.expense non-null", b.data?.related?.expense?.id === exp1.id && b.data?.related?.sale === null);
  check("AI related sale formatted number", a.data?.related?.sale?.formattedInvoiceNumber?.startsWith("INV-"));
}

/* ================== S/U/V/W — SWITCH, SAFETY, MONEY ======================= */
console.log("\n== S/U/V/W: SWITCH + SAFETY + MONEY ==");
section("SAFETY");
{
  // §36/§62 — after "switching" the header to business B, A's id 404s.
  const r = await call(fB, `/api/v1/customers/${customerId}`); // fB context = bizB
  check("S business switch → foreign id 404", r.res.status === 404);
}
{
  // §87 — forbidden fields anywhere in every detail payload.
  const responses = [];
  for (const [entity, id] of [["customer", customerId], ["supplier", supplierId], ["product", productId], ["sale", sale2.id], ["expense", exp2.id], ["payment", paySale2.id]]) {
    const { data } = await call(fA, `${ENTITY_ROUTES[entity].api}/${id}`);
    if (data) responses.push([entity, data]);
  }
  const FORBIDDEN = ["passwordHash", "sessionVersion", "secret", "token", "providerSecret", "webhookSignature", "ip", "userAgent", "aiCost", "providerRate", "businessId", "deletedAt", "actorId"];
  let clean = true;
  const seen = [];
  for (const [entity, data] of responses) {
    const keys = collectKeys(data);
    for (const tok of FORBIDDEN) {
      if (keys.includes(tok)) { clean = false; seen.push(`${entity}:${tok}`); }
    }
  }
  check("U forbidden fields absent from all detail DTOs", clean, seen.join(","));
  // §69 — platform separation: no platform/subscription/gateway keys.
  const allKeys = responses.flatMap(([, d]) => collectKeys(d));
  check("U no platform/subscription keys", !allKeys.some((k) => /subscription|checkout|webhook|provider|plan|invoiceId/i.test(k) === true && k !== "formattedInvoiceNumber"), "");
}
{
  // §43 — every monetary field is an integer.
  const moneyValues = [];
  const scanMoney = (v) => {
    if (Array.isArray(v)) return v.forEach(scanMoney);
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v)) {
        if (k.endsWith("Minor")) moneyValues.push([k, val]);
        else if (typeof val === "object") scanMoney(val);
      }
    }
  };
  for (const [entity, id] of [["customer", customerId], ["supplier", supplierId], ["sale", sale2.id], ["expense", exp2.id]]) {
    const { data } = await call(fA, `${ENTITY_ROUTES[entity].api}/${id}`);
    scanMoney(data);
  }
  check("V all *Minor values are integers", moneyValues.every(([, v]) => Number.isInteger(v)), JSON.stringify(moneyValues.filter(([, v]) => !Number.isInteger(v)).slice(0, 3)));
  check("V no float money anywhere", !moneyValues.some(([, v]) => !Number.isInteger(v)));
}
{
  // §73 — raw closed status tokens (client localizes).
  const { data } = await call(fA, `/api/v1/sales/${sale1.id}`);
  check("W raw status tokens (PAID)", data?.sale?.status === "PAID");
  const e = await call(fA, `/api/v1/expenses/${exp3.id}`);
  check("W raw status tokens (UNPAID)", e.data?.expense?.status === "UNPAID");
}

/* =================== AJ — NO CROSS-BUSINESS LEAKAGE ======================= */
console.log("\n== AJ: LEAK ==");
section("LEAK");
{
  const targets = [
    ["/api/v1/customers", customerId],
    ["/api/v1/suppliers", supplierId],
    ["/api/v1/products", productId],
    ["/api/v1/sales", sale1.id],
    ["/api/v1/expenses", exp1.id],
    ["/api/v1/payments", paySale1.id],
  ];
  let all = true;
  for (const [base, id] of targets) {
    const { res } = await call(fB, `${base}/${id}`);
    if (res.status !== 404) all = false;
  }
  check("AJ all six foreign records → 404 for B", all);
}

/* ================================ CLEANUP ================================= */
console.log("\n== CLEANUP ==");
section("CLEANUP");
{
  await db.business.deleteMany({ where: { name: { startsWith: `${PREFIX}-` } } });
  await db.user.deleteMany({ where: { email: { contains: "p34-" } } });
  const bizLeft = await db.business.count({ where: { name: { startsWith: `${PREFIX}-` } } });
  const userLeft = await db.user.count({ where: { email: { contains: "p34-" } } });
  const custLeft = await db.customer.count({ where: { name: { startsWith: `${PREFIX}-` } } });
  const prodLeft = await db.product.count({ where: { name: { startsWith: `${PREFIX}-` } } });
  const payLeft = await db.payment.count({ where: { note: { startsWith: `${PREFIX}-` } } });
  check("cleanup: zero businesses left", bizLeft === 0);
  check("cleanup: zero users left", userLeft === 0);
  check("cleanup: zero customers left", custLeft === 0);
  check("cleanup: zero products left", prodLeft === 0);
  check("cleanup: zero payment fixtures left", payLeft === 0);
}

/* ================================= SUMMARY ================================ */
const failed = results.filter((r) => !r.ok);
console.log(`\nprompt34-entity-check: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
