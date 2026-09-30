/**
 * scripts/prompt33-search-check.mjs — Prompt 33 E2E harness (§38).
 *
 * Exercises the REAL HTTP surface (GET /api/v1/search) + real NextAuth
 * flows against the dev server. Direct Prisma access is used ONLY for
 * deterministic fixture creation and cleanup (clearly marked).
 *
 * Sections (§38 A–AG — UI-only scenarios Z/AH/AI/AJ are covered by the
 * separate browser QA pass):
 *   SETUP      register/logins (ownerA+bizA, ownerB+bizB, staffA, rateUser)
 *   A  AUTH    401 unauthenticated · 400 no business context · 403 no membership
 *   B  TENANT  A sees ALPHA never BETA · B sees BETA never ALPHA · businessId param ignored
 *   C  RBAC    STAFF (data:read) allowed
 *   D  CUSTOMER name/phone/email matching
 *   E  SUPPLIER name matching
 *   F  PRODUCT name + SKU (case-insensitive)
 *   G  SALE    customer name + note
 *   H  EXPENSE category + supplier
 *   I  PAYMENT method + linked invoice + note
 *   K  RANK    exact match outranks prefix
 *   M  INVOICE numeric "42" + "INV-0042"
 *   O  PERSIAN Persian query matches Persian name
 *   P  VARIANT Arabic-ي query matches Persian-ی stored name
 *   Q  CASE    case-insensitive matching
 *   R  DELETE  soft-deleted customer invisible
 *   S  INACTIVE inactive product searchable with INACTIVE status
 *   T  LIMIT   clamped to ≤ 30
 *   U  LENGTH  q<2 → 422 · missing q → 422 · long q clamped OK
 *   V  TYPES   PlatformOperator/AiCostRecord/NotificationDelivery → 422
 *   W  DEDUPE  multi-field match appears once
 *   X  DEST    closed destinations + exact DTO key set
 *   AC CACHE   Cache-Control: private, no-store
 *   AD SAFE    no amounts/prices/ids/secrets in response
 *   AE EMPTY   no-match query → groups [] total 0
 *   AG I18N    fa-locale user gets Persian payment title
 *   AB LIMIT   31st request in 60 s → 429 (dedicated user, run LAST)
 *   CLEANUP    businesses (cascade) + users removed
 *
 * Run:  bun scripts/prompt33-search-check.mjs   (needs dev server on :3000)
 * Exit: 0 = all green · 1 = at least one failure.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.P33_BASE ?? "http://localhost:3000";
const PASS = "testpass123";
const PREFIX = "P33-SEARCH";
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
function section(name) {
  current = name;
}
let lastBody = null;
function record(name, ok, info = "") {
  results.push({ section: current, name, ok, info });
  console.log(`${ok ? "✓" : "✗"} [${current}] ${name}${info ? ` — ${info}` : ""}`);
}
function check(name, cond, info = "") {
  if (!cond) {
    record(name, false, `${info} |last=${JSON.stringify(lastBody).slice(0, 180)}`);
  } else record(name, true, info);
}

/* ------------------------------ fetch helpers ------------------------------ */
// Each actor gets its OWN random XFF so the per-IP auth-login limiter can
// never collide between logins or across harness runs.
function randomXff() {
  return `10.44.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
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
async function search(f, q, extra = "") {
  const { res, body } = await apiJson(f, `/api/v1/search?q=${encodeURIComponent(q)}${extra}`);
  if (body && !body.ok) {
    console.log(`  [search:${q.slice(0, 40)}] HTTP ${res.status} ${body?.error?.code ?? "?"}`);
  }
  return { res, body, data: body?.ok ? body.data : null };
}
const itemKeys = ["date", "destination", "direction", "id", "method", "status", "subtitle", "title", "type"];
const run = `r${Math.floor(Math.random() * 1e9)}`;

/* ================================== SETUP ================================== */
console.log("\n== SETUP ==");
section("SETUP");
// Defensive pre-clean (a previous crashed run may have left fixtures behind).
await db.business.deleteMany({ where: { name: { startsWith: `${PREFIX}-` } } });
await db.user.deleteMany({ where: { email: { contains: "p33-" } } });

const emailA = `p33-owner-a-${run}@test.local`;
const emailB = `p33-owner-b-${run}@test.local`;
const emailStaff = `p33-staff-${run}@test.local`;
const emailRate = `p33-rate-${run}@test.local`;

await registerApi(emailA, "P33 Owner A");
await registerApi(emailB, "P33 Owner B");
await registerApi(emailStaff, "P33 Staff");
await registerApi(emailRate, "P33 Rate");

const jarA = new Map();
const jarB = new Map();
const jarStaff = new Map();
const jarRate = new Map();

check("login owner A", await login(jarA, emailA, PASS));
check("login owner B", await login(jarB, emailB, PASS));
check("login staff", await login(jarStaff, emailStaff, PASS));
check("login rate user", await login(jarRate, emailRate, PASS));

const bizA = await createBusiness(jarA, `${PREFIX}-ALPHA-BIZ`);
const bizB = await createBusiness(jarB, `${PREFIX}-BETA-BIZ`);
const bizRate = await createBusiness(jarRate, `${PREFIX}-RATE-BIZ`);
check("business A created", Boolean(bizA), String(bizA));
check("business B created", Boolean(bizB), String(bizB));
check("rate business created", Boolean(bizRate), String(bizRate));

// staff joins business A (invite path is heavy; direct membership insert is
// the same row the API would create — used only to test RBAC on search).
const staffUser = await db.user.findUnique({ where: { email: emailStaff } });
if (!staffUser) throw new Error("staff user missing — SETUP incomplete (login rate-limited?)");
await db.businessMember.create({
  data: { businessId: bizA, userId: staffUser.id, role: "STAFF" },
});

const fA = withBiz(jarA, bizA);
const fB = withBiz(jarB, bizB);
const fStaff = withBiz(jarStaff, bizA);
const fRate = withBiz(jarRate, bizRate);

/* ------------------------- FIXTURES (direct Prisma) ----------------------- */
section("FIXTURES");
const custAlpha = await db.customer.create({
  data: {
    businessId: bizA,
    name: `${PREFIX}-ALPHA-CUSTOMER`,
    phone: "+989121234567",
    email: "p33alpha@example.com",
  },
});
const custPersian = await db.customer.create({
  data: { businessId: bizA, name: `${PREFIX}-علی رضایی` },
});
const custDeleted = await db.customer.create({
  data: { businessId: bizA, name: `${PREFIX}-GONE-CUSTOMER`, deletedAt: new Date() },
});
const custDedupe = await db.customer.create({
  data: { businessId: bizA, name: `${PREFIX}-DUP-CUSTOMER`, email: "p33dup@example.com" },
});
const custExact = await db.customer.create({
  data: { businessId: bizA, name: `${PREFIX}-Exact-Match` },
});
const custPrefix = await db.customer.create({
  data: { businessId: bizA, name: `${PREFIX}-Exact-Matcher` },
});
const custBeta = await db.customer.create({
  data: { businessId: bizB, name: `${PREFIX}-BETA-CUSTOMER` },
});
const suppAlpha = await db.supplier.create({
  data: { businessId: bizA, name: `${PREFIX}-ALPHA-SUPPLIER`, email: "p33sup@example.com" },
});
const suppDeleted = await db.supplier.create({
  data: { businessId: bizA, name: `${PREFIX}-GONE-SUPPLIER`, deletedAt: new Date() },
});
const prodActive = await db.product.create({
  data: { businessId: bizA, name: `${PREFIX}-iPhone 15 Pro`, sku: `${PREFIX}-IP15-128`, isActive: true },
});
const prodInactive = await db.product.create({
  data: { businessId: bizA, name: `${PREFIX}-Old iPhone`, sku: `${PREFIX}-IP-OLD`, isActive: false },
});
const SALE_NUMBER = 30000 + Math.floor(Math.random() * 9999);
const saleA = await db.sale.create({
  data: {
    businessId: bizA,
    number: SALE_NUMBER,
    customerId: custAlpha.id,
    subtotalMinor: 10000,
    totalMinor: 10000,
    status: "PARTIAL",
    paidMinor: 5000,
    note: `${PREFIX}-urgent delivery`,
  },
});
const expAlpha = await db.expense.create({
  data: {
    businessId: bizA,
    supplierId: suppAlpha.id,
    category: `${PREFIX}-Office Supplies`,
    amountMinor: 2000,
    paidMinor: 0,
    status: "UNPAID",
    note: `${PREFIX}-printer paper`,
  },
});
const payAlpha = await db.payment.create({
  data: {
    businessId: bizA,
    saleId: saleA.id,
    direction: "IN",
    amountMinor: 5000,
    method: "BANK_TRANSFER",
    note: `${PREFIX}-wire in`,
  },
});
record("fixtures created in business A", true, `sale=#${SALE_NUMBER}`);
check("staff membership row exists", Boolean(await db.businessMember.findUnique({ where: { businessId_userId: { businessId: bizA, userId: staffUser.id } } })));

/* ============================== A — AUTH ================================== */
console.log("\n== A. AUTH GATES ==");
section("A-AUTH");
{
  const anon = jarFetch(new Map());
  const { res } = await apiJson(anon, `/api/v1/search?q=hello`);
  check("A1 unauthenticated → 401", res.status === 401, `status=${res.status}`);
  const noCtx = jarFetch(jarA);
  const r2 = await apiJson(noCtx, `/api/v1/search?q=hello`);
  check("A2 no business context → 400", r2.res.status === 400, `status=${r2.res.status}`);
  // Owner B has a session but NO membership in business A.
  const wrongBiz = withBiz(jarB, bizA);
  const r3 = await apiJson(wrongBiz, `/api/v1/search?q=hello`);
  check("A3 session without membership → 403", r3.res.status === 403, `status=${r3.res.status}`);
}

/* ============================ B — TENANT ================================== */
console.log("\n== B. TENANT ISOLATION ==");
section("B-TENANT");
{
  const r1 = await search(fA, `${PREFIX}-ALPHA-CUSTOMER`);
  check("B1 A finds own ALPHA customer", r1.res.status === 200 && r1.data.groups.some((g) => g.items.some((i) => i.id === custAlpha.id)));
  const r2 = await search(fA, `${PREFIX}-BETA-CUSTOMER`);
  check("B2 A never sees BETA business data", r2.res.status === 200 && r2.data.total === 0);
  const r3 = await search(fB, `${PREFIX}-BETA-CUSTOMER`);
  check("B3 B finds own BETA customer", r3.res.status === 200 && r3.data.groups.some((g) => g.items.some((i) => i.id === custBeta.id)));
  const r4 = await search(fB, `${PREFIX}-ALPHA-CUSTOMER`);
  check("B4 B never sees ALPHA business data", r4.res.status === 200 && r4.data.total === 0);
  // §3 — client-supplied businessId in the query string is never authority.
  const r5 = await search(fA, `${PREFIX}-BETA-CUSTOMER`, `&businessId=${bizB}`);
  check("B5 ?businessId param cannot cross tenants", r5.res.status === 200 && r5.data.total === 0, JSON.stringify(r5.data).slice(0, 80));
  const r6 = await search(fA, `${PREFIX}-BETA-CUSTOMER`, `&userId=x&tenantId=y&ownerId=z`);
  check("B6 identity params ignored", r6.res.status === 200 && r6.data.total === 0);
}

/* ============================== C — RBAC ================================== */
console.log("\n== C. RBAC ==");
section("C-RBAC");
{
  const r1 = await search(fStaff, `${PREFIX}-ALPHA-CUSTOMER`);
  check("C1 STAFF with data:read → 200", r1.res.status === 200 && r1.data.total >= 1, `status=${r1.res.status}`);
  record("C2 note: every role in the current RBAC matrix holds data:read — a 403 can only come from missing membership (documented in docs/security/global-search-security.md)", true);
}

/* ============================ D–I — ENTITIES ============================== */
console.log("\n== D-I. ENTITY SEARCH ==");
section("D-I-ENTITIES");
{
  // D — customer: name
  const d1 = await search(fA, `${PREFIX}-ALPHA-CUSTOMER`);
  check("D1 customer by name", d1.data.groups.some((g) => g.type === "CUSTOMER" && g.items.some((i) => i.id === custAlpha.id)));
  const d2 = await search(fA, "p33alpha@example.com");
  check("D2 customer by email (secondary)", d1.data.groups.some((g) => g.type === "CUSTOMER") && Boolean(d2.data?.groups?.some((g) => g.type === "CUSTOMER" && g.items.some((i) => i.id === custAlpha.id))));
  const d3 = await search(fA, "989121234567");
  check("D3 customer by phone (secondary)", d3.data.groups.some((g) => g.type === "CUSTOMER" && g.items.some((i) => i.id === custAlpha.id)));
  // E — supplier
  const e1 = await search(fA, `${PREFIX}-ALPHA-SUPPLIER`);
  check("E1 supplier by name", e1.data.groups.some((g) => g.type === "SUPPLIER" && g.items.some((i) => i.id === suppAlpha.id)));
  // F — product: name + SKU case-insensitive
  const f1 = await search(fA, `${PREFIX}-iphone 15`);
  check("F1 product by name (case-insensitive)", f1.data.groups.some((g) => g.type === "PRODUCT" && g.items.some((i) => i.id === prodActive.id)));
  const f2 = await search(fA, `${PREFIX}-ip15-128`);
  check("F2 product by SKU lowercase", f2.data.groups.some((g) => g.type === "PRODUCT" && g.items.some((i) => i.id === prodActive.id)));
  const f3 = await search(fA, `${PREFIX}-IP15-128`);
  check("F3 product by SKU uppercase", f3.data.groups.some((g) => g.type === "PRODUCT" && g.items.some((i) => i.id === prodActive.id)));
  // G — sale: customer name + note
  const g1 = await search(fA, `${PREFIX}-ALPHA-CUSTOMER`, "&types=SALE");
  check("G1 sale by customer name", g1.data.groups.some((g) => g.type === "SALE" && g.items.some((i) => i.id === saleA.id)));
  const g2 = await search(fA, `${PREFIX}-urgent delivery`);
  check("G2 sale by note", g2.data.groups.some((g) => g.type === "SALE" && g.items.some((i) => i.id === saleA.id)));
  // H — expense: category + supplier
  const h1 = await search(fA, `${PREFIX}-Office Supplies`);
  check("H1 expense by category", h1.data.groups.some((g) => g.type === "EXPENSE" && g.items.some((i) => i.id === expAlpha.id)));
  const h2 = await search(fA, `${PREFIX}-ALPHA-SUPPLIER`, "&types=EXPENSE");
  check("H2 expense by supplier name", h2.data.groups.some((g) => g.type === "EXPENSE" && g.items.some((i) => i.id === expAlpha.id)));
  // I — payment: method + invoice + note
  const i1 = await search(fA, "bank_transfer", "&types=PAYMENT");
  check("I1 payment by method", i1.data.groups.some((g) => g.type === "PAYMENT" && g.items.some((i) => i.id === payAlpha.id && i.method === "BANK_TRANSFER" && i.direction === "IN")));
  const i2 = await search(fA, `INV-${String(SALE_NUMBER).padStart(4, "0")}`, "&types=PAYMENT");
  check("I2 payment by linked invoice number", i2.data.groups.some((g) => g.type === "PAYMENT" && g.items.some((i) => i.id === payAlpha.id)));
  const i3 = await search(fA, `${PREFIX}-wire in`);
  check("I3 payment by note", i3.data.groups.some((g) => g.type === "PAYMENT" && g.items.some((i) => i.id === payAlpha.id)));
}

/* =========================== K — RANKING ================================== */
console.log("\n== K. RANKING ==");
section("K-RANK");
{
  const r1 = await search(fA, `${PREFIX}-Exact-Match`, "&types=CUSTOMER");
  const items = r1.data.groups.find((g) => g.type === "CUSTOMER")?.items ?? [];
  check("K1 exact match outranks prefix match", items.length >= 2 && items[0].id === custExact.id, `first=${items[0]?.id}`);
  // Deterministic: same query twice → same order.
  const r2 = await search(fA, `${PREFIX}-Exact-Match`, "&types=CUSTOMER");
  check("K2 deterministic order across repeats", JSON.stringify(r1.data.groups) === JSON.stringify(r2.data.groups));
}

/* ========================== M — INVOICE NUMBERS =========================== */
console.log("\n== M. INVOICE ==");
section("M-INVOICE");
{
  const inv = `INV-${String(SALE_NUMBER).padStart(4, "0")}`;
  const m1 = await search(fStaff, String(SALE_NUMBER), "&types=SALE");
  check("M1 numeric invoice lookup", m1.data.groups.some((g) => g.type === "SALE" && g.items.some((i) => i.id === saleA.id)));
  const m2 = await search(fStaff, inv);
  check("M2 formatted INV-XXXX lookup", m2.data.groups.some((g) => g.type === "SALE" && g.items.some((i) => i.id === saleA.id)));
  const m3 = await search(fStaff, inv.toLowerCase());
  check("M3 lowercase inv-xxxx lookup", m3.data.groups.some((g) => g.type === "SALE" && g.items.some((i) => i.id === saleA.id)));
}

/* ======================= O/P — PERSIAN + VARIANTS ========================= */
console.log("\n== O/P. PERSIAN + ARABIC VARIANTS ==");
section("O-PERSIAN");
{
  const o1 = await search(fStaff, "علی", "&types=CUSTOMER");
  check("O1 Persian query matches Persian name", o1.data.groups.some((g) => g.type === "CUSTOMER" && g.items.some((i) => i.id === custPersian.id)));
  const p1 = await search(fStaff, "علي", "&types=CUSTOMER");
  check("P1 Arabic-ي variant matches Persian-ی stored name", p1.data.groups.some((g) => g.type === "CUSTOMER" && g.items.some((i) => i.id === custPersian.id)));
  const q1 = await search(fStaff, "۱۲۳۴۵۶۷", "&types=CUSTOMER");
  check("Q0 Persian digits find phone-stored digits", q1.data.groups.some((g) => g.type === "CUSTOMER" && g.items.some((i) => i.id === custAlpha.id)));
}

/* ============================== Q — CASE ================================== */
console.log("\n== Q. CASE NORMALIZATION ==");
section("Q-CASE");
{
  const q1 = await search(fStaff, `${PREFIX}-alpha-customer`);
  check("Q1 lowercase finds mixed-case name", q1.data.groups.some((g) => g.type === "CUSTOMER" && g.items.some((i) => i.id === custAlpha.id)));
  const q2 = await search(fStaff, `${PREFIX}-ALPHA-CUSTOMER`);
  check("Q2 uppercase finds mixed-case name", q2.data.groups.some((g) => g.type === "CUSTOMER" && g.items.some((i) => i.id === custAlpha.id)));
}

/* ============================ R — SOFT DELETE ============================= */
console.log("\n== R. SOFT DELETE ==");
section("R-SOFT-DELETE");
{
  const r1 = await search(fStaff, `${PREFIX}-GONE-CUSTOMER`);
  check("R1 soft-deleted customer invisible", r1.data.total === 0);
  const r2 = await search(fStaff, `${PREFIX}-GONE-SUPPLIER`);
  check("R2 soft-deleted supplier invisible", r2.data.total === 0);
}

/* ========================== S — INACTIVE PRODUCT ========================== */
console.log("\n== S. INACTIVE PRODUCT ==");
section("S-INACTIVE");
{
  const r1 = await search(fStaff, `${PREFIX}-Old iPhone`);
  const item = r1.data.groups.find((g) => g.type === "PRODUCT")?.items.find((i) => i.id === prodInactive.id);
  check("S1 inactive product still searchable", Boolean(item));
  check("S2 inactive product marked INACTIVE", item?.status === "INACTIVE", String(item?.status));
}

/* ============================== T — LIMIT ================================= */
console.log("\n== T. LIMIT CLAMP ==");
section("T-LIMIT");
{
  const r1 = await search(fStaff, `${PREFIX}`, "&limit=100");
  check("T1 limit=100 clamped (total ≤ 30)", r1.res.status === 200 && r1.data.total <= 30, `total=${r1.data.total}`);
  const r2 = await search(fStaff, `${PREFIX}`, "&limit=6");
  check("T2 limit=6 accepted", r2.res.status === 200 && r2.data.total <= 6);
  const r3 = await search(fStaff, `${PREFIX}`);
  check("T3 default limit works", r3.res.status === 200);
}

/* ========================= U/V — VALIDATION =============================== */
console.log("\n== U/V. VALIDATION ==");
section("U-VALIDATION");
{
  const u1 = await search(fStaff, "a");
  check("U1 single-char query → 422", u1.res.status === 422, `status=${u1.res.status}`);
  const u2 = await apiJson(fStaff, "/api/v1/search");
  check("U2 missing q → 422", u2.res.status === 422, `status=${u2.res.status}`);
  const u3 = await search(fStaff, "x".repeat(300));
  check("U3 overlong q clamped → 200", u3.res.status === 200, `status=${u3.res.status}`);
  const v1 = await search(fStaff, "hello", "&types=PlatformOperator");
  check("V1 types=PlatformOperator → 422", v1.res.status === 422);
  const v2 = await search(fStaff, "hello", "&types=AiCostRecord");
  check("V2 types=AiCostRecord → 422", v2.res.status === 422);
  const v3 = await search(fStaff, "hello", "&types=NotificationDelivery");
  check("V3 types=NotificationDelivery → 422", v3.res.status === 422);
  const v4 = await search(fStaff, "hello", "&types=CUSTOMER,PRODUCT");
  check("V4 valid multi-type accepted", v4.res.status === 200);
  const v5 = await search(fStaff, "hello", "&types=CUSTOMER,CUSTOMER,product");
  check("V5 duplicates + case normalized", v5.res.status === 200);
}

/* ============================== W — DEDUPE ================================ */
console.log("\n== W. DEDUPE ==");
section("W-DEDUPE");
{
  // Customer matches BOTH name and email → exactly one row.
  const r1 = await search(fStaff, `${PREFIX}-DUP-CUSTOMER`);
  const matches = r1.data.groups.find((g) => g.type === "CUSTOMER")?.items.filter((i) => i.id === custDedupe.id) ?? [];
  check("W1 multi-field match appears once", matches.length === 1, `count=${matches.length}`);
}

/* =========================== X — DESTINATIONS ============================= */
console.log("\n== X. DESTINATIONS + DTO SHAPE ==");
section("X-DEST");
{
  const r1 = await search(fStaff, `${PREFIX}`);
  const all = r1.data.groups.flatMap((g) => g.items);
  const allowed = ["customers", "suppliers", "products", "sales", "expenses", "payments"];
  check("X1 all destinations closed-vocabulary", all.every((i) => allowed.includes(i.destination)));
  check("X2 item keys exactly the DTO contract", all.every((i) => JSON.stringify(Object.keys(i).sort()) === JSON.stringify(itemKeys)));
  check("X3 groups carry type+count+items", r1.data.groups.every((g) => typeof g.type === "string" && typeof g.count === "number" && Array.isArray(g.items)));
  check("X4 no URL fields in items", all.every((i) => !JSON.stringify(i).includes("/api/") && !JSON.stringify(i).includes("http")));
}

/* ============================== AC — CACHE ================================ */
console.log("\n== AC. CACHE POLICY ==");
section("AC-CACHE");
{
  const res = await fA("/api/v1/search?q=hello");
  const cc = res.headers.get("cache-control") ?? "";
  check("AC1 Cache-Control private, no-store", cc.includes("private") && cc.includes("no-store"), cc);
}

/* ======================== AD — SENSITIVE DATA ============================= */
console.log("\n== AD. DATA MINIMIZATION ==");
section("AD-SAFE");
{
  const r1 = await search(fA, `${PREFIX}`);
  const raw = JSON.stringify(r1.data);
  const forbidden = [
    "amountMinor", "totalMinor", "paidMinor", "costPriceMinor", "salePriceMinor",
    "passwordHash", "sessionVersion", "businessId", "userId", "ownerId",
    "provider", "gateway", "checkoutSession", "webhook", "dataJson",
    "note\":", "address",
  ];
  const hits = forbidden.filter((f) => raw.includes(f));
  check("AD1 no sensitive/financial/internal fields", hits.length === 0, hits.join(","));
  check("AD2 no amounts leak via sale/expense items", !raw.includes("Minor"));
  check("AD3 total equals sum of group counts", r1.data.total === r1.data.groups.reduce((s, g) => s + g.count, 0));
  check("AD4 truncated flag boolean", typeof r1.data.truncated === "boolean");
}

/* ============================== AE — EMPTY ================================ */
console.log("\n== AE. EMPTY STATE ==");
section("AE-EMPTY");
{
  const r1 = await search(fA, "zzqqxx-no-match");
  check("AE1 no-match → groups [] total 0", r1.res.status === 200 && r1.data.groups.length === 0 && r1.data.total === 0);
}

/* ============================== AG — I18N ================================= */
console.log("\n== AG. I18N ==");
section("AG-I18N");
{
  await db.user.update({ where: { email: emailStaff }, data: { locale: "fa" } });
  const r1 = await search(fStaff, "bank_transfer", "&types=PAYMENT");
  const pay = r1.data.groups.find((g) => g.type === "PAYMENT")?.items[0];
  check("AG1 fa-locale user gets Persian payment title", pay?.title === "پرداخت", String(pay?.title));
  await db.user.update({ where: { email: emailStaff }, data: { locale: "en" } });
  const r2 = await search(fStaff, "bank_transfer", "&types=PAYMENT");
  const pay2 = r2.data.groups.find((g) => g.type === "PAYMENT")?.items[0];
  check("AG2 en-locale user gets English payment title", pay2?.title === "Payment", String(pay2?.title));
}

/* ============================ AB — RATE LIMIT ============================= */
console.log("\n== AB. RATE LIMIT (dedicated user, run last) ==");
section("AB-RATE");
{
  let hit429 = false;
  let allowed = 0;
  for (let i = 0; i < 40; i += 1) {
    const { res } = await search(fRate, `rate-probe-${i}`);
    if (res.status === 429) {
      hit429 = true;
      const body = await fRate(`/api/v1/search?q=rate-probe-final`).then((r) => r.json());
      check("AB1 429 envelope carries RATE_LIMITED", body?.error?.code === "RATE_LIMITED", String(body?.error?.code));
      break;
    }
    if (res.status === 200) allowed += 1;
  }
  check("AB2 limiter trips within 40 requests", hit429, `allowed=${allowed}`);
  check("AB3 allowed requests ≤ 30 before 429", allowed <= 30, `allowed=${allowed}`);
}

/* =============================== CLEANUP ================================== */
console.log("\n== CLEANUP ==");
section("CLEANUP");
{
  // Business delete cascades ALL tenant fixtures (members/customers/sales/
  // payments/... per schema onDelete: Cascade). Users are deleted after.
  await db.business.deleteMany({ where: { id: { in: [bizA, bizB, bizRate].filter(Boolean) } } });
  await db.user.deleteMany({
    where: { email: { in: [emailA, emailB, emailStaff, emailRate] } },
  });
  const leftC = await db.customer.count({ where: { name: { contains: PREFIX } } });
  const leftS = await db.sale.count({ where: { note: { contains: PREFIX } } });
  record("fixture rows fully removed", leftC === 0 && leftS === 0, `customers=${leftC} sales=${leftS}`);
}

/* ------------------------------- summary ---------------------------------- */
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\nprompt33-search-check: ${passed}/${results.length} passed`);
if (failed > 0) {
  console.log("FAILED assertions:");
  for (const r of results.filter((r) => !r.ok)) console.log(`  ✗ [${r.section}] ${r.name} ${r.info}`);
  await db.$disconnect();
  process.exit(1);
}
await db.$disconnect();
