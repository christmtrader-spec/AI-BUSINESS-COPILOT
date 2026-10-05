/**
 * P40 browser-QA fixture — demo dataset for MANUAL agent-browser QA of the
 * stocktake module. `--teardown` removes every fixture-owned record.
 *
 * Run:  node scripts/p40qa-browser-fixture.mjs            → create + print ids
 *       node scripts/p40qa-browser-fixture.mjs --teardown → remove everything
 */
const BASE = "http://localhost:3000";
const PASS = "testpass123";
const TAG = "P40QA-BROWSE";
const STAMP_FILE = "var/p40qa-browser-stamp.txt";
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
const EMAIL = S ? `p40qa-browser-owner-${S}@p40.test` : "";

function makeClient() {
  const jar = new Map();
  const xff = `10.40.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
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
  const users = await prisma.user.findMany({ where: { email: { contains: "p40qa-browser-owner-" } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  if (bizIds.length) {
    await prisma.auditLog.deleteMany({ where: { businessId: { in: bizIds }, action: { startsWith: "inventory.stocktake" } } });
    await prisma.auditLog.deleteMany({ where: { businessId: { in: bizIds }, action: { startsWith: "product" } } });
    await prisma.notification.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.inventoryStocktakeLine.deleteMany({ where: { stocktake: { businessId: { in: bizIds } } } });
    await prisma.inventoryStocktake.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.inventoryAdjustment.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.product.deleteMany({ where: { businessId: { in: bizIds } } });
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
const reg = await c("/api/v1/auth/register", { method: "POST", body: JSON.stringify({ name: "P40 Browser Owner", email: EMAIL, password: PASS }) });
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
  const created = await post("/api/v1/products", { name, sku, unit: "piece", salePriceMinor: 1000, costPriceMinor: 500, lowStockAt: 5, initialQty: qty }).catch(async (e) => {
    // fallback if initialQty unsupported: create then adjust
    const created2 = await post("/api/v1/products", { name, sku, unit: "piece", salePriceMinor: 1000, costPriceMinor: 500, lowStockAt: 5 });
    if (qty) await post(`/api/v1/products/${created2.product?.id ?? created2.id}/stock`, { delta: qty, reason: "P40QA initial stock" });
    return created2.product ?? created2;
  });
  return created.product ?? created;
};

const pA = await product("Widget A", "P40QA-A", 10);
const pB = await product("Widget B", "P40QA-B", 20);
const pC = await product("Widget C", "P40QA-C", 30);

const out = { email: EMAIL, password: PASS, businessId: biz.id, businessName: biz.name, products: [pA, pB, pC].map((p) => ({ id: p.id, name: p.name, stockQty: p.stockQty })) };
fs.writeFileSync("var/p40qa-browser-fixture.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
