/**
 * Exports-round browser-QA fixture — demo dataset for MANUAL agent-browser
 * QA of the three export surfaces (adjustments history card, stocktake
 * detail export, aging card export). `--teardown` removes everything.
 *
 * Run:  node scripts/exports-browser-fixture.mjs            → create + print ids
 *       node scripts/exports-browser-fixture.mjs --teardown → remove everything
 */
const BASE = "http://localhost:3000";
const PASS = "testpass123";
const TAG = "EXPQA-BROWSE";
const STAMP_FILE = "var/expqa-browser-stamp.txt";
const fs = await import("node:fs");

function stamp() {
  if (process.argv.includes("--teardown")) {
    try { return fs.readFileSync(STAMP_FILE, "utf8").trim(); } catch { return ""; }
  }
  const s = `${Date.now().toString(36)}`;
  fs.mkdirSync("var", { recursive: true });
  fs.writeFileSync(STAMP_FILE, s);
  return s;
}
const S = stamp();
const EMAIL = S ? `expqa-owner-${S}@expqa.test` : "";

function makeClient() {
  const jar = new Map();
  const xff = `10.41.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
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

async function teardown() {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const biz = await prisma.business.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
  const bizIds = biz.map((b) => b.id);
  const users = await prisma.user.findMany({ where: { email: { contains: "expqa-owner-" } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  if (bizIds.length) {
    await prisma.auditLog.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.notification.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.payment.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.sale.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.expense.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.customer.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.supplier.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.inventoryStocktakeLine.deleteMany({ where: { stocktake: { businessId: { in: bizIds } } } });
    await prisma.inventoryStocktake.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.inventoryAdjustment.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.product.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.subscriptionEvent.deleteMany({ where: { subscription: { businessId: { in: bizIds } } } });
    await prisma.subscription.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.businessMember.deleteMany({ where: { businessId: { in: bizIds } } });
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

const c = makeClient();
const reg = await c("/api/v1/auth/register", { method: "POST", body: JSON.stringify({ name: "Exports QA Owner", email: EMAIL, password: PASS }) });
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

const product = async (name, sku, qty) => {
  // products API has NO initialQty (unknown keys are stripped silently) —
  // create plainly, then set the opening stock through the stock endpoint.
  const created = await post("/api/v1/products", { name, sku, unit: "piece", salePriceMinor: 1000, costPriceMinor: 500, lowStockAt: 5 });
  const p = created.product ?? created;
  if (qty) await post(`/api/v1/products/${p.id}/stock`, { delta: qty, reason: "EXPQA initial stock" });
  return p;
};

const pA = await product("Widget Alpha", "EXPQA-A", 10);
const pB = await product("Widget Beta", "EXPQA-B", 20);
const pC = await product("Widget Gamma", "EXPQA-C", 30);

// Extra adjustment deltas → the history card has both directions + reasons.
await post(`/api/v1/products/${pB.id}/stock`, { delta: -3, reason: "EXPQA damage" });
await post(`/api/v1/products/${pC.id}/stock`, { delta: 4, reason: "EXPQA found in back room" });

// Open receivable + payable → the aging cards have real buckets.
const customer = await post("/api/v1/customers", { name: "Acme Receivables" });
await post("/api/v1/sales", {
  customerId: customer.id,
  items: [{ productId: pA.id, name: pA.name, qty: 5, unitPriceMinor: 2500 }],
  paymentMethod: "OTHER",
  paidMinor: 0,
  issueDate: new Date(Date.now() - 45 * 86400000).toISOString(),
});
const supplier = await post("/api/v1/suppliers", { name: "Pay Supplier" });
await post("/api/v1/expenses", {
  supplierId: supplier.id,
  category: "services",
  amountMinor: 25000,
  paidMinor: 0,
  paymentMethod: "OTHER",
  dueDate: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
});

// A stocktake with 2 counted lines → the detail page + its export have data.
const st = await post("/api/v1/inventory/stocktakes", { reference: "EXPQA-ST-01", notes: "exports QA count" });
for (const p of [pA, pB, pC]) {
  await post(`/api/v1/inventory/stocktakes/${st.id}/lines`, { productId: p.id });
}
await post(`/api/v1/inventory/stocktakes/${st.id}/start`);
const detail = await c(`/api/v1/inventory/stocktakes/${st.id}?page=1&pageSize=100`, { headers: H });
const lines = detail.body?.data?.lines ?? [];
const lineA = lines.find((l) => l.productId === pA.id);
const lineB = lines.find((l) => l.productId === pB.id);
await post(`/api/v1/inventory/stocktakes/${st.id}/lines/${lineA.id}/count`, { countedQty: 8 });
await post(`/api/v1/inventory/stocktakes/${st.id}/lines/${lineB.id}/count`, { countedQty: 17 });

const out = {
  email: EMAIL, password: PASS, businessId: biz.id, businessName: biz.name,
  stocktakeId: st.id, products: [pA, pB, pC].map((p) => ({ id: p.id, name: p.name, stockQty: p.stockQty })),
};
fs.writeFileSync("var/expqa-browser-fixture.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
