/**
 * Prompt 41-F browser-QA fixture — deterministic procurement dataset for
 * MANUAL agent-browser QA of the Purchase Orders feature. `--teardown`
 * removes everything (crashed-run safe: rerun of teardown sweeps any stale
 * P41QA-BROWSE residue).
 *
 * Run:  node scripts/prompt41-purchase-orders-browser-fixture.mjs            → create + print ids
 *       node scripts/prompt41-purchase-orders-browser-fixture.mjs --teardown → remove everything
 *
 * Dataset: 1 owner + business, 12 suppliers (picker pagination page 2),
 * 14 products (picker pagination page 2), and 5 purchase orders in EVERY
 * lifecycle state (DRAFT with 2 lines / SENT / CONFIRMED / CLOSED /
 * CANCELLED) with explicit references — NEVER array-position dependent.
 */
const BASE = "http://localhost:3000";
const PASS = "testpass123";
const TAG = "P41QA-BROWSE";
const STAMP_FILE = "var/p41qa-browser-stamp.txt";
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
const EMAIL = S ? `p41qa-owner-${S}@p41qa.test` : "";

function makeClient() {
  const jar = new Map();
  const xff = `10.42.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
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
  const users = await prisma.user.findMany({ where: { email: { contains: "p41qa-owner-" } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  if (bizIds.length) {
    await prisma.auditLog.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.notification.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.product.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.supplier.deleteMany({ where: { businessId: { in: bizIds } } });
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
const reg = await c("/api/v1/auth/register", { method: "POST", body: JSON.stringify({ name: "P41 QA Owner", email: EMAIL, password: PASS }) });
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

// 12 suppliers → supplier picker paginates (pageSize 10 → page 2 exists).
const suppliers = [];
for (let i = 1; i <= 12; i += 1) {
  const s = await post("/api/v1/suppliers", { name: `${TAG}-SUP-${String(i).padStart(2, "0")}` });
  suppliers.push(s.supplier ?? s);
}
// 14 products → product picker paginates (pageSize 10 → page 2 exists).
const products = [];
for (let i = 1; i <= 14; i += 1) {
  const p = await post("/api/v1/products", {
    name: `${TAG}-PROD-${String(i).padStart(2, "0")}`,
    sku: `P41QA-SKU-${String(i).padStart(2, "0")}`,
    unit: "piece",
    salePriceMinor: 1500,
    costPriceMinor: 800,
  });
  products.push(p.product ?? p);
}

const po = async (reference, supplierId) =>
  (await post("/api/v1/purchase-orders", { supplierId, reference })).purchaseOrder ?? (await post("/api/v1/purchase-orders", { supplierId, reference }));
const line = (poId, productId, qty, price) => post(`/api/v1/purchase-orders/${poId}/lines`, { productId, orderedQty: qty, unitPriceMinor: price });
const trans = (poId, op) => post(`/api/v1/purchase-orders/${poId}/${op}`, {});

// Explicit references — lookup by reference, never array position.
const poDraft = await post("/api/v1/purchase-orders", { supplierId: suppliers[0].id, reference: "P41PO-BROWSER-001" });
await line(poDraft.id, products[0].id, 10, 85_000);
await line(poDraft.id, products[1].id, 4, 120_000);

const poSent = await post("/api/v1/purchase-orders", { supplierId: suppliers[1].id, reference: "P41PO-BROWSER-002" });
await line(poSent.id, products[2].id, 6, 95_000);
await trans(poSent.id, "send");

const poConfirmed = await post("/api/v1/purchase-orders", { supplierId: suppliers[2].id, reference: "P41PO-BROWSER-003" });
await line(poConfirmed.id, products[3].id, 2, 250_000);
await trans(poConfirmed.id, "send");
await trans(poConfirmed.id, "confirm");

const poClosed = await post("/api/v1/purchase-orders", { supplierId: suppliers[3].id, reference: "P41PO-BROWSER-004" });
await line(poClosed.id, products[4].id, 8, 45_000);
await trans(poClosed.id, "send");
await trans(poClosed.id, "confirm");
await trans(poClosed.id, "close");

const poCancelled = await post("/api/v1/purchase-orders", { supplierId: suppliers[4].id, reference: "P41PO-BROWSER-005" });
await line(poCancelled.id, products[5].id, 1, 10_000);
await trans(poCancelled.id, "cancel");

const out = {
  email: EMAIL,
  password: PASS,
  businessId: biz.id,
  businessName: biz.name,
  supplierPage2: suppliers[10].name,
  productPage2: products[10].sku,
  purchaseOrders: {
    DRAFT: { id: poDraft.id, reference: "P41PO-BROWSER-001" },
    SENT: { id: poSent.id, reference: "P41PO-BROWSER-002" },
    CONFIRMED: { id: poConfirmed.id, reference: "P41PO-BROWSER-003" },
    CLOSED: { id: poClosed.id, reference: "P41PO-BROWSER-004" },
    CANCELLED: { id: poCancelled.id, reference: "P41PO-BROWSER-005" },
  },
};
fs.writeFileSync("var/p41qa-browser-fixture.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
