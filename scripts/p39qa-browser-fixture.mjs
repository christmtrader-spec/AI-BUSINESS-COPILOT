/**
 * P39 browser-QA fixture — creates a small deterministic demo dataset for
 * MANUAL browser QA of the statements view (agent-browser journey), then
 * `--teardown` removes every fixture-owned record (ZERO residue, §272/§273).
 *
 * Fixture tag: P39QA-BROWSE (distinct from the E2E's P39 tag so a crashed
 * browser round can never be confused with E2E residue).
 *
 * Run:  node scripts/p39qa-browser-fixture.mjs            → create + print ids
 *       node scripts/p39qa-browser-fixture.mjs --teardown → remove everything
 */
const BASE = "http://localhost:3000";
const PASS = "testpass123";
const TAG = "P39QA-BROWSE";
const STAMP_FILE = "var/p39qa-browser-stamp.txt";
const fs = await import("node:fs");

function stamp() {
  if (process.argv.includes("--teardown")) {
    return fs.readFileSync(STAMP_FILE, "utf8").trim();
  }
  const s = `${Date.now().toString(36)}`;
  fs.mkdirSync("var", { recursive: true });
  fs.writeFileSync(STAMP_FILE, s);
  return s;
}
const S = stamp();
const EMAIL = `p39qa-browser-owner-${S}@p39.test`;

function makeClient() {
  const jar = new Map();
  const xff = `10.39.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
  return async (path, init = {}) => {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const headers = { "x-forwarded-for": xff, ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  };
}

async function prisma() {
  const { PrismaClient } = await import("@prisma/client");
  return new PrismaClient();
}

// ---- cleanup helpers (fixture-owned patterns ONLY, never deleteMany) -------
async function teardown() {
  const prisma = await prisma();
  const biz = await prisma.business.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
  const bizIds = biz.map((b) => b.id);
  const users = await prisma.user.findMany({ where: { email: { contains: "p39qa-browser-owner-" } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  if (bizIds.length) {
    await prisma.auditLog.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.notification.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.payment.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.saleItem.deleteMany({ where: { sale: { businessId: { in: bizIds } } } });
    await prisma.sale.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.expense.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.customer.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.supplier.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.membership.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  }
  if (userIds.length) {
    await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.$disconnect();
  console.log(`teardown done: ${bizIds.length} business(es), ${userIds.length} user(s) removed`);
}

if (process.argv.includes("--teardown")) {
  await teardown();
  process.exit(0);
}

// ---- create -----------------------------------------------------------------
const c = makeClient();
const reg = await c("/api/v1/auth/register", { method: "POST", body: JSON.stringify({ name: "P39 Browser Owner", email: EMAIL, password: PASS }) });
if (reg.status !== 201 && reg.status !== 200) throw new Error(`register ${reg.status}`);
await c("/api/auth/csrf");
await c("/api/auth/callback/credentials", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ csrfToken: (await c("/api/auth/csrf")).body?.csrfToken ?? "", email: EMAIL, password: PASS, redirect: "false", json: "true" }).toString(),
});
const biz = (await c("/api/v1/businesses", { method: "POST", body: JSON.stringify({ name: `${TAG}-BIZ`, currencyCode: "USD", timezone: "Asia/Tehran" }) })).body?.data?.business;
const H = { "x-business-id": biz.id, "content-type": "application/json" };
const post = async (path, payload) => {
  const r = await c(path, { method: "POST", headers: H, body: JSON.stringify(payload) });
  if (r.status !== 201 && r.status !== 200) throw new Error(`${path} → ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.data;
};

const customer = await post("/api/v1/customers", { name: "Acme Trading" });
const supplier = await post("/api/v1/suppliers", { name: "GlobalParts Co" });

const sale1 = await post("/api/v1/sales", { customerId: customer.id, items: [{ name: "Consulting", qty: 1, unitPriceMinor: 10000 }], issueDate: "2026-10-02T09:00:00.000Z" });
const sale2 = await post("/api/v1/sales", { customerId: customer.id, items: [{ name: "Hardware", qty: 1, unitPriceMinor: 12000 }], issueDate: "2026-10-03T10:00:00.000Z" });
await post("/api/v1/payments", { saleId: sale1.id, amountMinor: 4000, method: "CASH", paidAt: "2026-10-04T11:00:00.000Z" });

const expense = await post("/api/v1/expenses", { supplierId: supplier.id, category: "Parts", amountMinor: 25000, spentAt: "2026-10-05T09:30:00.000Z", reference: "BILL-771" });
await post("/api/v1/payments", { expenseId: expense.id, amountMinor: 10000, method: "BANK_TRANSFER", paidAt: "2026-10-05T14:00:00.000Z" });

const out = { email: EMAIL, password: PASS, businessId: biz.id, businessName: biz.name, customerId: customer.id, customerName: customer.name, supplierId: supplier.id, supplierName: supplier.name };
fs.writeFileSync("var/p39qa-browser-fixture.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
