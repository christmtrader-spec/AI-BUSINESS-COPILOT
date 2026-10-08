/**
 * Prompt 42 browser-QA fixture — deterministic receiving dataset for
 * MANUAL agent-browser QA of the Goods Receipts feature. `--teardown`
 * removes everything (crashed-run safe: teardown sweeps any stale
 * P42QA-BROWSE residue; the P42GR / P42PO / P42PROD / P42SUP / P42USER
 * prefixed rows are all swept by business-scoped deletes without touching
 * persistent baselines).
 *
 * Run:  node scripts/prompt42-goods-receipts-browser-fixture.mjs            → create + print ids
 *       node scripts/prompt42-goods-receipts-browser-fixture.mjs --teardown → remove everything
 *
 * Dataset: 1 owner + business, 1 supplier, 3 products with stable SKUs, and
 * 3 purchase orders with EXPLICIT references (never array positions):
 *   - P42PO-FULL   : CONFIRMED, 1 line × 100 (for the partial 40→65→100 flow)
 *   - P42PO-EXTRA  : CONFIRMED, 2 lines (for a fresh draft flow)
 *   - P42PO-CLOSED : CLOSED (must NOT be receivable in the picker)
 * plus one POSTED receipt (P42GR-POSTED, 40 units against P42PO-FULL) and
 * one CANCELLED receipt (P42GR-CANCELLED) so every status state exists.
 */
const BASE = "http://localhost:3000";
const PASS = "testpass123";
const TAG = "P42QA-BROWSE";
const STAMP_FILE = "var/p42qa-browser-stamp.txt";
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
const EMAIL = S ? `p42qa-owner-${S}@p42qa.test` : "";

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
  const users = await prisma.user.findMany({ where: { email: { contains: "p42qa-owner-" } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  if (bizIds.length) {
    await prisma.auditLog.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.notification.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.goodsReceiptLine.deleteMany({ where: { goodsReceipt: { businessId: { in: bizIds } } } });
    await prisma.goodsReceipt.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.inventoryAdjustment.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.purchaseOrderLine.deleteMany({ where: { purchaseOrder: { businessId: { in: bizIds } } } });
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
const reg = await c("/api/v1/auth/register", { method: "POST", body: JSON.stringify({ name: "P42 QA Owner", email: EMAIL, password: PASS }) });
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

const supplier = await post("/api/v1/suppliers", { name: "P42SUP-Nordic Parts" });
const prodA = await post("/api/v1/products", { name: "P42PROD-Steel Bolt", sku: "P42-SKU-BOLT", unit: "box", stockQty: 10, costPriceMinor: 500, salePriceMinor: 900 });
const prodB = await post("/api/v1/products", { name: "P42PROD-Copper Wire", sku: "P42-SKU-WIRE", unit: "roll", stockQty: 4, costPriceMinor: 1200, salePriceMinor: 2100 });
const prodC = await post("/api/v1/products", { name: "P42PROD-Safety Glove", sku: "P42-SKU-GLOVE", unit: "pair", stockQty: 0, costPriceMinor: 300, salePriceMinor: 650 });

async function confirmedPo(reference, lines) {
  const po = await post("/api/v1/purchase-orders", { supplierId: supplier.id, reference });
  for (const l of lines) await post(`/api/v1/purchase-orders/${po.id}/lines`, l);
  await post(`/api/v1/purchase-orders/${po.id}/send`, {});
  await post(`/api/v1/purchase-orders/${po.id}/confirm`, {});
  return po.id;
}
async function closedPo(reference, lines) {
  const po = await post("/api/v1/purchase-orders", { supplierId: supplier.id, reference });
  for (const l of lines) await post(`/api/v1/purchase-orders/${po.id}/lines`, l);
  await post(`/api/v1/purchase-orders/${po.id}/send`, {});
  await post(`/api/v1/purchase-orders/${po.id}/confirm`, {});
  await post(`/api/v1/purchase-orders/${po.id}/close`, {});
  return po.id;
}

const poFull = await confirmedPo("P42PO-FULL", [{ productId: prodA.id, orderedQty: 100, unitPriceMinor: 500 }]);
const poExtra = await confirmedPo("P42PO-EXTRA", [
  { productId: prodB.id, orderedQty: 25, unitPriceMinor: 1200 },
  { productId: prodC.id, orderedQty: 40, unitPriceMinor: 300 },
]);
await closedPo("P42PO-CLOSED", [{ productId: prodA.id, orderedQty: 5, unitPriceMinor: 500 }]);

// POSTED receipt: 40 units against P42PO-FULL line 1 (leaves remaining 60).
const poFullDetail = (await c(`/api/v1/purchase-orders/${poFull}`, { headers: H })).body.data;
const grPosted = await post("/api/v1/inventory/goods-receipts", { purchaseOrderId: poFull, reference: "P42GR-POSTED" });
await post(`/api/v1/inventory/goods-receipts/${grPosted.id}/lines`, { purchaseOrderLineId: poFullDetail.lines[0].id, receivedQty: 40 });
await post(`/api/v1/inventory/goods-receipts/${grPosted.id}/post`, {});

// CANCELLED receipt against P42PO-EXTRA (draft → cancel).
const grCancelled = await post("/api/v1/inventory/goods-receipts", { purchaseOrderId: poExtra, reference: "P42GR-CANCELLED" });
await post(`/api/v1/inventory/goods-receipts/${grCancelled.id}/cancel`, {});

console.log(JSON.stringify({
  email: EMAIL,
  password: PASS,
  businessId: biz.id,
  supplierId: supplier.id,
  products: { bolt: prodA.id, wire: prodB.id, glove: prodC.id },
  pos: { full: poFull, extra: poExtra },
  receipts: { posted: grPosted.id, cancelled: grCancelled.id },
  poFullLineId: poFullDetail.lines[0].id,
}, null, 2));
