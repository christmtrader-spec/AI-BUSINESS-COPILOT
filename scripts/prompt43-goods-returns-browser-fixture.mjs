/**
 * Prompt 43 browser-QA fixture — deterministic goods-return dataset for
 * MANUAL agent-browser QA (§168). `--teardown` removes everything
 * (crashed-run safe: teardown sweeps any stale P43RT-BROWSE residue; the
 * P43RT prefixed rows are all swept by business-scoped deletes without
 * touching persistent baselines).
 *
 * Run:  node scripts/prompt43-goods-returns-browser-fixture.mjs            → create + print ids
 *       node scripts/prompt43-goods-returns-browser-fixture.mjs --teardown → remove everything
 *
 * Dataset: 1 owner + business, 1 supplier, 3 products with stable SKUs, and
 * purchase orders with EXPLICIT references (never array positions):
 *   - P43PO-BOLTS : CONFIRMED, 1 line × 100, fully posted receipt
 *                   (P43GR-BOLTS 100 units) → the return source.
 *   - P43PO-MIXED : CONFIRMED, 2 lines; receipt P43GR-MIXED posted with
 *                   40+40 → returnable lines for the picker flow.
 * plus one POSTED return (P43RT-POSTED, 20 units from P43GR-BOLTS) and one
 * CANCELLED return (P43RT-CANCELLED) so every status state exists.
 */
const BASE = "http://localhost:3000";
const PASS = "testpass123";
const TAG = "P43RT-BROWSE";
const STAMP_FILE = "var/p43rt-browser-stamp.txt";
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
const EMAIL = S ? `p43rt-owner-${S}@p43rt.test` : "";

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
  const users = await prisma.user.findMany({ where: { email: { contains: "p43rt-owner-" } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  if (bizIds.length) {
    await prisma.auditLog.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.notification.deleteMany({ where: { businessId: { in: bizIds } } });
    await prisma.goodsReturnLine.deleteMany({ where: { goodsReturn: { businessId: { in: bizIds } } } });
    await prisma.goodsReturn.deleteMany({ where: { businessId: { in: bizIds } } });
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
const reg = await c("/api/v1/auth/register", { method: "POST", body: JSON.stringify({ name: "P43 QA Owner", email: EMAIL, password: PASS }) });
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

const supplier = await post("/api/v1/suppliers", { name: "P43SUP-Nordic Parts" });
const prodBolt = await post("/api/v1/products", { name: "P43PROD-Steel Bolt", sku: "P43-SKU-BOLT", unit: "box", stockQty: 10, costPriceMinor: 500, salePriceMinor: 900 });
const prodWire = await post("/api/v1/products", { name: "P43PROD-Copper Wire", sku: "P43-SKU-WIRE", unit: "roll", stockQty: 4, costPriceMinor: 1200, salePriceMinor: 2100 });
const prodGlove = await post("/api/v1/products", { name: "P43PROD-Safety Glove", sku: "P43-SKU-GLOVE", unit: "pair", stockQty: 0, costPriceMinor: 300, salePriceMinor: 650 });

async function confirmedPo(reference, lines) {
  const po = await post("/api/v1/purchase-orders", { supplierId: supplier.id, reference });
  for (const l of lines) await post(`/api/v1/purchase-orders/${po.id}/lines`, l);
  await post(`/api/v1/purchase-orders/${po.id}/send`, {});
  await post(`/api/v1/purchase-orders/${po.id}/confirm`, {});
  return po.id;
}

const poBolts = await confirmedPo("P43PO-BOLTS", [{ productId: prodBolt.id, orderedQty: 100, unitPriceMinor: 500 }]);
const poMixed = await confirmedPo("P43PO-MIXED", [
  { productId: prodWire.id, orderedQty: 50, unitPriceMinor: 1200 },
  { productId: prodGlove.id, orderedQty: 40, unitPriceMinor: 300 },
]);

// POSTED receipt against P43PO-BOLTS: 100 units (the primary return source).
const poBoltsDetail = (await c(`/api/v1/purchase-orders/${poBolts}`, { headers: H })).body.data;
const grBolts = await post("/api/v1/inventory/goods-receipts", { purchaseOrderId: poBolts, reference: "P43GR-BOLTS" });
await post(`/api/v1/inventory/goods-receipts/${grBolts.id}/lines`, { purchaseOrderLineId: poBoltsDetail.lines[0].id, receivedQty: 100 });
await post(`/api/v1/inventory/goods-receipts/${grBolts.id}/post`, {});

// POSTED receipt against P43PO-MIXED: 40 + 40.
const poMixedDetail = (await c(`/api/v1/purchase-orders/${poMixed}`, { headers: H })).body.data;
const grMixed = await post("/api/v1/inventory/goods-receipts", { purchaseOrderId: poMixed, reference: "P43GR-MIXED" });
await post(`/api/v1/inventory/goods-receipts/${grMixed.id}/lines`, { purchaseOrderLineId: poMixedDetail.lines[0].id, receivedQty: 40 });
await post(`/api/v1/inventory/goods-receipts/${grMixed.id}/lines`, { purchaseOrderLineId: poMixedDetail.lines[1].id, receivedQty: 40 });
await post(`/api/v1/inventory/goods-receipts/${grMixed.id}/post`, {});

// One POSTED return (20 bolts) + one CANCELLED return so every state exists.
const retPosted = await post("/api/v1/inventory/goods-returns", { goodsReceiptId: grBolts.id, reference: "P43RT-POSTED" });
const grBoltsDetail = (await c(`/api/v1/inventory/goods-receipts/${grBolts.id}`, { headers: H })).body.data;
const boltsReceiptLineId = grBoltsDetail.lines[0].id;
await post(`/api/v1/inventory/goods-returns/${retPosted.id}/lines`, { goodsReceiptLineId: boltsReceiptLineId, returnedQty: 20, reasonCode: "DAMAGED" });
await post(`/api/v1/inventory/goods-returns/${retPosted.id}/post`, {});

const retCancelled = await post("/api/v1/inventory/goods-returns", { goodsReceiptId: grMixed.id, reference: "P43RT-CANCELLED" });
await post(`/api/v1/inventory/goods-returns/${retCancelled.id}/cancel`, {});

console.log(JSON.stringify({
  email: EMAIL,
  password: PASS,
  businessId: biz.id,
  supplierId: supplier.id,
  products: { bolt: prodBolt.id, wire: prodWire.id, glove: prodGlove.id },
  pos: { bolts: poBolts, mixed: poMixed },
  receipts: { bolts: grBolts.id, mixed: grMixed.id },
  receiptLines: { bolts: boltsReceiptLineId, wire: poMixedDetail.lines[0].id, glove: poMixedDetail.lines[1].id },
  returns: { posted: retPosted.id, cancelled: retCancelled.id },
}, null, 2));
