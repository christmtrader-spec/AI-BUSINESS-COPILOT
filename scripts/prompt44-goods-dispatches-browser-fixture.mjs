/**
 * Prompt 44 browser-QA fixture — deterministic goods-dispatch dataset for
 * MANUAL agent-browser QA. `--teardown` removes everything (crashed-run
 * safe: teardown sweeps any stale P44DS-BROWSE residue; the P44DS prefixed
 * rows are all swept by business-scoped deletes without touching
 * persistent baselines).
 *
 * Run:  node scripts/prompt44-goods-dispatches-browser-fixture.mjs            → create + print ids
 *       node scripts/prompt44-goods-dispatches-browser-fixture.mjs --teardown → remove everything
 *
 * Dataset: 1 owner + business (Asia/Tehran), 1 customer, 4 products with
 * stable SKUs and stock (incl. one zero-stock and one LOW-STOCK product),
 * plus one POSTED dispatch (P44DS-POSTED, 12 units), one DRAFT dispatch
 * (P44DS-DRAFT, 5 units with a line to edit/remove), and one CANCELLED
 * dispatch (P44DS-CANCELLED) so every status state exists for the UI.
 */
const BASE = "http://localhost:3000";
const PASS = "testpass123";
const TAG = "P44DS-BROWSE";
const STAMP_FILE = "var/p44ds-browser-stamp.txt";
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
const EMAIL = S ? `p44ds-owner-${S}@p44ds.test` : "";

function makeClient() {
  const jar = new Map();
  const xff = `10.44.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
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
  const bizs = await prisma.business.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
  const bizIds = bizs.map((b) => b.id);
  const users = await prisma.user.findMany({ where: { email: { contains: "p44ds-owner-" } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  if (bizIds.length) {
    await prisma.auditLog.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.notification.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.goodsDispatchLine.deleteMany({ where: { goodsDispatch: { businessId: { in: bizIds } } } });
    await prisma.goodsDispatch.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.inventoryAdjustment.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.saleItem.deleteMany({ where: { sale: { businessId: { in: bizIds } } } });
    await prisma.sale.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.product.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.customer.deleteMany({ where: { businessId: { in: bizIds } } });
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
const reg = await c("/api/v1/auth/register", { method: "POST", body: JSON.stringify({ name: "P44 QA Owner", email: EMAIL, password: PASS }) });
if (reg.status !== 201 && reg.status !== 200) throw new Error(`register ${reg.status}: ${JSON.stringify(reg.body)}`);
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

const customer = await post("/api/v1/customers", { name: "P44CUST-Aria Trading" });
const prodBolt = await post("/api/v1/products", { name: "P44PROD-Steel Bolt", sku: "P44-SKU-BOLT", unit: "box", stockQty: 60, costPriceMinor: 500, salePriceMinor: 900 });
const prodWire = await post("/api/v1/products", { name: "P44PROD-Copper Wire", sku: "P44-SKU-WIRE", unit: "roll", stockQty: 25, costPriceMinor: 1200, salePriceMinor: 2100 });
const prodGlove = await post("/api/v1/products", { name: "P44PROD-Safety Glove", sku: "P44-SKU-GLOVE", unit: "pair", stockQty: 0, costPriceMinor: 300, salePriceMinor: 650 });
const prodTape = await post("/api/v1/products", { name: "P44PROD-Duct Tape", sku: "P44-SKU-TAPE", unit: "roll", stockQty: 3, lowStockAt: 5, costPriceMinor: 250, salePriceMinor: 600 });

// One POSTED dispatch (12 bolts to the customer) so the detail/stock/widget
// states all exist.
const dsPosted = await post("/api/v1/inventory/goods-dispatches", { reference: "P44DS-POSTED", customerId: customer.id, notes: "QA posted dispatch" });
await post(`/api/v1/inventory/goods-dispatches/${dsPosted.id}/lines`, { productId: prodBolt.id, qty: 12, reasonCode: "SALE" });
await post(`/api/v1/inventory/goods-dispatches/${dsPosted.id}/post`, {});

// One DRAFT dispatch (5 wire units) for the line edit/remove/post flows.
const dsDraft = await post("/api/v1/inventory/goods-dispatches", { reference: "P44DS-DRAFT", customerId: customer.id, notes: "QA draft dispatch" });
await post(`/api/v1/inventory/goods-dispatches/${dsDraft.id}/lines`, { productId: prodWire.id, qty: 5, reasonCode: "TRANSFER_OUT" });

// One CANCELLED dispatch so every status state exists.
const dsCancelled = await post("/api/v1/inventory/goods-dispatches", { reference: "P44DS-CANCELLED" });
// the zero-stock glove stays for the picker's zero-stock state; the
// cancelled dispatch uses a stocked product (the advisory availability
// check would refuse a zero-stock line by design)
await post(`/api/v1/inventory/goods-dispatches/${dsCancelled.id}/lines`, { productId: prodTape.id, qty: 1, reasonCode: "GIFT_SAMPLE" });
await post(`/api/v1/inventory/goods-dispatches/${dsCancelled.id}/cancel`, {});

console.log(JSON.stringify({
  email: EMAIL,
  password: PASS,
  businessId: biz.id,
  customerId: customer.id,
  products: { bolt: prodBolt.id, wire: prodWire.id, glove: prodGlove.id, tape: prodTape.id },
  dispatches: { posted: dsPosted.id, draft: dsDraft.id, cancelled: dsCancelled.id },
}, null, 2));
